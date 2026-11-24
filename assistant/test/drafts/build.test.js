import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDraft, isSafeToSend } from '../../src/drafts/build.js'

const confirmed = {
  id: 'f1',
  claim: 'Сервис платежей передаёт события в Kafka',
  status: 'подтверждён',
  sourceRef: 'page_id=123; version=14'
}

test('черновик содержит подтверждённые факты со ссылками на источник', () => {
  const draft = buildDraft({ subject: 'Интеграция', request: 'Нужна интеграция', facts: [confirmed] })
  assert.match(draft.text, /Сервис платежей передаёт события в Kafka/)
  assert.match(draft.text, /page_id=123; version=14/)
  assert.equal(draft.citations.length, 1)
  assert.equal(draft.citations[0].factId, 'f1')
  assert.deepEqual(draft.warnings, [])
})

test('неподтверждённый факт не попадает в обоснование, но виден как предупреждение', () => {
  const proposed = { ...confirmed, id: 'f2', claim: 'Будем использовать RabbitMQ', status: 'предложен' }
  const draft = buildDraft({ facts: [confirmed, proposed] })
  const justification = draft.text.split('Обоснование:')[1].split('Требует подтверждения')[0]
  assert.doesNotMatch(justification, /RabbitMQ/)
  assert.match(draft.text, /Требует подтверждения/)
  assert.equal(draft.counts.proposed, 1)
  assert.ok(draft.warnings.some(w => w.includes('требуют подтверждения')))
})

test('устаревший источник даёт предупреждение в тексте и в списке', () => {
  const draft = buildDraft({
    facts: [confirmed],
    sourceStatus: { 'page_id=123; version=14': 'устарело' }
  })
  assert.match(draft.text, /источник устарел/)
  assert.ok(draft.warnings.some(w => w.startsWith('источник факта')))
  assert.equal(isSafeToSend(draft), false)
})

test('без подтверждённых фактов черновик честно говорит, что оснований нет', () => {
  const draft = buildDraft({ facts: [] })
  assert.match(draft.text, /Подтверждённых оснований для ответа нет/)
  assert.equal(draft.counts.confirmed, 0)
  assert.equal(isSafeToSend(draft), false)
})

test('заменённый факт показывается как история, а не как действующий', () => {
  const superseded = { ...confirmed, id: 'f0', claim: 'Использовали RabbitMQ', supersededBy: 'f1' }
  const draft = buildDraft({ facts: [confirmed, superseded] })
  const justification = draft.text.split('Обоснование:')[1].split('Ранее действовало')[0]
  assert.doesNotMatch(justification, /RabbitMQ/)
  assert.match(draft.text, /Ранее действовало, но заменено/)
  assert.equal(draft.counts.superseded, 1)
})

test('готовый черновик считается безопасным, если факты подтверждены и источники свежи', () => {
  const draft = buildDraft({ facts: [confirmed], sourceStatus: { 'page_id=123; version=14': 'свежо' } })
  assert.equal(isSafeToSend(draft), true)
})
