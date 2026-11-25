import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { createStore } from '../src/store/tasks.js'
import { createFactStore } from '../src/facts/store.js'
import { createCafoCache } from '../src/cafo/cache.js'
import { createServer } from '../src/server/app.js'
import { createRagClient } from '../src/rag/client.js'
import { createMcpClient } from '../src/rag/mcp.js'
import { createEmailStore } from '../src/email/store.js'
import { createMailClient } from '../src/email/mcp.js'
import { createEmailBridge } from '../src/email/bridge.js'
import { createDecisionStore } from '../src/decisions/store.js'
import { createDraftStore } from '../src/drafts/store.js'
import { buildReview } from '../src/review/build.js'
import { createReviewStore } from '../src/review/store.js'
import { startScheduler } from '../src/review/schedule.js'
import { createPluginRegistry } from '../src/plugins/registry.js'
import { verifyManifest } from '../src/bundle/integrity.js'
import { execFile } from 'node:child_process'

const dataDir = process.env.AA_DATA ?? fileURLToPath(new URL('../.data/', import.meta.url))
const port = Number(process.env.AA_PORT ?? 7777)

let priorityOrder = null
try {
  const settingsPath = process.env.AA_SETTINGS ?? `${dataDir}/настройки.json`
  priorityOrder = JSON.parse(readFileSync(settingsPath, 'utf8')).priorityOrder ?? null
} catch {
  priorityOrder = null
}

let integrity = 'нет манифеста'
try {
  const bundleDir = fileURLToPath(new URL('../', import.meta.url))
  const manifestPath = new URL('../manifest.json', import.meta.url)
  if (!existsSync(manifestPath)) throw new Error('запуск из исходников, манифест не создан')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const check = verifyManifest(bundleDir, manifest)
  integrity = check.ok ? 'ok' : `повреждено: ${[...check.missing, ...check.modified].join(', ')}`
} catch (error) {
  if (!/исходников/.test(error.message)) console.error('Проверка целостности не удалась:', error.message)
  integrity = 'нет манифеста'
}

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
const mailCommand = process.env.AA_MAIL_CMD ?? ''
const mailMcp = mailCommand
  ? createMcpClient({ command: mailCommand.split(' ')[0], args: mailCommand.split(' ').slice(1) })
  : null
const mail = mailMcp ? createMailClient({ mcp: mailMcp, folder: process.env.AA_MAIL_FOLDER ?? 'INBOX' }) : null
const email = createEmailStore(dataDir)
const myAddresses = (process.env.AA_MY_ADDRESSES ?? '').split(',').map(item => item.trim()).filter(Boolean)
const indexCommand = process.env.AA_INDEX_CMD ?? ''
const index = indexCommand
  ? () => new Promise((resolve, reject) => {
      const [command, ...args] = indexCommand.split(' ')
      execFile(command, args, { timeout: 120000 }, error => (error ? reject(new Error(`индексация не удалась: ${error.message}`)) : resolve()))
    })
  : null
const decisions = createDecisionStore(dataDir)
const reviewStore = createReviewStore(dataDir)
let scheduler = null
if (process.env.AA_REVIEW_SCHEDULE) {
  const [weekday = 'пятница', hour = '16'] = process.env.AA_REVIEW_SCHEDULE.split(',')
  scheduler = startScheduler({
    run: async () => {
      const review = buildReview({ tasks: store.all(), facts: facts.all(), cafo: cafo.list() })
      const saved = reviewStore.save(review.markdown, { suffix: 'по-расписанию' })
      console.log(`Ревью собрано по расписанию: ${saved.name}`)
      return review.counts
    },
    options: { weekday, hour: Number(hour) }
  })
  console.log(`Ревью по расписанию: ${weekday}, после ${hour}:00`)
}
const drafts = createDraftStore(dataDir)
const pluginsDir = process.env.AA_PLUGINS_DIR ?? `${dataDir}/плагины`
const plugins = createPluginRegistry({ dir: pluginsDir, logger: console })
plugins.load()
const bridge = createEmailBridge({ dir: dataDir, index })
const server = createServer({ store, facts, cafo, cafoBaseUrl, dataDir, rag, email, myAddresses, mail, bridge, decisions, drafts, plugins, integrity, priorityOrder })

server.listen(port, '127.0.0.1', () => {
  console.log(`Ассистент архитектора: http://127.0.0.1:${port}`)
  console.log(`Данные: ${dataDir}`)
  console.log(`Конфлюенс: ${cafoBaseUrl || 'не задан (сверка версий недоступна)'}`)
  console.log(`Почта: ${myAddresses.length ? myAddresses.join(', ') : 'адреса не заданы (AA_MY_ADDRESSES)'}; сервер: ${mailCommand || 'не задан (AA_MAIL_CMD)'}`)
  console.log(`Целостность: ${integrity}`)
  console.log(`Плагины: ${pluginsDir} (${plugins.list().length})`)
  console.log(`Индексация писем: ${indexCommand || 'не задана (AA_INDEX_CMD)'}`)
  console.log(`Поиск по знаниям: ${mcpCommand ? `MCP (${mcpCommand})` : ragCommand ? `CLI (${ragCommand})` : 'не задан (AA_MCP_CMD или AA_RAG_CMD)'}`)
})
