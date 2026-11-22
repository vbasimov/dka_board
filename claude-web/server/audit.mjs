/**
 * audit.mjs — JSONL-аудит (CONTRACT §4, plan §7.1 п.8).
 *
 * Пишем ТОЛЬКО метаданные: event/tool/decision/duration/code/sessionId/reqId/
 * status/ok/count. Промпты, тексты, пути пользователя и секреты отбрасываются
 * или режутся по whitelist-паттернам. Файл 0600, атомарная ротация.
 */
import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const EVENT_RE = /^[a-z][a-z0-9_.-]{0,40}$/;
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,60}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const DECISION_RE = /^(allow|deny|approve|block|timeout|interrupted|error)$/i;
const SECRET_RE = /sk-ant-|^[0-9a-f]{64}$/i;

function cleanString(v, re, max = 64) {
  if (typeof v !== 'string') return undefined;
  const s = v.slice(0, max);
  if (!re.test(s)) return undefined;
  if (SECRET_RE.test(s)) return '[redacted]';
  return s;
}

function cleanNumber(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  if (v > 86_400_000) return undefined;
  return Math.round(v);
}

/** Whitelist-фильтр полей события. */
export function sanitizeAuditFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  if (typeof fields.event === 'string') {
    const e = cleanString(fields.event, EVENT_RE, 40);
    if (e) out.event = e;
  }
  const tool = cleanString(fields.tool, TOOL_RE, 60);
  if (tool) out.tool = tool;
  if (typeof fields.decision === 'string' && DECISION_RE.test(fields.decision)) {
    out.decision = fields.decision.toLowerCase();
  }
  for (const key of ['duration', 'durationMs']) {
    const n = cleanNumber(fields[key]);
    if (n !== undefined) out[key] = n;
  }
  const code = cleanString(fields.code, CODE_RE, 40);
  if (code) out.code = code;
  for (const key of ['sessionId', 'reqId']) {
    const id = cleanString(fields[key], ID_RE, 64);
    if (id) out[key] = id;
  }
  if (typeof fields.status === 'string' && DECISION_RE.test(fields.status)) {
    out.status = fields.status.toLowerCase();
  }
  if (typeof fields.ok === 'boolean') out.ok = fields.ok;
  if (Number.isSafeInteger(fields.count) && fields.count >= 0 && fields.count < 1_000_000) {
    out.count = fields.count;
  }
  const reasonCode = cleanString(fields.reasonCode, CODE_RE, 40);
  if (reasonCode) out.reasonCode = reasonCode;
  return out;
}

/**
 * @param {{path:string, mode?:number, now?:()=>number, maxBytes?:number,
 *          mkdir?:boolean}} opts
 */
export function createAudit({ path, mode = 0o600, now = () => Date.now(), maxBytes = 10 * 1024 * 1024, mkdir = true }) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('audit path must be absolute');
  if (mkdir) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch {
      /* каталог уже существует или не наш — открытие ниже даст внятную ошибку */
    }
  }
  let fd;
  let bytes = 0;
  let closed = false;
  let writeErrors = 0;

  const open = () => {
    fd = openSync(path, 'a', mode);
    try {
      fchmodSync(fd, mode);
    } catch {
      /* best-effort: права уже заданы при создании */
    }
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = 0;
    }
  };

  const rotate = () => {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    const rotated = `${path}.1`;
    try {
      unlinkSync(rotated);
    } catch {
      /* нет старого */
    }
    try {
      renameSync(path, rotated);
    } catch {
      /* не смогли — продолжим писать в тот же файл */
    }
    open();
    bytes = 0;
  };

  open();

  const api = {
    path,
    /**
     * @param {string} event
     * @param {Record<string, unknown>} [fields]
     * @returns {boolean}
     */
    write(event, fields) {
      if (closed || !fd) return false;
      try {
        const clean = sanitizeAuditFields({ ...fields, event });
        if (!clean.event) return false;
        const line = `${JSON.stringify({ ts: new Date(now()).toISOString(), ...clean })}\n`;
        if (bytes > 0 && bytes + Buffer.byteLength(line) > maxBytes) rotate();
        writeSync(fd, line);
        bytes += Buffer.byteLength(line);
        return true;
      } catch {
        writeErrors += 1;
        return false;
      }
    },
    size() {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    },
    errorCount() {
      return writeErrors;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (fd) closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = undefined;
    },
  };
  return api;
}

export default createAudit;
