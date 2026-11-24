import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

const fixture = readFileSync(new URL('../fixtures/plain.drawio', import.meta.url), 'utf8')

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'diag-'))
  const server = createServer({ store: createStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

async function compare(base, payload) {
  const response = await fetch(`${base}/api/diagrams/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { status: response.status, body: await response.json() }
}

test('сравнивает схему с интеграциями КАФО и показывает расхождения', async () => {
  await withServer(async base => {
    const { status, body } = await compare(base, { xml: fixture, cafo: ['Кафка → CRM'] })
    assert.equal(status, 200)
    assert.equal(body.diagram, 'Платежи')
    assert.equal(body.result.onlyInDiagram.length, 1)
    assert.equal(body.result.onlyInDiagram[0].from, 'Kafka')
    assert.equal(body.result.onlyInCafo.length, 1)
  })
})

test('совпадающая интеграция не считается расхождением', async () => {
  await withServer(async base => {
    const { body } = await compare(base, { xml: fixture, cafo: ['Kafka → CRM'] })
    assert.equal(body.result.matched.length, 1)
    assert.equal(body.result.onlyInDiagram.length, 0)
  })
})

test('файл не в формате draw.io отклоняется с понятным текстом', async () => {
  await withServer(async base => {
    const { status, body } = await compare(base, { xml: 'не схема' })
    assert.equal(status, 400)
    assert.match(body.error, /draw\.io/)
  })
})
