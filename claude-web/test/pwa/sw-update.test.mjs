import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('баннер об обновлении только при реально ожидающем воркере (reg.waiting)', async () => {
  const src = await read('web/src/sw-register.ts');
  // Раньше условием был container.controller — на первом заходе под чужим
  // (DSH root) воркером это давало баннер без waiting: кнопка «Обновить»
  // молча закрывала плашку и ничего не перезагружала.
  assert.match(src, /installing\.state === 'installed' && reg\.waiting/);
  assert.ok(
    !/installing\.state === 'installed' && container\.controller/.test(src),
    'баннер не должен зависеть от container.controller',
  );
});

test('клик «Обновить» всегда что-то делает: fallback reload и forced reload', async () => {
  const src = await read('web/src/sw-register.ts');
  // Нет waiting -> принудительный reload, а не молчаливое скрытие баннера.
  assert.match(src, /if \(!waiting\) \{[\s\S]*?reloadOnce\(true\);[\s\S]*?return true;/);
  // После SKIP_WAITING есть страховка: если воркер не ответил, reload.
  assert.match(src, /postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(src, /setTimeout\(\(\) => \{\s*if \(registration\?\.waiting\) reloadOnce\(true\);/);
  // controllerchange по явному действию пользователя не должен глушиться guard'ом.
  assert.match(src, /if \(updateRequested\) \{\s*reloadOnce\(true\);/);
});

test('reloadOnce(force) обходит 5-секундный guard только для явного действия', async () => {
  const src = await read('web/src/sw-register.ts');
  assert.match(src, /function reloadOnce\(force = false\): void/);
  assert.match(src, /if \(!force && Date\.now\(\) - last < RELOAD_MIN_INTERVAL_MS\) return;/);
  // Автоматические пути остаются без force.
  assert.match(src, /if \(startedForeign && isOurWorker\(controller\.scriptURL\)\) reloadOnce\(\);/);
});

test('UI прячет баннер сразу и вызывает applyServiceWorkerUpdate', async () => {
  const src = await read('web/src/app.tsx');
  assert.match(src, /setUpdateReady\(false\);\s*applyServiceWorkerUpdate\(\);/);
});
