import test from 'node:test'
import assert from 'node:assert/strict'
import { createFact, planSupersession, canBeUsedInAnswer, FACT_STATUS } from '../../src/facts/model.js'

const base = {
  claim: 'Сервис платежей передаёт события в Kafka',
  subject: 'Сервис платежей',
  relation: 'интеграция',
  object: 'Kafka',
  fo: 'Платежи',
  sourceType: 'схема',
  sourceRef: 'page_id=123; version=4'
}

test('факт создаётся предложенным и требует обязательные поля', () => {
  const fact = createFact(base)
  assert.equal(fact.status, FACT_STATUS.PROPOSED)
  assert.ok(fact.id)
  assert.throws(() => createFact({ ...base, claim: '  ' }), /поле claim обязательно/)
})

test('совпадение тройки subject+relation+object означает замену', () => {
  const older = createFact({ ...base, id: 'f1' })
  const newer = createFact({ ...base, id: 'f2', sourceRef: 'page_id=123; version=5' })
  const plan = planSupersession([older], newer)
  assert.deepEqual(plan.superseded, ['f1'])
  assert.deepEqual(plan.conflicts, [])
})

test('другой object при той же паре subject+relation — противоречие, а не замена', () => {
  const older = createFact({ ...base, id: 'f1' })
  const other = createFact({ ...base, id: 'f2', object: 'RabbitMQ' })
  const plan = planSupersession([older], other)
  assert.deepEqual(plan.superseded, [])
  assert.deepEqual(plan.conflicts, ['f1'])
})

test('уже заменённый факт не участвует в повторной замене', () => {
  const older = { ...createFact({ ...base, id: 'f1' }), status: FACT_STATUS.SUPERSEDED }
  const newer = createFact({ ...base, id: 'f2' })
  assert.deepEqual(planSupersession([older], newer).superseded, [])
})

test('отклонённый факт не заменяется', () => {
  const older = { ...createFact({ ...base, id: 'f1' }), status: FACT_STATUS.REJECTED }
  assert.deepEqual(planSupersession([older], createFact({ ...base, id: 'f2' })).superseded, [])
})

test('в ответ идут только подтверждённые и не заменённые факты', () => {
  const proposed = createFact({ ...base, id: 'f1' })
  const confirmed = { ...proposed, id: 'f2', status: FACT_STATUS.CONFIRMED }
  const superseded = { ...confirmed, id: 'f3', supersededBy: 'f2' }
  assert.equal(canBeUsedInAnswer(proposed), false)
  assert.equal(canBeUsedInAnswer(confirmed), true)
  assert.equal(canBeUsedInAnswer(superseded), false)
})
