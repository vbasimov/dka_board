import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createEmailStore } from '../../src/email/store.js'
import { createServer } from '../../src/server/app.js'

async function withServer(fn, myAddresses = ['arch@example.com']) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-'))
  const email = createEmailStore(dir)
  const server = createServer({ store: createStore(dir), email, myAddresses })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    await fn({ email, base: `http://127.0.0.1:${port}` })
  } finally {
    server.close()
  }
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

test('письма принимаются и неотвеченные вычисляются по цепочке', async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, '/api/email/messages', {
      messages: [
        { folder: 'INBOX', uid: 11, from: 'analyst@example.com', subject: 'Интеграция', date: '2026-11-20T09:00:00Z', flags: [] }
      ]
    })
    const accepted = await response.json()
    assert.equal(accepted.created, 1)

    const body = await (await fetch(`${base}/api/email/unanswered`)).json()
    assert.equal(body.total, 1)
    assert.equal(body.items[0].title, 'Интеграция')
    assert.equal(body.items[0].unread, true)
  })
})

test('ответ архитектора закрывает письмо', async () => {
  await withServer(async ({ base }) => {
    await post(base, '/api/email/messages', {
      messages: [
        { folder: 'INBOX', uid: 11, from: 'analyst@example.com', subject: 'Интеграция', date: '2026-11-20T09:00:00Z' },
        { folder: 'Sent', uid: 21, from: 'arch@example.com', subject: 'Re: Интеграция', date: '2026-11-20T10:00:00Z' }
      ]
    })
    const body = await (await fetch(`${base}/api/email/unanswered`)).json()
    assert.equal(body.total, 0)
  })
})

test('сводка берёт неотвеченные из почты, а не из задач', async () => {
  await withServer(async ({ base }) => {
    await post(base, '/api/email/messages', {
      messages: [{ folder: 'INBOX', uid: 12, from: 'security@example.com', subject: 'Новые требования', date: '2026-11-24T09:00:00Z', flags: [] }]
    })
    const body = await (await fetch(`${base}/api/onepager`)).json()
    assert.equal(body.unanswered.length, 1)
    assert.match(body.unanswered[0].title, /Новые требования/)
  })
})
