import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFactStore } from '../../src/facts/store.js'
import { FACT_STATUS } from '../../src/facts/model.js'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-'))
  return { dir, store: createFactStore(dir) }
}

const base = {
  claim: 'Сервис платежей передаёт события в Kafka',
  subject: 'Сервис платежей',
  relation: 'интеграция',
  object: 'Kafka',
  fo: 'Платежи',
  sourceType: 'схема',
  sourceRef: 'page_id=123; version=4'
}

test('новая версия источника создаёт факт и заменяет старый, не удаляя его', () => {
  const { store } = fresh()
  const first = store.apply({ ...base, id: 'f1' })
  const second = store.apply({ ...base, id: 'f2', sourceRef: 'page_id=123; version=5' })

  assert.deepEqual(second.superseded, ['f1'])
  assert.equal(second.fact.supersedes, 'f1')
  assert.equal(store.byId('f1').status, FACT_STATUS.SUPERSEDED)
  assert.equal(store.byId('f1').supersededBy, 'f2')
  assert.equal(store.all().length, 2)
  assert.equal(first.fact.id, 'f1')
})

test('в ответ попадают только подтверждённые факты', () => {
  const { store } = fresh()
  store.apply({ ...base, id: 'f1' })
  assert.equal(store.answerable().length, 0)
  store.confirm('f1', 'архитектор ФО Платежи')
  assert.equal(store.answerable().length, 1)
  assert.equal(store.byId('f1').confirmedBy, 'архитектор ФО Платежи')
})

test('заменённый факт нельзя подтвердить', () => {
  const { store } = fresh()
  store.apply({ ...base, id: 'f1' })
  store.apply({ ...base, id: 'f2' })
  assert.throws(() => store.confirm('f1'), /заменённый/)
})

test('другой объект при той же паре — противоречие, оба факта живы', () => {
  const { store } = fresh()
  store.apply({ ...base, id: 'f1' })
  const result = store.apply({ ...base, id: 'f2', object: 'RabbitMQ' })
  assert.deepEqual(result.superseded, [])
  assert.deepEqual(result.conflicts, ['f1'])
  assert.equal(store.byId('f1').status, FACT_STATUS.PROPOSED)
  assert.equal(store.all().length, 2)
})

test('история показывает цепочку замен', () => {
  const { store } = fresh()
  store.apply({ ...base, id: 'f1' })
  store.apply({ ...base, id: 'f2' })
  store.apply({ ...base, id: 'f3' })
  assert.deepEqual(store.historyOf('f3').map(f => f.id), ['f3', 'f2', 'f1'])
})

test('состояние сохраняется между запусками', () => {
  const { dir, store } = fresh()
  store.apply({ ...base, id: 'f1' })
  store.confirm('f1')
  const reopened = createFactStore(dir)
  assert.equal(reopened.byId('f1').status, FACT_STATUS.CONFIRMED)
  assert.equal(reopened.answerable().length, 1)
})
