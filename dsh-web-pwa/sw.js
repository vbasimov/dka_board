/**
 * Service worker of the DSH Web PWA, served at `/sw.js` by `@local/dsh-web-pwa`.
 *
 * Scope: the origin root, because the DSH Web shell is served there.
 *
 * The shell is a live client: every session needs the Host over WebSocket and
 * nothing useful survives without it. So this worker never pretends to be
 * offline-capable — it keeps the immutable build assets fast, keeps the install
 * metadata fresh, and replaces a failed navigation with one small page that
 * explains the failure: the Host is unreachable, or the auth gateway ended the
 * session. API and streaming traffic is never intercepted: only navigations,
 * `/assets/*`, and the known static files are.
 *
 * Bump VERSION whenever the caching rules change; activate() drops every cache
 * of this worker that is not in the current pair and leaves foreign caches
 * alone.
 */

const VERSION = '1'
const SHELL_CACHE = `dsh-web-pwa-shell-v${VERSION}`
const ASSET_CACHE = `dsh-web-pwa-assets-v${VERSION}`
const CACHE_PREFIX = 'dsh-web-pwa-'

/** Hashed build assets kept on demand; bounded so upgrades cannot grow it forever. */
const ASSET_CACHE_LIMIT = 120

/** A navigation that cannot reach the Host within this window shows the retry page. */
const NAVIGATION_TIMEOUT_MS = 10000

/**
 * The browser sign-in page of the auth gateway this deployment runs in front of
 * the Host (`/auth/tg`: password and TOTP form). A deployment without such a
 * page still gets the retry button.
 */
const SIGN_IN_PATH = '/auth/tg'

/** Cheap same-origin files worth having before the first offline navigation. */
const PRECACHE_PATHS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg']

/** Files served stale-while-revalidate; they are small and change with a release. */
const STATIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.svg',
  '/favicon-dark.svg',
])

/** The content type each cached extension must carry, so a proxy page cannot pass for a file. */
const EXPECTED_TYPES = new Map([
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/'],
  ['.woff', 'font/'],
  ['.ttf', 'font/'],
  ['.otf', 'font/'],
])

const OFFLINE_TEXT = {
  en: {
    title: 'The DSH server is unreachable',
    message: 'The shell is cached, but a session needs the DeepSeek Harness Host.',
    hint: 'Check the network or the Tailscale connection, then retry.',
    retry: 'Retry',
    signIn: 'Sign in',
  },
  ru: {
    title: 'Сервер DSH недоступен',
    message: 'Оболочка сохранена, но для сессии нужен хост DeepSeek Harness.',
    hint: 'Проверьте сеть или подключение Tailscale и повторите.',
    retry: 'Повторить',
    signIn: 'Войти',
  },
  zh: {
    title: '无法连接 DSH 服务器',
    message: '外壳已缓存，但会话需要 DeepSeek Harness 主机。',
    hint: '请检查网络或 Tailscale 连接后重试。',
    retry: '重试',
    signIn: '登录',
  },
}

const SIGNED_OUT_TEXT = {
  en: {
    title: 'The session has ended',
    message: 'Sign in again to continue in this window.',
    hint: 'The auth gateway closed the session; saved work stays on the Host.',
    retry: 'Retry',
    signIn: 'Sign in',
  },
  ru: {
    title: 'Сессия завершилась',
    message: 'Войдите снова, чтобы продолжить в этом окне.',
    hint: 'Шлюз авторизации закрыл сессию; сохранённая работа осталась на хосте.',
    retry: 'Повторить',
    signIn: 'Войти',
  },
  zh: {
    title: '会话已结束',
    message: '请重新登录以继续使用此窗口。',
    hint: '认证网关结束了会话；已保存的工作仍在主机上。',
    retry: '重试',
    signIn: '登录',
  },
}

/** A response whose bytes this worker may store. */
function cacheable(request, response) {
  if (response === undefined || !response.ok || response.type !== 'basic'
    || response.headers.has('content-range')) return false
  // A redirect answered with another document is not the file that was asked for.
  if (response.url !== request.url) return false
  const type = (response.headers.get('content-type') || '').toLowerCase()
  // A reverse proxy in front of the Host answers a silent session expiry with
  // its login page; that HTML must never replace an asset in the cache.
  if (type.startsWith('text/html')) return false
  const pathname = new URL(request.url).pathname
  const dot = pathname.lastIndexOf('.')
  const expected = dot === -1 ? undefined : EXPECTED_TYPES.get(pathname.slice(dot).toLowerCase())
  return expected === undefined || type.startsWith(expected)
}

/** Store one already-cleared response; a full cache must never fail the request. */
async function remember(cache, request, response) {
  try {
    await cache.put(request, response.clone())
  } catch {
    // Quota and eviction are the browser's to report; the response still ships.
  }
}

/** Drop the oldest asset entries once the bound is exceeded. */
async function prune(cache) {
  const keys = await cache.keys()
  let excess = keys.length - ASSET_CACHE_LIMIT
  if (excess <= 0) return
  for (const key of keys) {
    if (excess <= 0) break
    await cache.delete(key)
    excess -= 1
  }
}

