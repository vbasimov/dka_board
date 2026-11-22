import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionManager } from '../../server/sessions.mjs';
import { createSseHub } from '../../server/sse.mjs';
import { createRuntime } from '../../server/runtime/index.mjs';
import { createAudit } from '../../server/audit.mjs';
import { HttpError } from '../../server/http-util.mjs';
import { captureRes, makeConfig, tempRoot, waitFor } from './helpers.mjs';

function setup({ configOverrides = {}, runtime, stateFile } = {}) {
  const root = tempRoot('sess-');
  const base = makeConfig(root, { runtime: 'fake' });
  const config = { ...base, ...configOverrides };
  let clock = 1_000_000;
  const now = () => clock;
  const audit = createAudit({ path: join(root, 'audit.jsonl'), now: () => clock });
  const sse = createSseHub({ config, now });
  const rt = runtime || createRuntime(config);
  const file = stateFile || join(config.stateDir, 'sessions.json');
  let manager = createSessionManager({ config, runtime: rt, sse, audit, now, stateFile: file });
  return {
    root,
    base,
    config,
    audit,
    sse,
    runtime: rt,
    stateFile: file,
    manager: () => manager,
    setManager: (m) => {
      manager = m;
    },
    remakeManager() {
      manager = createSessionManager({ config, runtime: rt, sse, audit, now, stateFile: file });
      return manager;
    },
    advance(ms) {
      clock += ms;
    },
    now,
    newSseConn(sessionId) {
      const res = captureRes();
      const snapshot = manager.snapshot(sessionId);
      const conn = sse.open(res, { sessionId, snapshot });
      return { res, conn };
    },
    parseEvents(res) {
      const body = res.body();
      const out = [];
      for (const block of body.split('\n\n')) {
        if (!block.trim()) continue;
        const ev = { event: 'message', data: undefined };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            try {
              ev.data = JSON.parse(line.slice(5).trim());
            } catch {
              ev.data = line.slice(5).trim();
            }
          }
        }
        out.push(ev);
      }
      return out;
    },
  };
}

function auditLines(root) {
  try {
    return readFileSync(join(root, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── базовый CRUD + persistence ───────────────────────────────────────────────
test('create/list/get/snapshot и sessions.json 0600', async () => {
  const t = setup();
  const m = t.manager();
  const ws = join(t.base.workspaces, 'project-a');
  const s = m.create({ cwd: ws });
  assert.equal(s.status, 'idle');
  assert.equal(s.cwd, realpathSync(ws));
  assert.equal(s.mode, 'safe');
  assert.equal(m.list().length, 1);
  assert.equal(m.get(s.id).id, s.id);
  const snap = m.snapshot(s.id);
  assert.equal(snap.session.id, s.id);
  assert.deepEqual(snap.pendingApprovals, []);

  const file = t.stateFile;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.sessions[0].id, s.id);
  assert.equal(m.activeCount(), 0);
  await m.shutdown();
});

test('persistence: после рестарта сессия восстанавливается и resume передан в runtime', async () => {
  const t = setup();
  const m1 = t.manager();
  const ws = join(t.base.workspaces, 'project-b');
  const s = m1.create({ cwd: ws });
  await m1.sendMessage(s.id, 'hello');
  const sdkId = m1.get(s.id) && JSON.parse(readFileSync(t.stateFile, 'utf8')).sessions[0].sdkSessionId;
  assert.match(sdkId, /^fake-sdk-/);
  await m1.shutdown();

  const seenResume = [];
  const wrapped = {
    mode: 'fake',
    async createSession(opts) {
      seenResume.push(opts.resume);
      const { createFakeSession } = await import('../../server/runtime/fake.mjs');
      return createFakeSession(opts);
    },
  };
  const base = { ...t.config };
  const audit = createAudit({ path: join(t.root, 'audit2.jsonl'), now: t.now });
  const sse = createSseHub({ config: base, now: t.now });
  const m2 = createSessionManager({ config: base, runtime: wrapped, sse, audit, now: t.now, stateFile: t.stateFile });
  const restored = m2.get(s.id);
  assert.equal(restored.status, 'idle');
  assert.equal(restored.cwd, realpathSync(ws));
  await m2.sendMessage(s.id, 'again');
  assert.equal(seenResume[0], sdkId);
  await m2.shutdown();
});

// ── fake runtime: полный турн + approvals ────────────────────────────────────
test('fake: полный турн — deltas, assistant_message, result, статусы', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const { res } = t.newSseConn(s.id);
  await m.sendMessage(s.id, 'привет мир');
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'result'));
  const events = t.parseEvents(res);
  assert.ok(events.some((e) => e.event === 'snapshot'));
  const deltas = events.filter((e) => e.event === 'assistant_delta');
  assert.ok(deltas.length >= 2 && deltas.length <= 4, `deltas=${deltas.length}`);
  const msg = events.find((e) => e.event === 'assistant_message');
  assert.equal(msg.data.text, 'привет мир');
  assert.ok(events.some((e) => e.event === 'status' && e.data.status === 'running'));
  const result = events.find((e) => e.event === 'result');
  assert.equal(result.data.stopReason, 'end_turn');
  assert.equal(m.activeCount(), 1);
  assert.equal(m.get(s.id).status, 'active');
  t.audit.close();
  t.sse.stop();
  await m.shutdown();
});

