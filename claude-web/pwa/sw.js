/**
 * Service worker of the Claude Workspace PWA.
 *
 * Served as `/claude/sw.js`; its scope is `/claude/` (the script path implies it,
 * and the server never sends `Service-Worker-Allowed`). The DSH shell keeps its
 * own worker on `/` — this one only ever claims paths under `/claude/`, so a
 * nested-scope deployment cannot break DSH.
 *
 * Caching policy (see docs/claude-pwa-plan.md §5.2):
 *   - navigations: network only, 10 s timeout, HTML is NEVER cached;
 *   - `/claude/assets/*`: cache-first, same-origin only, bounded to 100 entries,
 *     `Response.type === 'basic'`, no redirects, no HTML — a gateway login page
 *     must never replace a build asset;
 *   - `/claude/manifest.webmanifest` and `/claude/icons/*`: stale-while-revalidate;
 *   - API/SSE/heartbeat (`/claude/api/*`): not intercepted at all;
 *   - 401/403 navigation answers with the "session expired" page and a sign-in
 *     button; 5xx or a network failure answers with the "server unreachable"
 *     page and a retry button.
 *
 * Updates: install() deliberately does NOT call skipWaiting(). A new worker
 * waits until the page shows the update banner and posts `SKIP_WAITING`, then
 * the page reloads exactly once on `controllerchange`.
 *
 * Bump VERSION whenever caching rules change: activate() deletes every
 * `claude-pwa-*` cache of another generation and leaves foreign caches alone.
 */

const VERSION = '2026-11-22.1';

/** Application base; must match `web/vite.config.ts` `base` and the manifest scope. */
const BASE = '/claude/';
const CACHE_PREFIX = 'claude-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

/** Build assets are the only thing worth keeping warm. */
const ASSETS_PREFIX = `${BASE}assets/`;
const ASSET_CACHE_LIMIT = 100;

/** Longest a navigation may wait for the server before the retry page. */
const NAVIGATION_TIMEOUT_MS = 10000;

const MANIFEST_PATH = `${BASE}manifest.webmanifest`;
const ICONS_PREFIX = `${BASE}icons/`;
const API_PREFIX = `${BASE}api/`;

/** Gateway sign-in page (password + TOTP / Telegram). */
const SIGN_IN_PATH = '/auth/tg';
const HOME_PATH = BASE;

/** Failure pages reload themselves so a recovered/again-authenticated tab heals without a tap. */
const FAILURE_PAGE_REFRESH_SECONDS = 15;

/** Small install metadata worth fetching during install; failures are tolerated. */
const PRECACHE_PATHS = [
  MANIFEST_PATH,
  `${ICONS_PREFIX}icon-192.png`,
  `${ICONS_PREFIX}icon-512.png`,
  `${ICONS_PREFIX}icon-maskable-512.png`,
  `${ICONS_PREFIX}apple-touch-icon-180.png`,
];

/**
 * Whether the bytes of `response` may be stored under `request`.
 * A reverse proxy answering an expired session with an HTML login page is the
 * case this rejects: the cached asset would otherwise become a JSON/HTML page.
 */
function isCacheable(request, response) {
  if (!response || !response.ok) return false;
  if (response.type !== 'basic') return false; // opaque/error responses carry no headers we trust
  if (response.redirected) return false; // a redirect answered with another document
  if (response.url !== request.url) return false; // final URL differs: not the requested file
  if (response.headers.has('content-range')) return false; // partial content
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.startsWith('text/html')) return false; // never cache documents
  return true;
}

async function remember(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch {
    // Quota/eviction errors are the browser's to report; the response still ships.
  }
}

/** Drop the oldest asset entries once the bound is exceeded. */
async function trimAssets(cache) {
  let keys;
  try {
    keys = await cache.keys();
  } catch {
    return;
  }
  const assetKeys = keys.filter((key) => new URL(key.url).pathname.startsWith(ASSETS_PREFIX));
  let excess = assetKeys.length - ASSET_CACHE_LIMIT;
  if (excess <= 0) return;
  for (const key of assetKeys) {
    if (excess <= 0) break;
    await cache.delete(key);
    excess -= 1;
  }
}

async function fetchAndStore(request) {
  const response = await fetch(request);
  if (isCacheable(request, response)) {
    const cache = await caches.open(CACHE_NAME);
    await remember(cache, request, response);
    await trimAssets(cache);
  }
  return response;
}