async function fetchAndRemember(request, cacheName) {
  const response = await fetch(request)
  if (cacheable(request, response)) {
    const cache = await caches.open(cacheName)
    await remember(cache, request, response)
    if (cacheName === ASSET_CACHE) await prune(cache)
  }
  return response
}

/** Fetch one precache entry, keeping it only when it is the file it claims to be. */
async function precache(cache, path) {
  try {
    const request = new Request(new URL(path, self.location.origin))
    const response = await fetch(request)
    if (cacheable(request, response)) await remember(cache, request, response)
  } catch {
    // A side asset is optional; installation proceeds without it.
  }
}

function gatewayFailure() {
  return new Response('', { status: 504, statusText: 'Gateway Timeout' })
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit !== undefined) return hit
  try {
    return await fetchAndRemember(request, cacheName)
  } catch {
    return gatewayFailure()
  }
}

async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  const update = fetchAndRemember(request, cacheName)
  if (hit !== undefined) {
    // The update outlives this response; the page already has its bytes.
    event.waitUntil(update.catch(() => {}))
    return hit
  }
  try {
    return await update
  } catch {
    return gatewayFailure()
  }
}

/**
 * Network first, and never cached: the index carries this browser's boot graph,
 * so a stored copy would go stale the moment a plugin changes. A phone whose
 * Tailscale link is down would otherwise wait on the socket, and an expired
 * gateway session would show its JSON refusal in a standalone window.
 */
async function navigate(event) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS)
  try {
    const response = await fetch(event.request, { signal: controller.signal })
    if (response.status === 401 || response.status === 403) {
      return appPage(SIGNED_OUT_TEXT, { variant: 'signed-out', canSignIn: response.headers.has('www-authenticate') })
    }
    if (response.status >= 500) return appPage(OFFLINE_TEXT, { variant: 'offline' })
    return response
  } catch {
    return appPage(OFFLINE_TEXT, { variant: 'offline' })
  } finally {
    clearTimeout(timer)
  }
}

/** Pick the page language: the worker sees the browser preference too. */
function localized(texts) {
  const language = (self.navigator.language || 'en').slice(0, 2).toLowerCase()
  return { lang: language in texts ? language : 'en', ...(texts[language] ?? texts.en) }
}

const PAGE_STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;
  font:15px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;background:#fff;color:#0f1115}
.card{width:100%;max-width:400px;padding:28px 24px;border:1px solid rgba(127,127,127,.28);border-radius:16px}
.mark{position:relative;width:44px;height:44px;margin:0 auto 14px;border:2px solid currentColor;border-radius:12px;opacity:.9}
.mark::after{content:"";position:absolute;left:50%;top:50%;width:8px;height:8px;border-radius:50%;
  background:currentColor;transform:translate(-50%,-50%);opacity:.55}
h1{margin:0 0 8px;font-size:18px;line-height:1.3}
p{margin:0 0 6px;opacity:.82}
.hint{font-size:13px;opacity:.6;margin-top:12px}
.actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:18px}
button,a.button{display:inline-block;padding:9px 18px;font:inherit;font-weight:500;color:inherit;cursor:pointer;
  text-decoration:none;background:transparent;border:1px solid rgba(127,127,127,.38);border-radius:10px}
button:hover:not(:disabled),a.button:hover{background:rgba(127,127,127,.12)}
button:disabled{opacity:.55}
@media (prefers-color-scheme:dark){body{background:#151517;color:#f9fafb}}`

/** The retry page: the same small document for both failure kinds. */
function appPage(texts, { variant, canSignIn = false }) {
  const text = localized(texts)
  const offline = variant === 'offline'
  // A sign-in page must not reload itself: reloading lands on the same 401.
  const autoRetry = offline ? `
      const probe = async () => {
        if (document.visibilityState !== 'visible') return
        try {
          // Any HTTP answer means the path is reachable again; a thrown fetch
          // means the network is still down.
          await fetch('/sw.js', { method: 'HEAD', cache: 'no-store' })
          location.reload()
        } catch {}
      }
      addEventListener('online', probe)
      setInterval(probe, 5000)` : ''
  const html = `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${text.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true"></div>
    <h1>${text.title}</h1>
    <p>${text.message}</p>
    <p class="hint">${text.hint}</p>
    <div class="actions">
      <button type="button" id="retry">${text.retry}</button>${
        canSignIn ? `\n      <a class="button" href="${SIGN_IN_PATH}">${text.signIn}</a>` : ''}
    </div>
  </main>
  <script>
    (() => {
      const retry = document.querySelector('#retry')
      const label = retry.textContent
      retry.addEventListener('click', () => {
        retry.disabled = true
        retry.textContent = '…'
        location.reload()
      })
      addEventListener('pageshow', () => {
        retry.disabled = false
        retry.textContent = label
      })${autoRetry}
    })()
  </script>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    // A failed side asset must not fail the installation.
    await Promise.all(PRECACHE_PATHS.map(path => precache(cache, path)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE])
    // Only this worker's own generations are stale; another plugin's caches stay.
    const stale = (await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX) && !keep.has(key))
    await Promise.all(stale.map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // A byte range means a reader (font, video) owning partial content; leave it alone.
  if (request.method !== 'GET' || request.headers.has('range')) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(event))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE))
    return
  }
  if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request, SHELL_CACHE))
  }
})
