import assert from 'node:assert/strict';
import test from 'node:test';
// Node 24 runs TypeScript directly (type stripping); the merge logic is pure.
import {
  appendDelta,
  appendError,
  appendResult,
  attachToolResult,
  chatStatusFromSession,
  finalizeAssistant,
  finalizeStreaming,
  markToolDecision,
  upsertTool,
} from '../../web/src/timeline.ts';

const request = { reqId: 'req-1', tool: 'Edit', input: { file_path: '/w/a.txt' }, cwd: '/w', warnings: ['запись в workspace'] };

test('timeline: deltas accumulate into one streaming assistant bubble', () => {
  const items = appendDelta(appendDelta([], 'Hel'), 'lo');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assistant');
  assert.equal(items[0].text, 'Hello');
  assert.equal(items[0].streaming, true);
});

test('timeline: a delta after a user message starts a new bubble', () => {
  const items = appendDelta([{ kind: 'user', id: 'u1', text: 'hi' }], 'answer');
  assert.equal(items.length, 2);
  assert.equal(items[1].kind, 'assistant');
});

test('timeline: final assistant message closes the streaming bubble with authoritative text', () => {
  const streamed = appendDelta([], 'partial');
  const items = finalizeAssistant(streamed, 'final text');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'final text');
  assert.equal(items[0].streaming, false);
});

test('timeline: identical repeated final message is not duplicated', () => {
  const items = finalizeAssistant(appendDelta([], 'same'), 'same');
  const again = finalizeAssistant(items, 'same');
  assert.equal(again.length, 1);
});

test('timeline: snapshot finalizes any half-streamed bubble', () => {
  const items = appendDelta([], 'half');
  const finalized = finalizeStreaming(items);
  assert.equal(finalized[0].streaming, false);
  assert.equal(finalizeStreaming(finalized), finalized, 'no-op when nothing is streaming');
});

test('timeline: tool request is upserted by reqId (snapshot replay)', () => {
  const first = upsertTool([], request);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'tool');
  const repeated = upsertTool(first, { ...request, expiresAt: 123 });
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].request.expiresAt, 123);
});

test('timeline: approval decision can be set, cleared and flagged as submitting', () => {
  const items = upsertTool([], request);
  const submitting = markToolDecision(items, 'req-1', 'allow', true);
  assert.equal(submitting[0].decision, 'allow');
  assert.equal(submitting[0].submitting, true);
  const cleared = markToolDecision(submitting, 'req-1', undefined, false);
  assert.equal(cleared[0].decision, undefined);
  assert.equal(cleared[0].submitting, false);
  assert.equal(markToolDecision(cleared, 'unknown', 'allow', true), cleared);
});

test('timeline: tool result attaches to its card and closes submitting', () => {
  const items = markToolDecision(upsertTool([], request), 'req-1', 'allow', true);
  const withResult = attachToolResult(items, { reqId: 'req-1', tool: 'Edit', ok: true, summary: 'written' });
  assert.equal(withResult.length, 1);
  assert.equal(withResult[0].result.ok, true);
  assert.equal(withResult[0].submitting, false);
});

test('timeline: orphan tool result still becomes a visible card', () => {
  const items = attachToolResult([], { reqId: 'lost', tool: 'Write', ok: false });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'tool');
  assert.equal(items[0].request.reqId, 'lost');
});

test('timeline: result text is not duplicated when it was already streamed', () => {
  const streamed = finalizeAssistant(appendDelta([], 'Готово.'), 'Готово.');
  const withResult = appendResult(streamed, { text: 'Готово.', stopReason: 'end_turn' });
  assert.equal(withResult.filter((item) => item.kind === 'assistant').length, 1);
  assert.equal(withResult.filter((item) => item.kind === 'result').length, 1);
});

test('timeline: result text appears when nothing was streamed', () => {
  const items = appendResult([], { text: 'Ответ целиком', usage: { output_tokens: 3 } });
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'assistant');
  assert.equal(items[0].text, 'Ответ целиком');
  assert.equal(items[1].kind, 'result');
});

test('timeline: server errors are appended inline', () => {
  const items = appendError([], 'Лимит исчерпан');
  assert.equal(items[0].kind, 'error');
  assert.equal(items[0].message, 'Лимит исчерпан');
});

test('timeline: session status maps onto the live chat status', () => {
  assert.equal(chatStatusFromSession('active'), 'running');
  assert.equal(chatStatusFromSession('waiting'), 'waiting');
  assert.equal(chatStatusFromSession('idle'), 'idle');
  assert.equal(chatStatusFromSession('closed'), 'idle');
  assert.equal(chatStatusFromSession('error'), 'error');
  assert.equal(chatStatusFromSession(undefined), 'idle');
});
