import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePathGuard } from '../../server/runtime/hook.mjs';
import { tempRoot } from './helpers.mjs';

function setup() {
  const root = tempRoot('hook-');
  // macOS: /var → /private/var; делаем все пути каноническими, как в проде.
  const rawWs = join(root, 'workspaces');
  const rawProject = join(rawWs, 'project');
  const rawHome = join(root, 'home');
  mkdirSync(rawProject, { recursive: true });
  mkdirSync(join(rawHome, '.claude'), { recursive: true });
  mkdirSync(join(rawHome, '.dsh'), { recursive: true });
  writeFileSync(join(rawProject, 'readme.txt'), 'hello');
  const rawOutside = join(root, 'outside');
  mkdirSync(rawOutside, { recursive: true });
  writeFileSync(join(rawOutside, 'secret.txt'), 'TOP-SECRET');
  const wsRoot = realpathSync(rawWs);
  const project = join(wsRoot, 'project');
  const homeDir = realpathSync(rawHome);
  const outsideDir = realpathSync(rawOutside);
  const links = {};
  mkdirSync(join(root, 'fake-var-lib-claude-web'), { recursive: true });
  const mk = (name, target) => {
    const p = join(project, name);
    try {
      symlinkSync(target, p);
      links[name] = p;
    } catch {
      /* платформа без симлинков */
    }
    return p;
  };
  mk('environ', '/proc/self/environ');
  mk('etc-passwd', '/etc/passwd');
  mk('out-secret', join(outsideDir, 'secret.txt'));
  mk('out-dir', outsideDir);
  mk('sibling', join(project, 'readme.txt'));

  // путь, ведущий в /var/lib/claude-web через симлинк
  const varLib = realpathSync(join(root, 'fake-var-lib-claude-web'));
  mkdirSync(varLib, { recursive: true });
  writeFileSync(join(varLib, 'audit.jsonl'), '{}');
  mk('audit-link', varLib);

  const realProject = project;
  const guard = makePathGuard({ workspacesRoot: wsRoot, homeDir });
  return { root, wsRoot, project, realProject, homeDir, outsideDir, links, guard };
}

test('allowed: существующий файл и новый файл внутри workspace', () => {
  const { guard, realProject } = setup();
  const existing = guard.checkPath(join(realProject, 'readme.txt'));
  assert.equal(existing.allowed, true);
  const fresh = guard.checkPath(join(realProject, 'new-file.txt'));
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.path.endsWith('/new-file.txt'), true);
});

test('denied: /proc, /etc, /var/lib/claude-web, /var/log/claude-web, ~/.claude, ~/.dsh', () => {
  const { guard, homeDir } = setup();
  const cases = [
    '/proc/self/environ',
    '/etc/passwd',
    '/etc/claude-web/env',
    '/var/lib/claude-web/audit.jsonl',
    '/var/log/claude-web/audit.jsonl',
    '/root/.ssh/id_rsa',
    join(homeDir, '.claude', 'settings.json'),
    join(homeDir, '.dsh', 'config'),
  ];
  for (const p of cases) {
    const res = guard.checkPath(p);
    assert.equal(res.allowed, false, p);
    assert.equal(res.code, 'sensitive_path', p);
  }
});

test('denied: путь вне workspace и traversal', () => {
  const { guard, outsideDir, project } = setup();
  const outside = guard.checkPath(join(outsideDir, 'secret.txt'));
  assert.equal(outside.allowed, false);
  assert.equal(outside.code, 'outside_workspace');
  const traversal = guard.checkPath(join(project, '..', '..', 'etc', 'passwd'));
  assert.equal(traversal.allowed, false);
  assert.equal(guard.checkPath('relative/path.txt').allowed, false);
  assert.equal(guard.checkPath('').allowed, false);
  assert.equal(guard.checkPath('/etc/passwd\0.txt').allowed, false);
});

