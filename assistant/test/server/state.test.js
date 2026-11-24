import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

async function withServer(fn) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'state-')))
  const server = createServer({ store })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn({ store, base: `http://127.0.0.1:${port}` })
  } finally {
    server.close()
  }
}

test('сводка отдаёт три числа и не более трёх задач', async () => {
  await withServer(async ({ store, base }) => {
    for (let i = 0; i < 12; i++) {
      store.add({ id: `t-${i}`, title: `задача ${i}`, source: 'письмо' })
    }
    const response = await fetch(`${base}/api/state`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(typeof body.counts.today, 'number')
    assert.equal(typeof body.counts.overdue, 'number')
    assert.equal(typeof body.counts.notInCafo, 'number')
    assert.equal(body.tasks.length, 3)
    assert.equal(body.tasks[0].rank, 4)
  })
})

test('эскалация выходит на первое место, просрочка считается', async () => {
  await withServer(async ({ store, base }) => {
    store.add({ id: 'a', title: 'обычная', source: 'письмо' })
    store.add({ id: 'b', title: 'просроченная', source: 'письмо', dueAt: '2020-01-01' })
    store.add({ id: 'c', title: 'эскалация', source: 'письмо', escalation: true })
    const body = await (await fetch(`${base}/api/state`)).json()
    assert.equal(body.tasks[0].title, 'эскалация')
    assert.equal(body.tasks[0].reason, 'эскалация')
    assert.ok(body.counts.overdue >= 1)
    assert.ok(body.counts.today >= 2)
  })
})

test('закрытые задачи не попадают в сводку', async () => {
  await withServer(async ({ store, base }) => {
    const { task } = store.add({ id: 'x', title: 'закрытая', source: 'письмо', escalation: true })
    store.setStatus(task.id, 'закрыта')
    store.add({ id: 'y', title: 'открытая', source: 'письмо' })
    const body = await (await fetch(`${base}/api/state`)).json()
    assert.equal(body.tasks.length, 1)
    assert.equal(body.tasks[0].title, 'открытая')
  })
})
