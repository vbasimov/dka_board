import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createApp } from '../../server/app.mjs';
import { createAudit } from '../../server/audit.mjs';
import { createSseHub } from '../../server/sse.mjs';
import { createRuntime } from '../../server/runtime/index.mjs';
import { createSessionManager } from '../../server/sessions.mjs';
import {
  apiRequest,
  collectSse,
  makeConfig,
  makeDist,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  startServer,
  stopServer,
  tempRoot,
  USER_HASH,
} from './helpers.mjs';

async function setup() {
  const root = tempRoot('app-');
  const config = makeConfig(root, { runtime: 'fake' });
  const distDir = makeDist(root);
  const audit = createAudit({ path: config.auditLog });
  const sse = createSseHub({ config });
  const runtime = createRuntime(config);
  const sessions = createSessionManager({ config, runtime, sse, audit });
  const app = createApp({ config, deps: { sessions, sse, audit, runtime, distDir, version: '9.9.9-test' } });
  const { server, port } = await startServer(app);
  return {
    root,
    config,
    distDir,
    audit,
    sse,
    sessions,
    app,
    server,
    port,
    async cleanup() {
      await sessions.shutdown();
      sse.stop();
      audit.close();
      await stopServer(server);
    },
  };
}

test('auth gate: edge/user/host/origin/fetch-site/loopback + CSP на всех ответах', async () => {
  const t = await setup();
  try {
    const noEdge = await apiRequest(t.port, { headers: { 'X-Claude-Edge': '' } });
    assert.equal(noEdge.status, 403);
    const wrongUser = await apiRequest(t.port, { headers: { 'X-Auth-User': 'deadbeef0001' } });
    assert.equal(wrongUser.status, 403);
    const badHost = await apiRequest(t.port, { headers: { Host: 'evil.example' } });
    assert.equal(badHost.status, 403);
    const badOrigin = await apiRequest(t.port, { headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status, 403);
    const crossSite = await apiRequest(t.port, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const ok = await apiRequest(t.port);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.mode, 'fake');
    assert.equal(ok.json.version, '9.9.9-test');
    assert.equal(ok.json.max, 2);
    assert.match(ok.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal(ok.headers['cache-control'], 'no-store');
  } finally {
    await t.cleanup();
  }
});

test('POST: Content-Type application/json обязателен, origin обязателен', async () => {
  const t = await setup();
  try {
    const ct = await apiRequest(t.port, {
      method: 'POST',
      path: '/claude/api/heartbeat',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert.equal(ct.status, 415);
    assert.equal(ct.json.code, 'unsupported_media_type');

    const noOrigin = await apiRequest(t.port, {
      method: 'POST',
      path: '/claude/api/heartbeat',
      headers: { Origin: '' },
      body: {},
    });
    assert.equal(noOrigin.status, 403);
  } finally {
    await t.cleanup();
  }
});

test('/claude -> 308 /claude/', async () => {
  const t = await setup();
  try {
    const res = await apiRequest(t.port, { path: '/claude' });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, '/claude/');
  } finally {
    await t.cleanup();
  }
});

test('статика через app: index, sw.js, assets, manifest, traversal/symlink', async () => {
  const t = await setup();
  try {
    const index = await apiRequest(t.port, { path: '/claude/' });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.text, /SPA/);

    const sw = await apiRequest(t.port, { path: '/claude/sw.js' });
    assert.equal(sw.status, 200);
    assert.equal(sw.headers['cache-control'], 'no-store');
    assert.equal(sw.headers['service-worker-allowed'], undefined);

    const asset = await apiRequest(t.port, { path: '/claude/assets/app.js' });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=86400, immutable');

    const manifest = await apiRequest(t.port, { path: '/claude/manifest.webmanifest' });
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers['content-type'], /application\/manifest\+json/);

    const icon = await apiRequest(t.port, { path: '/claude/icons/icon-192.png' });
    assert.equal(icon.status, 200);

    const traversal = await apiRequest(t.port, { path: '/claude/%2e%2e/outside-secret.txt' });
    assert.equal(traversal.status, 404);
    assert.equal(traversal.text.includes('TOP-SECRET'), false);

    const leak = await apiRequest(t.port, { path: '/claude/leak.txt' });
    assert.equal(leak.status, 404);
    assert.equal(leak.text.includes('TOP-SECRET'), false);

    const unknown = await apiRequest(t.port, { path: '/claude/api/nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'not_found');
  } finally {
    await t.cleanup();
  }
});

test('api sessions: create/list/get/message/close/delete/heartbeat', async () => {
  const t = await setup();
  try {
    const ws = join(t.config.workspaces, 'project-a');
    const created = await apiRequest(t.port, { method: 'POST', path: '/claude/api/sessions', body: { cwd: ws } });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.ok(id);

    const list = await apiRequest(t.port, { path: '/claude/api/sessions' });
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].id, id);

    const one = await apiRequest(t.port, { path: `/claude/api/sessions/${id}` });
    assert.equal(one.status, 200);
    assert.equal(one.json.session.id, id);

    const msg = await apiRequest(t.port, {
      method: 'POST',
      path: `/claude/api/sessions/${id}/messages`,
      body: { text: 'hello http' },
    });
    assert.equal(msg.status, 202);
    assert.equal(msg.json.ok, true);

    const hb = await apiRequest(t.port, { method: 'POST', path: '/claude/api/heartbeat', body: {} });
    assert.equal(hb.status, 200);
    assert.equal(hb.json.ok, true);
    assert.equal(typeof hb.json.ts, 'number');

    const interrupt = await apiRequest(t.port, {
      method: 'POST',
      path: `/claude/api/sessions/${id}/interrupt`,
      body: {},
    });
    assert.equal(interrupt.status, 200);

    const close = await apiRequest(t.port, { method: 'POST', path: `/claude/api/sessions/${id}/close`, body: {} });
    assert.equal(close.status, 200);

    const del = await apiRequest(t.port, { method: 'DELETE', path: `/claude/api/sessions/${id}` });
    assert.equal(del.status, 200);
    const gone = await apiRequest(t.port, { path: `/claude/api/sessions/${id}` });
    assert.equal(gone.status, 404);
  } finally {
    await t.cleanup();
  }
});

test('api: 405 на неверный метод, 400/413 на плохое тело', async () => {
  const t = await setup();
  try {
    const mna = await apiRequest(t.port, { method: 'DELETE', path: '/claude/api/sessions' });
    assert.equal(mna.status, 405);

    const bad = await apiRequest(t.port, { method: 'POST', path: '/claude/api/sessions', body: { cwd: 123 } });
    assert.equal(bad.status, 400);

    const big = await apiRequest(t.port, {
      method: 'POST',
      path: '/claude/api/sessions',
      body: JSON.stringify({ cwd: 'x'.repeat(t.config.maxBodyBytes + 100) }),
    });
    assert.equal(big.status, 413);
    assert.equal(big.json.code, 'payload_too_large');

    const heartbeat = await apiRequest(t.port, {
      method: 'POST',
      path: '/claude/api/heartbeat',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    assert.equal(heartbeat.status, 400);
  } finally {
    await t.cleanup();
  }
});

test('SSE через app: snapshot + поток турна fake runtime', async () => {
  const t = await setup();
  try {
    const ws = join(t.config.workspaces, 'project-a');
    const created = await apiRequest(t.port, { method: 'POST', path: '/claude/api/sessions', body: { cwd: ws } });
    const id = created.json.id;

    const ssePromise = collectSse(t.port, `/claude/api/sessions/${id}/events`, {
      until: (events) => events.some((e) => e.event === 'result'),
      timeoutMs: 5000,
    });
    const msg = await apiRequest(t.port, {
      method: 'POST',
      path: `/claude/api/sessions/${id}/messages`,
      body: { text: 'привет sse' },
    });
    assert.equal(msg.status, 202);
    const { events, reason } = await ssePromise;
    assert.equal(reason, 'until');
    assert.equal(events[0].event, 'snapshot');
    assert.equal(events[0].data.session.id, id);
    assert.ok(events.some((e) => e.event === 'assistant_delta'));
    assert.ok(events.some((e) => e.event === 'assistant_message'));
    assert.ok(events.some((e) => e.event === 'result' && e.data.text === 'привет sse'));
    assert.ok(events.some((e) => e.event === 'status' && e.data.status === 'running'));
    // последующие (после result) события не важны; соединение закрыто клиентом
  } finally {
    await t.cleanup();
  }
});

test('SSE + approval через app: tool_request -> POST approvals -> tool_result', async () => {
  const t = await setup();
  try {
    const ws = join(t.config.workspaces, 'project-a');
    const created = await apiRequest(t.port, { method: 'POST', path: '/claude/api/sessions', body: { cwd: ws } });
    const id = created.json.id;

    const reqPromise = collectSse(t.port, `/claude/api/sessions/${id}/events`, {
      until: (events) => events.some((e) => e.event === 'tool_request'),
      timeoutMs: 5000,
    });
    const msgPromise = apiRequest(t.port, {
      method: 'POST',
      path: `/claude/api/sessions/${id}/messages`,
      body: { text: 'tool: edit file' },
    });
    const { events } = await reqPromise;
    const toolRequest = events.find((e) => e.event === 'tool_request').data;
    assert.equal(toolRequest.tool, 'Edit');

    const snapshotWithPending = await apiRequest(t.port, { path: `/claude/api/sessions/${id}` });
    assert.equal(snapshotWithPending.json.pendingApprovals.length, 1);

    const approval = await apiRequest(t.port, {
      method: 'POST',
      path: `/claude/api/sessions/${id}/approvals/${toolRequest.reqId}`,
      body: { decision: 'allow' },
    });
    assert.equal(approval.status, 200);
    const msg = await msgPromise;
    assert.equal(msg.status, 202);

    const after = await apiRequest(t.port, { path: `/claude/api/sessions/${id}` });
    assert.equal(after.json.pendingApprovals.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('auth не пропускает даже на статику (sw.js/manifest) без сессии', async () => {
  const t = await setup();
  try {
    for (const path of ['/claude/', '/claude/sw.js', '/claude/manifest.webmanifest']) {
      const res = await apiRequest(t.port, { path, headers: { 'X-Claude-Edge': 'f'.repeat(64) } });
      assert.equal(res.status, 403, path);
    }
  } finally {
    await t.cleanup();
  }
});

test('SPA fallback отдаёт index.html на навигацию', async () => {
  const t = await setup();
  try {
    const res = await apiRequest(t.port, { path: '/claude/sessions/anything', headers: { Accept: 'text/html' } });
    assert.equal(res.status, 200);
    assert.match(res.text, /SPA/);
  } finally {
    await t.cleanup();
  }
});

test('сессия создаётся только с cwd из workspace', async () => {
  const t = await setup();
  try {
    const bad = await apiRequest(t.port, { method: 'POST', path: '/claude/api/sessions', body: { cwd: '/etc' } });
    assert.ok([400, 403].includes(bad.status));
    const good = await apiRequest(t.port, {
      method: 'POST',
      path: '/claude/api/sessions',
      body: { cwd: join(t.config.workspaces, 'project-b') },
    });
    assert.equal(good.status, 201);
  } finally {
    await t.cleanup();
  }
});

test('заголовки ответа: Host spoofing и прямой доступ без edge невозможны', async () => {
  const t = await setup();
  try {
    // Caddy в проде вырезает X-Auth-*; здесь проверяем, что без edge нельзя даже с user
    const res = await apiRequest(t.port, {
      auth: 'none',
      headers: { 'X-Auth-User': USER_HASH, Host: PUBLIC_HOST, Origin: PUBLIC_ORIGIN },
    });
    // edge отсутствует → 403
    assert.equal(res.status, 403);
  } finally {
    await t.cleanup();
  }
});
