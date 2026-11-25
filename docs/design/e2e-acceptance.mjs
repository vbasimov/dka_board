// Приёмочный прогон собранного архива: распаковка, запуск, данные через API,
// загрузка интерфейса в jsdom и проверка экранов на настоящем сервере.
// Требует разово: npm i jsdom. Запуск: node docs/design/e2e-acceptance.mjs

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const archive = '/home/dsh/projects/assistant/dist/architect-assistant.zip'
const root = mkdtempSync(join(tmpdir(), 'accept-'))
execFile('unzip', ['-q', archive, '-d', root])

const port = 7850 + Math.floor(Math.random() * 40)
const dataDir = join(root, 'data')
const server = spawn('node', ['bin/serve.js'], {
  cwd: root,
  env: { ...process.env, AA_DATA: dataDir, AA_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
server.stdout.on('data', chunk => { log += chunk })
server.stderr.on('data', chunk => { log += chunk })

const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 50; i++) {
  try {
    const response = await fetch(`${base}/api/health`)
    if (response.ok) break
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 100))
}

const today = new Date().toISOString().slice(0, 10)

const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const created = await (await post('/api/tasks', { title: 'Согласовать интеграцию с антифродом', source: 'письмо', dueAt: today, escalation: true })).json()
await post('/api/decisions', { title: 'Платежи в Kafka', source: 'протокол' })
await post('/api/drafts/save', { subject: 'Ответ антифроду', text: 'Интеграция описана в КАФО.', citations: [{ factId: 'f1', sourceRef: 'page_id=1; version=14' }] })

const html = readFileSync(join(root, 'ui', 'index.html'), 'utf8')
const dom = new JSDOM(html, { url: `${base}/`, pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.CustomEvent = dom.window.CustomEvent
const realFetch = globalThis.fetch
globalThis.fetch = (url, options) => realFetch(String(url).startsWith('http') ? url : `${base}${url}`, options)

const errors = []
process.on('unhandledRejection', error => errors.push(String(error)))

await import(`${root}/ui/app.js`)
await new Promise(resolve => setTimeout(resolve, 700))

const text = selector => (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ')
const checks = {
  'health: integrity ok': (await (await realFetch(`${base}/api/health`)).json()).integrity === 'ok',
  'сводка: горящий срок виден': /Согласовать интеграцию с антифродом/.test(text('#summary')),
  'решения: долг виден': /Платежи в Kafka/.test(text('#decisions')),
  'задачи: строка есть': /Согласовать интеграцию/.test(text('#tasks')),
  'шаблоны: API отдаёт 12': (await (await realFetch(`${base}/api/templates`)).json()).items.length === 12,
  'экспорт задач: CSV': (await (await realFetch(`${base}/api/export/tasks.csv`)).text()).startsWith('id,title'),
  'ошибок исполнения нет': errors.length === 0
}

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
console.log('СЛОВО:', created.created)
console.log('ЛОГ:', log.split('\n').slice(0, 4).join(' | '))
server.kill()
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
