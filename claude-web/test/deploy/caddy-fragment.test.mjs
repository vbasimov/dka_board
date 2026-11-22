// Unit-lint для deploy/Caddyfile.fragment (runbook §5, plan §11).
// Проверяем состав, порядок и отсутствие секретов/опасных ослаблений.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../../deploy/', import.meta.url));
const FRAGMENT = readFileSync(`${DEPLOY}Caddyfile.fragment`, 'utf8');
const PUBLIC_ORIGIN = 'https://vps-4692.tailfbc4b2.ts.net:10000';
const FULL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

function extractSection(key) {
  const begin = `# >>> claude-web:fragment:${key}:begin >>>`;
  const end = `# <<< claude-web:fragment:${key}:end <<<`;
  const from = FRAGMENT.indexOf(begin);
  const to = FRAGMENT.indexOf(end);
  assert.ok(from >= 0, `нет маркера начала секции ${key}`);
  assert.ok(to > from, `нет маркера конца секции ${key}`);
  assert.equal(FRAGMENT.split(begin).length - 1, 1, `маркер начала ${key} должен быть один`);
  assert.equal(FRAGMENT.split(end).length - 1, 1, `маркер конца ${key} должен быть один`);
  return FRAGMENT.slice(from + begin.length, to);
}

const sectionA = extractSection('A');
const sectionB = extractSection('B');

function indexOfOrFail(haystack, needle, what = needle) {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `в фрагменте нет «${what}»`);
  return index;
}

