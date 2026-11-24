import test from 'node:test'
import assert from 'node:assert/strict'
import { rank, compareTasks, dueDate, reasonOf } from '../../src/domain/priority.js'

const now = new Date('2026-11-24T10:00:00+03:00')
const task = overrides => ({ dueAt: null, escalation: false, fromManager: false, status: 'новая', ...overrides })

const cases = [
  ['эскалация с далёким сроком', task({ escalation: true, dueAt: '2027-01-01' }), 0],
  ['эскалация со сроком сегодня', task({ escalation: true, dueAt: '2026-11-24' }), 0],
  ['эскалация с просрочкой', task({ escalation: true, dueAt: '2026-11-01' }), 0],
  ['срок сегодня', task({ dueAt: '2026-11-24' }), 1],
  ['срок вчера', task({ dueAt: '2026-11-23' }), 1],
  ['срок завтра', task({ dueAt: '2026-11-25' }), 3],
  ['срок через месяц', task({ dueAt: '2026-12-24' }), 3],
  ['поручение без срока', task({ fromManager: true }), 2],
  ['поручение со сроком завтра', task({ fromManager: true, dueAt: '2026-11-25' }), 2],
  ['поручение с просрочкой', task({ fromManager: true, dueAt: '2026-11-01' }), 1],
  ['эскалация и поручение', task({ escalation: true, fromManager: true }), 0],
  ['ничего не задано', task({}), 4],
  ['срок сегодня и поручение', task({ dueAt: '2026-11-24', fromManager: true }), 1],
  ['слово «сегодня» вместо даты', task({ dueAt: 'сегодня' }), 1],
  ['слово «завтра» вместо даты', task({ dueAt: 'завтра' }), 3]
]

test('15 эталонов приоритета', () => {
  assert.equal(cases.length, 15)
  for (const [name, value, expected] of cases) {
    assert.equal(rank(value, now), expected, `не совпало: ${name}`)
  }
})

test('закрытая задача уходит в конец', () => {
  assert.equal(rank(task({ status: 'закрыта', escalation: true }), now), 9)
})

test('сортировка ставит эскалацию выше срока, срок выше поручения', () => {
  const list = [
    task({ fromManager: true }),
    task({ dueAt: '2026-11-24' }),
    task({ escalation: true, dueAt: '2027-01-01' })
  ].sort((a, b) => compareTasks(a, b, now))
  assert.deepEqual(list.map(item => rank(item, now)), [0, 1, 2])
})

test('«завтра» и «сегодня» приводятся к локальной дате', () => {
  assert.equal(dueDate(task({ dueAt: 'сегодня' }), now), '2026-11-24')
  assert.equal(dueDate(task({ dueAt: 'завтра' }), now), '2026-11-25')
})

test('причина приоритета объясняет, почему задача здесь', () => {
  assert.equal(reasonOf(task({ escalation: true }), now), 'эскалация')
  assert.equal(reasonOf(task({ dueAt: '2026-11-23' }), now), 'просрочено')
  assert.equal(reasonOf(task({ dueAt: '2026-11-24' }), now), 'срок сегодня')
  assert.equal(reasonOf(task({ fromManager: true }), now), 'поручение руководителя')
  assert.equal(reasonOf(task({}), now), 'без срока')
})
