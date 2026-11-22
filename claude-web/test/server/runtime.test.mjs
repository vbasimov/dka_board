import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRuntime } from '../../server/runtime/index.mjs';
import {
  buildChildEnv,
  buildSdkOptions,
  DISALLOWED_TOOLS,
  mapSdkMessage,
  PERMISSION_DENY_RULES,
  SAFE_TOOLS,
} from '../../server/runtime/sdk.mjs';
import { loadConfig } from '../../server/config.mjs';
import { makeConfig, makeEnv, tempRoot, waitFor } from './helpers.mjs';

// ── fake runtime (CONTRACT §3) ──────────────────────────────────────────────
function fakeSession(overrides = {}) {
  const root = tempRoot('rt-');
  const config = makeConfig(root, { runtime: 'fake' });
  // config не нужен fake-сессии; собираем напрямую
  return { config, root, workspace: join(config.workspaces, 'project-a') };
}

async function createFake(opts = {}) {
  const { config, workspace } = fakeSession();
  const runtime = createRuntime({ ...config, runtimeMode: 'fake' });
  const events = [];
  const approvals = [];
  const pending = [];
  const session = await runtime.createSession({
    sessionId: 'sess-1234-abcd',
    cwd: workspace,
    resume: opts.resume,
    emit: (e) => events.push(e),
    requestApproval:
      opts.requestApproval ||
      ((req) => {
        approvals.push(req);
        return new Promise((resolve) => pending.push(resolve));
      }),
  });
  return { session, events, approvals, pending, runtime };
}

test('fake runtime: deltas -> assistant_message -> result', async () => {
  const { session, events, runtime } = await createFake();
  assert.equal(runtime.mode, 'fake');
  await session.sendUserText('привет');
  const types = events.map((e) => e.type);
  assert.equal(types[0], '_sdk_session_id');
  assert.ok(types.filter((t) => t === 'assistant_delta').length >= 2);
  assert.equal(types.at(-1), 'result');
  const msg = events.find((e) => e.type === 'assistant_message');
  assert.equal(msg.text, 'привет');
  assert.equal(session.info().status, 'idle');
  await session.close();
  await session.close(); // идемпотентно
});

test('fake runtime: tool_request -> approval -> tool_result', async () => {
  const { session, events, pending, approvals } = await createFake();
  const turn = session.sendUserText('tool: write file');
  await waitFor(() => approvals.length === 1);
  assert.equal(approvals[0].tool, 'Write');
  assert.ok(approvals[0].reqId);
  assert.ok(Array.isArray(approvals[0].warnings));
  const req = events.find((e) => e.type === 'tool_request');
  assert.equal(req, undefined); // tool_request эмитит менеджер, не fake
  pending[0]({ decision: 'allow' });
  await turn;
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.ok, true);
  assert.equal(result.reqId, approvals[0].reqId);
});

test('fake runtime: interrupt обрывает поток', async () => {
  const { session, events } = await createFake();
  const turn = session.sendUserText('slow long text with many words to stream');
  await waitFor(() => events.some((e) => e.type === 'assistant_delta'));
  await new Promise((r) => setTimeout(r, 3));
  await session.interrupt();
  await turn;
  const result = events.find((e) => e.type === 'result');
  assert.ok(result);
  assert.equal(result.stopReason, 'interrupted');
});

test('fake runtime: send после close отклоняется', async () => {
  const { session } = await createFake();
  await session.close();
  await assert.rejects(() => session.sendUserText('x'));
});

test('createRuntime: fake режим не трогает SDK', async () => {
  const rt = createRuntime({ runtimeMode: 'fake' });
  assert.equal(rt.mode, 'fake');
  assert.equal(typeof rt.createSession, 'function');
});

// ── SDK path: чистые функции (без установленного SDK) ──────────────────────
function sdkConfig() {
  // loadConfig создаёт секреты non-enumerable — спред бы их потерял
  return loadConfig(makeEnv(tempRoot('sdk-')));
}

test('buildChildEnv: минимальный allowlist, без EDGE_SECRET/DSH-переменных', () => {
  const cfg = sdkConfig();
  const env = buildChildEnv(cfg);
  assert.deepEqual(Object.keys(env).sort(), [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'DISABLE_AUTOUPDATER',
    'DO_NOT_TRACK',
    'HOME',
    'PATH',
  ]);
  assert.equal(env.HOME, cfg.home);
  assert.equal(env.CLAUDE_CONFIG_DIR, cfg.claudeConfigDir);
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.DO_NOT_TRACK, '1');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, cfg.oauthToken);
  assert.equal('EDGE_SECRET' in env, false);
  assert.equal(Object.keys(env).some((k) => k.startsWith('DSH')), false);
  assert.equal(JSON.stringify(env).includes('not-real'), true); // токен есть только в env
});

