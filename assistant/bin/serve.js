import { fileURLToPath } from 'node:url'
import { createStore } from '../src/store/tasks.js'
import { createServer } from '../src/server/app.js'

const dataDir = process.env.AA_DATA ?? fileURLToPath(new URL('../.data/', import.meta.url))
const port = Number(process.env.AA_PORT ?? 7777)

const store = createStore(dataDir)
const server = createServer({ store })

server.listen(port, '127.0.0.1', () => {
  console.log(`Ассистент архитектора: http://127.0.0.1:${port}`)
  console.log(`Данные: ${dataDir}`)
})
