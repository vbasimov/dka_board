import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

test('порядок приоритета берётся из настроек', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prio-'))
  const store = createStore(dir)
  store.add({ id: 'm', title: 'Поручение', source: 'письмо', fromManager: true })
  store.add({ id: 'e', title: 'Эскалация', source: 'письмо', escalation: true })

  const server = createServer({ store, priorityOrder: ['manager', 'escalation', 'due', 'hasDue', 'other'] })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()
    assert.equal(body.tasks[0].title, 'Поручение')
  } finally {
    server.close()
  }
})
