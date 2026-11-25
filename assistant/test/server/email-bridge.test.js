import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createEmailStore } from '../../src/email/store.js'
import { createEmailBridge } from '../../src/email/bridge.js'
import { createServer } from '../../src/server/app.js'

test('мост пишет письма в markdown и отдаёт счётчики', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-route-'))
  const email = createEmailStore(dir)
  email.add({ folder: 'INBOX', uid: 1, from: 'a@b', subject: 'Интеграция', date: '2026-11-25T09:00:00Z', body: 'текст' })
  const bridge = createEmailBridge({ dir })
  const server = createServer({ store: createStore(dir), email, bridge })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/email/bridge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.written, 1)
    assert.ok(existsSync(body.target))
    assert.equal(readdirSync(body.target).length, 1)
  } finally {
    server.close()
  }
})
