import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest } from '../../server/auth.mjs';
import {
  EDGE,
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
