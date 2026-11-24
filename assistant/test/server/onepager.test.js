import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createCafoCache } from '../../src/cafo/cache.js'
import { createServer } from '../../src/server/app.js'

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'one-'))
  const store = createStore(dir)
  const cafo = createCafoCache(dir)
  const today = new Date()
  const iso = today.toISOString().slice(0, 10)
  const past = new Date(today.getTime() - 3 * 86400000).toISOString().slice(0, 10)
  const future = new Date(today.getTime() + 5 * 86400000).toISOString().slice(0, 10)

  store.add({ id: 'a', title: 'Интеграция к релизу', source: 'письмо', dueAt: iso })
  store.add({ id: 'b', title: 'Уже отвечено', source: 'письмо', dueAt: future, answered: true })
  store.add({ id: 'c', title: 'Просроченная задача', source: 'файл', dueAt: past })
  store.add({ id: 'd', title: 'Будущая задача', source: 'файл', dueAt: future })
  cafo.put({ pageId: '1', title: 'КАФО: Платежи', version: 14, body: '# Платежи' })
  cafo.put({ pageId: '2', title: 'КАФО: Расчёты', version: 4, body: '# Расчёты' })

  const server = createServer({ store, cafo })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  return { server, base: `http://127.0.0.1:${port}`, cafo }
}

test('сводка собирает статусы КАФО, неотвеченные письма и горящие сроки', async () => {
  const { server, base } = await setup()
  try {
    const body = await (await fetch(`${base}/api/onepager`)).json()
    assert.equal(body.cafo.length, 2)
    assert.equal(body.counts.cafo, 2)
    assert.deepEqual(body.unanswered.map(task => task.id), ['a'])
    assert.deepEqual(body.burning.map(task => task.id).sort(), ['a', 'c'])
    assert.ok(body.burning[0].reason)
  } finally {
    server.close()
  }
})

test('отвеченные письма и будущие сроки не попадают в сводку', async () => {
  const { server, base } = await setup()
  try {
    const body = await (await fetch(`${base}/api/onepager`)).json()
    assert.ok(!body.unanswered.some(task => task.id === 'b'))
    assert.ok(!body.burning.some(task => task.id === 'd'))
  } finally {
    server.close()
  }
})

test('устаревшие страницы считаются отдельно', async () => {
  const { server, base, cafo } = await setup()
  try {
    await cafo.sync('1', async () => ({ version: 15 }))
    const body = await (await fetch(`${base}/api/onepager`)).json()
    assert.equal(body.counts.cafoStale, 1)
  } finally {
    server.close()
  }
})