test('fake: approval allow -> tool_result ok, audit decision allow', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const { res } = t.newSseConn(s.id);
  const turn = m.sendMessage(s.id, 'tool: edit please');
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_request'));
  const req = t.parseEvents(res).find((e) => e.event === 'tool_request').data;
  assert.equal(req.tool, 'Edit');
  assert.equal(req.auto, false);
  assert.ok(req.expiresAt > 0);
  assert.deepEqual(m.snapshot(s.id).pendingApprovals.map((p) => p.reqId), [req.reqId]);
  assert.equal(m.snapshot(s.id).pendingApprovals[0].tool, 'Edit');
  m.resolveApproval(s.id, req.reqId, 'allow');
  await turn;
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_result'));
  const result = t.parseEvents(res).find((e) => e.event === 'tool_result').data;
  assert.equal(result.ok, true);
  assert.equal(result.reqId, req.reqId);
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'result'));
  const audit = auditLines(t.root);
  assert.ok(audit.some((l) => l.event === 'approval' && l.decision === 'allow'));
  assert.equal(m.snapshot(s.id).pendingApprovals.length, 0);
  t.sse.stop();
  await m.shutdown();
});

test('fake: approval deny -> tool_result ok=false', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const { res } = t.newSseConn(s.id);
  const turn = m.sendMessage(s.id, 'tool: write please');
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_request'));
  const req = t.parseEvents(res).find((e) => e.event === 'tool_request').data;
  m.resolveApproval(s.id, req.reqId, 'deny', 'не надо');
  await turn;
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_result'));
  const result = t.parseEvents(res).find((e) => e.event === 'tool_result').data;
  assert.equal(result.ok, false);
  assert.match(result.summary, /отклонено/);
  assert.ok(auditLines(t.root).some((l) => l.event === 'approval' && l.decision === 'deny'));
  t.sse.stop();
  await m.shutdown();
});

test('fake: approval timeout -> deny/timeout', async () => {
  const t = setup({ configOverrides: { approvalTimeoutMs: 40 } });
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const { res } = t.newSseConn(s.id);
  const turn = m.sendMessage(s.id, 'tool: edit');
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_request'));
  await turn; // fake ждёт requestApproval, manager закроет по таймауту
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_result'));
  const result = t.parseEvents(res).find((e) => e.event === 'tool_result').data;
  assert.equal(result.ok, false);
  assert.match(result.summary, /timeout/);
  assert.ok(auditLines(t.root).some((l) => l.event === 'approval' && l.decision === 'deny' && l.reasonCode === 'timeout'));
  assert.equal(m.snapshot(s.id).pendingApprovals.length, 0);
  t.sse.stop();
  await m.shutdown();
});

