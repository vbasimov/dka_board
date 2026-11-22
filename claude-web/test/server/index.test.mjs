import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRequest, makeDist, makeEnv, tempRoot } from './helpers.mjs';

const serverRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const indexFile = join(serverRoot, 'server', 'index.mjs');

async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function spawnServer(env, { collect = true } = {}) {
  const child = spawn(process.execPath, [indexFile], {
    cwd: serverRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  if (collect) {
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
  }
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    exited: new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
}

async function waitHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await apiRequest(port);
      if (res.status === 200) return res;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw lastErr || new Error('health timeout');
}

test('index.mjs: старт, health, graceful shutdown по SIGTERM, без секретов в логах', async () => {
  const root = tempRoot('idx-');
  const port = await freePort();
  const env = makeEnv(root, { runtime: 'fake', extra: { PORT: String(port) } });
  const dist = makeDist(root);
  env.DIST_DIR = dist;
  const proc = spawnServer(env);
  try {
    const health = await waitHealth(port);
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.mode, 'fake');

    const sessions = await apiRequest(port, { path: '/claude/api/sessions' });
    assert.equal(sessions.status, 200);
    assert.deepEqual(sessions.json, []);

    proc.child.kill('SIGTERM');
    const { code } = await Promise.race([
      proc.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 6000)),
    ]);
    assert.equal(code, 0);

    const logs = proc.stdout + proc.stderr;
    assert.match(logs, /listening on 127\.0\.0\.1:/);
    assert.match(logs, /runtime=fake/);
    assert.equal(logs.includes(env.EDGE_SECRET), false);
    assert.equal(logs.includes(env.CLAUDE_CODE_OAUTH_TOKEN), false);
    assert.equal(logs.includes(env.ALLOWED_USER_HASH), false);

    const auditPath = env.AUDIT_LOG;
    assert.equal(existsSync(auditPath), true);
    assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});

test('index.mjs fail-closed: без EDGE_SECRET не стартует и не печатает секреты', async () => {
  const root = tempRoot('idx-fail-');
  const env = makeEnv(root, { runtime: 'fake' });
  delete env.EDGE_SECRET;
  const proc = spawnServer(env);
  try {
    const { code } = await Promise.race([
      proc.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('should exit')), 6000)),
    ]);
    assert.equal(code, 1);
    assert.match(proc.stderr, /startup failed: missing_env/);
    assert.equal(proc.stderr.includes(env.CLAUDE_CODE_OAUTH_TOKEN), false);
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});

test('index.mjs fail-closed: несуществующий WORKSPACES -> exit 1', async () => {
  const root = tempRoot('idx-fail2-');
  const env = makeEnv(root, { runtime: 'fake' });
  env.WORKSPACES = join(root, 'no-such-workspaces');
  const proc = spawnServer(env);
  try {
    const { code } = await Promise.race([
      proc.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('should exit')), 6000)),
    ]);
    assert.equal(code, 1);
    assert.match(proc.stderr, /workspaces_missing/);
  } finally {
    if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
  }
});
