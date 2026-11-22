/**
 * sessions.mjs — менеджер сессий (CONTRACT §3 SessionManager, plan §6.1, §6.4).
 *
 * - MAX_SESSIONS ограничивает число одновременно запущенных child, не число
 *   сессий: лишние получают status 'waiting' и очередь сообщений.
 * - idle-close закрывает child после простоя (IDLE_CLOSE_MS), метаданные живы;
 *   следующий запрос стартует child через resume (sdk session_id).
 * - Метаданные — STATE_DIR/sessions.json, 0600, атомарная запись.
 * - Подтверждения: requestApproval ждёт APPROVAL_TIMEOUT_MS, затем deny/timeout;
 *   interrupt() отклоняет как deny/interrupted.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { HttpError, conflict, notFound, payloadTooLarge, rateLimited } from './http-util.mjs';
import { resolveCwd } from './workspaces.mjs';

const DEFAULT_TITLE = 'Новая сессия';
const SESSION_STATUSES = new Set(['waiting', 'active', 'idle', 'closed', 'error']);
const MODES = new Set(['safe']);
const MAX_QUEUE = 20;
const REQ_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

function isTimestamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function padTitle(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (!oneLine) return DEFAULT_TITLE;
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

function metaOf(s) {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    mode: s.mode,
    status: s.status,
    lastActive: s.lastActive,
    createdAt: s.createdAt,
  };
}

/**
 * @param {{config:object, runtime:object, sse:object, audit:object,
 *          now?:()=>number, stateFile?:string}} deps
 */
