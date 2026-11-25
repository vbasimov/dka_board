import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as httpCreateServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createCafoCache } from '../../src/cafo/cache.js'
import { createServer } from '../../src/server/app.js'

test('при росте версии синхронизация перекачивает страницу и обновляет кэш', async () => {
  const confluence = httpCreateServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      version: { number: 15 },
      title: 'КАФО: Платежи и возвраты',
      space: { key: 'ARCH' },
      body: { storage: { value: 'новое тело страницы' } },
      ancestors: [{ title: 'КАФО' }]
    }))
  })
  await new Promise(done => confluence.listen(0, '127.0.0.1', done))
  const { port: confluencePort } = confluence.address()

  const dir = mkdtempSync(join(tmpdir(), 'cafo-refresh-'))
  const cafo = createCafoCache(dir)
  cafo.put({ pageId: '123', title: 'КАФО: Платежи', version: 12, body: 'старое тело' })

  const server = createServer({
    store: createStore(dir),
    cafo,
    cafoBaseUrl: `http://127.0.0.1:${confluencePort}`
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/cafo/sync`, { method: 'POST' })).json()
    assert.equal(body.results[0].refreshed, true)
    assert.equal(body.results[0].meta.version, 15)
    assert.match(cafo.get('123').body, /новое тело/)
    assert.equal(cafo.list()[0].title, 'КАФО: Платежи и возвраты')
  } finally {
    server.close()
    confluence.close()
  }
})
