/**
 * Verification for @local/dsh-web-pwa. Run from this directory with
 * `node --test` (or `node --test test/pwa.test.mjs`).
 *
 * Three layers:
 *  1. the Host plugin's routes and index rows, against the real
 *     renderIndexInjections and the real dist index.html;
 *  2. the service worker inside a VM with a Cache Storage / fetch double, so
 *     its strategies are exercised rather than described;
 *  3. the manifest's icons, which must exist in the frontend dist at the sizes
 *     they claim.
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PACKAGE_DIR = dirname(fileURLToPath(new URL('./', import.meta.url)))
const DSH_ROOT = process.env.DSH_ROOT ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const DIST = join(DSH_ROOT, 'dsh-web-frontend/dist')
const { renderIndexInjections } = await import(`${DSH_ROOT}/dsh-host-webserver/lib/index.js`)

const SW_SOURCE = readFileSync(join(PACKAGE_DIR, 'sw.js'), 'utf8')
const VERSION = /const VERSION = '([^']+)'/u.exec(SW_SOURCE)?.[1]
assert.ok(VERSION, 'sw.js declares its cache VERSION')
const SHELL = `dsh-web-pwa-shell-v${VERSION}`
const ASSETS = `dsh-web-pwa-assets-v${VERSION}`

// ── Host plugin ─────────────────────────────────────────────────────────────

function loadPlugin() {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    webServer: {
      register(route) {
        assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    on(event, listener) {
      assert.ok(!listeners.has(event), `duplicate listener ${event}`)
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }
  return { routes, listeners, disposers, ctx }
}

const loaded = loadPlugin()
const plugin = await import(`${PACKAGE_DIR}/index.js`)
plugin.apply(loaded.ctx)

test('plugin declares its services and name', () => {
  assert.equal(plugin.name, 'web-pwa')
  assert.deepEqual([...plugin.inject], ['webServer'])
  assert.deepEqual([...loaded.routes.keys()].sort(), ['/manifest.webmanifest', '/sw.js'])
  assert.deepEqual([...loaded.listeners.keys()], ['webserver/index-inject'])
})

test('the service worker route serves the sw.js file with revalidation', async () => {
  const route = loaded.routes.get('/sw.js')
  assert.equal(route.kind, 'exact')
  const response = await route.resource(new Request('https://dsh.test/sw.js'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  assert.equal(response.headers.get('service-worker-allowed'), '/')
  assert.equal(await response.text(), SW_SOURCE)
})

test('the service worker route answers a matching If-None-Match with 304', async () => {
  const route = loaded.routes.get('/sw.js')
  const first = await route.resource(new Request('https://dsh.test/sw.js'))
  const etag = first.headers.get('etag')
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/)
  const second = await route.resource(new Request('https://dsh.test/sw.js', { headers: { 'if-none-match': etag } }))
  assert.equal(second.status, 304)
  assert.equal(second.headers.get('etag'), etag)
})

test('routes reject a method other than GET or HEAD', async () => {
  for (const path of ['/sw.js', '/manifest.webmanifest']) {
    const response = await loaded.routes.get(path).resource(new Request(`https://dsh.test${path}`, { method: 'POST' }))
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  }
})

test('the manifest is installable and points at real dist icons', async () => {
  const response = await loaded.routes.get('/manifest.webmanifest').resource(new Request('https://dsh.test/manifest.webmanifest'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
  const manifest = JSON.parse(await response.text())
  assert.equal(manifest.id, '/')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.ok(Array.isArray(manifest.display_override) && !manifest.display_override.includes('window-controls-overlay'))
  assert.equal(manifest.name, 'DeepSeek Harness')
  assert.equal(manifest.short_name, 'DSH')
  assert.equal(manifest.theme_color, '#151517')
  assert.equal(manifest.background_color, '#151517')
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'))
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'))
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'))
})

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file) {
  const bytes = readFileSync(file)
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${file} is a PNG`)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test('every manifest icon exists in the dist at the size it declares', async () => {
  const response = await loaded.routes.get('/manifest.webmanifest').resource(new Request('https://dsh.test/manifest.webmanifest'))
  const manifest = JSON.parse(await response.text())
  for (const icon of manifest.icons) {
    const file = join(DIST, icon.src)
    assert.ok(statSync(file).size > 1024, `${icon.src} carries bytes`)
    const [width, height] = icon.sizes.split('x').map(Number)
    assert.deepEqual(pngSize(file), { width, height }, `${icon.src} is ${icon.sizes}`)
  }
})

test('head rows make the page installable through a credential-checking proxy', () => {
  const table = []
  loaded.listeners.get('webserver/index-inject')(table)
  assert.equal(table.length, 6)
  const raw = readFileSync(join(DIST, 'index.html'), 'utf8')
  // Mirror frontend-static: rows, then <base href="./"> after every head row.
  const rendered = renderIndexInjections(raw, table)
    .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)

  // The credential-carrying manifest link must be the first one the browser reads.
  assert.match(rendered, /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials">/)
  assert.match(rendered, /<link rel="manifest" href="\.\/manifest\.webmanifest" \/>/)
  assert.match(rendered, /<link rel="apple-touch-icon" href="\.\/apple-touch-icon\.png" \/>/)
  assert.match(rendered, /<meta name="apple-mobile-web-app-capable" content="yes">/)
  assert.match(rendered, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#ffffff">/)
  assert.match(rendered, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#151517">/)
  assert.match(rendered, /<meta name="application-name" content="DSH">/)
  assert.match(rendered, /navigator\.serviceWorker[\s\S]*?register\('\/sw\.js', \{ scope: '\/', updateViaCache: 'none' \}\)/)
  assert.match(rendered, /<script>\(globalThis\.__DSH_BOOT_READY__ \?\?= Promise\.withResolvers\(\)\)\.resolve\(\)<\/script>/)

  // The rows land inside <head>, ahead of the entry module; frontend-static puts
  // its base tag right after the opening head tag, before the rows.
  const headAt = rendered.search(/<head(?:\s[^>]*)?>/i)
  const baseAt = rendered.indexOf('<base href="./">')
  const oursAt = rendered.indexOf('href="/manifest.webmanifest"')
  const registerAt = rendered.indexOf("register('/sw.js'")
  const shippedAt = rendered.indexOf('href="./manifest.webmanifest"')
  const entryAt = rendered.indexOf('<script type="module"')
  assert.ok(headAt !== -1 && baseAt > headAt, 'the base tag follows the opening head tag')
  assert.ok(oursAt > baseAt && registerAt > oursAt, 'the credential manifest link and registration follow the base tag')
  assert.ok(shippedAt > registerAt, 'the shipped manifest link stays after the rows')
  assert.ok(entryAt > shippedAt, 'the entry module stays last')
  // No row closes the script element early: entry, registration, boot readiness.
  assert.equal(rendered.split('</script>').length - 1, 3)
})

test('routes and rows are released when the plugin unloads', () => {
  for (const dispose of loaded.disposers) dispose()
  assert.equal(loaded.routes.size, 0)
  assert.equal(loaded.listeners.size, 0)
})

// ── Service worker ──────────────────────────────────────────────────────────

const ORIGIN = 'https://dsh.test/sw.js'

/** Give a synthetic response the type a real same-origin fetch produces. */
function basic(response) {
  Object.defineProperty(response, 'type', { value: 'basic' })
  return response
}

