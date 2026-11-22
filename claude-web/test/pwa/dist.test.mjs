import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const dist = join(claudeWeb, 'web', 'dist');

const REQUIRED = [
  'index.html',
  'sw.js',
  'claude/manifest.webmanifest',
  'claude/icons/icon-192.png',
  'claude/icons/icon-512.png',
  'claude/icons/icon-maskable-512.png',
  'claude/icons/apple-touch-icon-180.png',
];

/** dist is a build product: skip the whole file explicitly when it is absent. */
const built = existsSync(join(dist, 'index.html'));

test('dist: build artifacts exist (or skip with an explicit reason)', (t) => {
  if (!built) {
    t.skip('web/dist отсутствует — выполните `npm run build` в claude-web (он собирает web, иконки и копирует PWA-ассеты)');
    return;
  }
  for (const relative of REQUIRED) {
    assert.ok(existsSync(join(dist, relative)), `нет обязательного артефакта web/dist/${relative}`);
  }
});

test('dist: service worker is copied verbatim and keeps the cache version', (t) => {
  if (!built) {
    t.skip('web/dist отсутствует — сборка не выполнялась');
    return;
  }
  const source = readFileSync(join(claudeWeb, 'pwa', 'sw.js'), 'utf8');
  const copied = readFileSync(join(dist, 'sw.js'), 'utf8');
  assert.equal(copied, source, 'web/dist/sw.js должен быть точной копией pwa/sw.js');
  assert.match(copied, /const VERSION = '/);
});

test('dist: index.html keeps the CSP, manifest link and /claude/ asset paths', (t) => {
  if (!built) {
    t.skip('web/dist отсутствует — сборка не выполнялась');
    return;
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /href="\/claude\/manifest\.webmanifest"/);
  assert.match(html, /src="\/claude\/assets\/[^"]+\.js"/, 'скрипт должен быть под /claude/assets/');
  assert.match(html, /href="\/claude\/assets\/[^"]+\.css"/, 'стиль должен быть под /claude/assets/');
  assert.doesNotMatch(html, /["']\/src\//, 'исходный путь Vite не должен попасть в сборку');
});

test('dist: install icons are valid PNGs with manifest sizes', (t) => {
  if (!built) {
    t.skip('web/dist отсутствует — сборка не выполнялась');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(dist, 'claude', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.scope, '/claude/');
  for (const icon of manifest.icons) {
    const file = join(dist, icon.src.replace('/claude/', 'claude/'));
    const png = readPng(file);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.ihdr.width, width);
    assert.equal(png.ihdr.height, height);
  }
  const apple = readPng(join(dist, 'claude', 'icons', 'apple-touch-icon-180.png'));
  assert.equal(apple.ihdr.width, 180);
  assert.equal(apple.ihdr.height, 180);
});

test('dist: hashed assets live under /claude/assets/', (t) => {
  if (!built) {
    t.skip('web/dist отсутствует — сборка не выполнялась');
    return;
  }
  const assetsDir = join(dist, 'assets');
  assert.ok(existsSync(assetsDir), 'нет web/dist/assets');
  const entries = readdirSync(assetsDir);
  assert.ok(entries.some((name) => name.endsWith('.js')), 'нет JS-бандла');
  assert.ok(entries.some((name) => name.endsWith('.css')), 'нет CSS-бандла');
});