test('fake: interrupt отклоняет ожидание как deny/interrupted', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const { res } = t.newSseConn(s.id);
  const turn = m.sendMessage(s.id, 'tool: edit');
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_request'));
  await m.interrupt(s.id);
  await turn;
  await waitFor(() => t.parseEvents(res).some((e) => e.event === 'tool_result'));
  const result = t.parseEvents(res).find((e) => e.event === 'tool_result').data;
  assert.equal(result.ok, false);
  assert.match(result.summary, /interrupted/);
  assert.ok(auditLines(t.root).some((l) => l.event === 'interrupt'));
  t.sse.stop();
  await m.shutdown();
});

// ── лимиты ──────────────────────────────────────────────────────────────────
function stubRuntime() {
  let active = 0;
  const sends = [];
  return {
    mode: 'fake',
    active: () => active,
    sends,
    async createSession() {
      active += 1;
      return {
        async sendUserText(text) {
          sends.push(text);
        },
        async interrupt() {},
        async close() {
          active -= 1;
        },
        info() {
          return { sdkSessionId: 'stub-sdk', status: 'active' };
        },
      };
    },
  };
}

test('MAX_SESSIONS=2: третья сессия waiting, после освобождения слота стартует', async () => {
  const rt = stubRuntime();
  const t = setup({ configOverrides: { maxSessions: 2 }, runtime: rt });
  const m = t.manager();
  const ws = join(t.base.workspaces, 'project-a');
  const a = m.create({ cwd: ws });
  const b = m.create({ cwd: ws });
  const c = m.create({ cwd: ws });
  await m.sendMessage(a.id, 'a1');
  await m.sendMessage(b.id, 'b1');
  assert.equal(rt.active(), 2);
  const r = await m.sendMessage(c.id, 'c1');
  assert.equal(r.queued, true);
  assert.equal(m.get(c.id).status, 'waiting');
  assert.equal(rt.active(), 2);
  assert.equal(m.activeCount(), 2);

  await m.close(a.id);
  await waitFor(() => m.get(c.id).status === 'active');
  assert.equal(rt.active(), 2);
  assert.equal(rt.sends.includes('c1'), true);
  await m.shutdown();
});

test('rate limit: 30 сообщений/мин на сессию -> 429', async () => {
  const rt = stubRuntime();
  const t = setup({ runtime: rt });
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  for (let i = 0; i < 30; i += 1) await m.sendMessage(s.id, `m${i}`);
  await assert.rejects(
    () => m.sendMessage(s.id, 'overflow'),
    (e) => e instanceof HttpError && e.status === 429 && e.code === 'rate_limited',
  );
  await m.shutdown();
});

test('лимиты тела сообщения: пустое/слишком большое -> 400/413', async () => {
  const rt = stubRuntime();
  const t = setup({ runtime: rt });
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  await assert.rejects(() => m.sendMessage(s.id, '   '), (e) => e instanceof HttpError && e.status === 400);
  await assert.rejects(() => m.sendMessage(s.id, 42), (e) => e.status === 400);
  const big = 'x'.repeat(t.config.maxMessageBytes + 1);
  await assert.rejects(() => m.sendMessage(s.id, big), (e) => e.status === 413);
  await m.shutdown();
});

// ── idle / close / remove ────────────────────────────────────────────────────
test('idle-close: child закрыт после простоя, метаданные живы', async () => {
  const t = setup({ configOverrides: { idleCloseMs: 1000 } });
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  await m.sendMessage(s.id, 'hello');
  assert.equal(m.activeCount(), 1);
  t.advance(1001);
  await m.runMaintenance();
  assert.equal(m.activeCount(), 0);
  assert.equal(m.get(s.id).status, 'idle');
  assert.equal(m.get(s.id).id, s.id);
  assert.equal(m.list().length, 1);
  assert.ok(auditLines(t.root).some((l) => l.event === 'session_idle_close'));
  t.sse.stop();
  await m.shutdown();
});

