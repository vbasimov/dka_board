import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripComments } from './support.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const claudeWeb = join(here, '..', '..');
const indexHtml = readFileSync(join(claudeWeb, 'web', 'index.html'), 'utf8');

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
];

test('index.html: full CSP is present as a meta backstop', () => {
  const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(indexHtml);
  assert.ok(match, 'нет <meta http-equiv="Content-Security-Policy">');
  for (const directive of CSP_DIRECTIVES) {
    assert.ok(match[1].includes(directive), `в CSP meta нет директивы: ${directive}`);
  }
});

test('index.html: theme colour, manifest and apple-touch-icon are wired', () => {
  assert.match(indexHtml, /<meta name="theme-color" content="#1a1917"\s*\/?>/);
  assert.match(indexHtml, /<link rel="manifest" href="\/claude\/manifest\.webmanifest"\s*\/?>/);
  assert.match(indexHtml, /<link rel="apple-touch-icon" sizes="180x180" href="\/claude\/icons\/apple-touch-icon-180\.png"\s*\/?>/);
  assert.match(indexHtml, /<html lang="ru" dir="ltr">/);
  assert.match(indexHtml, /<meta name="viewport"[^>]*width=device-width/);
});

test('index.html: no inline scripts (CSP script-src self)', () => {
  const scriptTags = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
  assert.ok(scriptTags.length > 0, 'должен быть module-скрипт входа');
  for (const tag of scriptTags) {
    assert.match(tag, /\bsrc=/, `inline <script> запрещён CSP: ${tag}`);
    assert.doesNotMatch(tag, /\btype="text\/javascript"\s*>/);
  }
});

test('index.html: no external (third-party) resources', () => {
  assert.doesNotMatch(indexHtml, /(?:src|href)="https?:\/\//i, 'внешние ресурсы нарушают CSP self');
});

test('vite config: base /claude/, dist output, esbuild JSX for Preact, no plugins', () => {
  const config = readFileSync(join(claudeWeb, 'web', 'vite.config.ts'), 'utf8');
  assert.match(config, /base: '\/claude\/'/);
  assert.match(config, /outDir: 'dist'/);
  assert.match(config, /jsx: 'automatic'/);
  assert.match(config, /jsxImportSource: 'preact'/);
  assert.doesNotMatch(config, /from 'vite-plugin|require\('vite-plugin|preact\/preset-vite/, 'плагины Vite не нужны');
  const pkg = JSON.parse(readFileSync(join(claudeWeb, 'web', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.ok(pkg.dependencies.preact, 'preact должен быть зависимостью');
  assert.ok(/^\^?7\./.test(pkg.devDependencies.vite), 'требуется Vite 7');
  assert.ok(/^\^?10\./.test(pkg.dependencies.preact), 'требуется Preact 10');
});

test('frontend sources: model output is never injected as raw HTML', () => {
  const sourceDir = join(claudeWeb, 'web', 'src');
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(sourceDir);
  assert.ok(files.length > 5, 'слишком мало исходников — проверка не имеет смысла');
  for (const file of files) {
    const content = stripComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(content, /dangerouslySetInnerHTML/, `${file}: dangerouslySetInnerHTML запрещён`);
    assert.doesNotMatch(content, /\.innerHTML\s*=/, `${file}: присваивание innerHTML запрещено`);
    assert.doesNotMatch(content, /insertAdjacentHTML/, `${file}: insertAdjacentHTML запрещён`);
    assert.doesNotMatch(content, /document\.write/, `${file}: document.write запрещён`);
  }
});

test('service worker registration targets /claude/sw.js with the nested scope', () => {
  const registration = readFileSync(join(claudeWeb, 'web', 'src', 'sw-register.ts'), 'utf8');
  assert.match(registration, /const SW_PATH = `\$\{BASE_URL\}sw\.js`;/);
  assert.match(registration, /const SW_SCOPE = BASE_URL;/);
  assert.match(registration, /register\(SW_PATH, \{ scope: SW_SCOPE, updateViaCache: 'none' \}\)/);
  // Nested-scope recovery must never unregister the DSH root worker.
  assert.doesNotMatch(registration, /\.unregister\(/, 'нельзя снимать чужие регистрации SW');
  assert.match(registration, /SKIP_WAITING/);
  assert.match(registration, /controllerchange/);
});
