import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../../src/store/tasks.js'
import { createEmailStore } from '../../src/email/store.js'
import { createMcpClient } from '../../src/rag/mcp.js'
import { createMailClient } from '../../src/email/mcp.js'
import { createServer } from '../../src/server/app.js'

const fixture = fileURLToPath(new URL('../../fixtures/fake-mail-mcp.mjs', import.meta.url))

test('синхронизация забирает письма из mcp-email и кладёт в хранилище', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'))
  const mcp = createMcpClient({ command: process.execPath, args: [fixture] })
  const email = createEmailStore(dir)
  const mail = createMailClient({ mcp })
  const server = createServer({ store: createStore(dir), email, mail, myAddresses: ['arch@example.com'] })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/email/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 10, read: 2 })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.listed, 2)
    assert.equal(body.created, 2)
    assert.equal(body.total, 2)

    const unanswered = await (await fetch(`http://127.0.0.1:${port}/api/email/unanswered`)).json()
    assert.equal(unanswered.total, 2)
  } finally {
    mcp.close()
    server.close()
  }
})

test('без почтового сервера синхронизация честно отказывает', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-'))
  const server = createServer({ store: createStore(dir), email: createEmailStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/email/sync`, { method: 'POST' })
    const body = await response.json()
    assert.equal(response.status, 503)
    assert.match(body.error, /не подключён/)
  } finally {
    server.close()
  }
})
