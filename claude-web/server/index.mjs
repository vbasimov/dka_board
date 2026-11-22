#!/usr/bin/env node
/**
 * index.mjs — сборка зависимостей, HTTP-сервер на HOST:PORT, graceful shutdown.
 *
 * Секреты не логируются: только mode/host/port/base/max_sessions и коды ошибок.
 */
import http from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config.mjs';
import { createAudit } from './audit.mjs';
import { createSseHub } from './sse.mjs';
import { createRuntime } from './runtime/index.mjs';
import { createSessionManager } from './sessions.mjs';
import { createApp } from './app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(here);

function log(line) {
  process.stderr.write(`[claude-web] ${line}\n`);
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function fatal(code) {
  log(`startup failed: ${code}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  fatal(err instanceof ConfigError ? err.code : 'config_error');
}

const distDir = process.env.DIST_DIR || join(rootDir, 'web', 'dist');

// Fail-closed: workspace должен существовать, state-dir — создаём/проверяем.
try {
  const st = statSync(config.workspaces);
  if (!st.isDirectory()) fatal('workspaces_not_directory');
} catch {
  fatal('workspaces_missing');
}
try {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.claudeConfigDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.auditLog), { recursive: true, mode: 0o700 });
} catch {
  fatal('data_dir_unavailable');
}

let audit;
try {
  audit = createAudit({ path: config.auditLog, maxBytes: config.auditMaxBytes });
} catch {
  fatal('audit_unavailable');
}

const sse = createSseHub({ config });
const runtime = createRuntime(config);

let sessions;
try {
  sessions = createSessionManager({ config, runtime, sse, audit });
} catch (err) {
  audit.write('startup_error', { code: err instanceof ConfigError ? err.code : 'sessions_init_failed' });
  fatal('sessions_init_failed');
}

const app = createApp({
  config,
  deps: { sessions, sse, audit, runtime, distDir, version: readVersion() },
});

const server = http.createServer((req, res) => {
  Promise.resolve(app(req, res)).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    try {
      res.end('{"error":"internal error","code":"internal"}');
    } catch {
      /* ignore */
    }
  });
});

server.on('error', () => {
  fatal('listen_failed');
});

server.listen(config.port, config.host, () => {
  log(
    `listening on ${config.host}:${config.port} base=${config.basePath} runtime=${runtime.mode} ` +
      `max_sessions=${config.maxSessions} auth=${config.authMode}`,
  );
  if (runtime.mode === 'sdk') log('runtime=sdk: token/env не выводятся в лог');
});

const maintenance = setInterval(
  () => {
    sessions.runMaintenance().catch(() => {
      audit.write('maintenance_error', { code: 'maintenance_failed' });
    });
  },
  Math.max(500, Math.min(60_000, Math.floor(config.idleCloseMs / 4))),
);
maintenance.unref?.();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${signal})`);
  clearInterval(maintenance);
  const force = setTimeout(() => {
    log('forced exit');
    process.exit(1);
  }, 8_000);
  force.unref?.();

  server.close(() => {
    try {
      audit.write('shutdown', { code: 'graceful' });
      audit.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  try {
    await sessions.shutdown();
  } catch {
    audit.write('shutdown_error', { code: 'sessions_shutdown_failed' });
  }
  try {
    sse.stop();
  } catch {
    /* ignore */
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