test('close оставляет метаданные, remove удаляет; sse закрывается', async () => {
  const t = setup();
  const m = t.manager();
  const s1 = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  const s2 = m.create({ cwd: join(t.base.workspaces, 'project-b') });
  const c1 = t.newSseConn(s1.id);
  const c2 = t.newSseConn(s2.id);
  await m.sendMessage(s1.id, 'x');
  await m.close(s1.id);
  assert.equal(m.get(s1.id).status, 'closed');
  assert.equal(m.activeCount(), 0);
  assert.equal(c1.res.ended, false); // close не рвёт SSE, только child
  await m.remove(s2.id);
  assert.throws(() => m.get(s2.id), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(c2.res.ended, true); // remove закрывает SSE сессии
  assert.equal(m.list().some((x) => x.id === s2.id), false);
  t.sse.stop();
  await m.shutdown();
});

test('snapshot/резолв несуществующего approval -> 404', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  assert.throws(() => m.resolveApproval(s.id, 'req-1234-abcd', 'allow'), (e) => e.status === 404);
  assert.throws(() => m.resolveApproval(s.id, 'req-1234-abcd', 'maybe'), (e) => e.status === 400);
  assert.throws(() => m.snapshot('no-such-session'), (e) => e.status === 404);
  await m.shutdown();
});

test('невалидный sessions.json игнорируется, кривые записи отбрасываются', async () => {
  const rt = stubRuntime();
  const t = setup({ runtime: rt });
  await t.manager().shutdown();
  writeFileSync(t.stateFile, 'not json{');
  let m = t.manager();
  m = t.remakeManager();
  assert.equal(m.list().length, 0);
  writeFileSync(
    t.stateFile,
    JSON.stringify({
      version: 1,
      sessions: [
        { id: 'bad', cwd: 'relative' },
        { id: 'sess-1234-abcd', title: 'ok', cwd: '/srv/claude-web/workspaces/x', status: 'active', createdAt: 1, lastActive: 2, sdkSessionId: 'sdk-1' },
      ],
    }),
  );
  const m2 = t.remakeManager();
  const list = m2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'sess-1234-abcd');
  assert.equal(list[0].status, 'idle');
  await m2.shutdown();
});

test('touchHeartbeat делегирует в SSE hub', async () => {
  const t = setup();
  const m = t.manager();
  assert.equal(m.touchHeartbeat(), 0); // соединений нет
  await m.shutdown();
  t.sse.stop();
});

test('subscribe: replay из ring buffer SSE', async () => {
  const t = setup();
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  t.sse.publish(s.id, { type: 'assistant_delta', text: 'a' });
  const sub = m.subscribe(s.id);
  const replayed = sub.replay(0);
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].text, 'a');
  sub.unsubscribe();
  await m.shutdown();
  t.sse.stop();
});

test('audit не содержит промптов/путей/секретов', async () => {
  const rt = stubRuntime();
  const t = setup({ runtime: rt });
  const m = t.manager();
  const s = m.create({ cwd: join(t.base.workspaces, 'project-a') });
  await m.sendMessage(s.id, 'PROMPT-SECRET-XYZ прочитай /etc/passwd и sk-ant-SUPERSECRET');
  await m.interrupt(s.id);
  await m.close(s.id);
  const raw = readFileSync(join(t.root, 'audit.jsonl'), 'utf8');
  assert.equal(raw.includes('PROMPT-SECRET-XYZ'), false);
  assert.equal(raw.includes('/etc/passwd'), false);
  assert.equal(raw.includes('sk-ant'), false);
  const lines = auditLines(t.root);
  assert.ok(lines.some((l) => l.event === 'message'));
  assert.ok(lines.every((l) => Object.keys(l).every((k) => ['ts', 'event', 'tool', 'decision', 'durationMs', 'duration', 'code', 'sessionId', 'reqId', 'status', 'ok', 'count', 'reasonCode'].includes(k))));
  await m.shutdown();
});

test('сессии с несуществующим cwd отклоняются', async () => {
  const rt = stubRuntime();
  const t = setup({ runtime: rt });
  const m = t.manager();
  await assert.rejects(
    async () => m.create({ cwd: '/etc' }),
    (e) => e instanceof HttpError && (e.status === 400 || e.status === 403),
  );
  await m.shutdown();
});