test('фрагмент: секции A (CSP) и B (маршрут), без route и без секретов', () => {
  assert.ok(sectionA.includes('header /claude/*'), 'A содержит header /claude/*');
  assert.ok(sectionA.includes(FULL_CSP), 'A содержит CSP из runbook §5 дословно');
  // A не содержит маршрутов — вставка в начале route, до глобального header.
  assert.ok(!/^\s*handle\b/m.test(sectionA), 'A не должна содержать handle-директиву');
  assert.ok(!sectionB.includes('Content-Security-Policy'), 'B не должна содержать CSP');
  // Фрагмент вставляется внутрь существующего route, а не создаёт свой.
  // вложенный route допустим (он внутри handle), top-level — нет: фрагмент
  // вставляется в существующий route шлюза.
  assert.ok(!/^route\s*\{/m.test(FRAGMENT), 'фрагмент не должен содержать top-level route {');

  assert.equal(
    sectionB.split('X-Claude-Edge __EDGE_SECRET__').length - 1,
    2,
    'плейсхолдер в обеих proxy-ветках (assets + остальное)',
  );
  assert.equal(
    FRAGMENT.split('__EDGE_SECRET__').length - 1,
    3,
    'два в секции B + один в шапке-описании',
  );
  assert.ok(FRAGMENT.includes('__EDGE_SECRET__'), 'плейсхолдер описан в шапке фрагмента');
  assert.doesNotMatch(FRAGMENT, /sk-ant-[A-Za-z0-9._-]+/);
  assert.doesNotMatch(FRAGMENT, /\b[0-9a-fA-F]{64}\b/, 'в фрагменте нет реального 64-hex секрета');
  assert.doesNotMatch(FRAGMENT, /Service-Worker-Allowed/, 'scope SW не расширяется');
});

test('фрагмент: комментарий A фиксирует порядок ПОСЛЕ глобального header', () => {
  assert.match(sectionA, /ПОСЛЕ глобального header/);
  assert.match(sectionA, /Caddy 2\.11\.9/);
  assert.doesNotMatch(sectionA, /В САМОЕ НАЧАЛО route/);
});

test('фрагмент: все строки секций имеют базовый отступ (переиндентация)', () => {
  for (const [name, section] of [
    ['A', sectionA],
    ['B', sectionB],
  ]) {
    for (const line of section.split('\n')) {
      if (!line.trim()) continue;
      assert.ok(line.startsWith('\t'), `строка секции ${name} без базового таба: ${JSON.stringify(line)}`);
    }
  }
});

test('фрагмент: Origin-guard стоит ДО install-ветки и до forward_auth', () => {
  const originIdx = indexOfOrFail(sectionB, '@claude_bad_origin');
  const respondIdx = indexOfOrFail(sectionB, 'respond @claude_bad_origin "forbidden" 403');
  const installIdx = indexOfOrFail(sectionB, '@claude_install path');
  const privateIdx = indexOfOrFail(sectionB, 'handle /claude/*');
  assert.ok(originIdx < respondIdx, 'guard-матичер до respond');
  assert.ok(respondIdx < installIdx, '403-guard до install-ветки');
  assert.ok(installIdx < privateIdx, 'install-ветка до forward_auth');
  assert.ok(
    sectionB.includes('{http.request.header.Origin}'),
    'guard сравнивает заголовок Origin',
  );
  assert.ok(
    sectionB.includes(`{http.request.header.Origin} != '${PUBLIC_ORIGIN}'`),
    'guard знает точный публичный origin',
  );
  assert.match(sectionB, /path \/claude\/\*/);
});

test('фрагмент: кэш/Content-Type статики — только успешные ответы, 401 без кэша', () => {
  // (a) sw.js: deferred no-store безопасен для любого статуса (no-store и так
  // глобальный; deferred убирает дубль).
  assert.ok(sectionB.includes('@claude_sw path /claude/sw.js'), 'матичер sw.js');
  assert.ok(
    sectionB.includes('header @claude_sw >Cache-Control "no-store"'),
    'sw.js: deferred no-store',
  );

  // (b) публичные manifest/icons: header ВНУТРИ handle @claude_install, после
  // respond 405 и до root/file_server; НЕ на уровне route (иначе 401 получал
  // бы no-cache/image/png).
  const installStart = indexOfOrFail(sectionB, 'handle @claude_install {');
  const installEnd = indexOfOrFail(sectionB, 'handle /claude {');
  const installBlock = sectionB.slice(installStart, installEnd);
  const order = [
    'respond @not_get "method not allowed" 405',
    '@claude_manifest path /claude/manifest.webmanifest',
    'header @claude_manifest Cache-Control "no-cache"',
    'header @claude_manifest Content-Type "application/manifest+json"',
    '@claude_icons path /claude/icons/*',
    'header @claude_icons Cache-Control "public, max-age=86400"',
    'header @claude_icons Content-Type "image/png"',
    'root * /srv/claude-web/public',
    'file_server',
  ];
  const blockLines = installBlock.split('\n').map((line) => line.trim());
  let previous = -1;
  for (const needle of order) {
    const idx = blockLines.indexOf(needle);
    assert.ok(idx >= 0, `install-ветка содержит строку «${needle}»`);
    assert.ok(idx > previous, `install-ветка: «${needle}» в правильном порядке`);
    previous = idx;
  }
  // нет cache/type правил на уровне route (регрессия 401-кэша)
  assert.doesNotMatch(
    sectionB,
    /^\theader @claude_(assets|icons|manifest)/m,
    'cache/type правила не на уровне route',
  );

  // (c) /claude/assets/*: immutable только на 2xx app через handle_response,
  // отдельная ветка после forward_auth (HTML/API/SSE идут обычным proxy).
  const forwardIdx = indexOfOrFail(sectionB, 'forward_auth 127.0.0.1:9090 {');
  const assetsHandleIdx = indexOfOrFail(sectionB, 'handle @claude_assets {');
  assert.ok(forwardIdx < assetsHandleIdx, 'forward_auth ДО ветки assets');
  const assetNeedles = [
    '@claude_asset_ok status 2xx',
    'handle_response @claude_asset_ok {',
    '>Cache-Control "public, max-age=86400, immutable"',
    'copy_response',
  ];
  for (const needle of assetNeedles) {
    assert.ok(sectionB.includes(needle), `assets 2xx-gated: «${needle}»`);
  }
  // immutable-правило ровно одно и только deferred
  assert.equal(
    FRAGMENT.split('public, max-age=86400, immutable').length - 1,
    1,
    'immutable-правило ровно одно',
  );
  assert.doesNotMatch(
    sectionB,
    /^\s*header @claude_assets /m,
    'нет не-deferred Cache-Control для assets',
  );
  // приватная часть обёрнута в route для фиксированного порядка
  assert.match(sectionB, /handle \/claude\/\* \{\n\t\troute \{/);
});

test('фрагмент: публичные install-ассеты — ровно 5 путей, GET/HEAD, file_server', () => {
  const installIdx = indexOfOrFail(sectionB, '@claude_install path');
  const matcher = sectionB.slice(installIdx, sectionB.indexOf('handle @claude_install'));
  const expected = [
    '/claude/manifest.webmanifest',
    '/claude/icons/icon-192.png',
    '/claude/icons/icon-512.png',
    '/claude/icons/icon-maskable-512.png',
    '/claude/icons/apple-touch-icon-180.png',
  ];
  for (const path of expected) {
    assert.ok(matcher.includes(path), `install-путь ${path}`);
  }
  // Никаких других путей: считаем токены, начинающиеся с /claude/.
  const paths = matcher.match(/\/claude\/[A-Za-z0-9._/-]+/g) ?? [];
  assert.deepEqual([...new Set(paths)].sort(), [...expected].sort());
  assert.ok(!matcher.includes('sw.js'), 'sw.js не публичный');

  const handle = sectionB.slice(
    indexOfOrFail(sectionB, 'handle @claude_install'),
    indexOfOrFail(sectionB, 'handle /claude {'),
  );
  assert.match(handle, /@not_get not method GET HEAD/);
  assert.match(handle, /respond @not_get "method not allowed" 405/);
  assert.match(handle, /root \* \/srv\/claude-web\/public/);
  assert.match(handle, /file_server/);
});

test('фрагмент: redirect /claude -> /claude/ 308 до приватной части', () => {
  const redirectIdx = indexOfOrFail(sectionB, 'handle /claude {');
  const redirIdx = indexOfOrFail(sectionB, 'redir * /claude/ 308');
  const privateIdx = indexOfOrFail(sectionB, 'handle /claude/*');
  assert.ok(redirectIdx < redirIdx, 'redir внутри handle /claude');
  assert.ok(redirectIdx < privateIdx, 'redirect до handle /claude/*');
  // «handle /claude» не должен быть префиксом «handle /claude/*» в поиске.
  assert.ok(sectionB.includes('handle /claude {'), 'точный handle /claude');
});

test('фрагмент: приватный handle — forward_auth + reverse_proxy 3090', () => {
  const privateIdx = indexOfOrFail(sectionB, 'handle /claude/*');
  const block = sectionB.slice(privateIdx);
  assert.match(block, /forward_auth 127\.0\.0\.1:9090 \{/);
  assert.match(block, /uri \/verify/);
  assert.match(block, /copy_headers X-Auth-User/);
  assert.match(block, /reverse_proxy 127\.0\.0\.1:3090 \{/);
  assert.match(block, /flush_interval -1/);
  assert.match(block, /header_up X-Forwarded-Proto https/);
  assert.match(block, /header_up -Cookie/);
  assert.match(block, /header_up X-Claude-Edge __EDGE_SECRET__/);
  assert.match(block, /header_up -Authorization/);
  assert.match(block, /header_up -X-Forwarded-User/);
  assert.match(block, /header_up -X-Real-IP/);
  // forward_auth должен идти до reverse_proxy (иначе X-Auth-User не появится).
  assert.ok(
    block.indexOf('forward_auth 127.0.0.1:9090') < block.indexOf('reverse_proxy 127.0.0.1:3090'),
    'forward_auth до reverse_proxy',
  );
  assert.doesNotMatch(block, /header_up Cookie\b/, 'cookie шлюза не пробрасывается');
});

test('фрагмент: нет ослаблений auth/CSP/логов', () => {
  assert.doesNotMatch(FRAGMENT, /Content-Security-Policy[^\n]*unsafe-eval/);
  assert.doesNotMatch(FRAGMENT, /frame-ancestors \*/);
  assert.doesNotMatch(FRAGMENT, /default-src \*/);
  assert.doesNotMatch(FRAGMENT, /reverse_proxy 0\.0\.0\.0/);
  assert.ok(!/127\.0\.0\.1:3090[^\n]*insecure/.test(FRAGMENT));
});
