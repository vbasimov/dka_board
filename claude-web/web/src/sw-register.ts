/**
 * Service-worker registration for the `/claude/` PWA (CONTRACT.md §7).
 *
 * Two things matter here:
 *
 * 1. Updates are user-driven. The worker never calls `skipWaiting()` on install;
 *    when a new version is waiting the app shows "Доступно обновление" and, on
 *    click, posts `SKIP_WAITING`, then reloads exactly once on `controllerchange`.
 *
 * 2. Nested scope safety. The DSH shell owns a worker on `/` with a root scope.
 *    We never unregister or touch it. If that foreign worker currently controls
 *    this page (`navigator.serviceWorker.controller.scriptURL` is not
 *    `/claude/sw.js`), we only (re-)register our own `/claude/sw.js` with the
 *    `/claude/` scope and perform one guarded reload — so the more specific
 *    worker takes over without breaking DSH.
 */
import { BASE_URL } from './api';

const SW_PATH = `${BASE_URL}sw.js`;
const SW_SCOPE = BASE_URL;
const RELOAD_STAMP_KEY = 'claude-sw-reloaded-at';
const RELOAD_MIN_INTERVAL_MS = 5000;

let registration: ServiceWorkerRegistration | null = null;
let updateRequested = false;
let initialized = false;

function isOurWorker(scriptURL: string | null | undefined): boolean {
  if (!scriptURL) return false;
  try {
    return new URL(scriptURL, window.location.href).pathname === SW_PATH;
  } catch {
    return false;
  }
}

/**
 * One reload per 5 s window: a catch-all guard against a reload loop.
 * `force` is for an explicit user action (the «Обновить» button): the tap must
 * never be a no-op, so the guard does not apply, but the stamp is still written
 * to keep the automatic paths loop-safe.
 */
function reloadOnce(force = false): void {
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_STAMP_KEY) ?? 0) || 0;
  } catch {
    // sessionStorage may be unavailable (privacy mode); still allow one reload.
  }
  if (!force && Date.now() - last < RELOAD_MIN_INTERVAL_MS) return;
  try {
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(Date.now()));
  } catch {
    // ignore
  }
  window.location.reload();
}

/** True when a waiting worker could be activated right now. */
export function canApplyServiceWorkerUpdate(): boolean {
  return Boolean(registration?.waiting);
}

/**
 * Ask the waiting worker to take over; `controllerchange` then performs the
 * single reload. Returns false when no update is waiting.
 */
export function applyServiceWorkerUpdate(): boolean {
  const waiting = registration?.waiting;
  if (!waiting) {
    // Nothing is waiting: the banner was not about a real pending update (the
    // takeover by our worker during the first load under a foreign root worker,
    // DSH, looks the same). The user asked to update — honour the tap with one
    // forced reload instead of silently hiding the banner.
    reloadOnce(true);
    return true;
  }
  updateRequested = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
  // The worker may not answer SKIP_WAITING (queued event, closed channel): a
  // reload still activates the waiting worker once the old clients are gone.
  window.setTimeout(() => {
    if (registration?.waiting) reloadOnce(true);
  }, 4000);
  return true;
}

export interface ServiceWorkerOptions {
  onUpdateAvailable?: () => void;
}

export function initServiceWorker(options: ServiceWorkerOptions = {}): void {
  if (initialized) return;
  if (!('serviceWorker' in navigator)) return;
  initialized = true;

  const container = navigator.serviceWorker;
  let startedForeign = false;
  const initialController = container.controller;
  if (initialController) startedForeign = !isOurWorker(initialController.scriptURL);

  container.addEventListener('controllerchange', () => {
    const controller = container.controller;
    if (!controller) return;
    if (updateRequested) {
      reloadOnce(true);
      return;
    }
    // A foreign root worker was replaced by ours inside /claude/: one reload so
    // every subsequent navigation is served by the right worker.
    if (startedForeign && isOurWorker(controller.scriptURL)) reloadOnce();
  });

  container
    .register(SW_PATH, { scope: SW_SCOPE, updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      if (reg.waiting) options.onUpdateAvailable?.();

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `reg.waiting` (not just an installed worker) is the real signal: a
          // brand-new registration for a first visit activates immediately and
          // never waits, so showing the banner there produced a dead button.
          if (installing.state === 'installed' && reg.waiting) {
            options.onUpdateAvailable?.();
          }
        });
      });

      if (startedForeign) {
        // Give the newly registered worker a moment to activate and claim.
        window.setTimeout(() => {
          const controller = container.controller;
          if (controller && !isOurWorker(controller.scriptURL)) reloadOnce();
        }, 4000);
      }

      const checkForUpdate = (): void => {
        void reg.update().catch(() => {
          // Offline or a transient error: the next visibility check retries.
        });
      };
      window.setInterval(checkForUpdate, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    })
    .catch(() => {
      // Service workers unavailable (private mode, insecure context): the app
      // still works as a plain web page.
    });
}
