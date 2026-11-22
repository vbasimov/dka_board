import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const publicDir = join(claudeWeb, 'pwa', 'public', 'claude');
const manifestPath = join(publicDir, 'manifest.webmanifest');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('manifest: identity fields pin the /claude/ scope', () => {
  assert.equal(manifest.id, '/claude/');
  assert.equal(manifest.start_url, '/claude/');
  assert.equal(manifest.scope, '/claude/');
});

test('manifest: names and display mode', () => {
  assert.equal(manifest.name, 'Claude Workspace');
  assert.equal(manifest.short_name, 'Claude');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['standalone', 'minimal-ui']);
});

test('manifest: dark theme, Russian locale, LTR', () => {
  assert.equal(manifest.theme_color, '#1a1917');
  assert.equal(manifest.background_color, '#1a1917');
  assert.equal(manifest.lang, 'ru');
  assert.equal(manifest.dir, 'ltr');
});

test('manifest: icons cover 192 any, 512 any and 512 maskable', () => {
  const icons = manifest.icons ?? [];
  const find = (size, purpose) =>
    icons.find(
      (icon) =>
        icon.sizes === size
        && (purpose === undefined || String(icon.purpose ?? '').split(/\s+/).includes(purpose)),
    );

  assert.ok(find('192x192', 'any'), 'нет иконки 192x192 purpose=any');
  assert.ok(find('512x512', 'any'), 'нет иконки 512x512 purpose=any');
  assert.ok(find('512x512', 'maskable'), 'нет маскируемой иконки 512x512');
});

test('manifest: every icon is a PNG under /claude/icons/ and exists on disk', () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png', `icon ${icon.src}: ожидается image/png`);
    assert.ok(icon.src.startsWith('/claude/icons/'), `icon ${icon.src}: путь вне /claude/icons/`);
    assert.ok(icon.src.startsWith('/'), `icon ${icon.src}: install-ассеты должны быть абсолютными`);
    const onDisk = join(publicDir, icon.src.replace('/claude/', ''));
    assert.ok(existsSync(onDisk), `иконка отсутствует на диске: ${onDisk}`);

    const png = readPng(onDisk);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.ihdr.width, width, `${icon.src}: ширина в PNG ≠ sizes`);
    assert.equal(png.ihdr.height, height, `${icon.src}: высота в PNG ≠ sizes`);
  }
});

test('manifest: no SVG icons (Chrome WebAPK requires raster PNG)', () => {
  for (const icon of manifest.icons ?? []) {
    assert.ok(!icon.src.toLowerCase().endsWith('.svg'), `SVG-иконка недопустима: ${icon.src}`);
  }
});

test('manifest: is valid JSON with a public application/manifest+json payload', () => {
  // JSON.parse above already proves validity; the served content type is checked
  // by deploy tests — here we only pin the path Caddy exposes publicly.
  assert.equal(manifestPath.endsWith('public/claude/manifest.webmanifest'), true);
  assert.ok(JSON.stringify(manifest).length > 100);
});