test('denied: симлинки в workspace, включая link → /proc/self/environ', () => {
  const { guard, links } = setup();
  if (!links.environ) return; // платформа без symlink
  for (const [name, p] of Object.entries(links)) {
    const res = guard.checkPath(p);
    assert.equal(res.allowed, false, name);
    assert.equal(res.code, 'symlink', name);
  }
});

test('checkToolInput: Read/Edit/Write/Grep/Glob и запись через симлинк', () => {
  const { guard, realProject, links } = setup();
  assert.equal(guard.checkToolInput('Read', { file_path: join(realProject, 'readme.txt') }, realProject).allowed, true);
  assert.equal(guard.checkToolInput('Read', { file_path: '/etc/passwd' }, realProject).allowed, false);
  assert.equal(guard.checkToolInput('Edit', { file_path: join(realProject, 'readme.txt') }, realProject).allowed, true);
  assert.equal(guard.checkToolInput('Write', { file_path: join(realProject, 'new.txt') }, realProject).allowed, true);
  assert.equal(guard.checkToolInput('Grep', { pattern: 'x', path: '/etc' }, realProject).allowed, false);
  assert.equal(guard.checkToolInput('Grep', { pattern: 'x' }, realProject).allowed, true);
  assert.equal(guard.checkToolInput('Glob', { pattern: '**/*.js' }, realProject).allowed, true);
  assert.equal(guard.checkToolInput('Glob', { pattern: '**/*.js', path: '/var/log/claude-web' }, realProject).allowed, false);
  assert.equal(guard.checkToolInput('Read', {}, realProject).allowed, false);
  // запись в /var/lib/claude-web через симлинк
  if (links['audit-link']) {
    const viaLink = guard.checkToolInput('Write', { file_path: join(links['audit-link'], 'x.txt') }, realProject);
    assert.equal(viaLink.allowed, false);
    assert.equal(viaLink.code, 'symlink');
  }
  // Read символинка на /proc/self/environ
  if (links.environ) {
    const viaLink = guard.checkToolInput('Read', { file_path: links.environ }, realProject);
    assert.equal(viaLink.allowed, false);
    assert.equal(viaLink.code, 'symlink');
  }
  // не-path инструмент не режется хуком
  assert.equal(guard.checkToolInput('AskUserQuestion', {}, realProject).allowed, true);
});

test('preToolUse: decision deny/allow для SDK-хука', () => {
  const { guard, realProject } = setup();
  const deny = guard.preToolUse({
    tool_name: 'Read',
    tool_input: { file_path: '/etc/passwd' },
    cwd: realProject,
    tool_use_id: 'toolu_1',
    hook_event_name: 'PreToolUse',
  });
  assert.equal(deny.decision, 'deny');
  const allow = guard.preToolUse({
    tool_name: 'Read',
    tool_input: { file_path: join(realProject, 'readme.txt') },
    cwd: realProject,
    tool_use_id: 'toolu_2',
    hook_event_name: 'PreToolUse',
  });
  assert.equal(allow.decision, 'allow');
});

test('describeWarnings: запись/чувствительный путь/команда', () => {
  const { guard, realProject } = setup();
  const w1 = guard.describeWarnings('Write', { file_path: join(realProject, 'a.txt'), content: 'x' }, realProject);
  assert.equal(w1.some((w) => /Изменение файла/.test(w)), true);
  const w2 = guard.describeWarnings('Read', { file_path: '/etc/shadow' }, realProject);
  assert.equal(w2.some((w) => /чувствительный путь/.test(w)), true);
  assert.equal(w2.some((w) => /вне workspace/.test(w)), true);
  const w3 = guard.describeWarnings('Write', { file_path: join(realProject, 'a.txt'), content: 'sudo systemctl stop x' }, realProject);
  assert.equal(w3.some((w) => /команду/.test(w)), true);
});

test('makePathGuard: недоступный workspaces root -> throw (fail-closed)', () => {
  assert.throws(() => makePathGuard({ workspacesRoot: '/definitely/not/existing', homeDir: '/tmp' }));
});
