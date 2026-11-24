import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFactStore } from '../../src/facts/store.js'
import { FACT_STATUS } from '../../src/facts/model.js'

const fresh = () => createFactStore(mkdtempSync(join(tmpdir(), 'quiz-')))
const fact = (id, over = {}) => ({
  id,
  claim: 'Сервис платежей передаёт события в Kafka',
  subject: 'Сервис платежей', relation: 'интеграция', object: 'Kafka',
  fo: 'Платежи', sourceType: 'кэш КАФО', sourceRef: 'page_id=123; version=14',
  ...over
})

test('в квиз попадают только предложенные факты', () => {
  const store = fresh()
  store.apply(fact('f1'))
  store.apply(fact('f2', { claim: 'Расчёты берут суммы из биллинга', subject: 'Расчёты', object: 'Биллинг', fo: 'Расчёты' }))
  assert.deepEqual(store.quiz().map(item => item.id), ['f1', 'f2'])
  store.confirm('f1')
  assert.deepEqual(store.quiz().map(item => item.id), ['f2'])
})

test('факт можно пометить недостоверным, и он не идёт в ответ', () => {
  const store = fresh()
  store.apply(fact('f1'))
  store.markUnreliable('f1', 'архитектор ФО Платежи')
  assert.equal(store.byId('f1').status, FACT_STATUS.UNRELIABLE)
  assert.equal(store.answerable().length, 0)
  assert.deepEqual(store.quiz(), [])
  assert.equal(store.unreliable().length, 1)
})

test('пропущенный факт не спрашивается в тот же день, но возвращается позже', () => {
  const store = fresh()
  store.apply(fact('f1'))
  store.skip('f1')
  const now = new Date()
  assert.equal(store.quiz(now).length, 0)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  assert.equal(store.quiz(tomorrow).length, 1)
})

test('подтвердить недостоверный факт нельзя без повторного решения', () => {
  const store = fresh()
  store.apply(fact('f1'))
  store.markUnreliable('f1')
  const confirmed = store.confirm('f1')
  assert.equal(confirmed.status, FACT_STATUS.CONFIRMED)
})
