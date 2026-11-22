/**
 * test/server/helpers.mjs — общие фикстуры и утилиты тестов (не тест-файл).
 */
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../server/config.mjs';

export const EDGE = '0123456789abcdef'.repeat(4); // 64 hex, тестовый (не боевой секрет)
export const USER_HASH = '8d9462ad9d8e';
export const DEV_USER_HASH = 'deadbeef0001';
export const PUBLIC_ORIGIN = 'https://vps-4692.tailfbc4b2.ts.net:10000';
export const PUBLIC_HOST = 'vps-4692.tailfbc4b2.ts.net:10000';
export const TEST_TOKEN = 'test-token-not-real';

export function tempRoot(prefix = 'claude-web-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Стандартное окружение приложения + временные каталоги. */
export function makeEnv(root, { authMode = 'prod', runtime = 'fake', extra = {} } = {}) {
  const workspaces = join(root, 'workspaces');
  const stateDir = join(root, 'state');
  mkdirSync(workspaces, { recursive: true, mode: 0o700 });
  mkdirSync(join(workspaces, 'project-a'), { recursive: true, mode: 0o700 });
  mkdirSync(join(workspaces, 'project-b'), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const env = {
    HOST: '127.0.0.1',
    WORKSPACES: workspaces,
    STATE_DIR: stateDir,
    AUDIT_LOG: join(root, 'audit.jsonl'),
    BASE_PATH: '/claude/',
    HOME: join(root, 'home'),
    CLAUDE_CONFIG_DIR: join(root, 'state', 'claude-config'),
    CLAUDE_RUNTIME: runtime,
    ...extra,
  };
  if (authMode === 'prod') {
    env.PORT = '3090';
    env.PUBLIC_ORIGIN = PUBLIC_ORIGIN;
    env.EDGE_SECRET = EDGE;
    env.ALLOWED_USER_HASH = USER_HASH;
    env.CLAUDE_CODE_OAUTH_TOKEN = TEST_TOKEN;
  } else {
    env.AUTH_MODE = 'dev';
    env.PORT = '3091';
    env.DEV_USER_HASH = DEV_USER_HASH;
  }
  // extra применяется последним: тесты могут переопределить PORT и т.п.
  return { ...env, ...extra };
}

export function makeConfig(root, opts = {}) {
  return loadConfig(makeEnv(root, opts));
}

/** web/dist фикстура с статикой и симлинком наружу. */
export function makeDist(root) {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'claude', 'icons'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log("app")');
  writeFileSync(join(dist, 'sw.js'), 'self.addEventListener("install", () => {});');
  writeFileSync(
    join(dist, 'claude', 'manifest.webmanifest'),
    JSON.stringify({ id: '/claude/', start_url: '/claude/', scope: '/claude/' }),
  );
  writeFileSync(join(dist, 'claude', 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dist, 'index.txt'), 'public text');
  writeFileSync(join(dist, '.secret'), 'dotfile');
  mkdirSync(join(dist, 'nested'), { recursive: true });
  writeFileSync(join(dist, 'nested', 'index.html'), '<p>nested index</p>');
  writeFileSync(join(dist, 'nested', 'page.html'), '<p>nested</p>');

  const outside = join(root, 'outside-secret.txt');
  writeFileSync(outside, 'TOP-SECRET-OUTSIDE-DIST');
  try {
    symlinkSync(outside, join(dist, 'leak.txt'));
  } catch {
    /* платформа без симлинков */
  }
  try {
    symlinkSync(join(root, 'outside-dir'), join(dist, 'linkdir'));
  } catch {
    /* ignore */
  }
  return dist;
}

/** req-подобный объект для auth.checkRequest. */
export function fakeReq({
  method = 'GET',
  headers = {},
  remoteAddress = '127.0.0.1',
} = {}) {
  return {
    method,
    headers,
    socket: { remoteAddress },
    connection: { remoteAddress },
  };
}

/** res-подобный объект, писавший ответ в память. */
export function captureRes() {
  const headers = {};
  const listeners = new Map();
  const chunks = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    headers,
    ended: false,
    destroyed: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete headers[String(name).toLowerCase()];
    },
    writeHead(status) {
      res.statusCode = status;
      res.headersSent = true;
      return res;
    },
    flushHeaders() {
      res.headersSent = true;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      if (res.ended) return;
      res.ended = true;
      res.emit('finish');
    },
    destroy() {
      res.destroyed = true;
      res.ended = true;
    },
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return res;
    },
    once(event, fn) {
      const wrapped = (...args) => {
        const arr = (listeners.get(event) || []).filter((f) => f !== wrapped);
        listeners.set(event, arr);
        fn(...args);
      };
      return res.on(event, wrapped);
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn));
      return res;
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    body() {
      return chunks.join('');
    },
    json() {
      return JSON.parse(res.body());
    },
  };
  return res;
}

