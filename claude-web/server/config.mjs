/**
 * config.mjs — fail-closed загрузка конфигурации из env (CONTRACT §2).
 *
 * loadConfig(env) — чистая функция (не трогает fs/сеть), бросает ConfigError
 * с коротким machine-кодом. Секреты (EDGE_SECRET, ALLOWED_USER_HASH,
 * CLAUDE_CODE_OAUTH_TOKEN) НИКОГДА не попадают в text ошибки, логи или ответы.
 *
 * Публичных origin'ов может быть несколько: PUBLIC_ORIGIN плюс необязательный
 * EXTRA_ORIGINS (только prod, список bare-origin'ов через запятую). Их host'ы
 * и origin'ы складываются в allowedHosts / allowedOrigins (CONTRACT §6).
 */
import { URL } from 'node:url';

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX12 = /^[0-9a-f]{12}$/i;
const ABS_PATH = /^\/(?:[^/\0]+(?:\/[^/\0]+)*)?$/;
const BASE_PATH_RE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/$/;

function raw(env, name) {
  const v = env[name];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function required(env, name) {
  const v = raw(env, name);
  if (!v) throw new ConfigError('missing_env', `${name} is required`);
  return v;
}

function absPath(env, name) {
  const v = raw(env, name);
  if (!v) throw new ConfigError('missing_env', `${name} is required`);
  if (!ABS_PATH.test(v)) throw new ConfigError('invalid_env', `${name} must be an absolute path`);
  if (v.includes('..')) throw new ConfigError('invalid_env', `${name} must not contain '..'`);
  return v;
}

function intEnv(env, name, fallback) {
  const v = raw(env, name);
  if (!v) return fallback;
  if (!/^[0-9]+$/.test(v)) throw new ConfigError('invalid_env', `${name} must be a positive integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new ConfigError('invalid_env', `${name} must be a positive integer`);
  return n;
}

/**
 * Разбор EXTRA_ORIGINS — дополнительных публичных origin'ов (CONTRACT §2):
 * список bare-origin'ов `https://host[:port]` через запятую.
 *
 * Каждый элемент проверяется fail-closed; в тексте ошибки — только номер
 * элемента и требование, значений env нет. Host и origin нормализуются так же,
 * как их сериализует браузер: host в lower-case, дефолтный порт 443 отброшен.
 * Дубли (в том числе совпадающие с PUBLIC_ORIGIN) отбрасываются.
 *
 * @param {string} value сырое значение env (уже trim'нутое, может быть '')
 * @returns {{host:string, origin:string}[]}
 */
function parseExtraOrigins(value) {
  if (!value) return [];
  const out = [];
  const seen = new Set();
  value.split(',').forEach((part, index) => {
    const n = index + 1;
    const entry = part.trim();
    if (!entry) throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} is empty`);
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} is not a valid URL`);
    }
    if (url.username || url.password) {
      throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} must not contain credentials`);
    }
    if (url.protocol !== 'https:') {
      throw new ConfigError('insecure_env', `EXTRA_ORIGINS entry ${n} must be https`);
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} must be a bare origin`);
    }
    if (url.port !== '') {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} has an out-of-range port`);
      }
    }
    // URL-парсер мог «спасти» кривой ввод (https:///host, https://host:443/,
    // https://host:8443/.): требуем, чтобы элемент буквально совпал с
    // каноническим origin (допускается только необязательный хвостовой '/').
    const withoutSlash = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (withoutSlash.toLowerCase() !== url.origin) {
      throw new ConfigError('invalid_env', `EXTRA_ORIGINS entry ${n} must be a bare origin like https://host[:port]`);
    }
    if (seen.has(url.origin)) return;
    seen.add(url.origin);
    out.push({ host: url.host, origin: url.origin });
  });
  return out;
}

