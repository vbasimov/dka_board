import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

test('задачу можно отложить с сохранённым шагом, и она видна в «Продолжить»', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'park-'))
  const store = createStore(dir)
  const { task } = store.add({ id: 't1', title: 'Разобрать схему', source: 'письмо' })
  const server = createServer({ store })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/park`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextStep: 'сверить связи с КАФО' })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.task.nextStep, 'сверить связи с КАФО')

    const summary = await (await fetch(`http://127.0.0.1:${port}/api/onepager`)).json()
    assert.equal(summary.counts.resume, 1)
    assert.equal(summary.resume[0].nextStep, 'сверить связи с КАФО')
  } finally {
    server.close()
  }
})
