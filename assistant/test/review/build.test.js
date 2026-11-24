import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReview } from '../../src/review/build.js'

const now = new Date('2026-11-24T10:00:00+03:00')

test('ревью перечисляет неподтверждённые факты, устаревшие страницы и просрочки', () => {
  const review = buildReview({
    now,
    tasks: [
      { title: 'Согласовать интеграцию', status: 'новая', dueAt: '2026-11-20' },
      { title: 'Ответить на запрос', status: 'закрыта' }
    ],
    facts: [{ claim: 'Будем использовать RabbitMQ', status: 'предложен' }],
    cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }],
    diagramDiffs: [{ diagram: 'Расчёты', onlyInDiagram: [{ from: 'Расчёты', to: 'Биллинг' }] }]
  })
  assert.match(review.markdown, /Будем использовать RabbitMQ/)
  assert.match(review.markdown, /КАФО «КАФО: Платежи» обновилась до версии 14/)
  assert.match(review.markdown, /Расчёты → Биллинг/)
  assert.equal(review.counts.overdue, 1)
  assert.equal(review.counts.proposedFacts, 1)
  assert.equal(review.counts.gaps, 3)
})

test('предлагает действия по найденным пропускам', () => {
  const review = buildReview({
    now,
    facts: [{ claim: 'x', status: 'предложен' }],
    cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }]
  })
  assert.match(review.markdown, /подтвердить или отклонить 1 факт/)
  assert.match(review.markdown, /обновить кэш 1 страниц/)
})

test('пустое ревью честно говорит, что пропусков не найдено', () => {
  const review = buildReview({ now })
  assert.match(review.markdown, /существенных пропусков не найдено/)
  assert.match(review.markdown, /ничего не требуется/)
  assert.equal(review.counts.gaps, 0)
})

test('закрытые задачи не попадают в «что произошло»', () => {
  const review = buildReview({ now, tasks: [{ title: 'Закрытая задача', status: 'закрыта' }] })
  assert.doesNotMatch(review.markdown, /Закрытая задача/)
})