/** req с EventEmitter-поведением для readJsonBody. */
export function bodyReq(bodyText, { headers = {} } = {}) {
  const listeners = new Map();
  const req = {
    headers,
    on(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return req;
    },
    removeListener(event, fn) {
      const arr = listeners.get(event) || [];
      listeners.set(event, arr.filter((f) => f !== fn));
      return req;
    },
    resumed: 0,
    resume() {
      req.resumed += 1;
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
  };
  process.nextTick(() => {
    if (bodyText) req.emit('data', Buffer.from(bodyText));
    req.emit('end');
  });
  return req;
}

export async function startServer(app) {
  const server = http.createServer((req, res) => {
    Promise.resolve(app(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

export function stopServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** HTTP-запрос с боевыми auth-заголовками (prod) по умолчанию. */
export function apiRequest(port, { method = 'GET', path = '/claude/api/health', headers = {}, body, auth = 'prod' } = {}) {
  const base = { Host: PUBLIC_HOST };
  if (auth === 'prod') {
    base['X-Claude-Edge'] = EDGE;
    base['X-Auth-User'] = USER_HASH;
  } else if (auth === 'user') {
    base['X-Auth-User'] = USER_HASH;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    if (auth === 'prod') base.Origin = PUBLIC_ORIGIN;
    base['Content-Type'] = 'application/json';
  }
  const merged = { ...base, ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: merged,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Открывает SSE и собирает события до count/предиката/таймаута.
 * @returns {Promise<{events:Array, res:object, close:Function}>}
 */
export function collectSse(port, path, { headers = {}, count = 1, until, timeoutMs = 5000, auth = 'prod' } = {}) {
  const base = { Host: PUBLIC_HOST, Accept: 'text/event-stream' };
  if (auth === 'prod') {
    base['X-Claude-Edge'] = EDGE;
    base['X-Auth-User'] = USER_HASH;
  } else if (auth === 'user') {
    base['X-Auth-User'] = USER_HASH;
  }
  const merged = { ...base, ...headers };
  const targetCount = until ? Number.POSITIVE_INFINITY : count;
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    let closed = false;
    const finish = (reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve({ events, reason, close: () => finish('closed') });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: merged }, (res) => {
      if (res.statusCode !== 200) {
        finish(`status_${res.statusCode}`);
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
          const ev = { event: 'message', data: '', id: undefined };
          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim());
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              const raw = line.slice(5).trim();
              try {
                ev.data = JSON.parse(raw);
              } catch {
                ev.data = raw;
              }
            }
          }
          events.push(ev);
          if (until && until(events)) {
            finish('until');
            return;
          }
          if (events.length >= targetCount) {
            finish('count');
            return;
          }
        }
      });
      res.on('end', () => finish('end'));
    });
    req.on('error', (err) => {
      if (!closed) reject(err);
    });
    req.end();
  });
}

/** Ждёт, пока predicate() станет truthy. */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timeout');
}
