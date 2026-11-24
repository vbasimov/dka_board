import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'

const fresh = () => createStore(mkdtempSync(join(tmpdir(), 'store-')))

test('держит 10 000 задач и ищет быстрее 500 мс', () => {
  const store = fresh()
  for (let i = 0; i < 10_000; i++) store.add({ id: `t-${i}`, title: `задача ${i}`, source: 'письмо' })
  assert.equal(store.count(), 10_000)
  const started = performance.now()
  const found = store.search('задача 9999')
  const ms = performance.now() - started
  assert.ok(found.length >= 1)
  assert.ok(ms < 500, `поиск занял ${Math.round(ms)} мс`)
})

test('задача без источника отклоняется', () => {
  assert.throws(() => fresh().add({ id: 't-1', title: 'без источника' }), /источник обязателен/)
})

test('повторный импорт того же письма не создаёт дубль', () => {
  const store = fresh()
  const first = store.add({ title: 'Интеграция', source: 'письмо', sourceRef: 'msg-1' })
  const second = store.add({ title: 'Интеграция', source: 'письмо', sourceRef: 'msg-1' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(store.count(), 1)
})

test('закрытая задача не удаляется, а меняет состояние', () => {
  const store = fresh()
  const { task } = store.add({ title: 'x', source: 'письмо', sourceRef: 'msg-2' })
  store.setStatus(task.id, 'закрыта')
  assert.equal(store.byId(task.id).status, 'закрыта')
  assert.equal(store.count(), 1)
})