test('buildSdkOptions: safe-режим, никаких bypass/allow-правил', () => {
  const cfg = sdkConfig();
  const options = buildSdkOptions({
    config: cfg,
    cwd: '/srv/claude-web/workspaces/x',
    resume: 'sdk-session-1',
    canUseTool: () => {},
    hooks: {},
  });
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(options.disallowedTools, [...DISALLOWED_TOOLS]);
  for (const tool of ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
    assert.ok(options.disallowedTools.includes(tool), tool);
  }
  assert.deepEqual(options.tools, [...SAFE_TOOLS]);
  assert.deepEqual(options.additionalDirectories, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.maxTurns, 30);
  assert.equal(options.resume, 'sdk-session-1');
  assert.equal(options.allowedTools, undefined);
  assert.equal(options.permissions, undefined);
  assert.equal(options.settings.permissions.allow, undefined);
  assert.equal(options.settings.permissions.defaultMode, undefined);
  assert.equal(options.settings.permissions.disableBypassPermissionsMode, undefined);
  // deny-правила — defense in depth
  for (const needle of ['//proc/', '//etc/', '//var/lib/claude-web/', '//var/log/claude-web/', '~/.claude', '~/.dsh']) {
    assert.ok(options.settings.permissions.deny.some((r) => r.includes(needle)), needle);
  }
  assert.deepEqual(options.env, buildChildEnv(cfg));
});

test('buildSdkOptions: без resume поле не выставляется, abortController прокидывается', () => {
  const cfg = sdkConfig();
  const abort = new AbortController();
  const options = buildSdkOptions({ config: cfg, cwd: '/tmp', canUseTool: () => {}, hooks: {}, abortController: abort });
  assert.equal('resume' in options, false);
  assert.equal(options.abortController, abort);
});

test('PERMISSION_DENY_RULES покрывает секретные пути', () => {
  const joined = PERMISSION_DENY_RULES.join('\n');
  for (const p of ['//proc/', '//sys/', '//etc/', '//root/', '//var/lib/claude-web/', '//var/log/claude-web/', '~/.claude', '~/.dsh', '~/.ssh', '~/.gnupg', '.env']) {
    assert.ok(joined.includes(p), p);
  }
});

test('mapSdkMessage: init -> SDK session id (для resume)', () => {
  const evs = mapSdkMessage({ type: 'system', subtype: 'init', session_id: 'sdk-abc' });
  assert.deepEqual(evs, [{ type: '_sdk_session_id', sdkSessionId: 'sdk-abc' }]);
  assert.deepEqual(mapSdkMessage({ type: 'system', subtype: 'status', status: 'compacting' }), [
    { type: 'status', status: 'running' },
  ]);
});

test('mapSdkMessage: streaming delta только text_delta', () => {
  const text = mapSdkMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  });
  assert.deepEqual(text, [{ type: 'assistant_delta', text: 'hi' }]);
  const thinking = mapSdkMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
  });
  assert.deepEqual(thinking, []);
});

test('mapSdkMessage: assistant text и auth-ошибка без утечек', () => {
  const evs = mapSdkMessage({
    type: 'assistant',
    message: { id: 'msg1', content: [{ type: 'text', text: 'ответ' }] },
  });
  assert.deepEqual(evs, [{ type: 'assistant_message', text: 'ответ', messageId: 'msg1' }]);

  const auth = mapSdkMessage({
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'secret prompt text' }] },
  });
  const err = auth.find((e) => e.type === 'error');
  assert.ok(err);
  assert.equal(err.code, 'auth_expired');
  assert.equal(err.message.includes('secret'), false);
});

test('mapSdkMessage: result success/error', () => {
  const ok = mapSdkMessage({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: { input_tokens: 1 },
    stop_reason: 'end_turn',
  });
  assert.deepEqual(ok, [
    { type: 'result', text: 'done', usage: { input_tokens: 1 }, stopReason: 'end_turn' },
  ]);
  const err = mapSdkMessage({ type: 'result', subtype: 'error_during_execution', errors: ['/etc/secret'] });
  assert.deepEqual(err, [{ type: 'error', code: 'turn_failed', message: 'Ход завершился ошибкой' }]);
  assert.equal(JSON.stringify(err).includes('/etc/secret'), false);
});

test('mapSdkMessage: неизвестные типы игнорируются', () => {
  assert.deepEqual(mapSdkMessage({ type: 'unknown_thing' }), []);
  assert.deepEqual(mapSdkMessage(null), []);
  assert.deepEqual(mapSdkMessage({ type: 'user', message: {} }), []);
});