function validateBasePath(v) {
  if (!v.startsWith('/') || !v.endsWith('/')) {
    throw new ConfigError('invalid_env', 'BASE_PATH must start and end with "/"');
  }
  if (!BASE_PATH_RE.test(v)) throw new ConfigError('invalid_env', 'BASE_PATH is not a valid path');
  for (const seg of v.split('/').filter(Boolean)) {
    if (seg === '.' || seg === '..') throw new ConfigError('invalid_env', 'BASE_PATH is not a valid path');
  }
  return v;
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {Readonly<object>} config
 */
export function loadConfig(env = process.env) {
  const authMode = raw(env, 'AUTH_MODE') || 'prod';
  if (authMode !== 'prod' && authMode !== 'dev') {
    throw new ConfigError('invalid_env', "AUTH_MODE must be 'prod' or 'dev'");
  }
  const isProd = authMode === 'prod';

  const runtimeMode = raw(env, 'CLAUDE_RUNTIME') || (isProd ? 'sdk' : 'fake');
  if (runtimeMode !== 'sdk' && runtimeMode !== 'fake') {
    throw new ConfigError('invalid_env', "CLAUDE_RUNTIME must be 'sdk' or 'fake'");
  }

  const host = raw(env, 'HOST') || '127.0.0.1';
  if (isProd && host !== '127.0.0.1') {
    throw new ConfigError('insecure_env', 'HOST must be 127.0.0.1 in prod');
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new ConfigError('insecure_env', 'HOST must be a loopback address');
  }

  const port = intEnv(env, 'PORT', isProd ? 3090 : 3091);
  if (port > 65535) throw new ConfigError('invalid_env', 'PORT is out of range');

  let publicOrigin;
  let allowedHosts;
  let allowedOrigins;
  let extraOrigins;
  if (isProd) {
    const origin = required(env, 'PUBLIC_ORIGIN');
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigError('invalid_env', 'PUBLIC_ORIGIN must be a valid URL');
    }
    if (url.protocol !== 'https:') throw new ConfigError('insecure_env', 'PUBLIC_ORIGIN must be https in prod');
    if (url.pathname !== '/' || url.search || url.hash) {
      throw new ConfigError('invalid_env', 'PUBLIC_ORIGIN must be a bare origin');
    }
    publicOrigin = url.origin;
    allowedHosts = [url.host];
    allowedOrigins = [url.origin];
    // Второй публичный origin (например Tailscale Funnel :8443 → отдельный
    // Caddy → то же приложение). Пусто по умолчанию: поведение не меняется.
    const extra = parseExtraOrigins(raw(env, 'EXTRA_ORIGINS')).filter((e) => e.origin !== url.origin);
    extraOrigins = extra.map((e) => e.origin);
    for (const e of extra) {
      if (!allowedHosts.includes(e.host)) allowedHosts.push(e.host);
      if (!allowedOrigins.includes(e.origin)) allowedOrigins.push(e.origin);
    }
  } else {
    // AUTH_MODE=dev — только loopback:3091, без Caddy/сессионных заголовков.
    if (port !== 3091) {
      throw new ConfigError('insecure_env', 'AUTH_MODE=dev is only allowed on 127.0.0.1:3091');
    }
    if (raw(env, 'EXTRA_ORIGINS')) {
      throw new ConfigError('insecure_env', 'EXTRA_ORIGINS is only allowed in AUTH_MODE=prod');
    }
    extraOrigins = [];
    publicOrigin = raw(env, 'PUBLIC_ORIGIN') || 'http://127.0.0.1:3091';
    const devUrl = new URL(publicOrigin);
    if (devUrl.protocol !== 'http:') throw new ConfigError('invalid_env', 'dev PUBLIC_ORIGIN must be http');
    if (devUrl.hostname !== '127.0.0.1' && devUrl.hostname !== 'localhost') {
      throw new ConfigError('insecure_env', 'dev PUBLIC_ORIGIN must be loopback');
    }
    allowedHosts = ['127.0.0.1:3091', 'localhost:3091'];
    allowedOrigins = ['http://127.0.0.1:3091', 'http://localhost:3091'];
  }

  const basePath = validateBasePath(raw(env, 'BASE_PATH') || '/claude/');

  const workspaces = absPath(env, 'WORKSPACES');
  const auditLog = absPath(env, 'AUDIT_LOG');
  const stateDir = absPath(env, 'STATE_DIR');

  const maxSessions = intEnv(env, 'MAX_SESSIONS', 2);
  if (maxSessions > 16) throw new ConfigError('invalid_env', 'MAX_SESSIONS is too large');

  const approvalTimeoutMs = intEnv(env, 'APPROVAL_TIMEOUT_MS', 300_000);
  const idleCloseMs = intEnv(env, 'IDLE_CLOSE_MS', 900_000);
  const sseMaxMs = intEnv(env, 'SSE_MAX_MS', 900_000);
  const sseHeartbeatTimeoutMs = intEnv(env, 'SSE_HEARTBEAT_TIMEOUT_MS', 120_000);
  const maxBodyBytes = intEnv(env, 'MAX_BODY_BYTES', 1_048_576);
  const maxMessageBytes = intEnv(env, 'MAX_MESSAGE_BYTES', 32_768);
  const auditMaxBytes = intEnv(env, 'AUDIT_MAX_BYTES', 10 * 1024 * 1024);

  /** @type {{edgeSecret?: string, allowedUserHash?: string, devUserHash?: string, oauthToken?: string}} */
  const secrets = {};

  if (isProd) {
    const edge = required(env, 'EDGE_SECRET');
    if (!HEX64.test(edge)) {
      throw new ConfigError('invalid_env', 'EDGE_SECRET must be 64 hex characters');
    }
    const user = required(env, 'ALLOWED_USER_HASH');
    if (!HEX12.test(user)) {
      throw new ConfigError('invalid_env', 'ALLOWED_USER_HASH must be 12 hex characters');
    }
    secrets.edgeSecret = Buffer.from(edge, 'hex');
    secrets.allowedUserHash = user.toLowerCase();
  } else {
    const devUser = required(env, 'DEV_USER_HASH');
    if (!HEX12.test(devUser)) {
      throw new ConfigError('invalid_env', 'DEV_USER_HASH must be 12 hex characters');
    }
    secrets.devUserHash = devUser.toLowerCase();
  }

  let oauthToken;
  if (runtimeMode === 'sdk' || isProd) {
    const token = required(env, 'CLAUDE_CODE_OAUTH_TOKEN');
    if (token.length < 8) throw new ConfigError('invalid_env', 'CLAUDE_CODE_OAUTH_TOKEN is too short');
    oauthToken = token;
  }

  let home = raw(env, 'HOME') || '/var/lib/claude-web';
  if (!ABS_PATH.test(home)) throw new ConfigError('invalid_env', 'HOME must be an absolute path');
  const claudeConfigDir = raw(env, 'CLAUDE_CONFIG_DIR') || `${stateDir}/claude-config`;
  if (!ABS_PATH.test(claudeConfigDir)) {
    throw new ConfigError('invalid_env', 'CLAUDE_CONFIG_DIR must be an absolute path');
  }
  if (runtimeMode === 'sdk') {
    // Путь к конфигу SDK обязателен: без него child писал бы в чужой HOME.
    required(env, 'CLAUDE_CONFIG_DIR');
  }

  const cfg = {
    authMode,
    isProd,
    runtimeMode,
    host,
    port,
    publicOrigin,
    extraOrigins: Object.freeze(extraOrigins),
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
    basePath,
    workspaces,
    auditLog,
    stateDir,
    maxSessions,
    approvalTimeoutMs,
    idleCloseMs,
    sseMaxMs,
    sseHeartbeatTimeoutMs,
    maxBodyBytes,
    maxMessageBytes,
    auditMaxBytes,
    messagesPerMinute: 30,
    maxTurns: 30,
    home,
    claudeConfigDir,
  };

  // Секреты — non-enumerable: доступны модулям (config.edgeSecret), но не
  // попадают в JSON.stringify / console.log / audit даже при случайном логировании.
  Object.defineProperty(cfg, 'edgeSecret', { value: secrets.edgeSecret, enumerable: false });
  Object.defineProperty(cfg, 'allowedUserHash', { value: secrets.allowedUserHash, enumerable: false });
  Object.defineProperty(cfg, 'devUserHash', { value: secrets.devUserHash, enumerable: false });
  Object.defineProperty(cfg, 'oauthToken', { value: oauthToken, enumerable: false });

  return Object.freeze(cfg);
}

export default loadConfig;
