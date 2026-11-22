// Статические проверки edge-claude/{systemd/claude-edge.service,install.sh,
// rollback.sh,README.md}: unit-lint, shell-синтаксис, fail-closed, отсутствие
// секретов и destructive-операций. node:test, без caddy/сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = fileURLToPath(new URL('../../edge-claude/', import.meta.url));
const read = (name) => readFileSync(join(EDGE, name), 'utf8');

const UNIT = read('systemd/claude-edge.service');
const INSTALL = read('install.sh');
const ROLLBACK = read('rollback.sh');
const README = read('README.md');

function parseUnit(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1];
      assert.ok(!sections.has(current), `секция [${current}] не должна дублироваться`);
      sections.set(current, []);
      continue;
    }
    assert.ok(current, `строка вне секции: ${rawLine}`);
    sections.get(current).push(line);
  }
  return sections;
}

function entries(sections, name) {
  const lines = sections.get(name);
  assert.ok(lines, `нет секции [${name}]`);
  return lines;
}

function values(sections, section, key) {
  const prefix = `${key}=`;
  return entries(sections, section)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function value(sections, section, key) {
  const hits = values(sections, section, key);
  assert.equal(hits.length, 1, `в [${section}] должен быть ровно один ${key}=`);
  return hits[0];
}

// ── unit ────────────────────────────────────────────────────────────────────
test('unit: секции [Unit]/[Service]/[Install] в правильном порядке', () => {
  const sections = parseUnit(UNIT);
  assert.deepEqual([...sections.keys()], ['Unit', 'Service', 'Install']);
});

test('unit: непривилегированный caddy, ExecStart, рестарт', () => {
  const sections = parseUnit(UNIT);
  assert.equal(value(sections, 'Service', 'Type'), 'simple');
  // Порт 8444 > 1024: root не нужен; работает под caddy (как auth-гейтвей).
  assert.equal(value(sections, 'Service', 'User'), 'caddy');
  assert.equal(value(sections, 'Service', 'Group'), 'caddy');
  assert.equal(value(sections, 'Service', 'Environment'), 'HOME=/var/lib/caddy');
  assert.equal(
    value(sections, 'Service', 'ExecStart'),
    '/usr/bin/caddy run --config /etc/claude-edge/Caddyfile --adapter caddyfile',
  );
  assert.equal(value(sections, 'Service', 'Restart'), 'on-failure');
  assert.equal(value(sections, 'Service', 'RestartSec'), '2');
  assert.equal(value(sections, 'Service', 'TimeoutStopSec'), '20');
  assert.equal(value(sections, 'Service', 'KillSignal'), 'SIGTERM');
  assert.equal(value(sections, 'Service', 'UMask'), '0027');
  // никаких прав root/CAP_NET_BIND_SERVICE
  assert.equal(value(sections, 'Service', 'CapabilityBoundingSet'), '');
  assert.equal(value(sections, 'Service', 'AmbientCapabilities'), '');
});

test('unit: hardening из постановки', () => {
  const sections = parseUnit(UNIT);
  assert.equal(value(sections, 'Service', 'NoNewPrivileges'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectSystem'), 'strict');
  assert.equal(value(sections, 'Service', 'ProtectHome'), 'yes');
  assert.equal(value(sections, 'Service', 'PrivateTmp'), 'yes');
  assert.equal(value(sections, 'Service', 'PrivateDevices'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectKernelTunables'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectKernelModules'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectKernelLogs'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectControlGroups'), 'yes');
  assert.equal(value(sections, 'Service', 'ProtectClock'), 'yes');
  assert.equal(value(sections, 'Service', 'RestrictSUIDSGID'), 'yes');
  assert.equal(value(sections, 'Service', 'RestrictRealtime'), 'yes');
  assert.equal(value(sections, 'Service', 'LockPersonality'), 'yes');
  assert.equal(
    value(sections, 'Service', 'RestrictAddressFamilies'),
    'AF_INET AF_INET6 AF_UNIX',
  );
  assert.equal(value(sections, 'Service', 'SystemCallArchitectures'), 'native');
});

test('unit: записываемые/читаемые пути и лимиты', () => {
  const sections = parseUnit(UNIT);
  const rw = value(sections, 'Service', 'ReadWritePaths');
  assert.match(rw, /\/var\/log\/claude-edge/);
  assert.match(rw, /\/var\/lib\/caddy/);
  const ro = value(sections, 'Service', 'ReadOnlyPaths');
  assert.match(ro, /\/etc\/claude-edge/);
  assert.match(ro, /\/srv\/claude-web\/public/);
  assert.equal(value(sections, 'Service', 'MemoryMax'), '256M');
  assert.equal(value(sections, 'Service', 'TasksMax'), '64');
});

test('unit: [Unit] — сеть и порядок запуска, [Install] — multi-user', () => {
  const sections = parseUnit(UNIT);
  assert.match(value(sections, 'Unit', 'Description'), /Claude Web edge/);
  const after = values(sections, 'Unit', 'After');
  assert.ok(after.includes('network-online.target'), 'After network-online.target');
  assert.ok(after.includes('claude-web.service dsh-gateway-auth.service'), 'After app+gateway');
  assert.equal(value(sections, 'Unit', 'Wants'), 'network-online.target');
  assert.equal(value(sections, 'Unit', 'StartLimitIntervalSec'), '300');
  assert.equal(value(sections, 'Unit', 'StartLimitBurst'), '10');
  assert.equal(value(sections, 'Install', 'WantedBy'), 'multi-user.target');
  // unit не использует root
  assert.doesNotMatch(UNIT, /^User=root$/m);
});

// ── скрипты ────────────────────────────────────────────────────────────────
test('скрипты: shebang, set -euo pipefail, валидный bash', () => {
  for (const [name, text] of [
    ['install.sh', INSTALL],
    ['rollback.sh', ROLLBACK],
  ]) {
    assert.ok(text.startsWith('#!/usr/bin/env bash'), `${name}: shebang`);
    assert.match(text, /^set -euo pipefail$/m, `${name}: set -euo pipefail`);
    const syntax = spawnSync('bash', ['-n', join(EDGE, name)], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `${name}: bash -n: ${syntax.stderr}`);
  }
});

test('install.sh: fail-closed без EDGE_SECRET — ДО любых изменений', () => {
  // env-файл и EDGE_SECRET проверяются до создания каталогов/установки.
  const envCheck = INSTALL.indexOf('нет $ENV_FILE');
  const secretCheck = INSTALL.indexOf('EDGE_SECRET не 64 hex');
  const firstInstallDir = INSTALL.indexOf('install -d -o root -g caddy');
  assert.ok(envCheck >= 0, 'проверка наличия env-файла');
  assert.ok(secretCheck >= 0, 'fail при невалидном EDGE_SECRET');
  assert.ok(firstInstallDir > secretCheck, 'EDGE_SECRET проверен до install -d');
  assert.match(INSTALL, /grep -Eq '\^EDGE_SECRET=\[0-9a-fA-F\]\{64\}\$'/);
  assert.match(INSTALL, /EDGE_SECRET.*\|\| die/);
  // секрет не печатается и не уходит в аргументы
  assert.doesNotMatch(INSTALL, /echo\s+"?\$\{?EDGE_SECRET/);
  assert.doesNotMatch(INSTALL, /printf[^\n]*\$\{?EDGE_SECRET/);
  assert.doesNotMatch(INSTALL, /--secret/);
  assert.doesNotMatch(INSTALL, /set -x/);
  // не трогает Caddy auth-гейтвея / приложение / env
  assert.doesNotMatch(INSTALL, /dsh-gateway-caddy|apply-caddy|systemctl restart claude-web|systemctl restart dsh-gateway/);
  // Funnel не открывается самим install.sh (только печатается подсказка).
  assert.doesNotMatch(INSTALL, /^\s*tailscale\s/m, 'install не выполняет tailscale');
  assert.match(INSTALL, /tailscale funnel --bg --yes --https=8443/, 'подсказка про Funnel');
  assert.doesNotMatch(INSTALL, /wireguard|iptables|nft /);
});

test('install.sh: подстановка секрета, validate/adapt ДО атомарной установки', () => {
  assert.match(INSTALL, /__EDGE_SECRET__/, 'работает с плейсхолдером шаблона');
  assert.match(INSTALL, /placeholder_lines/, 'проверяет число плейсхолдеров');
  assert.match(INSTALL, /-eq 2/);
  const validate = INSTALL.indexOf('validate --config "$TMP_CONFIG"');
  const adapt = INSTALL.indexOf('adapt --config "$TMP_CONFIG"');
  const installCfg = INSTALL.indexOf('mv -f -- "$TMP_CONFIG" "$CFG"');
  assert.ok(validate >= 0, 'caddy validate staged-конфига');
  assert.ok(adapt > validate, 'caddy adapt после validate');
  assert.ok(installCfg > adapt, 'подмена конфига только после validate+adapt');
  assert.match(INSTALL, /chown root:caddy "\$CFG"/);
  assert.match(INSTALL, /chmod 0640 "\$CFG"/);
  assert.match(INSTALL, /install -d -o root -g caddy -m 0750 "\$ETC"/);
  assert.match(INSTALL, /install -d -o caddy -g caddy -m 0750 "\$LOG_DIR"/);
  // временный файл с секретом не остаётся
  assert.match(INSTALL, /trap cleanup EXIT/);
  assert.match(INSTALL, /rm -f -- "\$TMP_CONFIG"/);

  // access.log создаётся ДО validate и сразу caddy:caddy: иначе validate от
  // root создаст файл root-owned, и сервис под caddy не сможет писать.
  const logCreate = INSTALL.indexOf('install -o caddy -g caddy -m 0640 /dev/null "$LOG_FILE"');
  assert.ok(logCreate >= 0, 'access.log создаётся заранее от caddy');
  assert.ok(logCreate < validate, 'access.log до caddy validate');
  assert.match(INSTALL, /chown caddy:caddy "\$LOG_FILE"/);
  // http-хелперы не роняют скрипт молча под set -e/pipefail
  assert.match(INSTALL, /http_code\(\) \{ curl .* \|\| true; \}/);
  assert.match(INSTALL, /header_of\(\) \{/, 'header_of определён');
  assert.match(INSTALL, /awk -v h="\$1"/);
});

test('install.sh: юнит, enable/restart и post-checks по постановке', () => {
  assert.match(INSTALL, /install -m 0644 -o root -g root "\$UNIT_SRC" "\$UNIT"/);
  const daemon = INSTALL.indexOf('systemctl daemon-reload');
  const enable = INSTALL.indexOf('systemctl enable claude-edge');
  const restart = INSTALL.indexOf('systemctl restart claude-edge');
  assert.ok(daemon >= 0 && enable > daemon && restart > enable, 'daemon-reload -> enable -> restart');
  assert.match(INSTALL, /systemctl is-active --quiet claude-edge/);

  // слушает только loopback
  assert.match(INSTALL, /ss -ltnH "sport = :8444"/);
  assert.match(INSTALL, /127\.0\.0\.1:8444/);
  // аноним /claude/ -> 401 + CSP
  assert.match(INSTALL, /"401"/);
  assert.match(INSTALL, /default-src 'self'/);
  // manifest/icon/405/origin/redirect
  assert.match(INSTALL, /application\/manifest\+json/);
  assert.match(INSTALL, /image\/png/);
  assert.match(INSTALL, /"405"/);
  assert.match(INSTALL, /"403"/);
  assert.match(INSTALL, /PUBLIC_ORIGIN\/"/);
  assert.match(INSTALL, /"308"/);
  assert.match(INSTALL, /"302"/);
  // лог: без query/cookie/Set-Cookie/секрета
  assert.match(INSTALL, /INSTALL_LOGTEST_QUERY/);
  assert.match(INSTALL, /INSTALL_LOGTEST_COOKIE/);
  assert.match(INSTALL, /'__Host-dsh_session'/);
  assert.match(INSTALL, /'Set-Cookie'/);
  assert.match(INSTALL, /'X-Claude-Edge'/);
  assert.match(INSTALL, /journalctl -u claude-edge/);
  assert.match(INSTALL, /RESULT=ok/);
});

// ── rollback ───────────────────────────────────────────────────────────────
test('rollback.sh: stop/disable + удаление unit, конфиг и логи сохраняются', () => {
  assert.match(ROLLBACK, /systemctl disable --now/);
  assert.match(ROLLBACK, /UNIT_FILE=\/etc\/systemd\/system\/claude-edge\.service/);
  assert.match(ROLLBACK, /rm -f -- "\$UNIT_FILE"/);
  assert.match(ROLLBACK, /systemctl daemon-reload/);
  // конфиг/логи НЕ удаляются
  assert.doesNotMatch(ROLLBACK, /rm -rf/);
  assert.doesNotMatch(ROLLBACK, /rm .*\/etc\/claude-edge/);
  assert.doesNotMatch(ROLLBACK, /rm .*\/var\/log\/claude-edge/);
  assert.match(ROLLBACK, /конфиг сохранён/);
  assert.match(ROLLBACK, /логи сохранены/);
  // публичный funnel закрывается отдельной командой (подсказка)
  assert.match(ROLLBACK, /tailscale funnel --https=8443 off/);
  // идемпотентно: отсутствие юнита — не ошибка
  assert.match(ROLLBACK, /нечего останавливать/);
  assert.match(ROLLBACK, /RESULT=ok/);
});

// ── README / handoff ───────────────────────────────────────────────────────
test('README: точные команды Funnel и предупреждение о разрешённых портах', () => {
  assert.match(
    README,
    /tailscale funnel --bg --yes --https=8443 http:\/\/127\.0\.0\.1:8444/,
    'точная команда включения',
  );
  assert.match(README, /tailscale funnel --https=8443 off/, 'команда выключения');
  assert.match(README, /tailscale funnel status/);
  assert.match(README, /443,?\s*8443,?\s*10000/, 'Funnel разрешает только 443/8443/10000');
  assert.match(README, /xray/, 'предупреждение про перенос xray-inbound');
  assert.match(README, /2096/);
  // handoff: как проверить и как откатить
  assert.match(README, /install\.sh/);
  assert.match(README, /rollback\.sh/);
  assert.match(README, /127\.0\.0\.1:8444/);
  assert.match(README, /vps-4692\.tailfbc4b2\.ts\.net:8443/);
  assert.match(README, /__Host-dsh_session/);
  assert.match(README, /один вход|вход один/i);
  // риск: приложению/гейтвею может понадобиться новый Host/Origin
  assert.match(README, /Host/);
  assert.match(README, /Origin/);
  assert.match(README, /allowlist/i);
});

test('артефакты: нет реальных секретов/токенов/ключей', () => {
  for (const [name, text] of [
    ['Caddyfile', read('Caddyfile')],
    ['systemd/claude-edge.service', UNIT],
    ['install.sh', INSTALL],
    ['rollback.sh', ROLLBACK],
    ['README.md', README],
  ]) {
    assert.doesNotMatch(text, /\b[0-9a-fA-F]{64}\b/, `${name}: 64-hex секрет`);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9._-]{20,}/, `${name}: OAuth-токен`);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, `${name}: приватный ключ`);
    assert.doesNotMatch(text, /Service-Worker-Allowed/, `${name}: scope SW не расширяется`);
  }
  // в Caddyfile остался только плейсхолдер
  assert.match(read('Caddyfile'), /header_up X-Claude-Edge __EDGE_SECRET__/);
  assert.match(INSTALL, /sed "s\/__EDGE_SECRET__/);
});
