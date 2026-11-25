import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createDecisionStore } from '../../src/decisions/store.js'
import { createServer } from '../../src/server/app.js'

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dec-'))
  const server = createServer({ store: createStore(dir), decisions: createDecisionStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

test('решение фиксируется, считается долгом и закрывается отметкой о КАФО', async () => {
  await withServer(async base => {
    const created = await (await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Платежи в Kafka', source: 'протокол' })
    })).json()
    assert.equal(created.decision.state, 'долг')

    const debts = await (await fetch(`${base}/api/decisions?debts=1`)).json()
    assert.equal(debts.items.length, 1)
    assert.equal(debts.debts, 1)

    const summary = await (await fetch(`${base}/api/onepager`)).json()
    assert.equal(summary.counts.notInCafo, 1)

    const closed = await (await fetch(`${base}/api/decisions/${created.decision.id}/cafo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cafoPageId: '123' })
    })).json()
    assert.equal(closed.decision.inCafo, true)
    assert.equal(closed.decision.cafoPageId, '123')

    const after = await (await fetch(`${base}/api/onepager`)).json()
    assert.equal(after.counts.notInCafo, 0)
  })
})

test('решение без источника отклоняется', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Без источника' })
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.match(body.error, /источник/)
  })
})