export function createSessionManager({ config, runtime, sse, audit, now = () => Date.now(), stateFile }) {
  const file = stateFile || join(config.stateDir, 'sessions.json');
  /** @type {Map<string, object>} */
  const sessions = new Map();
  let activeChildren = 0;
  let persistSeq = 0;
  let shuttingDown = false;

  // ── persistence ────────────────────────────────────────────────────────────
  function persist() {
    if (shuttingDown) return false;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const data = {
        version: 1,
        updatedAt: new Date(now()).toISOString(),
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          mode: s.mode,
          status: s.status,
          createdAt: s.createdAt,
          lastActive: s.lastActive,
          sdkSessionId: s.sdkSessionId || null,
        })),
      };
      const tmp = `${file}.tmp-${process.pid}-${++persistSeq}`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, file);
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort */
      }
      return true;
    } catch {
      audit.write('state_persist_error', { code: 'persist_failed' });
      return false;
    }
  }

  function loadPersisted() {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      audit.write('state_load_error', { code: 'invalid_json' });
      return;
    }
    if (!data || !Array.isArray(data.sessions)) return;
    for (const item of data.sessions) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(item.id)) continue;
      if (typeof item.cwd !== 'string' || !item.cwd.startsWith('/')) continue;
      if (typeof item.title !== 'string') continue;
      const status = SESSION_STATUSES.has(item.status) ? item.status : 'idle';
      const restored = {
        id: item.id,
        title: item.title.slice(0, 120) || DEFAULT_TITLE,
        cwd: item.cwd,
        mode: MODES.has(item.mode) ? item.mode : 'safe',
        // после рестарта child не живёт: активные/ожидающие становятся idle
        status: status === 'active' || status === 'waiting' || status === 'error' ? 'idle' : status,
        createdAt: isTimestamp(item.createdAt) ? item.createdAt : now(),
        lastActive: isTimestamp(item.lastActive) ? item.lastActive : now(),
        sdkSessionId: typeof item.sdkSessionId === 'string' && item.sdkSessionId.length <= 128 ? item.sdkSessionId : null,
        rt: null,
        starting: undefined,
        pending: new Map(),
        queue: [],
        msgTimes: [],
        seq: 0,
        generation: 0,
      };
      sessions.set(restored.id, restored);
    }
  }
  loadPersisted();

  // ── helpers ────────────────────────────────────────────────────────────────
  function mustGet(id) {
    const s = sessions.get(id);
    if (!s) throw notFound('session not found');
    return s;
  }

  function publish(s, event) {
    try {
      sse.publish(s.id, event);
    } catch {
      /* SSE не должен ронять сессию */
    }
  }

  function emitStatus(s, status) {
    publish(s, { type: 'status', status });
  }

  function auditWrite(event, fields) {
    try {
      audit.write(event, fields);
    } catch {
      /* аудит не должен ронять запрос */
    }
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  /**
   * @param {object} s
   * @param {{reqId?:string, tool:string, input:object, cwd?:string, warnings?:string[]}} req
   * @returns {Promise<{decision:'allow'|'deny', reason?:string}>}
   */
  function requestApproval(s, req) {
    const reqId = typeof req?.reqId === 'string' && REQ_ID_RE.test(req.reqId) ? req.reqId : randomUUID();
    const tool = typeof req?.tool === 'string' ? req.tool.slice(0, 64) : 'unknown';
    const input = req?.input && typeof req.input === 'object' ? req.input : {};
    const cwd = typeof req?.cwd === 'string' ? req.cwd : s.cwd;
    const warnings = Array.isArray(req?.warnings)
      ? req.warnings.filter((w) => typeof w === 'string').slice(0, 5).map((w) => w.slice(0, 200))
      : [];
    const expiresAt = now() + config.approvalTimeoutMs;

    return new Promise((resolve) => {
      const rec = {
        reqId,
        tool,
        input,
        cwd,
        warnings,
        expiresAt,
        createdAt: now(),
        resolve: null,
        timer: null,
        decided: false,
      };
      rec.finish = (decision, reason) => {
        if (rec.decided) return;
        rec.decided = true;
        if (rec.timer) clearTimeout(rec.timer);
        s.pending.delete(reqId);
        auditWrite('approval', {
          sessionId: s.id,
          reqId,
          tool,
          decision,
          reasonCode: reason === 'timeout' ? 'timeout' : reason === 'interrupted' ? 'interrupted' : undefined,
        });
        if (!reason || reason === 'user') emitStatus(s, 'running');
        resolve({ decision, reason });
      };
      rec.resolve = rec.finish;
      s.pending.set(reqId, rec);

      publish(s, { type: 'tool_request', reqId, tool, input, cwd, warnings, expiresAt, auto: false });
      emitStatus(s, 'waiting_approval');
      auditWrite('tool_request', { sessionId: s.id, reqId, tool });

      rec.timer = setTimeout(() => rec.finish('deny', 'timeout'), Math.max(1, config.approvalTimeoutMs));
      rec.timer.unref?.();
    });
  }

  function denyAllPending(s, reason) {
    for (const rec of [...s.pending.values()]) rec.finish('deny', reason);
  }

  // ── runtime lifecycle ──────────────────────────────────────────────────────
  function onRuntimeEvent(s, ev, token) {
    if (!ev || typeof ev.type !== 'string') return;
    if (s.rtToken !== token) return; // событие от уже закрытого/чужого child
    if (ev.type === '_sdk_session_id') {
      if (typeof ev.sdkSessionId === 'string' && ev.sdkSessionId.length <= 128) {
        s.sdkSessionId = ev.sdkSessionId;
        persist();
      }
      return;
    }
    if (ev.type === 'tool_result') {
      auditWrite('tool_result', { sessionId: s.id, tool: ev.tool, ok: ev.ok === true, reqId: ev.reqId });
    } else if (ev.type === 'result') {
      auditWrite('result', { sessionId: s.id, code: ev.stopReason ? 'turn_done' : 'turn_done' });
      s.lastActive = now();
      emitStatus(s, 'idle');
    } else if (ev.type === 'error') {
      auditWrite('runtime_error', { sessionId: s.id, code: ev.code });
      emitStatus(s, 'error');
    }
    publish(s, ev);
  }

  /** Запускает child, если есть свободный слот. null — слот занят. */
  function ensureStarted(s) {
    if (s.rt) return Promise.resolve(s.rt);
    if (s.starting) return s.starting;
    if (activeChildren >= config.maxSessions) {
      if (s.status !== 'waiting') {
        s.status = 'waiting';
        persist();
        emitStatus(s, 'waiting');
      }
      return Promise.resolve(null);
    }
    activeChildren += 1;
    const token = Symbol('runtime-session');
    const generation = s.generation;
    s.rtToken = token;
    s.starting = (async () => {
      try {
        const rt = await runtime.createSession({
          sessionId: s.id,
          cwd: s.cwd,
          resume: s.sdkSessionId || undefined,
          emit: (ev) => onRuntimeEvent(s, ev, token),
          requestApproval: (req) => requestApproval(s, req),
        });
        if (s.generation !== generation) {
          // сессию закрыли/удалили, пока стартовал child — не оставляем сироту
          activeChildren = Math.max(0, activeChildren - 1);
          s.rtToken = null;
          try {
            await rt.close();
          } catch {
            /* ignore */
          }
          return null;
        }
        s.rt = rt;
        s.status = 'active';
        persist();
        emitStatus(s, 'idle');
        return rt;
      } catch {
        activeChildren = Math.max(0, activeChildren - 1);
        s.rt = null;
        s.rtToken = null;
        s.status = 'error';
        persist();
        emitStatus(s, 'error');
        auditWrite('runtime_start_error', { sessionId: s.id, code: 'runtime_unavailable' });
        throw new HttpError(500, 'internal', 'runtime unavailable');
      } finally {
        s.starting = undefined;
      }
    })();
    return s.starting;
  }

  async function stopChild(s, reason) {
    const rt = s.rt;
    s.rt = null;
    s.rtToken = null;
    s.generation = (s.generation || 0) + 1;
    if (rt) {
      activeChildren = Math.max(0, activeChildren - 1);
      try {
        await rt.close();
      } catch {
        /* закрытие идемпотентно */
      }
    }
    denyAllPending(s, reason === 'idle' || reason === 'closed' ? 'closed' : reason);
  }

  function flushWaiting() {
    if (shuttingDown) return;
    const waiting = [...sessions.values()]
      .filter((s) => !s.rt && s.queue.length > 0 && s.status === 'waiting')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const s of waiting) {
      if (activeChildren >= config.maxSessions) break;
      ensureStarted(s)
        .then(async (rt) => {
          if (!rt) return;
          const texts = s.queue.splice(0);
          for (const text of texts) {
            try {
              emitStatus(s, 'running');
              await rt.sendUserText(text);
            } catch {
              auditWrite('runtime_send_error', { sessionId: s.id, code: 'send_failed' });
            }
          }
        })
        .catch(() => {
          /* status/error уже отправлены в ensureStarted */
        });
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function list() {
    return [...sessions.values()].sort((a, b) => b.lastActive - a.lastActive).map(metaOf);
  }

  function create({ cwd, mode } = {}) {
    if (mode !== undefined && !MODES.has(mode)) {
      throw new HttpError(400, 'bad_request', 'unsupported mode');
    }
    const absCwd = resolveCwd(config, cwd);
    const id = randomUUID();
    const t = now();
    const s = {
      id,
      title: DEFAULT_TITLE,
      cwd: absCwd,
      mode: 'safe',
      status: 'idle',
      createdAt: t,
      lastActive: t,
      sdkSessionId: null,
      rt: null,
      starting: undefined,
      pending: new Map(),
      queue: [],
      msgTimes: [],
      seq: 0,
      generation: 0,
    };
    sessions.set(id, s);
    persist();
    auditWrite('session_create', { sessionId: id, code: 'safe' });
    return metaOf(s);
  }

  function get(id) {
    return metaOf(mustGet(id));
  }

  function snapshot(id) {
    const s = mustGet(id);
    return {
      session: metaOf(s),
      pendingApprovals: [...s.pending.values()].map((r) => ({
        reqId: r.reqId,
        tool: r.tool,
        input: r.input,
        cwd: r.cwd,
        warnings: r.warnings,
        expiresAt: r.expiresAt,
      })),
    };
  }

  async function sendMessage(id, text) {
    const s = mustGet(id);
    if (typeof text !== 'string') throw new HttpError(400, 'bad_request', 'text is required');
    const body = text.trim();
    if (!body) throw new HttpError(400, 'bad_request', 'text is required');
    if (Buffer.byteLength(body, 'utf8') > config.maxMessageBytes) throw payloadTooLarge('message too large');

    const t = now();
    s.msgTimes = s.msgTimes.filter((x) => t - x < 60_000);
    if (s.msgTimes.length >= config.messagesPerMinute) throw rateLimited('too many messages');
    s.msgTimes.push(t);
    s.lastActive = t;
    s.seq += 1;
    if (s.title === DEFAULT_TITLE) {
      s.title = padTitle(body);
      persist();
    }
    auditWrite('message', { sessionId: s.id, count: 1 });

    if (!s.rt) {
      const rt = await ensureStarted(s);
      if (!rt) {
        if (!sessions.has(s.id)) throw notFound('session not found');
        if (s.queue.length >= MAX_QUEUE) throw conflict('queue is full');
        s.queue.push(body);
        persist();
        return { queued: true, status: s.status };
      }
      emitStatus(s, 'running');
      // не ждём завершения турна: POST /messages отвечает 202 сразу,
      // поток и approvals идут через SSE (CONTRACT §6).
      Promise.resolve(rt.sendUserText(body)).catch(() => {
        auditWrite('runtime_send_error', { sessionId: s.id, code: 'send_failed' });
      });
      return { queued: false, status: s.status };
    }
    emitStatus(s, 'running');
    Promise.resolve(s.rt.sendUserText(body)).catch(() => {
      auditWrite('runtime_send_error', { sessionId: s.id, code: 'send_failed' });
    });
    return { queued: false, status: s.status };
  }

  function resolveApproval(id, reqId, decision, reason) {
    const s = mustGet(id);
    if (decision !== 'allow' && decision !== 'deny') {
      throw new HttpError(400, 'bad_request', "decision must be 'allow' or 'deny'");
    }
    const rec = s.pending.get(reqId);
    if (!rec) throw notFound('approval not found');
    rec.finish(decision, reason ? 'user' : 'user');
    return { ok: true };
  }

  async function interrupt(id) {
    const s = mustGet(id);
    denyAllPending(s, 'interrupted');
    if (s.rt) {
      try {
        await s.rt.interrupt();
      } catch {
        /* ignore */
      }
    }
    auditWrite('interrupt', { sessionId: s.id, code: 'user' });
    return { ok: true };
  }

  async function close(id) {
    const s = mustGet(id);
    await stopChild(s, 'closed');
    if (s.status !== 'closed') {
      s.status = 'closed';
      persist();
      emitStatus(s, 'idle');
    }
    auditWrite('session_close', { sessionId: s.id, code: 'user' });
    flushWaiting();
    return { ok: true };
  }

  async function remove(id) {
    const s = mustGet(id);
    await stopChild(s, 'closed');
    sessions.delete(id);
    persist();
    try {
      sse.closeSession(id, 'session_removed');
    } catch {
      /* ignore */
    }
    auditWrite('session_remove', { sessionId: id, code: 'user' });
    flushWaiting();
    return { ok: true };
  }

  function touchHeartbeat(connectionId) {
    try {
      return sse.touchHeartbeat(connectionId);
    } catch {
      return 0;
    }
  }

  function subscribe(id) {
    mustGet(id);
    return {
      replay(lastEventId) {
        return sse.replay(id, lastEventId);
      },
      unsubscribe() {
        /* ring buffer общий; соединение закрывается через sse */
      },
    };
  }

  function activeCount() {
    return activeChildren;
  }

  /** Закрывает child'ы сессий, простаивающих дольше IDLE_CLOSE_MS. */
  async function runMaintenance() {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (!s.rt) continue;
      if (t - s.lastActive < config.idleCloseMs) continue;
      await stopChild(s, 'idle');
      s.status = 'idle';
      persist();
      emitStatus(s, 'idle');
      auditWrite('session_idle_close', { sessionId: s.id, code: 'idle' });
    }
  }

  async function shutdown() {
    shuttingDown = true;
    for (const s of [...sessions.values()]) {
      const rt = s.rt;
      s.rt = null;
      if (rt) {
        try {
          await rt.close();
        } catch {
          /* ignore */
        }
      }
      denyAllPending(s, 'interrupted');
    }
    activeChildren = 0;
    try {
      sse.closeAll('shutdown');
    } catch {
      /* ignore */
    }
    // финальный снимок метаданных (запись до выставления флага выше уже не нужна)
    try {
      const data = {
        version: 1,
        updatedAt: new Date(now()).toISOString(),
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          mode: s.mode,
          status: 'idle',
          createdAt: s.createdAt,
          lastActive: s.lastActive,
          sdkSessionId: s.sdkSessionId || null,
        })),
      };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}-shutdown`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      /* ignore */
    }
  }

  return {
    list,
    create,
    get,
    snapshot,
    sendMessage,
    resolveApproval,
    interrupt,
    close,
    remove,
    touchHeartbeat,
    subscribe,
    runMaintenance,
    shutdown,
    activeCount,
    get max() {
      return config.maxSessions;
    },
    /** только для тестов/health: список id */
    ids: () => [...sessions.keys()],
  };
}

export default createSessionManager;
