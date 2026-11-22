// Статические проверки edge-claude/Caddyfile — второй публичный origin Claude
// (:8443 -> 127.0.0.1:8444). node:test, без caddy/сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = fileURLToPath(new URL('../../edge-claude/', import.meta.url));
const CADDYFILE = readFileSync(`${EDGE}Caddyfile`, 'utf8');

const PUBLIC_ORIGIN_8443 = 'https://vps-4692.tailfbc4b2.ts.net:8443';
const PUBLIC_ORIGIN_10000 = 'https://vps-4692.tailfbc4b2.ts.net:10000';
const FULL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const INSTALL_PATHS = [
  '/claude/manifest.webmanifest',
  '/claude/icons/icon-192.png',
  '/claude/icons/icon-512.png',
  '/claude/icons/icon-maskable-512.png',
  '/claude/icons/apple-touch-icon-180.png',
];

function indexOfOrFail(needle) {
  const index = CADDYFILE.indexOf(needle);
  assert.ok(index >= 0, `в Caddyfile нет «${needle}»`);
  return index;
}

// Считает строки-директивы (trim === needle), чтобы комментарии с тем же
// текстом не ломали подсчёт.
function countDirective(text, needle) {
  return text.split('\n').filter((line) => line.trim() === needle).length;
}

test('Caddyfile: один сайт http://:8444, bind 127.0.0.1, admin off', () => {
  assert.match(CADDYFILE, /^http:\/\/:8444 \{$/m, 'site-адрес http://:8444');
  assert.match(CADDYFILE, /^\tbind 127\.0\.0\.1$/m, 'bind только loopback');
  assert.match(CADDYFILE, /^\tadmin off$/m, 'admin off (нет конфликта admin-порта 2019)');
  // Порт 8444 — локальный; публичный 8443 терминирует Tailscale Funnel.
  assert.doesNotMatch(CADDYFILE, /^https?:\/\/:8443 \{/m, 'site не слушает :8443 напрямую');
  assert.doesNotMatch(CADDYFILE, /^\tbind 0\.0\.0\.0$/m, 'не bind на все интерфейсы');
});

test('Caddyfile: базовые security-заголовки; HSTS без includeSubDomains', () => {
  const headerBlock = CADDYFILE.slice(
    indexOfOrFail('header {'),
    indexOfOrFail('header /claude/*'),
  );
  assert.match(headerBlock, /Strict-Transport-Security "max-age=31536000"/);
  assert.match(headerBlock, /X-Content-Type-Options "nosniff"/);
  assert.match(headerBlock, /Referrer-Policy "no-referrer"/);
  assert.match(headerBlock, /-Server/);
  // X-Frame-Options/Permissions-Policy не глобально (могут ломать /tg в
  // Telegram Web), а в scoped-блоке /claude/*.
  assert.ok(!headerBlock.includes('X-Frame-Options'), 'XFO не в глобальном header');
  const scoped = CADDYFILE.slice(indexOfOrFail('header /claude/*'), indexOfOrFail('route {'));
  assert.match(scoped, /X-Frame-Options "DENY"/);
  assert.match(scoped, /Permissions-Policy "[^"]*camera=\(\)/);
  // includeSubDomains упоминается только в комментарии; сама директива HSTS
  // ровно такая и без includeSubDomains.
  const hstsLine = headerBlock.split('\n').find((line) => line.includes('Strict-Transport-Security'));
  assert.ok(hstsLine, 'есть директива HSTS');
  assert.equal(hstsLine.trim(), 'Strict-Transport-Security "max-age=31536000"');
});

test('Caddyfile: CSP /claude/* — полный, default-src self, после глобального header', () => {
  const globalHeaderIdx = indexOfOrFail('header {');
  const cspIdx = indexOfOrFail('header /claude/*');
  assert.ok(globalHeaderIdx < cspIdx, 'CSP-блок после глобального header');
  assert.ok(CADDYFILE.includes(FULL_CSP), 'CSP дословно как в deploy/Caddyfile.fragment');
  assert.match(CADDYFILE, /Content-Security-Policy "default-src 'self'/);
  // CSP-директива ровно одна и лежит внутри header /claude/*.
  assert.equal(
    countDirective(CADDYFILE, `Content-Security-Policy "${FULL_CSP}"`),
    1,
    'CSP-директива ровно одна',
  );
  const cspOnlyBlock = CADDYFILE.slice(cspIdx, indexOfOrFail('route {'));
  assert.match(cspOnlyBlock, /Content-Security-Policy "default-src 'self'/);
  // в глобальном header-блоке CSP нет
  const globalBlock = CADDYFILE.slice(globalHeaderIdx, cspIdx);
  assert.ok(!globalBlock.split('\n').some((line) => line.trim().startsWith('Content-Security-Policy')),
    'CSP не в глобальном header');
});

test('Caddyfile: Spring Origin-guard — оба origin, только для непустого Origin, до assets/forward_auth', () => {
  const guardIdx = indexOfOrFail('@claude_bad_origin');
  const respondIdx = indexOfOrFail('respond @claude_bad_origin "forbidden" 403');
  const installIdx = indexOfOrFail('handle @claude_install');
  const claudeIdx = indexOfOrFail('handle /claude {');
  const privateIdx = indexOfOrFail('handle /claude/* {');
  const forwardIdx = indexOfOrFail('forward_auth 127.0.0.1:9090 {');

  assert.ok(guardIdx < respondIdx, 'matcher до respond');
  assert.ok(respondIdx < installIdx, '403-guard ДО install-ветки');
  assert.ok(installIdx < claudeIdx, 'install до /claude');
  assert.ok(claudeIdx < privateIdx, '/claude до /claude/*');
  assert.ok(respondIdx < forwardIdx, '403-guard ДО forward_auth');

  const guard = CADDYFILE.slice(guardIdx, respondIdx);
  assert.match(guard, /expression `\{http\.request\.header\.Origin\} != ''/);
  assert.ok(guard.includes(`!= '${PUBLIC_ORIGIN_8443}'`), 'разрешён origin :8443');
  assert.ok(guard.includes(`!= '${PUBLIC_ORIGIN_10000}'`), 'разрешён origin :10000');
  // Guard применяется к /claude/* и к входу гейтвея.
  assert.match(guard, /path \/claude\/\* \/tg \/tg\/\* \/auth\/\*/);
  // Пустой Origin (curl/навигация) не блокируется.
  assert.match(guard, /\{http\.request\.header\.Origin\} != ''/);
});

test('Caddyfile: публичные install-ассеты — ровно 5 путей, GET/HEAD, 405, типы и кэш', () => {
  const matcher = CADDYFILE.slice(
    indexOfOrFail('@claude_install path'),
    indexOfOrFail('handle @claude_install {'),
  );
  const installStart = indexOfOrFail('handle @claude_install {');
  const installEnd = indexOfOrFail('handle /claude {');
  const block = CADDYFILE.slice(installStart, installEnd);

  // Пути берём из матчера @claude_install (в блоке есть ещё /claude/icons/*
  // для Content-Type-правила — это не публичный путь матчера).
  const paths = matcher.match(/\/claude\/[A-Za-z0-9._/-]+/g) ?? [];
  assert.deepEqual([...new Set(paths)].sort(), [...INSTALL_PATHS].sort(), 'ровно 5 install-путей');
  assert.ok(!block.includes('sw.js'), 'sw.js не публичный');

  assert.match(block, /@not_get not method GET HEAD/);
  assert.match(block, /respond @not_get "method not allowed" 405/);
  assert.match(block, /@claude_manifest path \/claude\/manifest\.webmanifest/);
  assert.match(block, /header @claude_manifest >Cache-Control "no-cache"/);
  assert.match(block, /header @claude_manifest >Content-Type "application\/manifest\+json"/);
  assert.match(block, /header @claude_icons >Cache-Control "public, max-age=86400"/);
  assert.match(block, /header @claude_icons >Content-Type "image\/png"/);
  assert.match(block, /root \* \/srv\/claude-web\/public/);
  assert.match(block, /file_server/);

  // 405 и content-type/cache — в правильном порядке (route фиксирует порядок).
  const order = [
    'respond @not_get "method not allowed" 405',
    'header @claude_manifest >Cache-Control "no-cache"',
    'header @claude_manifest >Content-Type "application/manifest+json"',
    'header @claude_icons >Cache-Control "public, max-age=86400"',
    'header @claude_icons >Content-Type "image/png"',
    'root * /srv/claude-web/public',
    'file_server',
  ];
  const lines = block.split('\n').map((line) => line.trim());
  let previous = -1;
  for (const needle of order) {
    const idx = lines.indexOf(needle);
    assert.ok(idx >= 0, `install-блок содержит «${needle}»`);
    assert.ok(idx > previous, `install-блок: «${needle}» в правильном порядке`);
    previous = idx;
  }
});

test('Caddyfile: /claude -> /claude/ 308 до приватной части', () => {
  const redirectIdx = indexOfOrFail('handle /claude {');
  const redirIdx = indexOfOrFail('redir * /claude/ 308');
  const privateIdx = indexOfOrFail('handle /claude/* {');
  assert.ok(redirectIdx < redirIdx && redirIdx < privateIdx, '/claude 308 до /claude/*');
});

test('Caddyfile: forward_auth /verify с copy_headers X-Auth-User', () => {
  const forwardIdx = indexOfOrFail('forward_auth 127.0.0.1:9090 {');
  const block = CADDYFILE.slice(forwardIdx, indexOfOrFail('@claude_assets path'));
  assert.match(block, /uri \/verify/);
  assert.match(block, /copy_headers X-Auth-User/);
});

test('Caddyfile: приватный proxy — flush_interval -1, -Cookie, X-Claude-Edge, чистка trust-заголовков', () => {
  const privateStart = indexOfOrFail('handle /claude/* {');
  const block = CADDYFILE.slice(privateStart, indexOfOrFail('handle /tg {'));
  // ровно две proxy-ветки: assets и остальное
  assert.equal(block.split('reverse_proxy 127.0.0.1:3090 {').length - 1, 2, 'две proxy-ветки');
  assert.equal(countDirective(block, 'flush_interval -1'), 2, 'flush_interval -1 в обеих');
  assert.equal(countDirective(block, 'header_up X-Forwarded-Proto https'), 2);
  assert.equal(countDirective(block, 'header_up -Cookie'), 2, 'cookie гейтвея не уходит в app');
  assert.equal(countDirective(block, 'header_up X-Claude-Edge __EDGE_SECRET__'), 2);
  assert.equal(countDirective(block, 'header_up -Authorization'), 2);
  assert.equal(countDirective(block, 'header_up -X-Forwarded-User'), 2);
  assert.equal(countDirective(block, 'header_up -X-Real-IP'), 2);
  // плейсхолдер, а не реальный секрет
  assert.doesNotMatch(block, /\b[0-9a-fA-F]{64}\b/);
  // клиентские trust-заголовки вырезаются на входе
  assert.match(CADDYFILE, /request_header -X-Auth-User/);
  assert.match(CADDYFILE, /request_header -X-Claude-Edge/);
  assert.match(CADDYFILE, /request_header -X-Forwarded-For/);
});

test('Caddyfile: assets immutable — только на 2xx (handle_response), 401 без immutable', () => {
  const start = indexOfOrFail('@claude_assets path /claude/assets/*');
  const end = indexOfOrFail('handle /tg {');
  const block = CADDYFILE.slice(start, end);
  assert.ok(block.includes('@claude_asset_ok status 2xx'), 'assets: matcher status 2xx');
  assert.ok(block.includes('handle_response @claude_asset_ok {'), 'assets: handle_response');
  assert.ok(block.includes('>Cache-Control "public, max-age=86400, immutable"'));
  assert.ok(block.includes('copy_response'));
  // immutable ровно одно и только внутри handle_response
  assert.equal(CADDYFILE.split('public, max-age=86400, immutable').length - 1, 1);
  const gatedIdx = block.indexOf('handle_response @claude_asset_ok {');
  const immutableIdx = block.indexOf('>Cache-Control "public, max-age=86400, immutable"');
  assert.ok(gatedIdx < immutableIdx, 'immutable внутри 2xx-гейта');
  // нет deferred-правила на уровне route (регрессия SEC-11)
  assert.doesNotMatch(CADDYFILE, /^\t\theader @claude_assets /m);
});

test('Caddyfile: вход и health гейтвея (/tg, /tg/*, /auth/*, /healthz) -> 9090', () => {
  for (const matcher of ['handle /tg {', 'handle /tg/* {', 'handle /auth/* {', 'handle /healthz {']) {
    const idx = indexOfOrFail(matcher);
    const block = CADDYFILE.slice(idx, CADDYFILE.indexOf('}', idx) + 1);
    const proxy = CADDYFILE.slice(idx, idx + 600);
    assert.ok(proxy.includes('reverse_proxy 127.0.0.1:9090'), `${matcher}: proxy на 9090`);
    assert.ok(block.includes('header_up X-Forwarded-Proto https'), `${matcher}: X-Forwarded-Proto https`);
  }
  // cookie гейтвея для входа НЕ вырезается (иначе вход на :8443 не работает)
  const tgStart = indexOfOrFail('handle /tg {');
  const tgBlock = CADDYFILE.slice(tgStart, indexOfOrFail('handle /healthz {'));
  assert.ok(!tgBlock.includes('header_up -Cookie'), 'для входа cookie проходит как есть');
});

test('Caddyfile: catch-all — 302 на DSH :10000, последний маршрут, без {uri}', () => {
  const catchIdx = indexOfOrFail('redir * https://vps-4692.tailfbc4b2.ts.net:10000/ 302');
  const authIdx = indexOfOrFail('handle /auth/* {');
  assert.ok(catchIdx > authIdx, 'catch-all после маршрутов Claude/входа');
  assert.match(CADDYFILE, /handle \{\n\t\t\tredir \* https:\/\/vps-4692\.tailfbc4b2\.ts\.net:10000\/ 302/);
  assert.ok(!CADDYFILE.includes('{uri}'), 'catch-all не тащит path/query на другой origin');
});

test('Caddyfile: access-log JSON с фильтрами cookie/query/секрета', () => {
  const logIdx = indexOfOrFail('log {');
  const logBlock = CADDYFILE.slice(logIdx, indexOfOrFail('header {', logIdx));
  assert.match(logBlock, /output file \/var\/log\/claude-edge\/access\.log/);
  assert.match(logBlock, /format filter \{/);
  assert.match(logBlock, /request>headers>Cookie delete/);
  assert.match(logBlock, /request>headers>Authorization delete/);
  assert.match(logBlock, /request>headers>X-Claude-Edge delete/);
  assert.match(logBlock, /resp_headers>Set-Cookie delete/);
  assert.match(logBlock, /request>uri regexp "\[\?\]\.\*\$" ""/);
  assert.match(logBlock, /wrap json/);
  // ротация, чтобы диск не забился
  assert.match(logBlock, /roll_size 10MiB/);
  assert.match(logBlock, /roll_keep 5/);
});

test('Caddyfile: нет секретов, Service-Worker-Allowed и опасных ослаблений', () => {
  assert.equal(
    CADDYFILE.split('__EDGE_SECRET__').length - 1,
    3,
    'плейсхолдер: 2 в proxy-ветках + 1 упоминание в шапке',
  );
  assert.doesNotMatch(CADDYFILE, /\b[0-9a-fA-F]{64}\b/, 'нет реального 64-hex секрета');
  assert.doesNotMatch(CADDYFILE, /sk-ant-[A-Za-z0-9._-]{20,}/, 'нет OAuth-токена');
  assert.doesNotMatch(CADDYFILE, /BEGIN [A-Z ]*PRIVATE KEY/, 'нет приватного ключа');
  assert.doesNotMatch(CADDYFILE, /Service-Worker-Allowed/, 'scope SW не расширяется');
  assert.doesNotMatch(CADDYFILE, /tls internal|auto_https|acme/i, 'нет TLS/ACME на loopback');
  // catch-all не проксирует произвольное на app/DSH
  assert.doesNotMatch(CADDYFILE, /redir \* https:\/\/vps-4692\.tailfbc4b2\.ts\.net:10000\/claude/);
});

test('Caddyfile: каркас route { } фиксирует порядок', () => {
  assert.match(CADDYFILE, /^\troute \{$/m, 'site-level route { }');
  const routeIdx = indexOfOrFail('route {');
  const guardIdx = indexOfOrFail('@claude_bad_origin');
  assert.ok(routeIdx < guardIdx, 'route начинается до guard');
  // внутри route — документированный порядок секций 0..6
  const marks = [
    'request_header -X-Auth-User',
    'respond @claude_bad_origin "forbidden" 403',
    'handle @claude_install {',
    'handle /claude {',
    'handle /claude/* {',
    'handle /tg {',
    'handle /auth/* {',
  ];
  let previous = -1;
  for (const mark of marks) {
    const idx = CADDYFILE.indexOf(mark);
    assert.ok(idx >= 0, `есть маркер «${mark}»`);
    assert.ok(idx > previous, `порядок маршрутов: «${mark}»`);
    previous = idx;
  }
  // catch-all handle { } — последний (учитываем вложенный handle { } в assets)
  const catchAll = CADDYFILE.lastIndexOf('handle {');
  assert.ok(catchAll > CADDYFILE.indexOf('handle /healthz {'), 'catch-all после входа/healthz');
  assert.ok(catchAll > CADDYFILE.indexOf('handle /claude/* {'), 'catch-all после /claude/*');
});
