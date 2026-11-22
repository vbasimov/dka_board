import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseHub } from '../../server/sse.mjs';
import { captureRes, makeConfig, tempRoot } from './helpers.mjs';

function parseSse(body) {
  const events = [];
  for (const block of body.split('\n\n')) {
    if (!block.trim()) continue;
    const ev = { event: 'message', data: undefined, id: undefined };
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim());
      else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        try {
          ev.data = JSON.parse(raw);
        } catch {
          ev.data = raw;
        }
      }
    }
    events.push(ev);
  }
  return events;
}

function setup(overrides = {}) {
  const root = tempRoot('sse-');
  const base = makeConfig(root);
  const config = {
    ...base,
    sseMaxMs: 60_000,
    sseHeartbeatTimeoutMs: 120_000,
    ...overrides,
  };
  let clock = 1_000_000;
  const hub = createSseHub({ config, now: () => clock });
  return {
    hub,
    config,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

function openConn(hub, { sessionId = 's1', snapshot = { session: { id: sessionId }, pendingApprovals: [] }, lastEventId } = {}) {
  const res = captureRes();
  const conn = hub.open(res, { sessionId, snapshot, lastEventId });
  return { res, conn };
}

test('open: заголовки SSE и snapshot первым событием', () => {
  const { hub } = setup();
  const { res, conn } = openConn(hub, { snapshot: { session: { id: 's1', status: 'idle' }, pendingApprovals: [] } });
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader('content-type'), /text\/event-stream/);
  assert.equal(res.getHeader('cache-control'), 'no-store');
  assert.equal(res.getHeader('x-accel-buffering'), 'no');
  const events = parseSse(res.body());
  assert.equal(events[0].event, 'snapshot');
  assert.equal(events[0].data.session.id, 's1');
  assert.equal(events[0].id, 0);
  assert.ok(conn.id);
  hub.stop();
});

test('publish: события клиенту, type отдельно, payload без type', () => {
  const { hub } = setup();
  const { res } = openConn(hub);
  hub.publish('s1', { type: 'assistant_delta', text: 'hel' });
  hub.publish('s1', { type: 'assistant_delta', text: 'lo' });
  const events = parseSse(res.body()).filter((e) => e.event !== 'snapshot');
  assert.deepEqual(
    events.map((e) => [e.event, e.data, e.id]),
    [
      ['assistant_delta', { text: 'hel' }, 1],
      ['assistant_delta', { text: 'lo' }, 2],
    ],
  );
  hub.stop();
});

test('ring buffer: хранит 200 последних, replay отдаёт только новее', () => {
  const { hub } = setup();
  for (let i = 1; i <= 205; i += 1) hub.publish('s1', { type: 'assistant_delta', text: `t${i}` });
  const all = hub.replay('s1', 0);
  assert.equal(all.length, 200);
  assert.equal(all[0].id, 6);
  assert.equal(all.at(-1).id, 205);
  const newer = hub.replay('s1', 200);
  assert.deepEqual(newer.map((e) => e.id), [201, 202, 203, 204, 205]);
  hub.stop();
});

test('replay по Last-Event-ID при открытии: snapshot + пропущенные события', () => {
  const { hub } = setup();
  hub.publish('s1', { type: 'assistant_delta', text: 'a' });
  hub.publish('s1', { type: 'assistant_delta', text: 'b' });
  hub.publish('s1', { type: 'assistant_delta', text: 'c' });
  const { res } = openConn(hub, { lastEventId: 1 });
  const events = parseSse(res.body());
  assert.equal(events[0].event, 'snapshot');
  assert.equal(events[0].id, 3);
  assert.deepEqual(
    events.slice(1).map((e) => e.id),
    [2, 3],
  );
  hub.stop();
});

test('без Last-Event-ID replay не дублирует snapshot', () => {
  const { hub } = setup();
  hub.publish('s1', { type: 'assistant_delta', text: 'a' });
  const { res } = openConn(hub);
  const events = parseSse(res.body());
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'snapshot');
  hub.stop();
});

test('heartbeat: закрытие через SSE_HEARTBEAT_TIMEOUT_MS без heartbeat', () => {
  const { hub, advance } = setup({ sseHeartbeatTimeoutMs: 1000 });
  const { res, conn } = openConn(hub);
  advance(999);
  hub.tick();
  assert.equal(conn.closed, false);
  advance(2);
  hub.tick();
  assert.equal(conn.closed, true);
  assert.equal(conn.closeReason, 'heartbeat_timeout');
  assert.equal(res.ended, true);
  hub.stop();
});

test('heartbeat: успешный touchHeartbeat продлевает соединение', () => {
  const { hub, advance } = setup({ sseHeartbeatTimeoutMs: 1000 });
  const { conn } = openConn(hub);
  advance(900);
  hub.touchHeartbeat();
  advance(900);
  hub.tick();
  assert.equal(conn.closed, false);
  advance(120);
  hub.tick();
  assert.equal(conn.closed, true);
  hub.stop();
});

test('SSE_MAX_MS закрывает соединение даже при heartbeat', () => {
  const { hub, advance } = setup({ sseMaxMs: 5000, sseHeartbeatTimeoutMs: 120_000 });
  const { conn } = openConn(hub);
  advance(3000);
  hub.touchHeartbeat();
  advance(2100);
  hub.tick();
  assert.equal(conn.closed, true);
  assert.equal(conn.closeReason, 'max_duration');
  hub.stop();
});

test('ping каждые 15 c', () => {
  const { hub, advance } = setup({ sseHeartbeatTimeoutMs: 1_000_000, sseMaxMs: 1_000_000 });
  const { res } = openConn(hub);
  advance(15_000);
  hub.tick();
  const pings = parseSse(res.body()).filter((e) => e.event === 'ping');
  assert.equal(pings.length, 1);
  assert.equal(pings[0].id, undefined);
  hub.stop();
});

test('closeSession/closeAll закрывают только свои соединения', () => {
  const { hub } = setup();
  const a = openConn(hub, { sessionId: 'a' });
  const b = openConn(hub, { sessionId: 'b' });
  hub.closeSession('a');
  assert.equal(a.conn.closed, true);
  assert.equal(a.res.ended, true);
  assert.equal(b.conn.closed, false);
  hub.closeAll();
  assert.equal(b.conn.closed, true);
  assert.equal(hub.connectionCount(), 0);
  hub.stop();
});

test('внутренние события (_*) не уходят клиенту', () => {
  const { hub } = setup();
  const { res } = openConn(hub);
  const id = hub.publish('s1', { type: '_sdk_session_id', sdkSessionId: 'x' });
  assert.equal(id, 0);
  assert.equal(parseSse(res.body()).length, 1);
  hub.stop();
});