class TestCache {
  constructor(store, network) {
    this.store = store
    this.network = network
  }

  key(input) {
    return typeof input === 'string' ? new URL(input, ORIGIN).href : input.url
  }

  async match(input) {
    const found = this.store.get(this.key(input))
    return found === undefined ? undefined : found.clone()
  }

  async put(input, response) {
    this.store.set(this.key(input), response.clone())
  }

  async keys() {
    return [...this.store.keys()].map(url => new Request(url))
  }

  async delete(input) {
    return this.store.delete(this.key(input))
  }
}

/** The content type a real Host serves for a path, so type guards are exercised. */
function contentTypeFor(url) {
  const path = new URL(url).pathname
  if (path.endsWith('.webmanifest')) return 'application/manifest+json'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.css')) return 'text/css'
  if (path === '/') return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

/** A worker instance with its own cache, network, and lifecycle state. */
function createWorker({ network, language = 'en-US' } = {}) {
  const stores = new Map()
  const listeners = new Map()
  const state = { claimed: false, skipped: false, requests: [], timers: [] }
  const timers = new Map()
  let nextTimer = 1
  let fetchImpl = network ?? (async request => basic(new Response(`net:${request.url}`, {
    status: 200,
    headers: { 'content-type': contentTypeFor(request.url) },
  })))

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      return new TestCache(stores.get(name), request => fetchImpl(request))
    },
    async keys() {
      return [...stores.keys()]
    },
    async delete(name) {
      return stores.delete(name)
    },
  }

  const self = {
    location: new URL('https://dsh.test/sw.js'),
    navigator: { language },
    clients: { claim: async () => { state.claimed = true } },
    skipWaiting: async () => { state.skipped = true },
    addEventListener(type, listener) { listeners.set(type, listener) },
  }

  const sandbox = {
    self,
    caches,
    fetch: async (request, init) => {
      state.requests.push(request)
      state.lastSignal = init?.signal ?? request.signal
      const response = await fetchImpl(request, init)
      // A real network response carries its final URL; the doubles start empty.
      if (response !== undefined && response.url === '') {
        Object.defineProperty(response, 'url', { value: request.url })
      }
      return response
    },
    AbortController,
    Response,
    Request,
    Headers,
    URL,
    console,
    setInterval: () => 0,
    setTimeout: (callback) => {
      const id = nextTimer++
      timers.set(id, callback)
      state.timers.push(id)
      return id
    },
    clearTimeout: (id) => { timers.delete(id) },
  }
  vm.createContext(sandbox)
  vm.runInContext(SW_SOURCE, sandbox)

  const lifecycle = async (type) => {
    const pending = []
    const event = { waitUntil: promise => { pending.push(promise) } }
    await listeners.get(type)(event)
    await Promise.all(pending)
  }

  const fetchEvent = async (request) => {
    const pending = []
    let responded
    const event = {
      request,
      respondWith(value) { responded = value },
      waitUntil(promise) { pending.push(promise) },
    }
    listeners.get('fetch')(event)
    const response = responded === undefined ? undefined : await responded
    await Promise.all(pending)
    return response
  }

  return {
    stores, state, lifecycle, fetchEvent,
    setNetwork(next) { fetchImpl = next },
    store: name => stores.get(name) ?? new Map(),
    /** Fire every pending timeout, as the event loop would. */
    fireTimers() {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, callback] of pending) callback()
    },
    pendingTimers: () => timers.size,
  }
}

