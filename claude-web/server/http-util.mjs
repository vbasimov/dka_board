/**
 * http-util.mjs — HTTP-помощники: ошибки, JSON-ответы, security-заголовки,
 * чтение тела с лимитом ДО буферизации (CONTRACT §4, §6).
 */
import { timingSafeEqual } from 'node:crypto';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

/** HTTP-ошибка с machine-кодом из CONTRACT §4. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message = 'bad request') {
  return new HttpError(400, 'bad_request', message);
}
export function unauthorized(message = 'unauthorized') {
  return new HttpError(401, 'unauthorized', message);
}
export function forbidden(message = 'forbidden') {
  return new HttpError(403, 'forbidden', message);
}
export function notFound(message = 'not found') {
  return new HttpError(404, 'not_found', message);
}
export function conflict(message = 'limit exceeded') {
  return new HttpError(409, 'limit', message);
}
export function payloadTooLarge(message = 'payload too large') {
  return new HttpError(413, 'payload_too_large', message);
}
export function unsupportedMediaType(message = 'unsupported media type') {
  return new HttpError(415, 'unsupported_media_type', message);
}
export function rateLimited(message = 'rate limited') {
  return new HttpError(429, 'rate_limited', message);
}
export function internal(message = 'internal error') {
  return new HttpError(500, 'internal', message);
}

/** Заголовки безопасности на ВСЕ ответы приложения (CONTRACT §6). */
export function securityHeaders() {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Robots-Tag': 'noindex',
  };
}

export function applySecurityHeaders(res) {
  const h = securityHeaders();
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

/** JSON-ответ; по умолчанию no-store. */
export function json(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(payload);
  return true;
}

/** Ответ-ошибка {error, code}. */
export function sendError(res, status, code, message) {
  return json(res, status, { error: message || code, code });
}

/** Отправка любой ошибки (HttpError или 500 без утечки деталей). */
export function sendHttpError(res, err) {
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
  return sendError(res, 500, 'internal', 'internal error');
}

export function methodNotAllowed(res, allow) {
  if (allow) res.setHeader('Allow', allow);
  return sendError(res, 405, 'method_not_allowed', 'method not allowed');
}

export function isJsonContentType(req) {
  const ct = String(req.headers['content-type'] || '');
  const type = ct.split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/**
 * Читает тело как JSON с жёстким лимитом.
 * Content-Length проверяется ДО чтения: слишком большое тело не буферизуется.
 * @returns {Promise<object>}
 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (cl !== undefined) {
      const n = Number(cl);
      if (!Number.isFinite(n) || n < 0) {
        req.resume();
        reject(badRequest('invalid content-length'));
        return;
      }
      if (n > maxBytes) {
        req.resume();
        reject(payloadTooLarge());
        return;
      }
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.resume();
      reject(err);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(payloadTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(badRequest('JSON object expected'));
        }
        resolve(parsed);
      } catch {
        reject(badRequest('invalid JSON'));
      }
    };
    const onError = () => fail(badRequest('body read error'));
    const onAborted = () => fail(badRequest('request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** Loopback-проверка remoteAddress (IPv4/IPv6). */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr);
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Сравнение строк постоянного времени (длины не секретны, но не выходим за timingSafeEqual). */
export function constantTimeEqualString(expected, actual) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