/** Cache-first for hashed build assets. */
async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit !== undefined) return hit;
  try {
    return await fetchAndStore(request);
  } catch {
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

/** Stale-while-revalidate for the manifest and the install icons. */
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  const update = fetchAndStore(request).catch(() => undefined);
  if (hit !== undefined) {
    event.waitUntil(update);
    return hit;
  }
  const fresh = await update;
  return fresh ?? new Response('', { status: 504, statusText: 'Gateway Timeout' });
}

/** Precache one optional file; a failure must not fail the installation. */
async function precache(path) {
  try {
    const request = new Request(new URL(path, self.location.origin), { credentials: 'same-origin' });
    const response = await fetch(request);
    if (isCacheable(request, response)) {
      const cache = await caches.open(CACHE_NAME);
      await remember(cache, request, response);
    }
  } catch {
    // Install metadata is optional; the worker still installs and updates it later.
  }
}

const PAGE_STYLE = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  font:15px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  background:#1a1917;color:#f1e9df;text-align:center}
.card{width:100%;max-width:400px;padding:28px 24px;border:1px solid rgba(224,164,88,.28);
  border-radius:16px;background:rgba(255,255,255,.02)}
.mark{position:relative;width:44px;height:44px;margin:0 auto 16px;border:2px solid #e0a458;
  border-radius:50%;opacity:.85}
.mark::after{content:"";position:absolute;left:50%;top:50%;width:8px;height:8px;border-radius:2px;
  background:#e0a458;transform:translate(-50%,-50%)}
h1{margin:0 0 8px;font-size:18px;line-height:1.3;font-weight:600}
p{margin:0 0 6px;opacity:.82}
.hint{font-size:13px;opacity:.55;margin-top:12px}
.actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:20px}
.button{display:inline-block;padding:10px 18px;font:inherit;font-weight:500;color:#1a1917;
  text-decoration:none;background:#e0a458;border-radius:10px}
.button.secondary{color:#f1e9df;background:transparent;border:1px solid rgba(241,233,223,.28)}
.button:focus-visible{outline:2px solid #f1e9df;outline-offset:2px}`;

const EXPIRED_PAGE = {
  title: 'Сессия завершилась',
  message: 'Шлюз авторизации закрыл сессию. Войдите снова, чтобы продолжить.',
  hint: 'После входа откройте это приложение — страница обновится сама.',
  signIn: 'Войти',
  retry: 'Повторить',
};

const OFFLINE_PAGE = {
  title: 'Сервер недоступен',
  message: 'Не удалось связаться с сервером Claude.',
  hint: 'Проверьте сеть или подключение Tailscale и повторите попытку.',
  signIn: null,
  retry: 'Повторить',
};

/** One small, dependency-free document for both failure kinds. */
function failurePage(texts) {
  const refresh = `\n<meta http-equiv="refresh" content="${FAILURE_PAGE_REFRESH_SECONDS}">`;
  const signIn = texts.signIn
    ? `\n      <a class="button" href="${SIGN_IN_PATH}">${texts.signIn}</a>`
    : '';
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">${refresh}
<title>${texts.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true"></div>
    <h1>${texts.title}</h1>
    <p>${texts.message}</p>
    <p class="hint">${texts.hint}</p>
    <div class="actions">
      <a class="button secondary" href="${HOME_PATH}">${texts.retry}</a>${signIn}
    </div>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Navigations are network-only: the SPA shell is live and must never be served
 * from a cache. An expired gateway session (401/403) and an unreachable/5xx
 * upstream get a human-readable page instead of a bare JSON refusal.
 */
async function navigate(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.status === 401 || response.status === 403) return failurePage(EXPIRED_PAGE);
    if (response.status >= 500) return failurePage(OFFLINE_PAGE);
    return response;
  } catch {
    // Aborted timeout or a network failure: the server is unreachable.
    return failurePage(OFFLINE_PAGE);
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  // No skipWaiting() here: a new worker waits for the page's update banner.
  event.waitUntil((async () => {
    await Promise.all(PRECACHE_PATHS.map((path) => precache(path)));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = (await caches.keys()).filter(
      (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME,
    );
    await Promise.all(stale.map((key) => caches.delete(key)));
    // Claim only this worker's own scope; foreign workers keep their clients.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    // Requested by the page after the user accepted the update banner.
    void self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Non-GET (POST approvals/messages/heartbeat) and range reads pass through untouched.
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only

  const path = url.pathname;

  // Never intercept API, SSE or heartbeat: the live stream belongs to the page.
  if (path.startsWith(API_PREFIX)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (path.startsWith(ASSETS_PREFIX)) {
    event.respondWith(cacheFirstAsset(request));
    return;
  }
  if (path === MANIFEST_PATH || path.startsWith(ICONS_PREFIX)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