/** Node cannot construct a navigation Request; shadow the mode a browser sets. */
function navigateRequest(url) {
  const request = new Request(url)
  Object.defineProperty(request, 'mode', { value: 'navigate' })
  return request
}

test('install precaches the small static files and takes over immediately', async () => {
  const worker = createWorker()
  await worker.lifecycle('install')
  assert.equal(worker.state.skipped, true)
  const shell = worker.store(SHELL)
  assert.equal(shell.size, 4)
  assert.ok(shell.has('https://dsh.test/manifest.webmanifest'))
  assert.ok(shell.has('https://dsh.test/icon-192.png'))
})

test('activate drops this worker\'s stale generations and keeps foreign caches', async () => {
  const worker = createWorker()
  await worker.lifecycle('install')
  worker.stores.set('dsh-web-pwa-shell-v0', new Map())
  worker.stores.set('another-plugin-cache', new Map())
  await worker.lifecycle('activate')
  assert.equal(worker.state.claimed, true)
  assert.deepEqual([...worker.stores.keys()].sort(), [SHELL, 'another-plugin-cache'].sort())
})

test('a navigation is network only and is never stored', async () => {
  const worker = createWorker({ network: async () => basic(new Response('index-bytes', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  })) })
  await worker.lifecycle('install')
  const response = await worker.fetchEvent(navigateRequest('https://dsh.test/'))
  assert.equal(await response.text(), 'index-bytes')
  const indexFetches = worker.state.requests.filter(request => request.url === 'https://dsh.test/')
  assert.equal(indexFetches.length, 1, 'the navigation went to the network exactly once')
  for (const store of worker.stores.values()) {
    assert.ok(!store.has('https://dsh.test/'), 'the index must not be cached')
  }
  assert.equal(worker.pendingTimers(), 0, 'the navigation timeout is cleared')
})

