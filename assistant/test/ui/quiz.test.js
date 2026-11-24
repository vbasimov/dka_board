import test from 'node:test'
import assert from 'node:assert/strict'
import { renderQuiz } from '../../ui/quiz.js'

const fact = { id: 'f1', claim: 'Платежи передают события в Kafka', sourceType: 'кэш КАФО', sourceRef: 'page_id=123; version=14' }

test('карточка факта показывает источник и три ответа', () => {
  const html = renderQuiz([fact])
  assert.match(html, /Платежи передают события в Kafka/)
  assert.match(html, /page_id=123; version=14/)
  assert.match(html, /Подтвердить/)
  assert.match(html, /Недостоверно/)
  assert.match(html, /Пропустить/)
})

test('карточек столько же, сколько фактов', () => {
  const html = renderQuiz([fact, { ...fact, id: 'f2' }, { ...fact, id: 'f3' }])
  assert.equal((html.match(/data-verdict="confirm"/g) || []).length, 3)
})

test('пустой квиз объясняет, что делать нечего', () => {
  assert.match(renderQuiz([]), /проверять нечего/)
})

test('содержимое карточки экранируется', () => {
  const html = renderQuiz([{ ...fact, claim: '<img src=x onerror=1>' }])
  assert.doesNotMatch(html, /<img/)
})
