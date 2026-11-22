// Статические проверки deploy/*.sh и deploy/apply-caddy.py:
// синтаксис, guard-флаги, отсутствие секретов и destructive-операций без проверок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../../deploy/', import.meta.url));
const SHELL_SCRIPTS = ['apply-caddy.sh', 'install.sh', 'acceptance.sh', 'rollback.sh'];
const PYTHON = process.env.PYTHON || 'python3';

const read = (name) => readFileSync(join(DEPLOY, name), 'utf8');

function assertNoSecrets(text, label) {
  // Регэкспы-детекторы вида /sk-ant-[A-Za-z0-9._-]+/ сами по себе не токен:
  assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9._-]{20,}/, `${label}: sk-ant-токен`);
  assert.doesNotMatch(text, /\b[0-9a-fA-F]{64}\b/, `${label}: 64-hex секрет`);
  assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, `${label}: приватный ключ`);
}

test('deploy: нет реальных секретов ни в одном артефакте', () => {
  for (const name of readdirSync(DEPLOY)) {
    assertNoSecrets(read(name), name);
  }
});

test('shell-скрипты: shebang, set -euo pipefail, валидный синтаксис bash', () => {
  for (const name of SHELL_SCRIPTS) {
    const text = read(name);
    assert.ok(text.startsWith('#!/usr/bin/env bash'), `${name}: shebang`);
    assert.match(text, /^set -euo pipefail$/m, `${name}: set -euo pipefail`);
    const syntax = spawnSync('bash', ['-n', join(DEPLOY, name)], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: bash -n: ${syntax.stderr}`);
  }
});

test('apply-caddy.py: валидный Python (ast), режимы и fail-closed', () => {
  const text = read('apply-caddy.py');
  const astCheck = spawnSync(
    PYTHON,
    ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', join(DEPLOY, 'apply-caddy.py')],
    { encoding: 'utf8' },
  );
  if (astCheck.error || astCheck.status !== 0) {
    assert.fail(`python3 недоступен или файл не парсится: ${astCheck.stderr}`);
  }
  assert.match(text, /class Fail\(Exception\)/);
  assert.match(text, /--dry-run/);
  assert.match(text, /--install/);
  assert.match(text, /--rollback/);
  assert.match(text, /def require_root/);
  assert.match(text, /caddy.*validate/s);
  assert.match(text, /caddy.*adapt/s);
  assert.match(text, /--no-validate[\s\S]*--install[\s\S]*несовместим|--install несовместим с --no-validate/);
  assert.match(text, /atomic_install_text/);
  assert.match(text, /0640/);
  assert.match(text, /root.*caddy|group_gid\("caddy"\)/s);
  assert.match(text, /claude-pwa-backup-/);
  assert.match(text, /sha256/);
  assert.match(text, /request>headers>X-Claude-Edge delete/);
  // deferred-правила кэша/Content-Type для /claude/ статики
  assert.match(text, /@claude_assets/);
  assert.match(text, /@claude_manifest/);
  assert.match(text, /@claude_icons/);
  assert.match(text, />Cache-Control/);
  assert.match(text, /application\/manifest\+json/);
  assert.match(text, /image\/png/);
  // секрет не принимается argv: только --secret-file/--env-file
  assert.doesNotMatch(text, /add_argument\("--secret"/);
  assert.match(text, /--secret-file/);
  assert.match(text, /--env-file/);
  assert.match(text, /HEX64/);
});

test('apply-caddy.py: --install не пишет живой файл до validate/adapt', () => {
  const text = read('apply-caddy.py');
  const installBody = text.slice(text.indexOf('def do_install'));
  const validateIdx = installBody.indexOf('caddy_validate(caddy, staged)');
  const installIdx = installBody.indexOf('atomic_install_text');
  assert.ok(validateIdx >= 0, 'validate в install-ветке');
  assert.ok(installIdx > validateIdx, 'установка после validate');
  // бэкап делается из ровно прочитанных байт (original_text), а не из живого файла
  const backupIdx = installBody.indexOf('write_private(backup_file, original_text');
  assert.ok(backupIdx >= 0 && backupIdx < installIdx, 'бэкап из прочитанного снимка до установки');
  assert.match(installBody, /hashlib\.sha256\(original_text/);
  // живой файл перечитывается перед подменой: параллельный деплой -> fail, не затираем
  assert.match(installBody, /изменился во время подготовки/);
  assert.ok(
    installBody.indexOf('current_text != original_text') < installIdx,
    'проверка актуальности снимка до установки',
  );
  assert.match(installBody, /restart_gateway_and_check/);
  assert.match(installBody, /автоматический откат/);
});

test('install.sh: проверки до изменений и root-only', () => {
  const text = read('install.sh');
  assert.match(text, /EUID|id -u/);
  // env-файл проверяется раньше создания пользователя/каталогов
  const envIdx = text.indexOf('нет $ENV_FILE');
  const userIdx = text.indexOf('getent passwd "$APP_USER"');
  assert.ok(envIdx >= 0 && userIdx > envIdx, 'проверка env-файла до создания пользователя');
  assert.match(text, /0600 root:root/);
  assert.match(text, /useradd --system/);
  assert.match(text, /nologin/);
  assert.match(text, /for bad in dsh sudo admin wheel docker caddy/);
  assert.match(text, /install -d -o claudeapp|install -d -o "\$APP_USER"/);
  assert.match(text, /\/srv\/claude-web\/workspaces/);
  assert.match(text, /npm ci --omit=dev --ignore-scripts/);
  assert.match(text, /claude-agent-sdk-linux-x64\/claude/);
  assert.match(text, /chown -R root:root/);
  assert.match(text, /chmod -R a\+rX,go-w/);
  assert.match(text, /\/srv\/claude-web\/public/);
  assert.match(text, /systemctl daemon-reload/);
  assert.match(text, /systemctl enable claude-web/);
  assert.match(text, /systemctl restart claude-web/);
  assert.match(text, /127\.0\.0\.1:3090/);
  assert.match(text, /sk-ant/);
  // install.sh не трогает Caddy и не создаёт env-файл
  assert.doesNotMatch(text, /dsh-gateway-caddy/);
  assert.doesNotMatch(text, />\s*"?\$ENV_FILE"?/);
  assert.doesNotMatch(text, /apt-get|curl .*\| *sh/);
});

test('install.sh: destructive-шаги только за явными флагами', () => {
  const text = read('install.sh');
  assert.match(text, /--fresh/);
  assert.match(text, /--yes/);
  assert.match(text, /\[\[ \$FRESH -eq 1 \]\]/);
  assert.match(text, /\[\[ \$YES -eq 1 \]\]/);
  assert.match(text, /подтвердите --yes/);
  // rm -rf не должен применяться к корню/APP напрямую
  assert.doesNotMatch(text, /rm\s+-rf\s+\/(\s|$)/);
  assert.doesNotMatch(text, /rm\s+-rf\s+"\$APP"(\s|$)/);
  // временный каталог распаковки удаляется только через trap
  assert.match(text, /trap cleanup EXIT/);
  assert.match(text, /rm -rf -- "\$STAGE"/);
});

test('acceptance.sh: проверки runbook §6 и exit 1 при провале', () => {
  const text = read('acceptance.sh');
  for (const needle of [
    'PUBLIC',
    'APP_PORT',
    'ENV_FILE',
    'sw.js',
    'manifest.webmanifest',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'apple-touch-icon-180.png',
    "default-src 'self'",
    '405',
    '403',
    '308',
    'X-Auth-User',
    'X-Claude-Edge',
    '127.0.0.1',
    '/manifest.webmanifest',
    'Set-Cookie',
    'cache-control',
    'no-cache',
    'immutable',
    'check_401_no_cache',
    'sk-ant',
    'RESULT=fail',
  ]) {
    assert.ok(text.includes(needle), `acceptance.sh содержит «${needle}»`);
  }
  assert.match(text, /exit 1/);
  assert.match(text, /FAILS=/);
  assert.match(text, /--deep/);
});

test('rollback.sh: validate до установки, sha256, опции остановки', () => {
  const text = read('rollback.sh');
  assert.match(text, /\/root\/claude-pwa-backup-/);
  assert.match(text, /claude-pwa-backup-TAG/);
  assert.match(text, /sha256sum/);
  assert.match(text, /caddy validate/);
  const validateIdx = text.indexOf('caddy validate --config "$BACKUP_FILE"');
  const installIdx = text.indexOf('install -m 0640');
  assert.ok(validateIdx >= 0 && installIdx > validateIdx, 'validate до установки');
  assert.match(text, /systemctl restart "\$GATEWAY_UNIT"/);
  assert.match(text, /systemctl disable --now "\$APP_UNIT"/);
  assert.match(text, /--stop-app/);
  assert.match(text, /--no-restart/);
  assert.match(text, /PUBLIC.*401|DSH.*401/s);
});

test('apply-caddy.sh: обёртка запускает python3 без подстановки секретов', () => {
  const text = read('apply-caddy.sh');
  assert.match(text, /python3|PYTHON/);
  assert.match(text, /exec "\$py" "\$here\/apply-caddy.py" "\$@"/);
  assert.doesNotMatch(text, /EDGE_SECRET=/);
});

test('кросс-артефакты согласованы (origin, порты, пути, ассеты)', () => {
  const fragment = read('Caddyfile.fragment');
  const unit = read('claude-web.service');
  const install = read('install.sh');
  const acceptance = read('acceptance.sh');
  assert.ok(fragment.includes('https://vps-4692.tailfbc4b2.ts.net:10000'), 'origin в фрагменте');
  assert.ok(fragment.includes('127.0.0.1:3090'), 'app upstream в фрагменте');
  assert.ok(fragment.includes('127.0.0.1:9090'), 'auth upstream в фрагменте');
  assert.ok(fragment.includes('/srv/claude-web/public'), 'public root в фрагменте');
  assert.ok(unit.includes('/opt/claude-web/server/index.mjs'), 'ExecStart в юните');
  assert.ok(install.includes('/opt/claude-web'), 'APP в install.sh');
  assert.ok(install.includes('/var/log/claude-web'), 'audit-каталог в install.sh');
  const assets = [
    'manifest.webmanifest',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/apple-touch-icon-180.png',
  ];
  for (const asset of assets) {
    assert.ok(fragment.includes(`/claude/${asset}`), `фрагмент: /claude/${asset}`);
    assert.ok(install.includes(asset), `install.sh копирует ${asset}`);
    assert.ok(acceptance.includes(asset), `acceptance.sh проверяет ${asset}`);
  }
});
