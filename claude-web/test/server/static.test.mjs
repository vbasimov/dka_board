import test from 'node:test';
import assert from 'node:assert/strict';
import { serveStatic } from '../../server/static.mjs';
import { captureRes, makeDist, tempRoot } from './helpers.mjs';

const BASE = '/claude/';

function serve(distDir, urlPath, { method = 'GET', headers = {} } = {}) {
  const res = captureRes();
  const req = { method, headers };
  const handled = serveStatic(req, res, { distDir, basePath: BASE, urlPath });
  return { handled, res };
}

test('index.html для /claude/ с security-заголовками и no-store', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const { handled, res } = serve(dist, '/claude/');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader('content-type'), /text\/html/);
  assert.equal(res.getHeader('cache-control'), 'no-store');
  assert.match(res.getHeader('content-security-policy'), /default-src 'self'/);
  assert.equal(res.getHeader('x-content-type-options'), 'nosniff');
  assert.match(res.body(), /SPA/);
});

test('assets: immutable cache + js mime', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const { handled, res } = serve(dist, '/claude/assets/app.js');
  assert.equal(handled, true);
  assert.match(res.getHeader('content-type'), /javascript/);
  assert.equal(res.getHeader('cache-control'), 'public, max-age=86400, immutable');
});

test('sw.js: no-store и НЕТ Service-Worker-Allowed', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const { handled, res } = serve(dist, '/claude/sw.js');
  assert.equal(handled, true);
  assert.equal(res.getHeader('cache-control'), 'no-store');
  assert.equal(res.getHeader('service-worker-allowed'), undefined);
  assert.match(res.getHeader('content-type'), /javascript/);
});

test('manifest/иконки: dist/claude fallback, no-cache+ETag / public icons', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const manifest = serve(dist, '/claude/manifest.webmanifest');
  assert.equal(manifest.handled, true);
  assert.match(manifest.res.getHeader('content-type'), /application\/manifest\+json/);
  assert.equal(manifest.res.getHeader('cache-control'), 'no-cache');
  const etag = manifest.res.getHeader('etag');
  assert.ok(etag);

  const cached = serve(dist, '/claude/manifest.webmanifest', { headers: { 'if-none-match': etag } });
  assert.equal(cached.handled, true);
  assert.equal(cached.res.statusCode, 304);

  const icon = serve(dist, '/claude/icons/icon-192.png');
  assert.equal(icon.handled, true);
  assert.equal(icon.res.getHeader('content-type'), 'image/png');
  assert.equal(icon.res.getHeader('cache-control'), 'public, max-age=86400');
});

test('path traversal и encoded traversal отклоняются', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  for (const p of [
    '/claude/../outside-secret.txt',
    '/claude/%2e%2e/outside-secret.txt',
    '/claude/..%2foutside-secret.txt',
    '/claude/a/../../outside-secret.txt',
    '/etc/passwd',
    '/claude//etc/passwd',
  ]) {
    const r = serve(dist, p);
    assert.equal(r.handled, false, p);
    assert.equal(r.res.body().includes('TOP-SECRET'), false, p);
  }
});

test('симлинк внутри dist наружу не отдаётся', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const r = serve(dist, '/claude/leak.txt');
  assert.equal(r.handled, false);
  assert.equal(r.res.body().includes('TOP-SECRET'), false);
  assert.equal(r.res.getHeader('content-type'), undefined);
});

test('dotfiles и несуществующие файлы отклоняются', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  assert.equal(serve(dist, '/claude/.secret').handled, false);
  assert.equal(serve(dist, '/claude/nope.js').handled, false);
});

test('HEAD отдаёт заголовки без body', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const r = serve(dist, '/claude/index.html', { method: 'HEAD' });
  assert.equal(r.handled, true);
  assert.equal(r.res.body(), '');
  assert.match(r.res.getHeader('content-type'), /text\/html/);
});

test('не-GET/HEAD -> 405', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const r = serve(dist, '/claude/index.html', { method: 'POST' });
  assert.equal(r.handled, true);
  assert.equal(r.res.statusCode, 405);
});

test('SPA fallback только для навигации с Accept: text/html', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const nav = serve(dist, '/claude/sessions/abc', { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(nav.handled, true);
  assert.match(nav.res.body(), /SPA/);
  const noAccept = serve(dist, '/claude/sessions/abc');
  assert.equal(noAccept.handled, false);
  // файл с расширением в fallback не попадает
  assert.equal(serve(dist, '/claude/sessions/abc.js', { headers: { accept: 'text/html' } }).handled, false);
});

test('вложенный index.html отдаётся', () => {
  const root = tempRoot('static-');
  const dist = makeDist(root);
  const r = serve(dist, '/claude/nested/');
  assert.equal(r.handled, true);
  assert.match(r.res.body(), /nested/);
});
