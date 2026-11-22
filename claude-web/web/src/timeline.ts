/**
 * Timeline state helpers for the chat screen. Pure functions over immutable
 * arrays so SSE callbacks can run inside functional `setState` updates without
 * stale closures, and node:test can check the merge logic directly.
 */
import type { ChatStatus, ResultInfo, SessionStatus, ToolRequest, ToolResult } from './types';

export type ToolItem = {
  kind: 'tool';
  id: string;
  request: ToolRequest;
  decision?: 'allow' | 'deny';
  submitting?: boolean;
  result?: ToolResult;
};

export type TimelineItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | ToolItem
  | { kind: 'result'; id: string; result: ResultInfo }
  | { kind: 'error'; id: string; message: string };

let sequence = 0;

export function nextItemId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

/** Streaming delta: extend the open assistant bubble or start a new one. */
export function appendDelta(items: TimelineItem[], text: string): TimelineItem[] {
  if (!text) return items;
  const last = items[items.length - 1];
  if (last && last.kind === 'assistant' && last.streaming) {
    const updated: TimelineItem = { ...last, text: last.text + text };
    return [...items.slice(0, -1), updated];
  }
  return [...items, { kind: 'assistant', id: nextItemId('a'), text, streaming: true }];
}

/** Final assistant message: close the open stream bubble with authoritative text. */
export function finalizeAssistant(items: TimelineItem[], text: string): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === 'assistant' && last.streaming) {
    const updated: TimelineItem = { ...last, text, streaming: false };
    return [...items.slice(0, -1), updated];
  }
  if (last && last.kind === 'assistant' && !last.streaming && last.text === text) return items;
  return [...items, { kind: 'assistant', id: nextItemId('a'), text, streaming: false }];
}

/** Close any half-streamed bubble when the stream restarts with a snapshot. */
export function finalizeStreaming(items: TimelineItem[]): TimelineItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind === 'assistant' && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : items;
}

/** Insert a tool request or update an existing one (snapshot replay may repeat it). */
export function upsertTool(items: TimelineItem[], request: ToolRequest): TimelineItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.request.reqId === request.reqId);
  if (index === -1) {
    return [...items, { kind: 'tool', id: nextItemId('t'), request }];
  }
  const existing = items[index] as ToolItem;
  const merged: ToolItem = { ...existing, request: { ...existing.request, ...request } };
  const next = [...items];
  next[index] = merged;
  return next;
}

/**
 * Does this tool request need a human decision?
 *
 * The runtime reports every tool call as `tool_request` for observability, but
 * read-only tools (Read/Glob/Grep) arrive with `auto: true` and a `tool_result`
 * follows immediately — the UI must not show approval buttons or enter the
 * `waiting_approval` state for them. Approval-required calls carry `auto: false`;
 * approvals restored from a snapshot omit the field (treated as requiring one).
 */
export function needsApproval(request: ToolRequest): boolean {
  return request.auto !== true;
}

/** Mark the local approval decision (and its in-flight flag). */
export function markToolDecision(
  items: TimelineItem[],
  reqId: string,
  decision: 'allow' | 'deny' | undefined,
  submitting: boolean,
): TimelineItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.kind !== 'tool' || item.request.reqId !== reqId) return item;
    changed = true;
    const updated: ToolItem = { ...item, submitting };
    if (decision === undefined) delete updated.decision;
    else updated.decision = decision;
    return updated;
  });
  return changed ? next : items;
}

/** Attach the execution result to its tool card. */
export function attachToolResult(items: TimelineItem[], result: ToolResult): TimelineItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.request.reqId === result.reqId);
  if (index === -1) {
    // A result without a visible request (reconnect edge): still show it.
    return [
      ...items,
      {
        kind: 'tool',
        id: nextItemId('t'),
        request: { reqId: result.reqId, tool: result.tool, input: undefined },
        result,
      },
    ];
  }
  const existing = items[index] as ToolItem;
  const next = [...items];
  next[index] = { ...existing, result, submitting: false };
  return next;
}

/** Turn result: shown as a compact meta line; adds its text only if not streamed. */
export function appendResult(items: TimelineItem[], result: ResultInfo): TimelineItem[] {
  const next = [...items];
  const text = result.text?.trim();
  if (text) {
    const lastAssistant = [...next].reverse().find((item) => item.kind === 'assistant');
    const alreadyShown =
      lastAssistant !== undefined
      && lastAssistant.kind === 'assistant'
      && (lastAssistant.text.trim() === text || lastAssistant.text.includes(text));
    if (!alreadyShown) next.push({ kind: 'assistant', id: nextItemId('a'), text, streaming: false });
  }
  next.push({ kind: 'result', id: nextItemId('r'), result });
  return next;
}

export function appendError(items: TimelineItem[], message: string): TimelineItem[] {
  return [...items, { kind: 'error', id: nextItemId('e'), message }];
}

/** Map the persisted session status onto the live turn status used by the header. */
export function chatStatusFromSession(status: SessionStatus | undefined): ChatStatus {
  switch (status) {
    case 'active':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}
