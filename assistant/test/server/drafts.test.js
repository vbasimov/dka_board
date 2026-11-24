import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createFactStore } from '../../src/facts/store.js'
import { createCafoCache } from '../../src/cafo/cache.js'
import { createServer } from '../../src/server/app.js'

test('черновик собирается из подтверждённых фактов и отражает устаревший источник', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drafts-'))
  const facts = createFactStore(dir)
  const cafo = createCafoCache(dir)

  cafo.put({ pageId: '123', title: 'КАФО: Платежи', version: 12, body: '# Платежи' })
  const { fact } = facts.apply({
    claim: 'Сервис платежей передаёт события в Kafka',
    subject: 'Сервис платежей',
    relation: 'интеграция',
    object: 'Kafka',
    fo: 'Платежи',
    sourceType: 'кэш КАФО',
    sourceRef: 'page_id=123; version=12'
  })
  facts.confirm(fact.id, 'архитектор ФО Платежи')
  await cafo.sync('123', async () => ({ version: 14 }))

  const server = createServer({ store: createStore(dir), facts, cafo })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/drafts/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'Интеграция', request: 'Нужна интеграция к релизу' })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.draft.text, /Kafka/)
    assert.ok(body.draft.warnings.some(w => w.includes('устарел')))
  } finally {
    server.close()
  }
})

test('пустой реестр даёт черновик без выдуманных утверждений', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drafts-'))
  const server = createServer({ store: createStore(dir), facts: createFactStore(dir), cafo: createCafoCache(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/drafts/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.draft.text, /Подтверждённых оснований для ответа нет/)
  } finally {
    server.close()
  }
})
