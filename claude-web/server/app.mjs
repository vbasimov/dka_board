/**
 * app.mjs — HTTP-роутер claude-web (CONTRACT §6).
 *
 * Все ответы проходят auth-check ДО чтения тела. API — под {BASE_PATH}api/,
 * статика — из web/dist; SSE — sessions/:id/events.
 */
import { URL } from 'node:url';
import { checkRequest } from './auth.mjs';
import {
  applySecurityHeaders,
  HttpError,
  json,
  methodNotAllowed,
  readJsonBody,
  sendError,
} from './http-util.mjs';
import { serveStatic } from './static.mjs';
import { listWorkspaces } from './workspaces.mjs';

const POST = ['POST'];

function requireMethod(req, res, methods) {
  const method = String(req.method || 'GET').toUpperCase();
  if (methods.includes(method)) return true;
  methodNotAllowed(res, methods.join(', '));
  return false;
}

/**
 * @param {{config:object, deps:{sessions:object,sse:object,audit:object,
 *          runtime:object,distDir:string,version:string}}} opts
 * @returns {(req:import('node:http').IncomingMessage, res:import('node:http').ServerResponse)=>Promise<void>}
 */
export function createApp({ config, deps }) {
  const { sessions, sse, audit, runtime, distDir, version } = deps;

  async function readBody(req) {
    return readJsonBody(req, config.maxBodyBytes);
  }

  async function handleApi(req, res, parts, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const [first, second, third, fourth] = parts;

    // GET api/health
    if (parts.length === 1 && first === 'health') {
      if (!requireMethod(req, res, ['GET', 'HEAD'])) return;
      return json(res, 200, {
        ok: true,
        version,
        active: sessions.activeCount(),
        max: sessions.max,
        mode: runtime.mode,
      });
    }

    // GET api/workspaces
    if (parts.length === 1 && first === 'workspaces') {
      if (!requireMethod(req, res, ['GET', 'HEAD'])) return;
      return json(res, 200, listWorkspaces(config));
    }

    // GET/POST api/sessions
    if (parts.length === 1 && first === 'sessions') {
      if (!requireMethod(req, res, ['GET', 'POST'])) return;
      if (method === 'GET') return json(res, 200, sessions.list());
      const body = await readBody(req);
      const session = sessions.create({ cwd: body.cwd, mode: body.mode });
      audit.write('http_session_create', { sessionId: session.id });
      return json(res, 201, { id: session.id });
    }

    // POST api/heartbeat
    if (parts.length === 1 && first === 'heartbeat') {
      if (!requireMethod(req, res, POST)) return;
      const body = await readBody(req);
      sessions.touchHeartbeat(typeof body.connectionId === 'string' ? body.connectionId.slice(0, 64) : undefined);
      return json(res, 200, { ok: true, ts: Date.now() });
    }

    // api/sessions/:id...
    if (first === 'sessions' && parts.length >= 2 && second) {
      const id = second;
      audit.write('http_api', { sessionId: id, code: parts[2] || 'get' });

      if (parts.length === 2) {
        if (!requireMethod(req, res, ['GET', 'DELETE'])) return;
        if (method === 'GET') return json(res, 200, sessions.snapshot(id));
        await sessions.remove(id);
        return json(res, 200, { ok: true });
      }

      if (parts.length === 3 && third === 'events') {
        if (!requireMethod(req, res, ['GET'])) return;
        const snapshot = sessions.snapshot(id);
        const lastEventId = req.headers['last-event-id'];
        sse.open(res, {
          sessionId: id,
          snapshot,
          lastEventId,
          onClose: () => {
            audit.write('sse_close', { sessionId: id });
          },
        });
        audit.write('sse_open', { sessionId: id });
        return;
      }

      if (parts.length === 3 && third === 'messages') {
        if (!requireMethod(req, res, POST)) return;
        const body = await readBody(req);
        await sessions.sendMessage(id, body.text);
        return json(res, 202, { ok: true });
      }

      if (parts.length === 3 && third === 'interrupt') {
        if (!requireMethod(req, res, POST)) return;
        await readBody(req);
        await sessions.interrupt(id);
        return json(res, 200, { ok: true });
      }

      if (parts.length === 3 && third === 'close') {
        if (!requireMethod(req, res, POST)) return;
        await readBody(req);
        await sessions.close(id);
        return json(res, 200, { ok: true });
      }

      if (parts.length === 4 && third === 'approvals' && fourth) {
        if (!requireMethod(req, res, POST)) return;
        const body = await readBody(req);
        sessions.resolveApproval(id, fourth, body.decision, body.reason);
        return json(res, 200, { ok: true });
      }
    }

    return sendError(res, 404, 'not_found', 'not found');
  }

  return async function app(req, res) {
    applySecurityHeaders(res);
    let url;
    try {
      url = new URL(String(req.url || '/'), 'http://127.0.0.1');
    } catch {
      return sendError(res, 400, 'bad_request', 'bad request');
    }
    const pathname = url.pathname;
    const baseNoSlash = config.basePath.slice(0, -1);

    // /claude -> /claude/ (относительные URL не должны улетать в корень DSH)
    if (pathname === baseNoSlash) {
      res.statusCode = 308;
      res.setHeader('Location', config.basePath);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    if (!pathname.startsWith(config.basePath)) {
      return sendError(res, 404, 'not_found', 'not found');
    }

    const auth = checkRequest(req, config);
    if (!auth.ok) {
      audit.write('auth_fail', { code: auth.status === 401 ? 'unauthorized' : 'forbidden' });
      return sendError(res, auth.status, auth.code, auth.message || auth.code);
    }

    const rel = pathname.slice(config.basePath.length);
    const parts = rel.split('/').filter(Boolean);

    try {
      if (parts[0] === 'api') {
        if (url.search) {
          // query-параметры пока не используются, но не отдаём на них статику
        }
        return await handleApi(req, res, parts.slice(1), url);
      }
      const handled = serveStatic(req, res, {
        distDir,
        basePath: config.basePath,
        urlPath: pathname,
      });
      if (handled) return;
      return sendError(res, 404, 'not_found', 'not found');
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal';
      audit.write('http_error', { code: code === 'internal' ? 'internal' : code });
      return sendError(res, status, code, err instanceof HttpError ? err.message : 'internal error');
    }
  };
}

export default createApp;
