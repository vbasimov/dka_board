import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../../src/store/tasks.js'
import { createServer } from '../../src/server/app.js'

const fixture = fileURLToPath(new URL('../fixtures/plain.drawio', import.meta.url))
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'diag-path-'))
  const server = createServer({ store: createStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`, dir)
  } finally {
    server.close()
  }
}

const post = (base, body) => fetch(`${base}/api/diagrams/compare`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

test('схему можно передать путём к файлу', async () => {
  await withServer(async (base, dir) => {
    const path = join(dir, 'schema.drawio')
    copyFileSync(fixture, path)
    const body = await (await post(base, { path, cafo: ['Kafka → CRM'] })).json()
    assert.equal(body.result.matched.length, 1)
  })
})

test('PNG без встроенной схемы честно помечается как нераспознанный', async () => {
  await withServer(async (base, dir) => {
    const path = join(dir, 'screenshot.png')
    writeFileSync(path, png)
    const response = await post(base, { path })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.unsupported, true)
    assert.match(body.reason, /изображение/)
  })
})

test('свежесть схемы сравнивается с сохранённым хэшем', async () => {
  await withServer(async (base, dir) => {
    const path = join(dir, 'schema2.drawio')
    copyFileSync(fixture, path)
    const first = await (await post(base, { path, cafo: [] })).json()
    assert.equal(first.freshness, null)

    const { fileDigest } = await import('../../src/parse/sources.js')
    const digest = await fileDigest(path)
    const same = await (await post(base, { path, cafo: [], cached: { digest } })).json()
    assert.equal(same.freshness.status, 'свежо')

    const stale = await (await post(base, { path, cafo: [], cached: { digest: 'deadbeef' } })).json()
    assert.equal(stale.freshness.status, 'устарело')
  })
})
