import { fileURLToPath } from 'node:url'
import { createStore } from '../src/store/tasks.js'
import { createFactStore } from '../src/facts/store.js'
import { createCafoCache } from '../src/cafo/cache.js'
import { createServer } from '../src/server/app.js'
import { createRagClient } from '../src/rag/client.js'
import { createMcpClient } from '../src/rag/mcp.js'
import { createEmailStore } from '../src/email/store.js'

const dataDir = process.env.AA_DATA ?? fileURLToPath(new URL('../.data/', import.meta.url))
const port = Number(process.env.AA_PORT ?? 7777)

const cafoBaseUrl = process.env.AA_CONFLUENCE ?? ''
const store = createStore(dataDir)
const facts = createFactStore(dataDir)
const cafo = createCafoCache(dataDir)
const mcpCommand = process.env.AA_MCP_CMD ?? ''
const ragCommand = process.env.AA_RAG_CMD ?? ''
const rag = mcpCommand
  ? createMcpClient({ command: mcpCommand.split(' ')[0], args: mcpCommand.split(' ').slice(1) })
  : ragCommand
    ? createRagClient({ command: ragCommand.split(' ')[0], args: ragCommand.split(' ').slice(1) })
    : null
const email = createEmailStore(dataDir)
const myAddresses = (process.env.AA_MY_ADDRESSES ?? '').split(',').map(item => item.trim()).filter(Boolean)
const server = createServer({ store, facts, cafo, cafoBaseUrl, dataDir, rag, email, myAddresses })

server.listen(port, '127.0.0.1', () => {
  console.log(`Ассистент архитектора: http://127.0.0.1:${port}`)
  console.log(`Данные: ${dataDir}`)
  console.log(`Конфлюенс: ${cafoBaseUrl || 'не задан (сверка версий недоступна)'}`)
  console.log(`Почта: ${myAddresses.length ? myAddresses.join(', ') : 'адреса не заданы (AA_MY_ADDRESSES)'}`)
  console.log(`Поиск по знаниям: ${mcpCommand ? `MCP (${mcpCommand})` : ragCommand ? `CLI (${ragCommand})` : 'не задан (AA_MCP_CMD или AA_RAG_CMD)'}`)
})
