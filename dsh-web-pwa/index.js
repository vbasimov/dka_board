/**
 * @local/dsh-web-pwa — the installable-app layer of the DSH Web GUI.
 *
 * It serves two files the built frontend does not ship and adds the head rows
 * that make the page an installable app:
 *
 * - `/manifest.webmanifest` — a stricter manifest than the shipped one: a
 *   stable `id`, dark splash colors, an explicit `display_override`, and the
 *   existing dist icons.
 * - `/sw.js` — the service worker from `sw.js` next to this file, read per
 *   request so an edited worker needs no plugin reload, and served from the
 *   origin root so its scope covers the shell.
 * - head rows — a credential-carrying manifest link, the Apple standalone tag,
 *   `theme-color` for both color schemes, the app name, and the registration
 *   script.
 *
 * Both routes are public like every other static asset of the shell; the
 * browser authenticates the index page, not its assets. Nothing here touches
 * API traffic.
 *
 * @module @local/dsh-web-pwa
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Stable Cordis plugin name. */
export const name = 'web-pwa'

/** The origin-root webserver must exist before either file can be routed. */
export const inject = ['webServer']

const SW_PATH = '/sw.js'
const SW_FILE = new URL('./sw.js', import.meta.url)
const MANIFEST_PATH = '/manifest.webmanifest'

const MANIFEST = {
  id: '/',
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  description: 'DeepSeek Harness: a coding agent session in the browser.',
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'any',
  background_color: '#151517',
  theme_color: '#151517',
  categories: ['developer', 'productivity'],
  prefer_related_applications: false,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}

/** Registration runs after the shell starts so it never competes with app boot. */
const REGISTER_SCRIPT = `(() => {
  if (!('serviceWorker' in navigator)) return
  addEventListener('load', () => {
    navigator.serviceWorker
      .register('${SW_PATH}', { scope: '/', updateViaCache: 'none' })
      .catch((error) => console.warn('dsh web: service worker registration failed', error))
  })
})()`

const manifestSource = `${JSON.stringify(MANIFEST, null, 2)}\n`

function weakEtag(body) {
  return `W/"${createHash('sha1').update(body).digest('base64url')}"`
}

/**
 * One conditional static response: an exact `If-None-Match` match answers 304,
 * any other GET answers the bytes with `no-cache` so the browser revalidates.
 * @param load - produces the bytes for this request.
 * @param type - the response content type.
 * @param extraHeaders - route-specific headers added to every response.
 */
function staticResource(load, type, extraHeaders) {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    const body = await load()
    const etag = weakEtag(body)
    const headers = { 'content-type': type, 'cache-control': 'no-cache', etag, ...extraHeaders }
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(body, { status: 200, headers })
  }
}

/**
 * Head rows: install metadata plus the registration that starts the worker.
 *
 * The manifest link comes first on purpose: the browser fetches a manifest
 * without credentials, so a deployment behind a cookie-authenticating proxy
 * answers that fetch with 401 and the app never installs. This link opts in
 * with `use-credentials`, and because it precedes the shipped one it is the
 * manifest the browser reads.
 */
const HEAD_ROWS = [
  { kind: 'html', placement: 'head', html: `<link rel="manifest" href="${MANIFEST_PATH}" crossorigin="use-credentials">` },
  { kind: 'html', placement: 'head', html: '<meta name="apple-mobile-web-app-capable" content="yes">' },
  { kind: 'html', placement: 'head', html: '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">' },
  { kind: 'html', placement: 'head', html: '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151517">' },
  { kind: 'html', placement: 'head', html: '<meta name="application-name" content="DSH">' },
  { kind: 'script', placement: 'head', text: REGISTER_SCRIPT },
]

/**
 * Route the two files and contribute the head rows.
 * @param ctx - plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SW_PATH,
    resource: staticResource(
      () => readFile(SW_FILE, 'utf8'),
      'text/javascript; charset=utf-8',
      { 'service-worker-allowed': '/' },
    ),
  }), 'web-pwa: service worker route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANIFEST_PATH,
    resource: staticResource(() => manifestSource, 'application/manifest+json; charset=utf-8', {}),
  }), 'web-pwa: manifest route')

  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push(...HEAD_ROWS)
  }), 'web-pwa: install head rows')
}
