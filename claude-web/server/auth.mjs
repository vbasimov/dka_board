/**
 * auth.mjs — проверка запроса до чтения тела (CONTRACT §6).
 *
 * Порядок (fail-closed):
 *   1. remoteAddress — loopback
 *   2. X-Claude-Edge — timingSafeEqual с EDGE_SECRET (prod), иначе 403
 *   3. X-Auth-User === ALLOWED_USER_HASH (prod; dev — DEV_USER_HASH без заголовков)
 *   4. Host === публичный authority
 *   5. Origin, если присутствует, === PUBLIC_ORIGIN (и для GET)
 *   6. Sec-Fetch-Site: cross-site -> 403
 *   7. unsafe-метод: Origin обязателен, Content-Type: application/json
 *
 * AUTH_MODE=dev (только 127.0.0.1:3091) не требует edge/user: браузерный
 * EventSource не может ставить заголовки, а Caddy в dev отсутствует.
 */
import { isJsonContentType, isLoopbackAddress } from './http-util.mjs';
import { timingSafeEqual } from 'node:crypto';

const HEX_RE = /^[0-9a-f]+$/i;

function header(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v === undefined ? undefined : String(v);
}

function deny(status, code, message) {
  return { ok: false, status, code, message };
}

function edgeMatches(config, presented) {
  const expected = config.edgeSecret;
  if (!expected || !presented) return false;
  if (!HEX_RE.test(presented) || presented.length !== expected.length * 2) return false;
  const actual = Buffer.from(presented, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Сравнение X-Auth-User (12 hex) без утечки длины через ранний выход. */
function userMatches(expected, presented) {
  if (!expected || typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} config
 * @returns {{ok:true,userHash:string}|{ok:false,status:number,code:string,message?:string}}
 */
export function checkRequest(req, config) {
  const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress;
  if (!isLoopbackAddress(remote)) {
    return deny(403, 'forbidden', 'loopback only');
  }

  if (config.authMode === 'prod') {
    if (!edgeMatches(config, header(req, 'x-claude-edge'))) {
      return deny(403, 'forbidden', 'forbidden');
    }
    if (!userMatches(config.allowedUserHash, header(req, 'x-auth-user'))) {
      return deny(403, 'forbidden', 'forbidden');
    }
  }

  const host = String(header(req, 'host') || '').toLowerCase();
  if (!config.allowedHosts.includes(host)) {
    return deny(403, 'forbidden', 'forbidden host');
  }

  const origin = header(req, 'origin');
  const hasOrigin = origin !== undefined && origin !== '';
  if (hasOrigin && !config.allowedOrigins.includes(origin)) {
    return deny(403, 'forbidden', 'forbidden origin');
  }

  const site = String(header(req, 'sec-fetch-site') || '').toLowerCase();
  if (site === 'cross-site') {
    return deny(403, 'forbidden', 'cross-site request');
  }

  const method = String(req.method || 'GET').toUpperCase();
  const safeMethod = method === 'GET' || method === 'HEAD';
  if (!safeMethod) {
    if (!hasOrigin) return deny(403, 'forbidden', 'origin required');
    if (!isJsonContentType(req)) {
      return deny(415, 'unsupported_media_type', 'application/json required');
    }
  }

  const userHash = config.authMode === 'prod' ? config.allowedUserHash : config.devUserHash;
  return { ok: true, userHash };
}

export default checkRequest;
