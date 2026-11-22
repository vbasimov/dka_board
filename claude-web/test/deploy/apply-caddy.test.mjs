// Интеграционные тесты deploy/apply-caddy.py на синтетическом Caddyfile.
//
// Фикстура повторяет структуру живого auth-гейтвея: global options, site на
// http://:8081, route { ... } с глобальным header, @pwa_install handle, /tg,
// /auth/*, /healthz, /connect, /verify, /internal/*, финальный catch-all
// handle { forward_auth ... }, а также handle_errors и log > format filter >
// fields — чтобы проверить и поиск якорей, и патч log-фильтра.
//
// Штатный прогон: node --test test/deploy (python3 обязателен).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../../deploy/', import.meta.url));
const APPLY_PY = join(DEPLOY, 'apply-caddy.py');
const FRAGMENT = join(DEPLOY, 'Caddyfile.fragment');
const PY = process.env.PYTHON || 'python3';
const FAKE_SECRET = 'ab'.repeat(32); // 64 hex, синтетический (не секрет)

const pythonOk =
  spawnSync(PY, ['-c', 'import sys; sys.exit(0)'], { encoding: 'utf8' }).status === 0;
const skipIfNoPython = pythonOk ? false : `python3 не найден (${PY})`;

const FIXTURE = `# synthetic auth-gateway Caddyfile (fixture)
# структура повторяет живой конфиг: global options, site, route, global header,
# @pwa_install, /internal/*, финальный catch-all handle, handle_errors, log.

{
	admin off
	persist_config off

	servers {
		trusted_proxies static 127.0.0.1/32 ::1/128
		max_header_size 32KB
	}
}

http://:8081 {
	bind 127.0.0.1

	route {
		# ── защитные заголовки ответа ──────────────────────────────────────
		header {
			Strict-Transport-Security "max-age=31536000"
			X-Content-Type-Options "nosniff"
			Content-Security-Policy "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
		}

		@pwa_no_store expression \`!({http.request.uri}.startsWith("/assets/"))\`
		header @pwa_no_store Cache-Control "no-store, private"

		request_header -X-Auth-*
		request_header -X-Forwarded-User

		request_body {
			max_size 64MB
		}
		@badMethods not method GET HEAD POST OPTIONS
		respond @badMethods "method not allowed" 405

		# посторонний публичный файл (как /vendor в живом конфиге): второй
		# file_server НЕ должен ломать проверку install-ветки claude-web
		handle /vendor/telegram-web-app.js {
			root * /opt/dsh-gateway/public
			file_server
			header Cache-Control "public, max-age=86400"
		}
		handle /vendor/* {
			respond "not found" 404
		}

		@pwa_install path /manifest.webmanifest /icon-192.png /icon-512.png /icon-maskable-512.png /apple-touch-icon.png
		handle @pwa_install {
			reverse_proxy 127.0.0.1:3080
		}
		handle /tg {
			reverse_proxy 127.0.0.1:9090 {
				header_down Content-Security-Policy "default-src 'self'"
			}
		}
		handle /auth/* {
			reverse_proxy 127.0.0.1:9090
		}
		handle /healthz {
			reverse_proxy 127.0.0.1:9090
		}
		handle /connect {
			respond "not found" 404
		}
		handle /connect/* {
			respond "not found" 404
		}
		handle /verify {
			respond "not found" 404
		}
		handle /internal/* {
			respond "not found" 404
		}

		handle {
			forward_auth 127.0.0.1:9090 {
				uri /verify
			}
			reverse_proxy 127.0.0.1:9090 {
				flush_interval -1
				header_up -X-Forwarded-User
				header_up -Authorization
			}
		}
	}

	handle_errors {
		@unavailable \`{err.status_code} >= 500\`
		handle @unavailable {
			respond "auth gateway unavailable" 503
		}
		handle {
			respond "gateway error" 500
		}
	}

	log {
		output file /var/log/dsh-gateway/caddy-access.log {
			mode 0600
		}
		format filter {
			wrap json
			fields {
				request>uri regexp \`\\\\?.*\` ""
				request>headers>Cookie delete
				request>headers>Authorization delete
				resp_headers>Set-Cookie delete
			}
		}
	}
}
`;

function makeWorkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-edge-apply-'));
  writeFileSync(join(dir, 'Caddyfile'), FIXTURE, 'utf8');
  return dir;
}

function runApply(args, options = {}) {
  return spawnSync(PY, [APPLY_PY, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    ...options,
  });
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function findBlockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/`[^`]*`/g, ' ').replace(/"[^"]*"/g, ' ');
    for (const ch of code) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0 && i > start) return i;
  }
  return -1;
}

function indentLen(line) {
  return (line.match(/^\t*/) || [''])[0].length;
}

function assertNoSecret(text, label) {
  assert.ok(!text.includes(FAKE_SECRET), `${label}: реальный/тестовый секрет не должен утекать`);
  assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9._-]+/, `${label}: нет sk-ant-токена`);
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function routeIndices(lines) {
  return lines.reduce((acc, line, i) => (line.trim() === 'route {' ? [...acc, i] : acc), []);
}

test('apply-caddy.py: dry-run вставляет A/B и патчит log-фильтр', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const original = readFileSync(join(work, 'Caddyfile'), 'utf8');
    const result = runApply(
      [
        '--config',
        join(work, 'Caddyfile'),
        '--fragment',
        FRAGMENT,
        '--output-dir',
        join(work, 'out'),
        '--no-validate',
      ],
      { cwd: work },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stdout, /RESULT=ok/);
    const kv = parseKV(result.stdout);
    assert.equal(kv.CHANGED, '1');
    const patchedPath = kv.DRY_RUN_CONFIG;
    assert.ok(patchedPath && existsSync(patchedPath), 'dry-run пишет пропатченную копию');
    assert.equal(statSync(patchedPath).mode & 0o777, 0o600, 'копия 0600');
    assert.equal(readFileSync(join(work, 'Caddyfile'), 'utf8'), original, 'исходник не изменён');

    const patched = readFileSync(patchedPath, 'utf8');
    const lines = patched.split('\n');
    const allRoutes = routeIndices(lines);
    const minRouteIndent = Math.min(...allRoutes.map((i) => indentLen(lines[i])));
    assert.equal(
      allRoutes.filter((i) => indentLen(lines[i]) === minRouteIndent).length,
      1,
      'ровно один внешний route { (вложенный route допускается)',
    );

    // маркеры: ровно по одному на секцию
    for (const key of ['A', 'B', 'C']) {
      assert.equal(count(patched, `claude-web:fragment:${key}:begin`), 1, `marker ${key}`);
      assert.equal(count(patched, `claude-web:fragment:${key}:end`), 1, `marker end ${key}`);
    }

    // A — ПОСЛЕ глобальных header-директив route, но ДО @pwa_no_store
    // (Caddy 2.11.9: header, идущий позже, перетирает CSP).
    const routeIdx = routeIndices(lines)[0];
    const cspIdx = lines.findIndex((line) => line.trim().startsWith('header /claude/*'));
    const globalHeaderIdx = lines.findIndex(
      (line) => line.trim() === 'header {' && line.startsWith('\t\t'),
    );
    const globalHeaderEnd = findBlockEnd(lines, globalHeaderIdx);
    const pwaNoStoreIdx = lines.findIndex((line) => line.trim().startsWith('@pwa_no_store'));
    assert.ok(cspIdx > routeIdx, 'CSP внутри route');
    assert.ok(cspIdx > globalHeaderEnd, 'CSP после глобального header-блока');
    assert.ok(cspIdx < pwaNoStoreIdx, 'CSP до @pwa_no_store');
    assert.match(lines[cspIdx + 1], /default-src 'self'; script-src 'self'/);

    // кэш/Content-Type статики: 2xx-gated assets + header внутри install-ветки
    const globalNoStoreIdx = lines.findIndex((line) =>
      line.trim().startsWith('header @pwa_no_store Cache-Control'),
    );
    assert.ok(globalNoStoreIdx >= 0, 'глобальный @pwa_no_store найден');
    const swMatcherIdx = lines.findIndex((line) => line.trim() === '@claude_sw path /claude/sw.js');
    const swHeaderIdx = lines.findIndex(
      (line) => line.trim() === 'header @claude_sw >Cache-Control "no-store"',
    );
    assert.ok(swMatcherIdx > globalNoStoreIdx, 'sw.js: правило после @pwa_no_store');
    assert.ok(swMatcherIdx < swHeaderIdx, 'sw.js: deferred no-store');
    const forwardAuthPos = lines.findIndex((line) => line.trim() === 'forward_auth 127.0.0.1:9090 {');
    const assetsHandlePos = lines.findIndex((line) => line.trim() === 'handle @claude_assets {');
    assert.ok(forwardAuthPos >= 0, 'forward_auth найден');
    assert.ok(forwardAuthPos < assetsHandlePos, 'forward_auth ДО ветки assets');
    for (const needle of [
      '@claude_asset_ok status 2xx',
      'handle_response @claude_asset_ok {',
      '>Cache-Control "public, max-age=86400, immutable"',
      'copy_response',
      'header @claude_manifest Cache-Control "no-cache"',
      'header @claude_manifest Content-Type "application/manifest+json"',
      'header @claude_icons Cache-Control "public, max-age=86400"',
      'header @claude_icons Content-Type "image/png"',
    ]) {
      assert.ok(patched.includes(needle), `2xx-gated правило: ${needle}`);
    }
    // регрессия: cache/type правила НЕ на уровне route (иначе 401 получает кэш)
    const routeLevelCache = lines.filter(
      (line) => indentLen(line) === minRouteIndent + 1 &&
        /^header @claude_(assets|icons|manifest)\b/.test(line.trim()),
    );
    assert.deepEqual(routeLevelCache, [], 'cache/type правила не на уровне route');
    assert.ok(
      !lines.some((line) => line.trim().startsWith('-Cache-Control')),
      'нет -Cache-Control (даёт потерю заголовка)',
    );

    // B — после handle /internal/*, до финального catch-all handle {
    const internalIdx = lines.findIndex((line) => line.trim() === 'handle /internal/* {');
    const originIdx = lines.findIndex((line) => line.trim() === '@claude_bad_origin {');
    const installIdx = lines.findIndex((line) => line.trim().startsWith('@claude_install path'));
    const privateIdx = lines.findIndex((line) => line.trim() === 'handle /claude/* {');
    const handleErrorsIdx = lines.findIndex((line) => line.trim() === 'handle_errors {');
    const catchAll = lines
      .map((line, i) => ({ line, i }))
      .filter(
        ({ line, i }) =>
          line.startsWith('\t\thandle {') && (handleErrorsIdx === -1 || i < handleErrorsIdx),
      );
    assert.equal(catchAll.length, 1, 'ровно один финальный catch-all handle {');
    assert.ok(originIdx > internalIdx, 'Origin-guard после /internal/*');
    assert.ok(installIdx > originIdx, 'install-ветка после Origin-guard');
    assert.ok(privateIdx > installIdx, 'handle /claude/* после install');
    assert.ok(catchAll[0].i > privateIdx, 'handle /claude/* до catch-all');

    const privateBlock = lines
      .slice(privateIdx, findBlockEnd(lines, privateIdx) + 1)
      .join('\n');
    assert.match(privateBlock, /forward_auth 127\.0\.0\.1:9090/);
    assert.match(privateBlock, /copy_headers X-Auth-User/);
    assert.match(privateBlock, /reverse_proxy 127\.0\.0\.1:3090/);
    assert.match(privateBlock, /flush_interval -1/);
    assert.match(privateBlock, /header_up -Cookie/);
    assert.match(privateBlock, /header_up X-Claude-Edge __EDGE_SECRET__/);

    // log-фильтр: X-Claude-Edge удаляется из access-лога
    assert.match(patched, /request>headers>X-Claude-Edge delete/);
    assert.ok(
      lines.findIndex((line) => line.trim().startsWith('request>headers>X-Claude-Edge delete')) >
        lines.findIndex((line) => line.trim() === 'fields {'),
      'удаление edge-секрета внутри fields',
    );

    assertNoSecret(result.stdout + result.stderr, 'dry-run stdout');
    assertNoSecret(patched, 'patched copy');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// Фикстура «как текущий живой Caddyfile»: минимальная CSP вынесена из header{}
// в отдельную директиву с матчером @nonAuthCsp (плюс header без CSP ниже —
// @pwa_no_store Cache-Control), которая должна остаться ПОСЛЕ нашего блока A.
const LIVE_FIXTURE = (() => {
  const withoutHeaderCsp = FIXTURE.replace(
    "\t\t\tContent-Security-Policy \"frame-ancestors 'none'; base-uri 'none'; object-src 'none'\"\n",
    '',
  );
  assertNotEqual(withoutHeaderCsp, FIXTURE);
  const withMatcher = withoutHeaderCsp.replace(
    '\t\t}\n\n\t\t@pwa_no_store',
    [
      '\t\t}',
      '\t\t# CSP: глобально — только минимальная и НЕ для /tg и /auth/*',
      '\t\t@nonAuthCsp not path /tg /auth/*',
      '\t\theader @nonAuthCsp Content-Security-Policy "frame-ancestors \'none\'; base-uri \'none\'; object-src \'none\'"',
      '',
      '\t\t@pwa_no_store',
    ].join('\n'),
  );
  assertNotEqual(withMatcher, withoutHeaderCsp);
  return withMatcher;
})();

function assertNotEqual(actual, expected) {
  assert.notEqual(actual, expected);
}

function makeWorkdirWith(content = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-edge-apply-'));
  writeFileSync(join(dir, 'Caddyfile'), content, 'utf8');
  return dir;
}

test('apply-caddy.py: A после @nonAuthCsp-CSP и до @pwa_no_store (живой конфиг)', { skip: skipIfNoPython }, () => {
  const work = makeWorkdirWith(LIVE_FIXTURE);
  try {
    const result = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const patched = readFileSync(parseKV(result.stdout).DRY_RUN_CONFIG, 'utf8');
    const lines = patched.split('\n');
    const globalHeaderIdx = lines.findIndex(
      (line) => line.trim() === 'header {' && line.startsWith('\t\t'),
    );
    const globalHeaderEnd = findBlockEnd(lines, globalHeaderIdx);
    const matcherIdx = lines.findIndex((line) => line.trim() === '@nonAuthCsp not path /tg /auth/*');
    const globalCspIdx = lines.findIndex(
      (line) =>
        line.startsWith('\t\t') &&
        line.trim().startsWith('header @nonAuthCsp Content-Security-Policy'),
    );
    const cspIdx = lines.findIndex((line) => line.trim().startsWith('header /claude/*'));
    const pwaNoStoreIdx = lines.findIndex((line) => line.trim().startsWith('@pwa_no_store'));
    assert.ok(globalHeaderIdx >= 0, 'глобальный header {} найден');
    assert.ok(matcherIdx > globalHeaderEnd, '@nonAuthCsp после header{}');
    assert.ok(globalCspIdx > matcherIdx, 'глобальный CSP-header найден');
    assert.ok(cspIdx > globalCspIdx, 'наш CSP-блок A ПОСЛЕ глобального CSP-header');
    assert.ok(cspIdx < pwaNoStoreIdx, 'наш CSP-блок A ДО @pwa_no_store');
    assert.match(lines[cspIdx + 1], /default-src 'self'; script-src 'self'/);
    const swMatcherIdx2 = lines.findIndex((line) => line.trim() === '@claude_sw path /claude/sw.js');
    assert.ok(
      swMatcherIdx2 > lines.findIndex((line) => line.trim().startsWith('@pwa_no_store')),
      'sw.js: правило после @pwa_no_store',
    );
    assert.ok(patched.includes('handle @claude_assets {'), 'ветка assets');
    assert.ok(patched.includes('@claude_asset_ok status 2xx'), 'assets: gating 2xx');
    assert.ok(
      patched.includes('>Cache-Control "public, max-age=86400, immutable"'),
      'assets: deferred immutable',
    );
    assert.ok(
      patched.includes('header @claude_icons Content-Type "image/png"'),
      'icons: Content-Type',
    );
    const forwardAuthPos2 = lines.findIndex((line) => line.trim() === 'forward_auth 127.0.0.1:9090 {');
    assert.ok(
      forwardAuthPos2 < lines.findIndex((line) => line.trim() === 'handle @claude_assets {'),
      'forward_auth ДО ветки assets',
    );
    assert.equal(
      patched.split('header /claude/*').length - 1,
      1,
      'ровно один header /claude/*',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: fail-closed без глобального header {}', { skip: skipIfNoPython }, () => {
  const noHeader = FIXTURE.replace(
    /\t\theader \{[\s\S]*?\n\t\t\}\n/,
    '',
  );
  assert.notEqual(noHeader, FIXTURE);
  const work = makeWorkdirWith(noHeader);
  try {
    const result = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAIL:.*header \{/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: fail-closed без глобального CSP', { skip: skipIfNoPython }, () => {
  const noCsp = FIXTURE.replace(
    "\t\t\tContent-Security-Policy \"frame-ancestors 'none'; base-uri 'none'; object-src 'none'\"\n",
    '',
  );
  assert.notEqual(noCsp, FIXTURE);
  const work = makeWorkdirWith(noCsp);
  try {
    const result = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAIL:.*Content-Security-Policy/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: повторный запуск идемпотентен (без дублей)', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const out1 = join(work, 'out1');
    const first = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      out1,
      '--no-validate',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const patchedPath = parseKV(first.stdout).DRY_RUN_CONFIG;
    const patched1 = readFileSync(patchedPath, 'utf8');

    const second = runApply([
      '--config',
      patchedPath,
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out2'),
      '--no-validate',
    ]);
    assert.equal(second.status, 0, second.stderr);
    const patched2 = readFileSync(parseKV(second.stdout).DRY_RUN_CONFIG, 'utf8');
    assert.equal(parseKV(second.stdout).CHANGED, '0');
    assert.equal(patched2, patched1, 'второй прогон не меняет файл');
    for (const key of ['A', 'B', 'C']) {
      assert.equal(count(patched2, `claude-web:fragment:${key}:begin`), 1, `без дубля ${key}`);
    }
    assert.equal(count(patched2, '@claude_install path'), 1, 'без дубля install-матичера');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: обновляет уже установленный фрагмент (upgrade)', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const first = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out1'),
      '--no-validate',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const patchedPath = parseKV(first.stdout).DRY_RUN_CONFIG;
    const fresh = readFileSync(patchedPath, 'utf8');
    // имитируем ранее установленную (устаревшую) версию фрагмента
    const stale = fresh.replace(
      'header @claude_sw >Cache-Control "no-store"',
      'header @claude_sw >Cache-Control "stale-value"',
    );
    assert.notEqual(stale, fresh, 'фикстура должна измениться');
    writeFileSync(patchedPath, stale, 'utf8');

    const second = runApply([
      '--config',
      patchedPath,
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out2'),
      '--no-validate',
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(parseKV(second.stdout).CHANGED, '1', 'устаревший фрагмент обновляется');
    assert.match(second.stdout, /обновляю секции/);
    const upgraded = readFileSync(parseKV(second.stdout).DRY_RUN_CONFIG, 'utf8');
    assert.match(upgraded, /header @claude_sw >Cache-Control "no-store"/);
    assert.doesNotMatch(upgraded, /stale-value/);
    for (const key of ['A', 'B']) {
      assert.equal(
        upgraded.split(`claude-web:fragment:${key}:begin`).length - 1,
        1,
        `после upgrade маркер ${key} один`,
      );
    }
    // повторный прогон по обновлённому — уже no-op
    const third = runApply([
      '--config',
      parseKV(second.stdout).DRY_RUN_CONFIG,
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out3'),
      '--no-validate',
    ]);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(parseKV(third.stdout).CHANGED, '0', 'после upgrade идемпотентно');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: отказ без якоря route {', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const noRoute = FIXTURE.replace('route {', 'route-removed {');
    writeFileSync(join(work, 'noroute.Caddyfile'), noRoute, 'utf8');
    const result = runApply([
      '--config',
      join(work, 'noroute.Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.notEqual(result.status, 0, 'должен быть ненулевой exit');
    assert.match(result.stderr, /FAIL:.*route \{/);
    assert.match(result.stdout + result.stderr, /RESULT=fail/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: отказ при неоднозначном catch-all handle {', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const ambiguous = FIXTURE.replace(
      '\t\thandle {\n\t\t\tforward_auth 127.0.0.1:9090 {',
      '\t\thandle {\n\t\t\trespond "first catch-all" 404\n\t\t}\n\t\thandle {\n\t\t\tforward_auth 127.0.0.1:9090 {',
    );
    assert.notEqual(ambiguous, FIXTURE, 'фикстура должна измениться');
    writeFileSync(join(work, 'ambiguous.Caddyfile'), ambiguous, 'utf8');
    const result = runApply([
      '--config',
      join(work, 'ambiguous.Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAIL:.*неоднозначен/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: redaction секрета в diff, плейсхолдер в файле', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const secretFile = join(work, 'secret.txt');
    writeFileSync(secretFile, `${FAKE_SECRET}\n`, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    const result = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      FRAGMENT,
      '--secret-file',
      secretFile,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assertNoSecret(result.stdout + result.stderr, 'stdout');
    assert.ok(
      result.stdout.includes('<EDGE_SECRET>'),
      'в diff плейсхолдер должен быть отредактирован',
    );
    const patched = readFileSync(parseKV(result.stdout).DRY_RUN_CONFIG, 'utf8');
    assert.ok(
      patched.includes('header_up X-Claude-Edge __EDGE_SECRET__'),
      'dry-run не подставляет реальный секрет в файл',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: отказ при фрагменте без плейсхолдера', { skip: skipIfNoPython }, () => {
  const work = makeWorkdir();
  try {
    const badFragment = join(work, 'bad.fragment');
    writeFileSync(
      badFragment,
      readFileSync(FRAGMENT, 'utf8').replaceAll('__EDGE_SECRET__', 'REPLACED'),
      'utf8',
    );
    const result = runApply([
      '--config',
      join(work, 'Caddyfile'),
      '--fragment',
      badFragment,
      '--output-dir',
      join(work, 'out'),
      '--no-validate',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /FAIL:/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('apply-caddy.py: help и режимы описаны', { skip: skipIfNoPython }, () => {
  const result = runApply(['--help']);
  assert.equal(result.status, 0);
  for (const needle of ['--dry-run', '--install', '--rollback', '--env-file', '--secret-file']) {
    assert.ok(result.stdout.includes(needle), `help содержит ${needle}`);
  }
  assert.doesNotMatch(result.stdout, /--secret\s/);
});
