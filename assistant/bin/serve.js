import { fileURLToPath } from 'node:url'
import { createStore } from '../src/store/tasks.js'
import { createFactStore } from '../src/facts/store.js'
import { createCafoCache } from '../src/cafo/cache.js'
import { createServer } from '../src/server/app.js'

const dataDir = process.env.AA_DATA ?? fileURLToPath(new URL('../.data/', import.meta.url))
const port = Number(process.env.AA_PORT ?? 7777)

const cafoBaseUrl = process.env.AA_CONFLUENCE ?? ''
const store = createStore(dataDir)
const facts = createFactStore(dataDir)
const cafo = createCafoCache(dataDir)
const server = createServer({ store, facts, cafo, cafoBaseUrl, dataDir })

server.listen(port, '127.0.0.1', () => {
  console.log(`Ассистент архитектора: http://127.0.0.1:${port}`)
  console.log(`Данные: ${dataDir}`)
  console.log(`Конфлюенс: ${cafoBaseUrl || 'не задан (сверка версий недоступна)'}`)
})
