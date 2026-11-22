import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../server/config.mjs';
import {
  EDGE,
  EXTRA_HOST,
  EXTRA_ORIGIN,
  makeEnv,
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  tempRoot,
  TEST_TOKEN,
  USER_HASH,
} from './helpers.mjs';

function base() {
  const root = tempRoot('cfg-');
  return makeEnv(root);
}

function baseWithExtra(value) {
  const env = base();
  env.EXTRA_ORIGINS = value;
  return env;
}

test('valid prod config: defaults and non-enumerable secrets', () => {
  const env = base();
  delete env.CLAUDE_RUNTIME; // prod default = sdk
  const cfg = loadConfig(env);
  assert.equal(cfg.authMode, 'prod');
  assert.equal(cfg.runtimeMode, 'sdk');
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3090);
  assert.equal(cfg.basePath, '/claude/');
  assert.equal(cfg.maxSessions, 2);
  assert.equal(cfg.approvalTimeoutMs, 300_000);
  assert.equal(cfg.idleCloseMs, 900_000);
  assert.equal(cfg.sseMaxMs, 900_000);
  assert.equal(cfg.sseHeartbeatTimeoutMs, 120_000);
  assert.equal(cfg.maxBodyBytes, 1_048_576);
  assert.equal(cfg.maxMessageBytes, 32_768);
  // секреты доступны модулям, но не сериализуются
  assert.equal(cfg.edgeSecret.length, 32);
  assert.equal(cfg.oauthToken, TEST_TOKEN);
  const json = JSON.stringify(cfg);
  assert.equal(json.includes(TEST_TOKEN), false);
  assert.equal(json.includes(EDGE), false);
  assert.equal(json.includes(USER_HASH), false);
});

test('fail-closed: missing/short EDGE_SECRET', () => {
  const env = base();
  delete env.EDGE_SECRET;
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && e.code === 'missing_env');
  for (const bad of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63)]) {
    const e2 = base();
    e2.EDGE_SECRET = bad;
    assert.throws(() => loadConfig(e2), (e) => e instanceof ConfigError, `edge=${bad}`);
  }
});

test('fail-closed: ALLOWED_USER_HASH must be 12 hex', () => {
  const env = base();
  delete env.ALLOWED_USER_HASH;
  assert.throws(() => loadConfig(env), (e) => e.code === 'missing_env');
  for (const bad of ['abc', 'xy'.repeat(6), '8d9462ad9d8', '']) {
    const e2 = base();
    e2.ALLOWED_USER_HASH = bad;
    assert.throws(() => loadConfig(e2), (e) => e instanceof ConfigError);
  }
});

test('fail-closed: HOST must be loopback in prod', () => {
  const env = base();
  env.HOST = '0.0.0.0';
  assert.throws(() => loadConfig(env), (e) => e.code === 'insecure_env');
});

test('fail-closed: PUBLIC_ORIGIN required and https', () => {
  const env = base();
  delete env.PUBLIC_ORIGIN;
  assert.throws(() => loadConfig(env), (e) => e.code === 'missing_env');
  const env2 = base();
  env2.PUBLIC_ORIGIN = 'http://vps.example:10000';
  assert.throws(() => loadConfig(env2), (e) => e.code === 'insecure_env');
});

test('fail-closed: required paths', () => {
  for (const key of ['WORKSPACES', 'AUDIT_LOG', 'STATE_DIR']) {
    const env = base();
    delete env[key];
    assert.throws(() => loadConfig(env), (e) => e.code === 'missing_env', key);
    const env2 = base();
    env2[key] = 'relative/path';
    assert.throws(() => loadConfig(env2), (e) => e.code === 'invalid_env', key);
  }
});

test('fail-closed: token required in prod', () => {
  const env = base();
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.throws(() => loadConfig(env), (e) => e.code === 'missing_env');

  const devEnv = makeEnv(tempRoot('cfg-dev-'), { authMode: 'dev' });
  const dev = loadConfig(devEnv);
  assert.equal(dev.runtimeMode, 'fake'); // dev по умолчанию fake
  assert.equal(dev.authMode, 'dev');
});

