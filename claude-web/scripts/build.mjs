#!/usr/bin/env node
/**
 * Сборка claude-web:
 *   1. web/ (Vite + Preact) -> web/dist
 *   2. pwa/gen-icons.mjs -> pwa/public/claude/icons/*.png + favicon
 *   3. pwa/public/claude/* -> web/dist/claude/*   (dev-fallback статика приложения)
 *   4. pwa/sw.js -> web/dist/sw.js                (отдаётся как /claude/sw.js)
 *
 * Приложение (server/static.mjs) отдаёт web/dist; в production
 * /claude/manifest.webmanifest и /claude/icons/* перехватывает Caddy file_server
 * из /srv/claude-web/public (туда копируется web/dist/claude/*).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const web = join(root, 'web');
const pwa = join(root, 'pwa');
const dist = join(web, 'dist');

function log(msg) {
  process.stdout.write(`[build] ${msg}\n`);
}

function run(cmd, args, cwd) {
  log(`${cmd} ${args.join(' ')} (${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
}

// 1. Иконки (идемпотентно; артефакты коммитятся, но пересборка безопасна).
const genIcons = join(pwa, 'gen-icons.mjs');
if (existsSync(genIcons)) run(process.execPath, [genIcons], root);
else log('pwa/gen-icons.mjs отсутствует — иконки должны быть уже в pwa/public/claude/icons');

// 2. Frontend.
if (!existsSync(join(web, 'package.json'))) {
  log('web/package.json отсутствует — фронтенд ещё не готов');
  process.exit(1);
}
if (!existsSync(join(web, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], web);
run('npm', ['run', 'build'], web);

// 3. Публичные install-ассеты для dev-fallback и для Caddy file_server.
const publicClaude = join(pwa, 'public', 'claude');
if (!existsSync(publicClaude)) {
  log('pwa/public/claude отсутствует — install-ассеты не скопированы');
  process.exit(1);
}
cpSync(publicClaude, join(dist, 'claude'), { recursive: true });

// 4. Service worker.
const sw = join(pwa, 'sw.js');
if (!existsSync(sw)) {
  log('pwa/sw.js отсутствует');
  process.exit(1);
}
copyFileSync(sw, join(dist, 'sw.js'));

// Чистим возможные старые артефакты сборки.
rmSync(join(dist, 'icons'), { recursive: true, force: true });

const required = [
  'index.html',
  'sw.js',
  'claude/manifest.webmanifest',
  'claude/icons/icon-192.png',
  'claude/icons/icon-512.png',
  'claude/icons/icon-maskable-512.png',
  'claude/icons/apple-touch-icon-180.png',
];
for (const rel of required) {
  if (!existsSync(join(dist, rel))) {
    console.error(`[build] ОШИБКА: нет обязательного артефакта web/dist/${rel}`);
    process.exit(1);
  }
}
mkdirSync(join(dist, 'assets'), { recursive: true });
log('готово: web/dist');
