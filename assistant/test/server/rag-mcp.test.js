import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../../src/store/tasks.js'
import { createMcpClient } from '../../src/rag/mcp.js'
import { createServer } from '../../src/server/app.js'

const fixture = fileURLToPath(new URL('../../fixtures/fake-mcp.mjs', import.meta.url))

test('маршрут поиска работает через MCP-клиент', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-mcp-'))
  const rag = createMcpClient({ command: process.execPath, args: [fixture] })
  const server = createServer({ store: createStore(dir), rag })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/rag/search?q=Kafka`)).json()
    assert.equal(body.items[0].title, 'КАФО: Платежи')
    assert.equal(body.items[0].sourceType, 'md')
  } finally {
    rag.close()
    server.close()
  }
})
