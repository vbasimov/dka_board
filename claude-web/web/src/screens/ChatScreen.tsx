import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Markdown } from '../components/Markdown';
import { ToolCard } from '../components/ToolCard';
import { describeError, isApiError, isUnauthorized, type ApiClient } from '../api';
import { SessionEvents } from '../sse';
import {
  appendDelta,
  appendError,
  appendResult,
  attachToolResult,
  chatStatusFromSession,
  finalizeAssistant,
  finalizeStreaming,
  markToolDecision,
  needsApproval,
  nextItemId,
  upsertTool,
  type TimelineItem,
  type ToolItem,
} from '../timeline';
import type { ChatStatus, SessionInfo } from '../types';

const STATUS_LABEL: Record<ChatStatus, string> = {
  running: 'выполняется',
  waiting_approval: 'нужно подтверждение',
  waiting: 'ожидает слот',
  idle: 'простаивает',
  error: 'ошибка',
};

type Connection = 'connecting' | 'live' | 'reconnecting' | 'closed';

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'подключение…',
  live: 'на связи',
  reconnecting: 'переподключение…',
  closed: 'соединение закрыто',
};

const MAX_MESSAGE_BYTES = 32768;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatUsage(usage: unknown): string | null {
  if (!usage || typeof usage !== 'object') return null;
  const data = usage as Record<string, unknown>;
  const labels: Record<string, string> = {
    input_tokens: 'вход',
    output_tokens: 'выход',
    cache_read_input_tokens: 'кэш',
    cache_creation_input_tokens: 'кэш+',
  };
  const parts: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${label}: ${value}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface ChatScreenProps {
  api: ApiClient;
  sessionId: string;
  onBack: () => void;
  onExpired: () => void;
  onNotify: (message: string) => void;
}

export function ChatScreen({ api, sessionId, onBack, onExpired, onNotify }: ChatScreenProps) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [chatStatus, setChatStatus] = useState<ChatStatus>('idle');
  const [connection, setConnection] = useState<Connection>('connecting');
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const eventsRef = useRef<SessionEvents | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const propsRef = useRef({ onBack, onExpired, onNotify });
  propsRef.current = { onBack, onExpired, onNotify };

  useEffect(() => {
    let alive = true;
    eventsRef.current?.close();
    setItems([]);
    setSession(null);
    setChatStatus('idle');
    setConnection('connecting');
    setLoadError(null);

    const events = new SessionEvents(sessionId, api, {
      onSnapshot: (snapshot) => {
        if (!alive) return;
        setSession(snapshot.session);
        // Only real pending approvals mean a human decision is awaited; a
        // read-only tool (auto) never blocks the turn.
        setChatStatus(
          snapshot.pendingApprovals.some(needsApproval)
            ? 'waiting_approval'
            : chatStatusFromSession(snapshot.session.status),
        );
        setItems((previous) => {
          let next = finalizeStreaming(previous);
          for (const approval of snapshot.pendingApprovals) next = upsertTool(next, approval);
          return next;
        });
      },
      onDelta: (text) => {
        if (!alive) return;
        setChatStatus('running');
        setItems((previous) => appendDelta(previous, text));
      },
      onMessage: (text) => {
        if (!alive) return;
        setItems((previous) => finalizeAssistant(previous, text));
      },
      onToolRequest: (request) => {
        if (!alive) return;
        // Read/Glob/Grep are reported for observability (auto: true): they get
        // an informational card and a tool_result, not an approval prompt.
        if (needsApproval(request)) setChatStatus('waiting_approval');
        setItems((previous) => upsertTool(previous, request));
      },
      onToolResult: (result) => {
        if (!alive) return;
        setItems((previous) => attachToolResult(previous, result));
      },
      onStatus: (status) => {
        if (!alive) return;
        setChatStatus(status);
      },
      onResult: (result) => {
        if (!alive) return;
        setChatStatus('idle');
        setItems((previous) => appendResult(previous, result));
      },
      onServerError: (message) => {
        if (!alive) return;
        setItems((previous) => appendError(previous, message));
        propsRef.current.onNotify(message);
      },
      onExpired: () => propsRef.current.onExpired(),
      onOpen: () => {
        if (alive) setConnection('live');
      },
      onReconnecting: (reconnecting) => {
        if (alive) setConnection(reconnecting ? 'reconnecting' : 'live');
      },
    });
    eventsRef.current = events;
    events.connect();

    void (async () => {
      try {
        const meta = await api.getSession(sessionId);
        if (!alive) return;
        setSession(meta.session);
        setChatStatus(
          meta.pendingApprovals.some(needsApproval)
            ? 'waiting_approval'
            : chatStatusFromSession(meta.session.status),
        );
        setItems((previous) => {
          let next = previous;
          for (const approval of meta.pendingApprovals) next = upsertTool(next, approval);
          return next;
        });
      } catch (cause) {
        if (!alive || isUnauthorized(cause)) return;
        if (isApiError(cause) && cause.status === 404) {
          propsRef.current.onNotify('Сессия не найдена.');
          propsRef.current.onBack();
          return;
        }
        setLoadError(describeError(cause));
      }
    })();

    return () => {
      alive = false;
      events.close();
      eventsRef.current = null;
      setConnection('closed');
    };
  }, [api, sessionId]);

  useEffect(() => {
    const element = listRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  const send = useCallback(async () => {
    const text = composer.trim();
    if (!text || sending) return;
    if (byteLength(text) > MAX_MESSAGE_BYTES) {
      propsRef.current.onNotify('Сообщение больше лимита 32 КБ.');
      return;
    }
    setSending(true);
    setComposer('');
    setChatStatus('running');
    setItems((previous) => [...previous, { kind: 'user', id: nextItemId('u'), text }]);
    try {
      await api.sendMessage(sessionId, text);
    } catch (cause) {
      if (!isUnauthorized(cause)) propsRef.current.onNotify(describeError(cause));
    } finally {
      setSending(false);
    }
  }, [api, composer, sending, sessionId]);

  const decide = useCallback(
    async (item: ToolItem, decision: 'allow' | 'deny') => {
      const reqId = item.request.reqId;
      setItems((previous) => markToolDecision(previous, reqId, decision, true));
      try {
        await api.resolveApproval(sessionId, reqId, decision);
        setItems((previous) => markToolDecision(previous, reqId, decision, false));
      } catch (cause) {
        setItems((previous) => markToolDecision(previous, reqId, undefined, false));
        if (!isUnauthorized(cause)) propsRef.current.onNotify(describeError(cause));
      }
    },
    [api, sessionId],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await api.interrupt(sessionId);
      propsRef.current.onNotify('Останавливаю текущий ход…');
    } catch (cause) {
      if (!isUnauthorized(cause)) propsRef.current.onNotify(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId]);

  const closeSession = useCallback(async () => {
    setBusy(true);
    try {
      await api.closeSession(sessionId);
      setSession((previous) => (previous ? { ...previous, status: 'closed' } : previous));
      setChatStatus('idle');
      propsRef.current.onNotify('Сессия закрыта. Метаданные сохранены для возобновления.');
    } catch (cause) {
      if (!isUnauthorized(cause)) propsRef.current.onNotify(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [api, sessionId]);

  const removeSession = useCallback(async () => {
    const label = session?.title || sessionId;
    if (!window.confirm(`Удалить сессию «${label}»? Транскрипт и метаданные будут удалены.`)) return;
    setBusy(true);
    try {
      await api.deleteSession(sessionId);
      propsRef.current.onBack();
    } catch (cause) {
      if (!isUnauthorized(cause)) propsRef.current.onNotify(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [api, session, sessionId]);

  const canStop = chatStatus === 'running' || chatStatus === 'waiting_approval';
  const composerBytes = byteLength(composer);

  const renderItem = (item: TimelineItem) => {
    switch (item.kind) {
      case 'user':
        return (
          <div class="msg user" key={item.id}>
            <div class="bubble user-bubble">{item.text}</div>
          </div>
        );
      case 'assistant':
        return (
          <div class={['msg assistant', item.streaming ? 'streaming' : ''].join(' ').trim()} key={item.id}>
            <div class="bubble assistant-bubble">
              <Markdown text={item.text} />
              {item.streaming ? <span class="cursor" aria-hidden="true" /> : null}
            </div>
          </div>
        );
      case 'tool':
        return <ToolCard key={item.id} entry={item} onDecision={(decision) => void decide(item, decision)} />;
      case 'result': {
        const usage = formatUsage(item.result.usage);
        const stopReason = item.result.stopReason;
        if (!usage && !stopReason) return null;
        return (
          <div class="msg result" key={item.id}>
            <div class="result-line">
              {stopReason ? <span class="result-stop">причина остановки: {stopReason}</span> : null}
              {usage ? <span class="result-usage">{usage}</span> : null}
            </div>
          </div>
        );
      }
      case 'error':
        return (
          <div class="notice error inline" key={item.id}>
            {item.message}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div class="screen chat-screen">
      <header class="chat-header">
        <div class="chat-header-row">
          <button type="button" class="icon-btn" onClick={onBack} aria-label="К списку сессий">
            ←
          </button>
          <div class="chat-title">
            <div class="title">{session?.title || 'Сессия'}</div>
            <div class="subtitle">{session?.cwd || ''}</div>
          </div>
          <span class={['status-chip', `status-${chatStatus}`].join(' ')}>{STATUS_LABEL[chatStatus]}</span>
        </div>
        <div class="chat-header-row secondary">
          <span class={['conn-chip', `conn-${connection}`].join(' ')}>SSE · {CONNECTION_LABEL[connection]}</span>
          <div class="chat-actions">
            <button type="button" class="btn ghost small" disabled={!canStop || busy} onClick={() => void stop()}>
              Стоп
            </button>
            <button type="button" class="btn ghost small" disabled={busy} onClick={() => void closeSession()}>
              Закрыть
            </button>
            <button type="button" class="btn danger small" disabled={busy} onClick={() => void removeSession()}>
              Удалить
            </button>
          </div>
        </div>
      </header>

      {connection === 'reconnecting' ? (
        <div class="notice warning">Соединение с сервером потеряно — переподключаюсь…</div>
      ) : null}

      {loadError ? (
        <div class="notice error">
          {loadError}
          <button type="button" class="btn ghost small" onClick={onBack}>
            К списку
          </button>
        </div>
      ) : null}

      <div class="chat-body" ref={listRef} onScroll={onScroll}>
        {items.length === 0 && !loadError ? (
          <div class="empty-state">
            <p class="empty-title">Начните диалог</p>
            <p class="muted">
              Claude Code работает в каталоге сессии. Инструменты Edit и Write требуют ручного подтверждения —
              карточка появится здесь.
            </p>
          </div>
        ) : null}
        {items.map(renderItem)}
      </div>

      <footer class="composer">
        <textarea
          class="composer-input"
          rows={2}
          value={composer}
          placeholder="Сообщение Claude… (Enter — отправить, Shift+Enter — новая строка)"
          onInput={(event) => setComposer((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            const keyboardEvent = event as KeyboardEvent;
            if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey && !keyboardEvent.isComposing) {
              keyboardEvent.preventDefault();
              void send();
            }
          }}
        />
        <div class="composer-row">
          {composerBytes > 28000 ? (
            <span class={['byte-counter', composerBytes > MAX_MESSAGE_BYTES ? 'over' : ''].join(' ').trim()}>
              {composerBytes} / {MAX_MESSAGE_BYTES} байт
            </span>
          ) : null}
          <button
            type="button"
            class="btn primary"
            disabled={sending || composer.trim().length === 0 || composerBytes > MAX_MESSAGE_BYTES}
            onClick={() => void send()}
          >
            {sending ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
      </footer>
    </div>
  );
}
