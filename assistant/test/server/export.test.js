import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createFactStore } from '../../src/facts/store.js'
import { createServer } from '../../src/server/app.js'

test('задачи выгружаются в CSV с заголовком и типом содержимого', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-'))
  const store = createStore(dir)
  store.add({ id: 't1', title: 'Согласовать, интеграцию', source: 'письмо', dueAt: '2026-11-25' })
  const server = createServer({ store, facts: createFactStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/export/tasks.csv`)
    const text = await response.text()
    assert.match(response.headers.get('content-type'), /text\/csv/)
    assert.match(text, /id,title,source/)
    assert.match(text, /"Согласовать, интеграцию"/)
  } finally {
    server.close()
  }
})

test('факты выгружаются в markdown с источником', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-'))
  const facts = createFactStore(dir)
  facts.apply({
    claim: 'Платежи в Kafka', subject: 'Платежи', relation: 'интеграция', object: 'Kafka',
    fo: 'Платежи', sourceType: 'кэш КАФО', sourceRef: 'page_id=1; version=14'
  })
  const server = createServer({ store: createStore(dir), facts })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/export/facts.md`)
    const text = await response.text()
    assert.match(response.headers.get('content-type'), /text\/markdown/)
    assert.match(text, /Платежи в Kafka/)
    assert.match(text, /page_id=1; version=14/)
  } finally {
    server.close()
  }
})
