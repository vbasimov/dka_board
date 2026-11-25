import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecision, isDebt } from '../../src/decisions/model.js'

const base = { title: 'Платежи передают события в Kafka', source: 'протокол', sourceRef: 'meeting-2026-11-20' }

test('решение создаётся как долг перед КАФО', () => {
  const decision = createDecision(base)
  assert.equal(decision.state, 'долг')
  assert.equal(isDebt(decision), true)
  assert.ok(decision.decidedAt)
})

test('без названия или источника решение не создаётся', () => {
  assert.throws(() => createDecision({ source: 'протокол' }), /название/)
  assert.throws(() => createDecision({ title: 'x' }), /источник/)
})

test('решение, уже внесённое в КАФО, долгом не считается', () => {
  const decision = createDecision({ ...base, inCafo: true, cafoPageId: '123' })
  assert.equal(decision.state, 'в КАФО')
  assert.equal(isDebt(decision), false)
})
