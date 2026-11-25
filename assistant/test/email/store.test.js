import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmailStore } from '../../src/email/store.js'

const dir = () => mkdtempSync(join(tmpdir(), 'email-'))
const message = over => ({ messageId: 'm-1', from: 'analyst@example.com', subject: 'Интеграция', date: '2026-11-20T09:00:00Z', seen: false, ...over })

test('письма сохраняются и переживают перезапуск', () => {
  const path = dir()
  const store = createEmailStore(path)
  store.add(message({}))
  const reopened = createEmailStore(path)
  assert.equal(reopened.count(), 1)
  assert.equal(reopened.all()[0].subject, 'Интеграция')
})

test('повторное добавление того же письма не создаёт дубль', () => {
  const store = createEmailStore(dir())
  assert.equal(store.add(message({})).created, true)
  assert.equal(store.add(message({ subject: 'Интеграция (обновлено)' })).created, false)
  assert.equal(store.count(), 1)
})

test('письмо без идентификатора отклоняется', () => {
  const store = createEmailStore(dir())
  assert.throws(() => store.add({ subject: 'без id' }), /идентификатор/)
})
