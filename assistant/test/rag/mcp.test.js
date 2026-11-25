import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createMcpClient } from '../../src/rag/mcp.js'

const fixture = fileURLToPath(new URL('../../fixtures/fake-mcp.mjs', import.meta.url))

test('клиент MCP запускает сервер, здоровается и читает результаты', async () => {
  const client = createMcpClient({ command: process.execPath, args: [fixture] })
  try {
    const items = await client.search('Kafka')
    assert.equal(items.length, 1)
    assert.equal(items[0].id, '42')
    assert.equal(items[0].title, 'КАФО: Платежи')
    assert.equal(items[0].score, 0.87)
  } finally {
    client.close()
  }
})

test('пустой запрос не запускает сервер', async () => {
  const client = createMcpClient({ command: '/nonexistent/mcp' })
  await assert.rejects(() => client.search('  '), /пустой поисковый запрос/)
})

test('недоступная команда даёт понятную ошибку, а не зависание', async () => {
  const client = createMcpClient({ command: '/nonexistent/mcp', timeoutMs: 1500 })
  await assert.rejects(() => client.search('Kafka'), /не удалось запустить поиск|остановился/)
})
