import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

test('поиск по знаниям отдаёт нормализованные результаты', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-route-'))
  const rag = { search: async (query, options) => [{ id: '1', title: `по ${query}`, score: 0.5, sourceType: 'md', snippet: '', path: '' }] }
  const server = createServer({ store: createStore(dir), rag })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/rag/search?q=Kafka`)).json()
    assert.equal(body.query, 'Kafka')
    assert.equal(body.items[0].title, 'по Kafka')
  } finally {
    server.close()
  }
})

test('без подключённого поиска возвращается понятный отказ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-route-'))
  const server = createServer({ store: createStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rag/search?q=Kafka`)
    const body = await response.json()
    assert.equal(response.status, 503)
    assert.match(body.error, /не подключён/)
  } finally {
    server.close()
  }
})

test('ошибка поиска отдаётся как 400 с текстом', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-route-'))
  const rag = { search: async () => { throw new Error('индекс не собран') } }
  const server = createServer({ store: createStore(dir), rag })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rag/search?q=Kafka`)
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.match(body.error, /индекс не собран/)
  } finally {
    server.close()
  }
})
