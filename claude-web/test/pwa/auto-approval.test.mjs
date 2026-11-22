import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// Node 24 runs TypeScript directly (type stripping); the helper is pure.
import { attachToolResult, markToolDecision, needsApproval, upsertTool } from '../../web/src/timeline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const readSource = (relative) => readFileSync(join(claudeWeb, relative), 'utf8');

/** Shape emitted by the runtime for Read/Glob/Grep: observability, no approval. */
const AUTO_REQUEST = {
  reqId: 'req-read',
  tool: 'Read',
  input: { file_path: '/srv/claude-web/workspaces/demo/README.md' },
  cwd: '/srv/claude-web/workspaces/demo',
  warnings: [],
  expiresAt: null,
  auto: true,
};

/** Shape emitted for Edit/Write: a human decision is required. */
const APPROVAL_REQUEST = {
  reqId: 'req-edit',
  tool: 'Edit',
  input: { file_path: '/srv/claude-web/workspaces/demo/src/parser.js' },
  cwd: '/srv/claude-web/workspaces/demo',
  warnings: ['изменение существующего файла'],
  expiresAt: Date.now() + 300000,
  auto: false,
};

test('auto: read-only tool_request needs no approval', () => {
  assert.equal(needsApproval(AUTO_REQUEST), false);
  assert.equal(needsApproval(APPROVAL_REQUEST), true);
  // Snapshot pending approvals omit the flag: those always need a decision.
  assert.equal(needsApproval({ reqId: 'req-snap', tool: 'Write', input: {} }), true);
});

test('auto: flag survives upsert/replay and the card receives the tool_result', () => {
  let items = upsertTool([], AUTO_REQUEST);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'tool');
  assert.equal(items[0].request.auto, true);
  assert.equal(items[0].decision, undefined, 'у auto-карточки не должно быть решения');

  items = upsertTool(items, { ...AUTO_REQUEST, warnings: [] }); // snapshot/replay merge
  assert.equal(items.length, 1);
  assert.equal(items[0].request.auto, true);

  items = attachToolResult(items, { reqId: 'req-read', tool: 'Read', ok: true, summary: 'прочитано' });
  assert.equal(items[0].result.ok, true);
  assert.equal(items[0].submitting, false);
  assert.equal(items[0].decision, undefined, 'решение по auto-вызову не выставляется');
});

test('auto: approval-required tool still supports allow/deny', () => {
  let items = upsertTool([], APPROVAL_REQUEST);
  items = markToolDecision(items, 'req-edit', 'allow', true);
  assert.equal(items[0].decision, 'allow');
  assert.equal(needsApproval(APPROVAL_REQUEST), true);
});

test('sse: tool_request forwards the auto flag to the UI handlers', () => {
  const sse = readSource('web/src/sse.ts');
  assert.match(sse, /auto: payload\.auto === true/, 'sse.ts должен пробрасывать auto: payload.auto === true');
});

test('ChatScreen: waiting_approval is set only when needsApproval(request)', () => {
  const chat = readSource('web/src/screens/ChatScreen.tsx');
  const start = chat.indexOf('onToolRequest:');
  const end = chat.indexOf('onToolResult:');
  assert.ok(start !== -1 && end > start, 'не найден обработчик onToolRequest');
  const handler = chat.slice(start, end);

  const statusLines = handler
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes("'waiting_approval'"));
  assert.equal(statusLines.length, 1, 'в обработчике tool_request ровно один переход в waiting_approval');
  assert.match(statusLines[0], /needsApproval\(request\)/, 'переход должен быть под условием needsApproval(request)');
  assert.match(handler, /setItems\(\(previous\) => upsertTool\(previous, request\)\)/, 'auto-карточка всё равно добавляется в таймлайн');
});

test('ChatScreen: snapshot approvals drive waiting_approval, auto events do not', () => {
  const chat = readSource('web/src/screens/ChatScreen.tsx');
  assert.match(chat, /snapshot\.pendingApprovals\.some\(needsApproval\)/);
  assert.match(chat, /meta\.pendingApprovals\.some\(needsApproval\)/);
});

test('ToolCard: auto cards render without approve/deny buttons', () => {
  const card = readSource('web/src/components/ToolCard.tsx');
  assert.match(card, /const auto = !needsApproval\(entry\.request\)/, 'ToolCard должен вычислять auto из needsApproval');
  assert.match(card, /const canDecide = !auto &&/, 'кнопки решений запрещены для auto-карточек');
  assert.match(card, /\{canDecide \? \(/, 'кнопки рисуются только внутри canDecide');
  // The informational variant is labelled and never asks for a decision.
  assert.match(card, /tool-badge auto/, 'у auto-карточки есть метка «авто»');
  assert.match(card, /подтверждение не требуется/);
});
