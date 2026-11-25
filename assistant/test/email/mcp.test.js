import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createMcpClient } from '../../src/rag/mcp.js'
import { createMailClient } from '../../src/email/mcp.js'

const fixture = fileURLToPath(new URL('../../fixtures/fake-mail-mcp.mjs', import.meta.url))

test('клиент почты собирает письма из list_messages и read_message', async () => {
  const mcp = createMcpClient({ command: process.execPath, args: [fixture] })
  const mail = createMailClient({ mcp })
  try {
    const { listed, messages } = await mail.fetch({ limit: 10, read: 2 })
    assert.equal(listed.length, 2)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].folder, 'INBOX')
    assert.equal(messages[0].uid, 40512)
    assert.equal(messages[0].from, 'ivanov@company.ru')
    assert.equal(messages[0].unread, true)
    assert.match(messages[0].body, /инкремент/)
    assert.equal(messages[1].uid, 40513)
    assert.equal(messages[1].unread, false)
  } finally {
    mcp.close()
  }
})

test('количество прочитанных писем ограничивается параметром read', async () => {
  const mcp = createMcpClient({ command: process.execPath, args: [fixture] })
  try {
    const { messages } = await createMailClient({ mcp }).fetch({ limit: 10, read: 1 })
    assert.equal(messages.length, 1)
  } finally {
    mcp.close()
  }
})
