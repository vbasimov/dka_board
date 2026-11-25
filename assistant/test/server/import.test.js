import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'import-route-'))
  const store = createStore(dir)
  const server = createServer({ store })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn({ store, base: `http://127.0.0.1:${port}`, dir })
  } finally {
    server.close()
  }
}

test('импорт элементов не создаёт дублей при повторе', async () => {
  await withServer(async ({ store, base }) => {
    const payload = { items: [{ title: 'Согласовать', source: 'jira', sourceRef: 'JIRA-7' }] }
    const post = () => fetch(`${base}/api/import/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const first = await (await post()).json()
    const second = await (await post()).json()
    assert.equal(first.created, 1)
    assert.equal(second.duplicate, 1)
    assert.equal(store.count(), 1)
  })
})

test('импорт из каталога читает файлы и сообщает ошибки', async () => {
  await withServer(async ({ base, dir }) => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ title: 'Из файла', source: 'файл' }]))
    writeFileSync(join(dir, 'broken.json'), '{ oops')
    const response = await fetch(`${base}/api/import/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.created, 1)
    assert.equal(body.readErrors.length, 1)
  })
})
