import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from '../../server/auth.mjs';
import {
  EDGE,
  EXTRA_HOST,
  EXTRA_ORIGIN,
  fakeReq,
  makeConfig,
  PUBLIC_ORIGIN,
  PUBLIC_HOST,
  tempRoot,
  USER_HASH,
} from './helpers.mjs';

function prodConfig() {
  return makeConfig(tempRoot('auth-prod-'));
}
function prodExtraConfig() {
  return makeConfig(tempRoot('auth-prod-extra-'), { extra: { EXTRA_ORIGINS: EXTRA_ORIGIN } });
}
function devConfig() {
  return makeConfig(tempRoot('auth-dev-'), { authMode: 'dev' });
}

function prodHeaders(extra = {}) {
  return { host: PUBLIC_HOST, 'x-claude-edge': EDGE, 'x-auth-user': USER_HASH, ...extra };
}

test('prod: valid GET passes', () => {
  const res = checkRequest(fakeReq({ headers: prodHeaders() }), prodConfig());
  assert.equal(res.ok, true);
  assert.equal(res.userHash, USER_HASH);
});

test('non-loopback remote rejected even with valid headers', () => {
  const res = checkRequest(fakeReq({ headers: prodHeaders(), remoteAddress: '10.1.2.3' }), prodConfig());
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test('missing / short / wrong edge rejected (fail-closed)', () => {
  const cfg = prodConfig();
  for (const edge of [undefined, '', 'abc', 'z'.repeat(64), 'f'.repeat(64)]) {
    const headers = prodHeaders();
    if (edge === undefined) delete headers['x-claude-edge'];
    else headers['x-claude-edge'] = edge;
    const res = checkRequest(fakeReq({ headers }), cfg);
    assert.equal(res.ok, false, `edge=${edge}`);
    assert.equal(res.status, 403);
  }
});

test('spoofed X-Auth-User rejected', () => {
  const cfg = prodConfig();
  for (const user of [undefined, '', 'deadbeef0001', '8d9462ad9d8e ']) {
    const headers = prodHeaders();
    if (user === undefined) delete headers['x-auth-user'];
    else headers['x-auth-user'] = user;
    assert.equal(checkRequest(fakeReq({ headers }), cfg).ok, false, `user=${user}`);
  }
  // верхний регистр допустим (hex case-insensitive)
  const upper = checkRequest(fakeReq({ headers: prodHeaders({ 'x-auth-user': USER_HASH.toUpperCase() }) }), cfg);
  assert.equal(upper.ok, true);
});

test('Host must match PUBLIC_ORIGIN authority', () => {
  const cfg = prodConfig();
  for (const host of [undefined, 'evil.example', PUBLIC_HOST + '.evil', '127.0.0.1:3090']) {
    const headers = prodHeaders();
    if (host === undefined) delete headers.host;
    else headers.host = host;
    assert.equal(checkRequest(fakeReq({ headers }), cfg).ok, false, `host=${host}`);
  }
});

test('Origin: present and mismatched rejected even for GET', () => {
  const cfg = prodConfig();
  const bad = checkRequest(fakeReq({ headers: prodHeaders({ origin: 'https://evil.example' }) }), cfg);
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 403);
  const good = checkRequest(fakeReq({ headers: prodHeaders({ origin: PUBLIC_ORIGIN }) }), cfg);
  assert.equal(good.ok, true);
});

test('Sec-Fetch-Site: cross-site rejected', () => {
  const cfg = prodConfig();
  const res = checkRequest(fakeReq({ headers: prodHeaders({ 'sec-fetch-site': 'cross-site' }) }), cfg);
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  const ok = checkRequest(fakeReq({ headers: prodHeaders({ 'sec-fetch-site': 'same-origin' }) }), cfg);
  assert.equal(ok.ok, true);
});

test('unsafe methods: Origin required, JSON content-type required', () => {
  const cfg = prodConfig();
  const noOrigin = checkRequest(
    fakeReq({ method: 'POST', headers: prodHeaders({ 'content-type': 'application/json' }) }),
    cfg,
  );
  assert.equal(noOrigin.status, 403);

  const wrongCt = checkRequest(
    fakeReq({
      method: 'POST',
      headers: prodHeaders({ origin: PUBLIC_ORIGIN, 'content-type': 'text/plain' }),
    }),
    cfg,
  );
  assert.equal(wrongCt.ok, false);
  assert.equal(wrongCt.status, 415);

  const ok = checkRequest(
    fakeReq({
      method: 'POST',
      headers: prodHeaders({ origin: PUBLIC_ORIGIN, 'content-type': 'application/json; charset=utf-8' }),
    }),
    cfg,
  );
  assert.equal(ok.ok, true);
});

test('EXTRA_ORIGINS: Host нового origin проходит, старый тоже, чужой -> 403', () => {
  const cfg = prodExtraConfig();
  const newHost = checkRequest(fakeReq({ headers: prodHeaders({ host: EXTRA_HOST }) }), cfg);
  assert.equal(newHost.ok, true);
  assert.equal(newHost.userHash, USER_HASH);

  const oldHost = checkRequest(fakeReq({ headers: prodHeaders() }), cfg);
  assert.equal(oldHost.ok, true);

  const badHosts = [
    'vps-4692.tailfbc4b2.ts.net', // без порта: разрешены ровно authorities из env
    'evil.example:8443',
    'vps-4692.tailfbc4b2.ts.net:9443',
    'vps-4692.tailfbc4b2.ts.net:8443.evil',
  ];
  for (const host of badHosts) {
    const res = checkRequest(fakeReq({ headers: prodHeaders({ host }) }), cfg);
    assert.equal(res.ok, false, `host=${host}`);
    assert.equal(res.status, 403);
  }
  // регистр Host не важен (как и раньше: auth приводит Host к lower-case)
  assert.equal(checkRequest(fakeReq({ headers: prodHeaders({ host: EXTRA_HOST.toUpperCase() }) }), cfg).ok, true);
});

test('EXTRA_ORIGINS: без env Host :8443 -> 403 (дефолт не меняется)', () => {
  const cfg = prodConfig();
  const res = checkRequest(fakeReq({ headers: prodHeaders({ host: EXTRA_HOST }) }), cfg);
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(checkRequest(fakeReq({ headers: prodHeaders() }), cfg).ok, true);
});

test('EXTRA_ORIGINS: Origin нового origin проходит для safe и unsafe, чужой -> 403', () => {
  const cfg = prodExtraConfig();

  // GET: Origin нового origin допустим
  const get = checkRequest(fakeReq({ headers: prodHeaders({ host: EXTRA_HOST, origin: EXTRA_ORIGIN }) }), cfg);
  assert.equal(get.ok, true);

  // GET со старым Origin тоже допустим (списки host/origin независимы, как и раньше)
  assert.equal(checkRequest(fakeReq({ headers: prodHeaders({ origin: PUBLIC_ORIGIN }) }), cfg).ok, true);

  // POST: Origin нового origin + JSON — пропускается
  const post = checkRequest(
    fakeReq({
      method: 'POST',
      headers: prodHeaders({
        host: EXTRA_HOST,
        origin: EXTRA_ORIGIN,
        'content-type': 'application/json; charset=utf-8',
      }),
    }),
    cfg,
  );
  assert.equal(post.ok, true);

  // чужой Origin -> 403 и для GET, и для POST (до Content-Type)
  for (const method of ['GET', 'POST']) {
    const res = checkRequest(
      fakeReq({
        method,
        headers: prodHeaders({
          host: EXTRA_HOST,
          origin: 'https://evil.example:8443',
          'content-type': 'application/json',
        }),
      }),
      cfg,
    );
    assert.equal(res.ok, false, `method=${method}`);
    assert.equal(res.status, 403);
  }

  // unsafe-метод без Origin — по-прежнему 403
  const noOrigin = checkRequest(
    fakeReq({ method: 'POST', headers: prodHeaders({ host: EXTRA_HOST, 'content-type': 'application/json' }) }),
    cfg,
  );
  assert.equal(noOrigin.ok, false);
  assert.equal(noOrigin.status, 403);

  // Origin чужого порта того же хоста при новом Host -> 403 (в списке только
  // PUBLIC_ORIGIN и EXTRA_ORIGIN)
  const wrongPort = checkRequest(
    fakeReq({ method: 'POST', headers: prodHeaders({ host: EXTRA_HOST, origin: 'https://vps-4692.tailfbc4b2.ts.net:9443', 'content-type': 'application/json' }) }),
    cfg,
  );
  assert.equal(wrongPort.ok, false);
  assert.equal(wrongPort.status, 403);
});

test('dev mode: no edge/user headers needed, loopback hosts only', () => {
  const cfg = devConfig();
  const res = checkRequest(fakeReq({ headers: { host: '127.0.0.1:3091' } }), cfg);
  assert.equal(res.ok, true);
  assert.equal(res.userHash, 'deadbeef0001');

  assert.equal(checkRequest(fakeReq({ headers: { host: 'localhost:3091' } }), cfg).ok, true);
  assert.equal(checkRequest(fakeReq({ headers: { host: '127.0.0.1:3090' } }), cfg).ok, false);

  const post = checkRequest(
    fakeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:3091', origin: 'http://127.0.0.1:3091', 'content-type': 'application/json' },
    }),
    cfg,
  );
  assert.equal(post.ok, true);
});

test('checkRequest не читает тело: возвращает решение только по заголовкам', () => {
  // fakeReq не реализует on/read — если бы auth пытался читать тело, тест бы упал.
  const res = checkRequest(fakeReq({ method: 'POST', headers: prodHeaders() }), prodConfig());
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});
