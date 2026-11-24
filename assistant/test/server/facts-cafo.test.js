import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpCreateServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createFactStore } from '../../src/facts/store.js'
import { createCafoCache } from '../../src/cafo/cache.js'
import { createServer } from '../../src/server/app.js'

async function withApp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'app-'))
  const deps = { store: createStore(dir), facts: createFactStore(dir), cafo: createCafoCache(dir) }
  const server = createServer(deps)
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn({ ...deps, base: `http://127.0.0.1:${port}` })
  } finally {
    server.close()
  }
}

const fact = {
  claim: 'Сервис платежей передаёт события в Kafka',
  subject: 'Сервис платежей',
  relation: 'интеграция',
  object: 'Kafka',
  fo: 'Платежи',
  sourceType: 'схема',
  sourceRef: 'page_id=123; version=4'
}

test('факт подтверждается через вызов и попадает в ответ', async () => {
  await withApp(async ({ facts, base }) => {
    const { fact: created } = facts.apply(fact)
    const response = await fetch(`${base}/api/facts/${created.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'архитектор ФО Платежи' })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.fact.status, 'подтверждён')

    const answer = await (await fetch(`${base}/api/facts?mode=answer`)).json()
    assert.equal(answer.items.length, 1)
    assert.equal(answer.items[0].confirmedBy, 'архитектор ФО Платежи')
  })
})

test('подтверждение несуществующего факта возвращает понятную ошибку', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/facts/нет-такого/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'архитектор' })
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.match(body.error, /не найден/)
  })
})

test('синхронизация КАФО помечает страницу устаревшей', async () => {
  const confluence = httpCreateServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: { number: 14 } }))
  })
  await new Promise(done => confluence.listen(0, '127.0.0.1', done))
  const { port: confluencePort } = confluence.address()

  const dir = mkdtempSync(join(tmpdir(), 'cafo-app-'))
  const cafo = createCafoCache(dir)
  cafo.put({ pageId: '123', title: 'КАФО: Платежи', spaceKey: 'ARCH', version: 12, body: '# Платежи' })

  const server = createServer({
    store: createStore(dir),
    cafo,
    cafoBaseUrl: `http://127.0.0.1:${confluencePort}`
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/cafo/sync`, { method: 'POST' })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.results[0].status, 'устарело')
    assert.equal(body.results[0].diff, 2)

    const list = await (await fetch(`http://127.0.0.1:${port}/api/cafo`)).json()
    assert.equal(list.items[0].status, 'устарело')
  } finally {
    server.close()
    confluence.close()
  }
})