test('dev restrictions: only 127.0.0.1:3091 and DEV_USER_HASH', () => {
  const env = makeEnv(tempRoot('cfg-dev2-'), { authMode: 'dev' });
  env.PORT = '4000';
  assert.throws(() => loadConfig(env), (e) => e.code === 'insecure_env');

  const env2 = makeEnv(tempRoot('cfg-dev3-'), { authMode: 'dev' });
  env2.DEV_USER_HASH = 'not-hex';
  assert.throws(() => loadConfig(env2), (e) => e.code === 'invalid_env');

  const env3 = makeEnv(tempRoot('cfg-dev4-'), { authMode: 'dev' });
  env3.HOST = '0.0.0.0';
  assert.throws(() => loadConfig(env3), (e) => e.code === 'insecure_env');
});

test('invalid BASE_PATH rejected', () => {
  for (const bad of ['claude/', '/claude', '/claude//', '/claude/../etc/', '/claude/%2e%2e/']) {
    const env = base();
    env.BASE_PATH = bad;
    assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError, `base=${bad}`);
  }
});

test('config errors never include secret values', () => {
  const env = base();
  env.AUTH_MODE = 'prod';
  env.EDGE_SECRET = 'deadbeef'.repeat(8); // валидный hex, но не тот, что нужно
  env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-SUPERSECRET-TOKEN-VALUE';
  env.ALLOWED_USER_HASH = 'NOTHEX';
  try {
    loadConfig(env);
    assert.fail('should throw');
  } catch (err) {
    assert.equal(String(err.message).includes('SUPERSECRET'), false);
    assert.equal(String(err.message).includes('deadbeef'), false);
    assert.equal(String(err.stack).includes('NOTHEX'), false);
  }
  // значения-плейсхолдеры не утекают и в успешной конфигурации
  env.ALLOWED_USER_HASH = USER_HASH;
  const ok = loadConfig(env);
  assert.equal(JSON.stringify(ok).includes('SUPERSECRET'), false);
});

test('PUBLIC_ORIGIN parsed: allowed host/origin', () => {
  const cfg = loadConfig(base());
  assert.equal(cfg.publicOrigin, PUBLIC_ORIGIN);
  assert.deepEqual(cfg.allowedHosts, ['vps-4692.tailfbc4b2.ts.net:10000']);
  assert.deepEqual(cfg.allowedOrigins, [PUBLIC_ORIGIN]);
  // дефолт без EXTRA_ORIGINS — поведение прежнее
  assert.deepEqual(cfg.extraOrigins, []);
});

test('EXTRA_ORIGINS: один origin добавляет host и origin, PUBLIC_ORIGIN остаётся', () => {
  const cfg = loadConfig(baseWithExtra(EXTRA_ORIGIN));
  assert.equal(cfg.publicOrigin, PUBLIC_ORIGIN);
  assert.deepEqual(cfg.extraOrigins, [EXTRA_ORIGIN]);
  assert.deepEqual(cfg.allowedHosts, [PUBLIC_HOST, EXTRA_HOST]);
  assert.deepEqual(cfg.allowedOrigins, [PUBLIC_ORIGIN, EXTRA_ORIGIN]);
  // секреты по-прежнему не сериализуются
  const json = JSON.stringify(cfg);
  assert.equal(json.includes(EDGE), false);
  assert.equal(json.includes(TEST_TOKEN), false);
  assert.equal(json.includes(USER_HASH), false);
});

test('EXTRA_ORIGINS: несколько через запятую, пробелы, хвостовой слэш, lower-case host', () => {
  const cfg = loadConfig(
    baseWithExtra(
      ' https://vps-4692.tailfbc4b2.ts.net:8443/ , https://SECOND.Example.TEST:9443 ,https://third.example.test ',
    ),
  );
  assert.deepEqual(cfg.extraOrigins, [
    EXTRA_ORIGIN,
    'https://second.example.test:9443',
    'https://third.example.test',
  ]);
  assert.deepEqual(cfg.allowedHosts, [
    PUBLIC_HOST,
    EXTRA_HOST,
    'second.example.test:9443',
    'third.example.test',
  ]);
  assert.deepEqual(cfg.allowedOrigins, [
    PUBLIC_ORIGIN,
    EXTRA_ORIGIN,
    'https://second.example.test:9443',
    'https://third.example.test',
  ]);
});

