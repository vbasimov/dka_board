import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('install.ts: перехват beforeinstallprompt/appinstalled и prompt()', async () => {
  const src = await read('web/src/install.ts');
  assert.match(src, /addEventListener\('beforeinstallprompt'/);
  assert.match(src, /event\.preventDefault\(\)/);
  assert.match(src, /addEventListener\('appinstalled'/);
  assert.match(src, /await event\.prompt\(\)/);
  assert.match(src, /userChoice/);
  assert.match(src, /accepted/);
  assert.match(src, /dismissed/);
  // Кнопка не показывается в standalone и после установки.
  assert.match(src, /export function canInstall\(\): boolean \{/);
  assert.match(src, /deferred !== null && !installedDuringSession && !isStandalone\(\)/);
});

test('список сессий: кнопка «Установить» только при возможности установки', async () => {
  const src = await read('web/src/screens/SessionListScreen.tsx');
  assert.match(src, /initInstallPrompt\(\(\) => setInstallable\(canInstall\(\)\)\)/);
  assert.match(src, /installable \? \(/);
  assert.match(src, /Установить/);
  assert.match(src, /promptInstall\(\)/);
});

test('манифест Claude: отдельное приложение (id/scope /claude/), не DSH', async () => {
  const manifest = JSON.parse(await read('pwa/public/claude/manifest.webmanifest'));
  assert.equal(manifest.id, '/claude/');
  assert.equal(manifest.scope, '/claude/');
  assert.equal(manifest.start_url, '/claude/');
  assert.equal(manifest.short_name, 'Claude');
  assert.equal(manifest.display, 'standalone');
  // DSH ставится с id '/', поэтому приложения различаются и не перетирают друг друга.
  assert.notEqual(manifest.id, '/');
});
