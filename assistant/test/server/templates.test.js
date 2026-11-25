import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createFactStore } from '../../src/facts/store.js'
import { createServer } from '../../src/server/app.js'

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'))
  const server = createServer({ store: createStore(dir), facts: createFactStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

test('список шаблонов доступен и содержит 12 штук без тел', async () => {
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/templates`)).json()
    assert.equal(body.items.length, 12)
    assert.ok(body.items.every(item => item.id && item.title && item.when))
    assert.ok(body.items.every(item => item.body === undefined))
  })
})

test('черновик возвращает заполненный шаблон и незаполненные подстановки', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/drafts/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request: 'Нужна схема', templateId: 'diagram-request', deadline: '25.11' })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.template.id, 'diagram-request')
    assert.match(body.template.text, /Нужна схема/)
    assert.ok(Array.isArray(body.template.missing))
  })
})

test('неизвестный шаблон даёт понятную ошибку', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/drafts/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: 'нет-такого' })
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.match(body.error, /не найден/)
  })
})
