// Unit-lint для deploy/claude-web.service (runbook §4).
// Только чтение артефактов; node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../../deploy/', import.meta.url));
const unitText = readFileSync(`${DEPLOY}claude-web.service`, 'utf8');

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

function value(sections, section, key) {
  const hits = entries(sections, section).filter((line) => line.startsWith(`${key}=`));
  assert.equal(hits.length, 1, `в [${section}] должен быть ровно один ${key}=`);
  return hits[0].slice(key.length + 1);
}

test('unit: обязательные секции и порядок', () => {
  const sections = parseUnit(unitText);
  assert.deepEqual([...sections.keys()], ['Unit', 'Service', 'Install']);
});

test('unit: [Unit] — описание, сеть, лимиты перезапуска', () => {
  const sections = parseUnit(unitText);
  assert.match(value(sections, 'Unit', 'Description'), /Claude Web UI/);
  assert.equal(value(sections, 'Unit', 'After'), 'network-online.target');
  assert.equal(value(sections, 'Unit', 'Wants'), 'network-online.target');
  assert.equal(value(sections, 'Unit', 'StartLimitIntervalSec'), '300');
  assert.equal(value(sections, 'Unit', 'StartLimitBurst'), '10');
});

test('unit: [Service] — пользователь, окружение, ExecStart, UMask', () => {
  const sections = parseUnit(unitText);
  assert.equal(value(sections, 'Service', 'Type'), 'simple');
  assert.equal(value(sections, 'Service', 'User'), 'claudeapp');
  assert.equal(value(sections, 'Service', 'Group'), 'claudeapp');
  assert.equal(value(sections, 'Service', 'WorkingDirectory'), '/opt/claude-web');
  assert.equal(value(sections, 'Service', 'EnvironmentFile'), '/etc/claude-web/env');
  const env = entries(sections, 'Service').filter((line) => line.startsWith('Environment='));
  assert.deepEqual(
    env.sort(),
    [
      'Environment=NODE_ENV=production',
      'Environment=HOME=/var/lib/claude-web',
      'Environment=CLAUDE_CONFIG_DIR=/var/lib/claude-web/claude-config',
      'Environment=DISABLE_AUTOUPDATER=1',
    ].sort(),
  );
  assert.equal(
    value(sections, 'Service', 'ExecStart'),
    '/usr/bin/node /opt/claude-web/server/index.mjs',
  );
  assert.equal(value(sections, 'Service', 'Restart'), 'on-failure');
  assert.equal(value(sections, 'Service', 'RestartSec'), '2');
  assert.equal(value(sections, 'Service', 'TimeoutStopSec'), '20');
  assert.equal(value(sections, 'Service', 'KillSignal'), 'SIGTERM');
  assert.equal(value(sections, 'Service', 'UMask'), '0077');
});

test('unit: hardening-блок полный и без опасных опций', () => {
  const sections = parseUnit(unitText);
  const expected = {
    NoNewPrivileges: 'yes',
    ProtectSystem: 'strict',
    ProtectHome: 'yes',
    PrivateTmp: 'yes',
    PrivateDevices: 'yes',
    ProtectKernelTunables: 'yes',
    ProtectKernelModules: 'yes',
    ProtectKernelLogs: 'yes',
    ProtectControlGroups: 'yes',
    ProtectClock: 'yes',
    RestrictSUIDSGID: 'yes',
    RestrictRealtime: 'yes',
    LockPersonality: 'yes',
    RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6',
    SystemCallArchitectures: 'native',
    CapabilityBoundingSet: '',
    AmbientCapabilities: '',
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.equal(value(sections, 'Service', key), expectedValue, `hardening ${key}`);
  }
  // egress к API Anthropic нужен — блокировать IP нельзя; RestrictNamespaces ломает bwrap.
  assert.doesNotMatch(unitText, /IPAddressDeny/i);
  assert.doesNotMatch(unitText, /RestrictNamespaces/i);
  assert.doesNotMatch(unitText, /SupplementaryGroups/i);
  assert.doesNotMatch(unitText, /CapabilityBoundingSet=.*CAP_/);
});

test('unit: ReadWritePaths и лимиты ресурсов (runbook §4)', () => {
  const sections = parseUnit(unitText);
  assert.equal(
    value(sections, 'Service', 'ReadWritePaths'),
    '/var/lib/claude-web /var/log/claude-web /srv/claude-web/workspaces',
  );
  assert.equal(value(sections, 'Service', 'MemoryMax'), '1150M');
  assert.equal(value(sections, 'Service', 'MemoryHigh'), '950M');
  assert.equal(value(sections, 'Service', 'CPUQuota'), '150%');
  assert.equal(value(sections, 'Service', 'TasksMax'), '256');
  // рабочий каталог модели — только workspace, не /home/dsh и не /opt.
  assert.doesNotMatch(unitText, /\/home\/dsh/);
});

test('unit: [Install] и отсутствие секретов', () => {
  const sections = parseUnit(unitText);
  assert.equal(value(sections, 'Install', 'WantedBy'), 'multi-user.target');
  assert.doesNotMatch(unitText, /sk-ant-[A-Za-z0-9._-]+/);
  assert.doesNotMatch(unitText, /\b[0-9a-fA-F]{64}\b/);
  assert.ok(unitText.endsWith('\n'), 'файл юнита должен оканчиваться переводом строки');
});