test('a failed navigation shows the retry page in the browser language', async () => {
  for (const [language, needle] of [['ru-RU', 'Сервер DSH недоступен'], ['zh-CN', '无法连接 DSH 服务器'], ['en-GB', 'The DSH server is unreachable']]) {
    const worker = createWorker({
      language,
      network: async () => { throw new TypeError('Failed to fetch') },
    })
    await worker.lifecycle('install')
    const response = await worker.fetchEvent(navigateRequest('https://dsh.test/'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const html = await response.text()
    assert.ok(html.includes(needle), `${language} page carries its own title`)
    assert.ok(html.includes("fetch('/sw.js', { method: 'HEAD', cache: 'no-store' })"), 'the page probes for liveness')
    assert.ok(html.includes('location.reload()'), 'any HTTP answer reloads it')
    assert.ok(html.includes('<html lang="' + language.slice(0, 2) + '">'))
    assert.ok(!html.includes('href="/auth/tg"'), 'no sign-in link while the network is the problem')
  }
})

test('a signed-out navigation offers the gateway sign-in page', async () => {
  const challenge = () => basic(new Response('{"error":"unauthorized"}', {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'DSH-Session realm="dsh-gateway"' },
  }))
  const worker = createWorker({ language: 'ru-RU', network: async () => challenge() })
  const html = await (await worker.fetchEvent(navigateRequest('https://dsh.test/'))).text()
  assert.match(html, /Сессия завершилась/)
  assert.match(html, /<a class="button" href="\/auth\/tg">Войти<\/a>/)
  assert.doesNotMatch(html, /setInterval\(/, 'a sign-in page never reloads itself into the same 401')
})

test('a 401 without an auth challenge, and a 403, still explain the session state', async () => {
  for (const status of [401, 403]) {
    const worker = createWorker({ language: 'en-GB', network: async () => basic(new Response('denied', { status })) })
    const html = await (await worker.fetchEvent(navigateRequest('https://dsh.test/'))).text()
    assert.match(html, /The session has ended/)
    assert.ok(!html.includes('href="/auth/tg"'), 'no sign-in link without a challenge header')
  }
})

test('an upstream 5xx shows the unreachable page, not the proxy body', async () => {
  const worker = createWorker({ language: 'en-US', network: async () => basic(new Response('<h1>bad gateway</h1>', {
    status: 502, headers: { 'content-type': 'text/html' },
  })) })
  const html = await (await worker.fetchEvent(navigateRequest('https://dsh.test/'))).text()
  assert.match(html, /The DSH server is unreachable/)
  assert.doesNotMatch(html, /bad gateway/)
})

test('a stalled navigation shows the retry page when the timeout fires', async () => {
  let signal
  const worker = createWorker({
    network: (request, init) => new Promise((resolve, reject) => {
      // Honor the worker's AbortSignal, like a real fetch.
      signal = init?.signal
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
    language: 'en-US',
  })
  const pending = worker.fetchEvent(navigateRequest('https://dsh.test/'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(worker.pendingTimers(), 1, 'a navigation timeout is armed')
  worker.fireTimers()
  assert.equal(signal.aborted, true, 'the timeout aborts the network request')
  const response = await pending
  assert.match(await response.text(), /The DSH server is unreachable/)
  assert.equal(worker.pendingTimers(), 0, 'the timeout is cleared afterwards')
})

test('build assets are cache first and survive the network going away', async () => {
  let calls = 0
  const worker = createWorker({
    network: async () => {
      calls += 1
      return basic(new Response(`asset-${calls}`, { status: 200, headers: { 'content-type': 'text/javascript' } }))
    },
  })
  await worker.lifecycle('install')
  const first = await worker.fetchEvent(new Request('https://dsh.test/assets/index-abc.js'))
  const firstBody = await first.text()
  assert.match(firstBody, /^asset-\d+$/)
  const callsAfterFirst = calls

  worker.setNetwork(async () => { throw new TypeError('offline') })
  const second = await worker.fetchEvent(new Request('https://dsh.test/assets/index-abc.js'))
  assert.equal(await second.text(), firstBody)
  assert.equal(calls, callsAfterFirst, 'the cached copy answered without the network')
  assert.ok(worker.store(ASSETS).has('https://dsh.test/assets/index-abc.js'))
})

test('an uncached asset with no network answers 504 rather than throwing', async () => {
  const worker = createWorker({ network: async () => { throw new TypeError('offline') } })
  await worker.lifecycle('activate')
  const response = await worker.fetchEvent(new Request('https://dsh.test/assets/missing.js'))
  assert.equal(response.status, 504)
})

test('static files are stale-while-revalidate', async () => {
  let body = 'manifest-1'
  const worker = createWorker({ network: async () => basic(new Response(body, {
    status: 200, headers: { 'content-type': 'application/manifest+json' },
  })) })
  await worker.lifecycle('install')
  body = 'manifest-2'
  const stale = await worker.fetchEvent(new Request('https://dsh.test/manifest.webmanifest'))
  assert.equal(await stale.text(), 'manifest-1', 'the cached copy answers immediately')
  const fresh = await worker.fetchEvent(new Request('https://dsh.test/manifest.webmanifest'))
  assert.equal(await fresh.text(), 'manifest-2', 'the background update replaced it')
})

test('the asset cache stays bounded', async () => {
  const worker = createWorker({ network: async () => basic(new Response('x', {
    status: 200, headers: { 'content-type': 'text/javascript' },
  })) })
  await worker.lifecycle('install')
  for (let index = 0; index < 130; index += 1) {
    await worker.fetchEvent(new Request(`https://dsh.test/assets/chunk-${index}.js`))
  }
  assert.equal(worker.store(ASSETS).size, 120)
})

test('a proxy login page never replaces a cached asset or the manifest', async () => {
  const login = () => basic(new Response('<!doctype html><title>sign in</title>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  }))
  const worker = createWorker({ network: async () => login() })
  await worker.lifecycle('install')
  assert.equal(worker.store(SHELL).size, 0, 'the login page is not a precache entry')

  const asset = await worker.fetchEvent(new Request('https://dsh.test/assets/app.js'))
  assert.match(await asset.text(), /sign in/, 'the page still reaches the browser')
  assert.equal(worker.store(ASSETS).size, 0, 'and is not stored as an asset')

  await worker.fetchEvent(new Request('https://dsh.test/manifest.webmanifest'))
  assert.equal(worker.store(SHELL).size, 0, 'and does not replace the manifest')
})

test('a JSON body is not stored as a script or a stylesheet', async () => {
  const json = () => basic(new Response('{"error":"unauthorized"}', {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  const worker = createWorker({ network: async () => json() })
  await worker.lifecycle('install')
  await worker.fetchEvent(new Request('https://dsh.test/assets/app.js'))
  await worker.fetchEvent(new Request('https://dsh.test/assets/app.css'))
  assert.equal(worker.store(ASSETS).size, 0)
})

test('traffic the worker must not touch is left to the browser', async () => {
  const worker = createWorker()
  await worker.lifecycle('install')
  const untouched = [
    new Request('https://dsh.test/api/sessions'),
    new Request('https://dsh.test/plugins/module.js'),
    new Request('https://dsh.test/sw.js'),
    new Request('https://dsh.test/assets/range.js', { headers: { range: 'bytes=0-10' } }),
    new Request('https://dsh.test/', { method: 'POST', body: 'x' }),
    new Request('https://other.test/assets/x.js'),
  ]
  for (const request of untouched) {
    const response = await worker.fetchEvent(request)
    assert.equal(response, undefined, `${request.method} ${request.url} must not be answered by the worker`)
  }
})
