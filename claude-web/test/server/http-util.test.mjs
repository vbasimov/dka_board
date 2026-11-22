import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeEqualString,
  HttpError,
  isLoopbackAddress,
  json,
  methodNotAllowed,
  readJsonBody,
  securityHeaders,
  sendError,
  sendHttpError,
} from '../../server/http-util.mjs';
import { bodyReq, captureRes } from './helpers.mjs';

test('securityHeaders: полный CSP и защитные заголовки', () => {
  const h = securityHeaders();
  assert.match(h['Content-Security-Policy'], /default-src 'self'/);
  assert.match(h['Content-Security-Policy'], /script-src 'self'/);
  assert.match(h['Content-Security-Policy'], /connect-src 'self'/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(h['Content-Security-Policy'], /base-uri 'none'/);
  assert.match(h['Content-Security-Policy'], /object-src 'none'/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(h['X-Robots-Tag'], 'noindex');
});

test('json: status, content-type, no-store, body', () => {
  const res = captureRes();
  json(res, 201, { id: 'x' });
  assert.equal(res.statusCode, 201);
  assert.match(res.getHeader('content-type'), /application\/json/);
  assert.equal(res.getHeader('cache-control'), 'no-store');
  assert.deepEqual(res.json(), { id: 'x' });
});

test('sendError / sendHttpError: контракт {error, code}, внутренние детали не утекают', () => {
  const res = captureRes();
  sendError(res, 403, 'forbidden', 'no');
  assert.equal(res.json().code, 'forbidden');

  const res2 = captureRes();
  sendHttpError(res2, new HttpError(413, 'payload_too_large', 'too big'));
  assert.equal(res2.statusCode, 413);
  assert.equal(res2.json().code, 'payload_too_large');

  const res3 = captureRes();
  sendHttpError(res3, new Error('internal path /etc/secret and token sk-ant-XYZ'));
  assert.equal(res3.statusCode, 500);
  assert.equal(res3.json().code, 'internal');
  assert.equal(res3.body().includes('/etc/secret'), false);
  assert.equal(res3.body().includes('sk-ant'), false);
});

test('methodNotAllowed: 405 + Allow', () => {
  const res = captureRes();
  methodNotAllowed(res, 'GET, HEAD');
  assert.equal(res.statusCode, 405);
  assert.equal(res.getHeader('allow'), 'GET, HEAD');
  assert.equal(res.json().code, 'method_not_allowed');
});

test('readJsonBody: валидный JSON и пустое тело', async () => {
  const ok = await readJsonBody(bodyReq('{"text":"hi"}', { headers: { 'content-length': '13' } }), 1024);
  assert.deepEqual(ok, { text: 'hi' });
  const empty = await readJsonBody(bodyReq('', { headers: { 'content-length': '0' } }), 1024);
  assert.deepEqual(empty, {});
  const noCl = await readJsonBody(bodyReq('{"a":1}'), 1024);
  assert.deepEqual(noCl, { a: 1 });
});

test('readJsonBody: битый JSON / массив / не-объект -> 400', async () => {
  for (const body of ['not json', '[1,2]', '"str"', '42', 'null']) {
    await assert.rejects(
      () => readJsonBody(bodyReq(body, { headers: { 'content-length': String(body.length) } }), 1024),
      (e) => e instanceof HttpError && e.status === 400,
      body,
    );
  }
});

test('readJsonBody: лимит по Content-Length проверяется ДО чтения', async () => {
  const req = bodyReq('x', { headers: { 'content-length': '99999' } });
  await assert.rejects(() => readJsonBody(req, 1024), (e) => e.status === 413 && e.code === 'payload_too_large');
  assert.equal(req.resumed, 1); // тело слито, но не буферизовано
});

test('readJsonBody: лимит для chunked (без content-length)', async () => {
  const big = 'x'.repeat(2048);
  await assert.rejects(
    () => readJsonBody(bodyReq(JSON.stringify({ big })), 1024),
    (e) => e.status === 413,
  );
});

test('readJsonBody: невалидный content-length -> 400', async () => {
  await assert.rejects(
    () => readJsonBody(bodyReq('{}', { headers: { 'content-length': 'abc' } }), 1024),
    (e) => e.status === 400,
  );
});

test('isLoopbackAddress / constantTimeEqualString', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['10.0.0.1', '0.0.0.0', '127.0.0.2', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  assert.equal(constantTimeEqualString('abc', 'abc'), true);
  assert.equal(constantTimeEqualString('abc', 'abd'), false);
  assert.equal(constantTimeEqualString('abc', 'ab'), false);
  assert.equal(constantTimeEqualString('', ''), false);
});
