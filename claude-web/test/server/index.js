/**
 * test/server/index.js — агрегатор для `node --test test/server`.
 *
 * Node 24.22 больше не принимает каталог как позиционный аргумент test runner
 * (пытается выполнить сам каталог как модуль), поэтому `node --test test/server`
 * выполняется как один тест-файл, импортирующий все *.test.mjs этого каталога.
 * На Node, где каталоги поддержаны, index.js не матчится тест-паттернами и
 * тесты всё равно запускаются через *.test.mjs (без двойного запуска).
 */
import './config.test.mjs';
import './auth.test.mjs';
import './http-util.test.mjs';
import './static.test.mjs';
import './workspaces.test.mjs';
import './hook.test.mjs';
import './sse.test.mjs';
import './audit.test.mjs';
import './sessions.test.mjs';
import './runtime.test.mjs';
import './app.test.mjs';
import './index.test.mjs';
