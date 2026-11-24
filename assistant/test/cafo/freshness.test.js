import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { freshnessOf, fetchMeta } from '../../src/cafo/freshness.js'

test('совпадение версий — свежо', () => {
  assert.deepEqual(freshnessOf({ version: 12 }, { version: 12 }), { status: 'свежо', diff: 0 })
})

test('рост версии — устарело с числом правок', () => {
  assert.deepEqual(freshnessOf({ version: 12 }, { version: 14 }), { status: 'устарело', diff: 2 })
})

test('нет ответа — не сверено, никогда не свежо', () => {
  assert.equal(freshnessOf({ version: 12, checkedAt: '2026-11-24T09:00:00+03:00' }, null).status, 'не_сверено')
})

test('версия в источнике меньше сохранённой — устарело, отрицательная разница допустима', () => {
  assert.deepEqual(freshnessOf({ version: 14 }, { version: 12 }), { status: 'устарело', diff: -2 })
})

test('fetchMeta отдаёт номер версии при успешном ответе', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: { number: 14 } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const meta = await fetchMeta('123', { baseUrl: `http://127.0.0.1:${port}` })
  assert.deepEqual(meta, { version: 14 })
  server.close()
})

test('fetchMeta возвращает null при ошибке сервера, а не бросает', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500)
    res.end('error')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const meta = await fetchMeta('123', { baseUrl: `http://127.0.0.1:${port}` })
  assert.equal(meta, null)
  server.close()
})

test('fetchMeta укладывается в таймаут и возвращает null', async () => {
  const server = createServer(() => {
    // намеренно не отвечаем
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const started = Date.now()
  const meta = await fetchMeta('123', { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 })
  assert.equal(meta, null)
  assert.ok(Date.now() - started < 1500)
  server.closeAllConnections()
  server.close()
})
