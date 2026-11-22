import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAudit, sanitizeAuditFields } from '../../server/audit.mjs';
import { tempRoot } from './helpers.mjs';

function modeOf(p) {
  return statSync(p).mode & 0o777;
}

test('write: JSONL, 0600, метаданные только', () => {
  const root = tempRoot('audit-');
  const path = join(root, 'logs', 'audit.jsonl');
  const audit = createAudit({ path, now: () => Date.parse('2026-11-22T00:00:00Z') });
  assert.equal(audit.write('tool_request', { tool: 'Edit', sessionId: 'sess-1234-abcd', reqId: 'req-1234-abcd' }), true);
  assert.equal(audit.write('approval', { tool: 'Edit', decision: 'allow', durationMs: 42, sessionId: 'sess-1234-abcd' }), true);
  audit.close();
  assert.equal(modeOf(path), 0o600);
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'tool_request');
  assert.equal(lines[0].tool, 'Edit');
  assert.equal(lines[1].decision, 'allow');
  assert.equal(lines[1].durationMs, 42);
  assert.equal(lines[0].ts, '2026-11-22T00:00:00.000Z');
});

test('sanitize: промпты/пути/секреты/лишние поля не попадают в аудит', () => {
  const fields = sanitizeAuditFields({
    event: 'message',
    sessionId: 'sess-1234-abcd',
    tool: 'Read',
    prompt: 'SECRET PROMPT TEXT',
    text: 'user message body',
    path: '/srv/claude-web/workspaces/project/secret.txt',
    token: 'sk-ant-SUPERSECRET',
    edgeSecret: 'a'.repeat(64),
    input: { file_path: '/etc/passwd' },
    reason: 'free text reason',
  });
  assert.deepEqual(Object.keys(fields).sort(), ['event', 'sessionId', 'tool']);
  assert.equal(JSON.stringify(fields).includes('SECRET'), false);
  assert.equal(JSON.stringify(fields).includes('/etc/passwd'), false);
  assert.equal(JSON.stringify(fields).includes('a'.repeat(64)), false);
});

test('sanitize: невалидные коды/типы отбрасываются', () => {
  const fields = sanitizeAuditFields({
    event: 'UPPER CASE EVENT',
    tool: 'Bad Tool!',
    decision: 'maybe',
    code: '../etc/passwd',
    sessionId: 'short',
    durationMs: -5,
    count: 3,
    ok: true,
  });
  assert.equal(fields.event, undefined);
  assert.equal(fields.tool, undefined);
  assert.equal(fields.decision, undefined);
  assert.equal(fields.code, undefined);
  assert.equal(fields.sessionId, undefined);
  assert.equal(fields.durationMs, undefined);
  assert.equal(fields.count, 3);
  assert.equal(fields.ok, true);
});

test('rights: существующий файл с 0644 принудительно становится 0600', () => {
  const root = tempRoot('audit2-');
  const path = join(root, 'audit.jsonl');
  writeFileSync(path, '');
  chmodSync(path, 0o644);
  const audit = createAudit({ path });
  audit.write('session_create', { sessionId: 'sess-1234-abcd' });
  audit.close();
  assert.equal(modeOf(path), 0o600);
});

test('rotation: при превышении maxBytes файл ротируется в .1', () => {
  const root = tempRoot('audit3-');
  const path = join(root, 'audit.jsonl');
  const audit = createAudit({ path, maxBytes: 300 });
  for (let i = 0; i < 20; i += 1) {
    audit.write('tool_result', { tool: 'Read', sessionId: 'sess-1234-abcd', durationMs: i });
  }
  audit.close();
  assert.equal(existsSync(path), true);
  const rotated = `${path}.1`;
  assert.equal(existsSync(rotated), true);
  assert.equal(modeOf(rotated), 0o600);
  assert.equal(modeOf(path), 0o600);
  for (const p of [path, rotated]) {
    for (const line of readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
      JSON.parse(line);
    }
  }
});

test('close идемпотентен, write после close — false', () => {
  const root = tempRoot('audit4-');
  const audit = createAudit({ path: join(root, 'audit.jsonl') });
  audit.write('session_create', {});
  audit.close();
  audit.close();
  assert.equal(audit.write('session_create', {}), false);
});

test('createAudit: относительный путь запрещён', () => {
  assert.throws(() => createAudit({ path: 'relative/audit.jsonl' }));
});
