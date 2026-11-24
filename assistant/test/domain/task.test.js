import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTask } from '../../src/domain/task.js'

test('создаёт задачу с обязательным источником', () => {
  const task = makeTask({ title: 'Ответить антифроду', source: 'письмо', sourceRef: 'msg-1' })
  assert.equal(task.status, 'новая')
  assert.equal(task.source, 'письмо')
  assert.ok(task.id.length > 0)
  assert.ok(task.createdAt)
})

test('без источника падает с понятным текстом', () => {
  assert.throws(() => makeTask({ title: 'Без источника' }), /источник обязателен/)
})

test('срок приводится к дате', () => {
  assert.equal(makeTask({ title: 'x', source: 'письмо', dueAt: '2026-11-24' }).dueAt, '2026-11-24')
  assert.equal(makeTask({ title: 'x', source: 'письмо', dueAt: '2026-11-24T10:00:00+03:00' }).dueAt, '2026-11-24')
})

test('без названия задача не создаётся', () => {
  assert.throws(() => makeTask({ source: 'письмо' }), /название задачи обязательно/)
})
