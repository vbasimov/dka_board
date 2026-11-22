/**
 * SSE client for `GET {base}api/sessions/:id/events` (CONTRACT.md §5).
 *
 * `EventSource` is used as the transport, so the browser owns the
 * `Last-Event-ID` header while it retries a dropped stream itself; we only
 * re-create the source after it reaches CLOSED (a 401/403 answer or a fatal
 * network state) and then reconnect with exponential backoff. Every reconnect
 * starts with a `snapshot`, which the app uses to reset stream-local state.
 */
import { ApiClient, isUnauthorized } from './api';
import type { ChatStatus, ResultInfo, Snapshot, ToolRequest, ToolResult } from './types';

export interface SessionEventHandlers {
  onSnapshot: (snapshot: Snapshot) => void;
  onDelta: (text: string) => void;
  onMessage: (text: string, messageId?: string) => void;
  onToolRequest: (request: ToolRequest) => void;
  onToolResult: (result: ToolResult) => void;
  onStatus: (status: ChatStatus) => void;
  onResult: (result: ResultInfo) => void;
  onServerError: (message: string, code?: string) => void;
  onExpired: () => void;
  onOpen?: () => void;
  onReconnecting?: (reconnecting: boolean) => void;
}

const EVENT_TYPES = [
  'snapshot',
  'assistant_delta',
  'assistant_message',
  'tool_request',
  'tool_result',
  'status',
  'result',
  'session_expired',
  'ping',
] as const;

const MAX_BACKOFF_MS = 30000;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export class SessionEvents {
  private source: EventSource | null = null;
  private closed = false;
  private lastEventId = '';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly api: ApiClient,
    private readonly handlers: SessionEventHandlers,
  ) {}

  get eventSourceUrl(): string {
    const base = `${String(import.meta.env.BASE_URL || '/claude/').replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(this.sessionId)}/events`;
    return this.lastEventId
      ? `${base}?lastEventId=${encodeURIComponent(this.lastEventId)}`
      : base;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.source?.close();
    this.source = null;
  }

  private open(): void {
    if (this.closed) return;
    let source: EventSource;
    try {
      source = new EventSource(this.eventSourceUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;

    source.onopen = () => {
      this.attempt = 0;
      this.handlers.onOpen?.();
      this.handlers.onReconnecting?.(false);
    };

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const message = event as MessageEvent<string>;
        if (message.lastEventId) this.lastEventId = message.lastEventId;
        this.dispatch(type, parseJson(message.data ?? ''));
      });
    }

    // A named `error` event carries a server-side payload; a transport failure
    // arrives as a plain Event with no `data`.
    source.addEventListener('error', (event) => {
      const message = event as MessageEvent<string | undefined>;
      if (typeof message.data === 'string' && message.data.length > 0) {
        const data = parseJson(message.data) as { code?: unknown; message?: unknown } | undefined;
        const code = typeof data?.code === 'string' ? data.code : undefined;
        if (code === 'unauthorized' || code === 'session_expired') {
          this.handlers.onExpired();
          this.close();
          return;
        }
        const text = typeof data?.message === 'string' && data.message ? data.message : 'Ошибка выполнения.';
        this.handlers.onServerError(text, code);
        return;
      }
      this.handleTransportError(source);
    });
  }

  private handleTransportError(source: EventSource): void {
    if (this.closed || this.source !== source) return;
    if (source.readyState === EventSource.CONNECTING) {
      // The browser retries by itself and replays with Last-Event-ID.
      this.handlers.onReconnecting?.(true);
      return;
    }
    // CLOSED: no automatic retry for this instance (e.g. the gateway answered 401).
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.source?.close();
    this.source = null;
    this.handlers.onReconnecting?.(true);

    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.probeThenReconnect();
    }, delay);
  }

  /**
   * A closed EventSource cannot tell "session revoked" from "network lost", so a
   * heartbeat decides: 401 switches the UI to the expired screen, anything else
   * retries the stream.
   */
  private async probeThenReconnect(): Promise<void> {
    try {
      await this.api.heartbeat();
    } catch (error) {
      if (isUnauthorized(error)) {
        this.handlers.onExpired();
        this.close();
        return;
      }
      // Transient failure: the reconnect below decides — it will back off again.
    }
    if (this.closed) return;
    this.open();
  }

  private dispatch(type: (typeof EVENT_TYPES)[number], data: unknown): void {
    const payload = data as Record<string, unknown> | undefined;
    switch (type) {
      case 'snapshot': {
        if (payload && typeof payload === 'object' && payload.session) {
          this.handlers.onSnapshot({
            session: payload.session as Snapshot['session'],
            pendingApprovals: Array.isArray(payload.pendingApprovals)
              ? (payload.pendingApprovals as ToolRequest[])
              : [],
          });
        }
        break;
      }
      case 'assistant_delta': {
        const text = typeof payload?.text === 'string' ? payload.text : '';
        if (text) this.handlers.onDelta(text);
        break;
      }
      case 'assistant_message': {
        const text = typeof payload?.text === 'string' ? payload.text : '';
        const messageId = typeof payload?.messageId === 'string' ? payload.messageId : undefined;
        if (text) this.handlers.onMessage(text, messageId);
        break;
      }
      case 'tool_request': {
        if (payload && typeof payload.reqId === 'string' && typeof payload.tool === 'string') {
          this.handlers.onToolRequest({
            reqId: payload.reqId,
            tool: payload.tool,
            input: payload.input,
            cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
            warnings: Array.isArray(payload.warnings)
              ? payload.warnings.filter((value): value is string => typeof value === 'string')
              : undefined,
            expiresAt:
              typeof payload.expiresAt === 'number' || typeof payload.expiresAt === 'string'
                ? payload.expiresAt
                : undefined,
            // Read-only calls are emitted with `auto: true`; the UI must render
            // them as informational cards and must not wait for an approval.
            auto: payload.auto === true,
          });
        }
        break;
      }
      case 'tool_result': {
        if (payload && typeof payload.reqId === 'string') {
          this.handlers.onToolResult({
            reqId: payload.reqId,
            tool: typeof payload.tool === 'string' ? payload.tool : '',
            ok: payload.ok !== false,
            summary: typeof payload.summary === 'string' ? payload.summary : undefined,
          });
        }
        break;
      }
      case 'status': {
        const status = payload?.status;
        if (
          status === 'running'
          || status === 'idle'
          || status === 'waiting_approval'
          || status === 'waiting'
          || status === 'error'
        ) {
          this.handlers.onStatus(status);
        }
        break;
      }
      case 'result': {
        this.handlers.onResult({
          text: typeof payload?.text === 'string' ? payload.text : undefined,
          usage: payload?.usage,
          stopReason: typeof payload?.stopReason === 'string' ? payload.stopReason : undefined,
        });
        break;
      }
      case 'session_expired': {
        this.handlers.onExpired();
        this.close();
        break;
      }
      case 'ping':
      default:
        break;
    }
  }
}
