#!/usr/bin/env node
/**
 * test/server/sdk-verify.mjs — проверка SDK-пути БЕЗ вызова модели.
 *
 * Запуск на VPS (там, где установлен @anthropic-ai/claude-agent-sdk@0.3.330):
 *   cd /home/dsh/projects/runtime-dev
 *   node test/server/sdk-verify.mjs
 *
 * Что проверяет:
 *   1. runtime/sdk.mjs импортируется без установленного SDK (ленивый import);
 *   2. реальный пакет SDK 0.3.330 импортируется и экспортирует query;
 *   3. buildSdkOptions даёт safe-режим: permissionMode 'default', tools-whitelist,
 *      disallowedTools, settingSources [], additionalDirectories [], без allow-правил;
 *   4. buildChildEnv — минимальный env без EDGE_SECRET/DSH-переменных;
 *   5. mapSdkMessage маппит system/init, streaming delta, assistant, result.
 * Модель не вызывается, токен не нужен (используется фиктивный 'test-token').
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const sdk = await import('../../server/runtime/sdk.mjs');
const require = createRequire(import.meta.url);

const config = {
  home: '/tmp/claude-web-verify-home',
  claudeConfigDir: '/tmp/claude-web-verify-home/.claude',
  workspaces: '/tmp/claude-web-verify-ws',
  maxTurns: 30,
  oauthToken: 'test-token-not-real',
};

const env = sdk.buildChildEnv(config);
assert.deepEqual(Object.keys(env).sort(), [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'DISABLE_AUTOUPDATER',
  'DO_NOT_TRACK',
  'HOME',
  'PATH',
]);
assert.equal('EDGE_SECRET' in env, false);
assert.equal(Object.keys(env).some((k) => k.startsWith('DSH')), false);

const options = sdk.buildSdkOptions({ config, cwd: '/tmp/claude-web-verify-ws/p', canUseTool: () => {}, hooks: {} });
assert.equal(options.permissionMode, 'default');
assert.deepEqual(options.additionalDirectories, []);
assert.deepEqual(options.settingSources, []);
assert.equal(options.strictMcpConfig, true);
assert.equal(options.includePartialMessages, true);
assert.equal(options.allowedTools, undefined);
assert.equal(options.settings.permissions.allow, undefined);
assert.equal(options.settings.permissions.defaultMode, undefined);
for (const tool of ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
  assert.ok(options.disallowedTools.includes(tool), tool);
}
for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) {
  assert.ok(options.tools.includes(tool), tool);
}

const events = [
  ...sdk.mapSdkMessage({ type: 'system', subtype: 'init', session_id: 'verify-session' }),
  ...sdk.mapSdkMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  }),
  ...sdk.mapSdkMessage({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] } }),
  ...sdk.mapSdkMessage({ type: 'result', subtype: 'success', result: 'ok', stop_reason: 'end_turn', usage: {} }),
];
assert.deepEqual(
  events.map((e) => e.type),
  ['_sdk_session_id', 'assistant_delta', 'assistant_message', 'result'],
);

// Реальная проверка пакета SDK (только импорт и версия, без query()).
function sdkVersion() {
  const candidates = [];
  try {
    candidates.push(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
  } catch {
    /* exports может не открывать package.json */
  }
  try {
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    candidates.push(join(dirname(entry), 'package.json'));
    candidates.push(join(dirname(entry), '..', 'package.json'));
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version;
    } catch {
      /* next */
    }
  }
  return 'unknown';
}
const actual = await import('@anthropic-ai/claude-agent-sdk');
assert.equal(typeof actual.query, 'function', 'SDK должен экспортировать query()');
assert.equal(typeof actual.startup, 'function');
const version = sdkVersion();
assert.equal(version, '0.3.330', `SDK version must be pinned 0.3.330, got ${version}`);
console.log(`sdk-verify OK: @anthropic-ai/claude-agent-sdk@${version}, safe options/map/env invariants hold, model not called`);
