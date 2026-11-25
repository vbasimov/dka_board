import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecisionStore } from '../../src/decisions/store.js'

const fresh = () => createDecisionStore(mkdtempSync(join(tmpdir(), 'decisions-')))
const base = { title: 'Платежи передают события в Kafka', source: 'протокол' }

test('решения переживают перезапуск', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decisions-'))
  createDecisionStore(dir).add(base)
  const reopened = createDecisionStore(dir)
  assert.equal(reopened.count(), 1)
})

test('долги считаются отдельно от внесённых в КАФО', () => {
  const store = fresh()
  const a = store.add({ ...base, title: 'Решение A' })
  store.add({ ...base, title: 'Решение B', inCafo: true })
  assert.equal(store.count(), 2)
  assert.equal(store.debts().length, 1)
  store.markInCafo(a.id, 'page-1')
  assert.equal(store.debts().length, 0)
  assert.equal(store.byId(a.id).cafoPageId, 'page-1')
})

test('отметка о КАФО для несуществующего решения даёт ошибку', () => {
  assert.throws(() => fresh().markInCafo('нет-такого'), /не найдено/)
})
