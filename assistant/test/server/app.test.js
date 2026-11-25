import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

test('слушает только 127.0.0.1 и отдаёт задачи', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'server-')))
  store.add({ id: 't-1', title: 'тест', source: 'письмо' })
  const server = createServer({ store })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port, address } = server.address()
  assert.equal(address, '127.0.0.1')

  const started = performance.now()
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks?q=тест`)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.items[0].id, 't-1')
  assert.equal(body.total, 1)
  assert.ok(performance.now() - started < 1000)

  server.close()
})

test('неизвестный путь отдаёт 404 с русским текстом', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'server-')))
  const server = createServer({ store })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}/api/unknown`)
  const body = await response.json()
  assert.equal(response.status, 404)
  assert.match(body.error, /не найдено/)
  server.close()
})

test('health сообщает состояние целостности бандла', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-'))
  const server = createServer({ store: createStore(dir), integrity: 'повреждено: ui/app.js' })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
    assert.equal(body.integrity, 'повреждено: ui/app.js')
  } finally {
    server.close()
  }
})

test('POST /api/tasks создаёт задачу, а не отдаёт список', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-'))
  const server = createServer({ store: createStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Согласовать интеграцию', source: 'письмо', dueAt: '2026-11-25' })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.created, true)
    assert.equal(body.task.title, 'Согласовать интеграцию')
  } finally {
    server.close()
  }
})
