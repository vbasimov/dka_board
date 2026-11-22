import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripComments } from './support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const swPath = join(claudeWeb, 'pwa', 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const swCode = stripComments(sw);

/** Body of one self.addEventListener('…', …) handler, from its opening to the next handler. */
function handlerBody(eventName) {
  const start = sw.indexOf(`self.addEventListener('${eventName}'`);
  assert.notEqual(start, -1, `в sw.js нет обработчика ${eventName}`);
  const nextEvent = sw.indexOf('self.addEventListener(', start + 10);
  return sw.slice(start, nextEvent === -1 ? sw.length : nextEvent);
}

test('sw: valid JavaScript and served as /claude/sw.js', () => {
  execFileSync(process.execPath, ['--check', swPath], { stdio: 'pipe' });
  assert.match(sw, /const BASE = '\/claude\/';/);
});

test('sw: version, cache prefix and old-cache cleanup', () => {
  const version = /const VERSION = '([^']+)';/.exec(sw);
  assert.ok(version, 'нет константы VERSION');
  assert.ok(version[1].length > 0, 'VERSION пустой');
  assert.match(sw, /const CACHE_PREFIX = 'claude-pwa-';/);
  assert.match(sw, /const CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{VERSION\}`;/);
  assert.match(sw, /caches\.keys\(\)/, 'нет перечисления кэшей для чистки');
  assert.match(sw, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_NAME/, 'нет фильтра старых кэшей текущего воркера');
  assert.match(sw, /caches\.delete\(key\)/, 'старые кэши не удаляются');
});

test('sw: install does NOT skipWaiting; SKIP_WAITING is message-driven only', () => {
  const installBody = handlerBody('install');
  assert.doesNotMatch(installBody, /self\.skipWaiting\(/, 'install не должен вызывать skipWaiting');
  const messageBody = handlerBody('message');
  assert.match(messageBody, /data\.type === 'SKIP_WAITING'/);
  assert.match(messageBody, /self\.skipWaiting\(\)/);
  const skipWaitingCalls = sw.match(/self\.skipWaiting\(\)/g) ?? [];
  assert.equal(skipWaitingCalls.length, 1, 'self.skipWaiting() должен вызываться ровно один раз — по сообщению');
});

test('sw: never asks for the root scope via Service-Worker-Allowed', () => {
  assert.doesNotMatch(swCode, /Service-Worker-Allowed/i, 'заголовок Service-Worker-Allowed запрещён');
});

test('sw: assets are cache-first, bounded, same-origin, basic, no redirects, no HTML', () => {
  assert.match(sw, /const ASSETS_PREFIX = `\$\{BASE\}assets\/`;/);
  assert.match(sw, /const ASSET_CACHE_LIMIT = 100;/);
  assert.match(sw, /new URL\(key\.url\)\.pathname\.startsWith\(ASSETS_PREFIX\)/, 'лимит должен считать только assets');
  assert.match(sw, /response\.type !== 'basic'/, 'нужна проверка Response.type === basic');
  assert.match(sw, /response\.redirected/, 'нужна проверка редиректа');
  assert.match(sw, /contentType\.startsWith\('text\/html'\)/, 'HTML не должен попадать в кэш');
  assert.match(sw, /cacheFirstAsset/, 'нет cache-first для assets');
});

test('sw: manifest and icons are stale-while-revalidate', () => {
  assert.match(sw, /staleWhileRevalidate/);
  assert.match(sw, /const MANIFEST_PATH = `\$\{BASE\}manifest\.webmanifest`;/);
  assert.match(sw, /const ICONS_PREFIX = `\$\{BASE\}icons\/`;/);
  assert.match(sw, /path === MANIFEST_PATH \|\| path\.startsWith\(ICONS_PREFIX\)/);
});

test('sw: navigation is network-only with a 10 s timeout, HTML never cached', () => {
  assert.match(sw, /const NAVIGATION_TIMEOUT_MS = 10000;/);
  assert.match(sw, /request\.mode === 'navigate'/);
  const navigateBody = sw.slice(sw.indexOf('async function navigate'), sw.indexOf("self.addEventListener('install'"));
  assert.match(navigateBody, /await fetch\(request, \{ signal: controller\.signal \}\)/);
  assert.doesNotMatch(navigateBody, /cache\.(put|match|add)/, 'навигация не должна читать/писать кэш');
  assert.equal((navigateBody.match(/cache/gi) ?? []).length, 0, 'в навигации не должно быть кэширования');
});

test('sw: 401/403 → expired page with sign-in, 5xx/network → retry page', () => {
  assert.match(sw, /response\.status === 401 \|\| response\.status === 403\) return failurePage\(EXPIRED_PAGE\)/);
  assert.match(sw, /response\.status >= 500\) return failurePage\(OFFLINE_PAGE\)/);
  assert.match(sw, /\/\/ Aborted timeout or a network failure:[\s\S]{0,200}?return failurePage\(OFFLINE_PAGE\)/);
  assert.match(sw, /title: 'Сессия завершилась'/);
  assert.match(sw, /title: 'Сервер недоступен'/);
  assert.match(sw, /const SIGN_IN_PATH = '\/auth\/tg';/);
});

test('sw: API, SSE and heartbeat are never intercepted', () => {
  assert.match(sw, /const API_PREFIX = `\$\{BASE\}api\/`;/);
  assert.match(sw, /if \(path\.startsWith\(API_PREFIX\)\) return;/);
  const fetchBody = handlerBody('fetch');
  const apiGuard = fetchBody.indexOf('API_PREFIX');
  assert.ok(apiGuard !== -1, 'нет раннего выхода для API');
  assert.match(fetchBody, /request\.method !== 'GET'\) return;/, 'POST/approvals не перехватываются');
});

test('sw: only same-origin GETs are handled; foreign workers keep their clients', () => {
  assert.match(sw, /if \(url\.origin !== self\.location\.origin\) return;/);
  assert.match(sw, /request\.headers\.has\('range'\)\) return;/);
  assert.match(sw, /self\.clients\.claim\(\)/, 'activate должен забирать только свои клиенты');
  assert.doesNotMatch(sw, /unregister\(/, 'sw.js не должен снимать чужие регистрации');
});