test('EXTRA_ORIGINS: дубли (включая PUBLIC_ORIGIN) не размножаются', () => {
  const cfg = loadConfig(
    baseWithExtra(`${EXTRA_ORIGIN},${EXTRA_ORIGIN},${PUBLIC_ORIGIN},https://VPS-4692.tailfbc4b2.ts.net:8443`),
  );
  assert.deepEqual(cfg.extraOrigins, [EXTRA_ORIGIN]);
  assert.deepEqual(cfg.allowedHosts, [PUBLIC_HOST, EXTRA_HOST]);
  assert.deepEqual(cfg.allowedOrigins, [PUBLIC_ORIGIN, EXTRA_ORIGIN]);
});

test('EXTRA_ORIGINS: пустое/отсутствующее значение — дефолт без изменений', () => {
  for (const value of [undefined, '', '   ']) {
    const env = base();
    if (value === undefined) delete env.EXTRA_ORIGINS;
    else env.EXTRA_ORIGINS = value;
    const cfg = loadConfig(env);
    assert.deepEqual(cfg.extraOrigins, [], `value=${JSON.stringify(value)}`);
    assert.deepEqual(cfg.allowedHosts, [PUBLIC_HOST]);
    assert.deepEqual(cfg.allowedOrigins, [PUBLIC_ORIGIN]);
  }
});

test('EXTRA_ORIGINS: невалидные элементы -> ConfigError (fail-closed)', () => {
  const cases = [
    ['http://vps.example:8443', 'insecure_env'], // http
    ['ftp://vps.example:8443', 'insecure_env'], // не https
    ['https://vps.example:8443/claude/', 'invalid_env'], // путь
    ['https://vps.example:8443/?x=1', 'invalid_env'], // query
    ['https://vps.example:8443#frag', 'invalid_env'], // fragment
    ['https://user:pass@vps.example:8443', 'invalid_env'], // креды
    ['vps.example:8443', 'insecure_env'], // без схемы (URL видит схему «vps.example»)
    ['https://', 'invalid_env'], // пустой host
    ['https://vps.example:99999', 'invalid_env'], // порт вне диапазона
    ['https://vps.example:0', 'invalid_env'], // порт 0
    ['https://vps.example:abc', 'invalid_env'], // порт не число
    ['https://vps.example:8443/.', 'invalid_env'], // URL-нормализация не спасает
    ['https:///vps.example:8443', 'invalid_env'], // кривая схема-разделитель
    ['https://vps.example:443', 'invalid_env'], // дефолтный порт не round-trip'ится
    [`${EXTRA_ORIGIN},`, 'invalid_env'], // пустой последний элемент
    ['https://a.example, ,https://b.example', 'invalid_env'], // пустой в середине
    [',', 'invalid_env'], // только запятая
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => loadConfig(baseWithExtra(value)),
      (e) => e instanceof ConfigError && e.code === code,
      `value=${value}`,
    );
  }
});

test('EXTRA_ORIGINS: ошибки не содержат значений env', () => {
  const secretish = 'https://SUPERSECRET-VALUE.example:8443/some/path';
  try {
    loadConfig(baseWithExtra(secretish));
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message.includes('SUPERSECRET'), false);
    assert.equal(err.message.includes('some/path'), false);
    assert.equal(String(err.stack).includes('SUPERSECRET'), false);
  }
});

test('EXTRA_ORIGINS: в AUTH_MODE=dev запрещён (dev — только loopback:3091)', () => {
  const env = makeEnv(tempRoot('cfg-dev-extra-'), { authMode: 'dev', extra: { EXTRA_ORIGINS: EXTRA_ORIGIN } });
  assert.throws(() => loadConfig(env), (e) => e.code === 'insecure_env');

  // пустое значение в dev допустимо (это дефолт)
  const dev = loadConfig(makeEnv(tempRoot('cfg-dev-extra2-'), { authMode: 'dev', extra: { EXTRA_ORIGINS: '' } }));
  assert.deepEqual(dev.extraOrigins, []);
  assert.deepEqual(dev.allowedHosts, ['127.0.0.1:3091', 'localhost:3091']);
});

