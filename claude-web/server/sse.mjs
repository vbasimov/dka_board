/**
 * sse.mjs — SSE-hub: snapshot, ring buffer (200 событий), ping каждые 15 c,
 * закрытие соединения по SSE_MAX_MS или без успешного heartbeat
 * SSE_HEARTBEAT_TIMEOUT_MS (CONTRACT §4 SSE, plan §3, §4.3).
 */
import { randomUUID } from 'node:crypto';

const RING_SIZE = 200;
const PING_INTERVAL_MS = 15_000;

function formatEvent(id, type, payload) {
  let out = '';
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  out += `event: ${type}\n`;
  out += `data: ${JSON.stringify(payload ?? {})}\n\n`;
  return out;
}

/**
 * @param {{config:object, now?:()=>number}} opts
 */
export function createSseHub({ config, now = () => Date.now() }) {
  /** @type {Map<string, {seq:number, ring:Array<{id:number,type:string,payload:object}>, conns:Set<object>}>} */
  const states = new Map();
  const connections = new Set();
  let closed = false;
  let globalHeartbeat = now();

  const stateFor = (sessionId) => {
    let st = states.get(sessionId);
    if (!st) {
      st = { seq: 0, ring: [], conns: new Set() };
      states.set(sessionId, st);
    }
    return st;
  };

  const writeRaw = (conn, raw) => {
    if (conn.closed) return false;
    try {
      conn.res.write(raw);
      return true;
    } catch {
      closeConnection(conn, 'write_error');
      return false;
    }
  };

  const closeConnection = (conn, reason = 'closed') => {
    if (conn.closed) return;
    conn.closed = true;
    conn.closeReason = reason;
    connections.delete(conn);
    const st = states.get(conn.sessionId);
    if (st) st.conns.delete(conn);
    try {
      conn.res.end();
    } catch {
      /* ignore */
    }
    if (typeof conn.onClose === 'function') {
      try {
        conn.onClose(reason);
      } catch {
        /* ignore */
      }
    }
  };

  const sendEvent = (conn, ev) => {
    if (conn.closed) return;
    conn.lastSentAt = now();
    writeRaw(conn, formatEvent(ev.id, ev.type, ev.payload));
  };

  /**
   * Открывает SSE-соединение и шлёт snapshot (+replay по Last-Event-ID).
   * @param {import('node:http').ServerResponse} res
   * @param {{sessionId:string, snapshot:object, lastEventId?:number|string,
   *          onClose?:(reason:string)=>void}} opts
   */
  const open = (res, { sessionId, snapshot, lastEventId, onClose }) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const st = stateFor(sessionId);
    const conn = {
      id: randomUUID(),
      sessionId,
      res,
      closed: false,
      closeReason: null,
      openedAt: now(),
      lastHeartbeat: now(),
      lastSentAt: now(),
      onClose,
    };
    connections.add(conn);
    st.conns.add(conn);
    globalHeartbeat = now();

    // snapshot: id = текущий seq, чтобы Last-Event-ID клиента был валиден.
    sendEvent(conn, { id: st.seq, type: 'snapshot', payload: snapshot });

    const lastId = lastEventId === undefined || lastEventId === null ? undefined : Number(lastEventId);
    if (lastId !== undefined && Number.isFinite(lastId)) {
      for (const ev of st.ring) {
        if (ev.id > lastId) sendEvent(conn, { id: ev.id, type: ev.type, payload: ev.payload });
      }
    }

    res.on('close', () => closeConnection(conn, 'client_closed'));
    res.on('error', () => closeConnection(conn, 'client_error'));
    return conn;
  };

  /** Публикует событие всем соединениям сессии + кладёт в ring buffer. */
  const publish = (sessionId, event) => {
    if (closed || !event || typeof event.type !== 'string') return 0;
    const { type, ...payload } = event;
    if (type.startsWith('_')) return 0; // internal, не для клиента
    const st = stateFor(sessionId);
    const id = ++st.seq;
    const ev = { id, type, payload };
    st.ring.push(ev);
    if (st.ring.length > RING_SIZE) st.ring.splice(0, st.ring.length - RING_SIZE);
    let sent = 0;
    for (const conn of st.conns) {
      sendEvent(conn, ev);
      sent += 1;
    }
    return id;
  };

  /** Принудительно завершает соединения сессии. */
  const closeSession = (sessionId, reason = 'session_closed') => {
    const st = states.get(sessionId);
    if (!st) return;
    for (const conn of [...st.conns]) closeConnection(conn, reason);
    states.delete(sessionId);
  };

  const closeAll = (reason = 'shutdown') => {
    closed = true;
    for (const conn of [...connections]) closeConnection(conn, reason);
    states.clear();
  };

  /**
   * Успешный heartbeat (POST /api/heartbeat). connectionId необязателен:
   * без него продлеваются все соединения (single-owner MVP).
   */
  const touchHeartbeat = (connectionId) => {
    const t = now();
    globalHeartbeat = t;
    let touched = 0;
    for (const conn of connections) {
      if (connectionId === undefined || connectionId === null || conn.id === connectionId) {
        conn.lastHeartbeat = t;
        conn.closeAfter = undefined;
        touched += 1;
      }
    }
    return touched;
  };

  const pingAll = () => {
    for (const conn of connections) {
      if (!conn.closed) writeRaw(conn, formatEvent(undefined, 'ping', {}));
    }
  };

  /** Проверка таймаутов (вызывается таймером; в тестах — напрямую). */
  const tick = () => {
    const t = now();
    for (const conn of [...connections]) {
      if (conn.closed) continue;
      if (t - conn.openedAt >= config.sseMaxMs) {
        closeConnection(conn, 'max_duration');
        continue;
      }
      if (t - conn.lastHeartbeat >= config.sseHeartbeatTimeoutMs) {
        closeConnection(conn, 'heartbeat_timeout');
        continue;
      }
      if (t - (conn.lastPingAt ?? conn.openedAt) >= PING_INTERVAL_MS) {
        conn.lastPingAt = t;
        writeRaw(conn, formatEvent(undefined, 'ping', {}));
      }
    }
  };

  const timer = setInterval(tick, Math.min(PING_INTERVAL_MS, Math.max(100, Math.floor(config.sseHeartbeatTimeoutMs / 4))));
  timer.unref?.();

  /** ring buffer для replay (SessionManager.subscribe). */
  const replay = (sessionId, lastEventId) => {
    const st = states.get(sessionId);
    if (!st) return [];
    const last = Number(lastEventId);
    if (!Number.isFinite(last)) return [];
    return st.ring.filter((ev) => ev.id > last).map((ev) => ({ id: ev.id, type: ev.type, ...ev.payload }));
  };

  const connectionCount = (sessionId) => {
    if (sessionId === undefined) return connections.size;
    return states.get(sessionId)?.conns.size ?? 0;
  };

  return {
    open,
    publish,
    closeSession,
    closeAll,
    touchHeartbeat,
    tick,
    pingAll,
    replay,
    connectionCount,
    lastHeartbeat: () => globalHeartbeat,
    stop() {
      clearInterval(timer);
      closeAll('stop');
    },
  };
}

export default createSseHub;
