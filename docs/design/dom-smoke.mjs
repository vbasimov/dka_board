// Проверка интерфейса без браузера: поднимает index.html в jsdom, подменяет fetch фикстурами
// и проверяет, что все блоки отрисовались без ошибок исполнения.
// Требует разово: npm i jsdom (в проект не добавляется).
// Запуск: node docs/design/dom-smoke.mjs

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const html = readFileSync('/home/dsh/projects/assistant/ui/index.html', 'utf8')
const dom = new JSDOM(html, { url: 'http://127.0.0.1:7797/', pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.CustomEvent = dom.window.CustomEvent


const fixtures = {
  '/api/onepager': {
    cafo: [
      { pageId: '1', title: 'КАФО: Платежи', version: 14, status: 'устарело', checkedAt: '2026-11-25T09:00:00Z' },
      { pageId: '2', title: 'КАФО: Расчёты', version: 8, status: 'свежо', checkedAt: '2026-11-25T09:00:00Z' }
    ],
    unanswered: [{ id: 't1', title: 'Интеграция к релизу', reason: 'эскалация', source: 'письмо' }],
    burning: [{ id: 't2', title: 'Согласовать антифрод', reason: 'срок сегодня', dueAt: '2026-11-25' }],
    resume: [{ id: 't3', title: 'Разбор схемы', nextStep: 'сверить связи' }],
    counts: { cafo: 2, cafoStale: 1, cafoUnchecked: 0, unanswered: 1, burning: 1, resume: 1 }
  },
  '/api/state': { counts: { today: 2, overdue: 1, notInCafo: 1 }, tasks: [{ title: 'Согласовать антифрод', reason: 'срок сегодня' }], feed: ['Обновилась КАФО «Платежи»'] },
  '/api/tasks': { items: [{ id: 't1', title: 'Интеграция к релизу', source: 'письмо', dueAt: '2026-11-25', status: 'новая' }] },
  '/api/cafo': { items: [{ pageId: '1', title: 'КАФО: Платежи', version: 14, status: 'устарело' }] },
  '/api/facts': { items: [{ id: 'f1', claim: 'Платежи передают события в Kafka', fo: 'Платежи', status: 'подтверждён', sourceRef: 'page_id=1; version=14' }] },
  '/api/quiz': { items: [{ id: 'f1', claim: 'Платежи передают события в Kafka', sourceType: 'КАФО', sourceRef: 'page_id=1; version=14' }] },
  '/api/config': { 'папка данных': '/tmp/data', 'адрес Confluence': 'не задан' }
}

globalThis.fetch = async url => {
  const path = String(url).replace('http://127.0.0.1:7797', '')
  const body = fixtures[path]
  return {
    ok: Boolean(body),
    status: body ? 200 : 404,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {})
  }
}

const errors = []
process.on('unhandledRejection', error => errors.push(String(error)))

await import('file:///home/dsh/projects/assistant/ui/app.js')
await new Promise(resolve => setTimeout(resolve, 300))

const text = sel => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ')
const checks = {
  'сводка: счётная полоса': /сегодня|просрочено/i.test(text('#summary')),
  'сводка: горящие сроки': /Согласовать антифрод/.test(text('#summary')),
  'сводка: КАФО-статус': /Платежи/.test(text('#summary')),
  'сводка: продолжить': /сверить связи/.test(text('#summary')),
  'квиз: карточка': /Kafka/.test(text('#quiz')),
  'квиз: три действия': document.querySelectorAll('#quiz [data-verdict]').length >= 3,
  'кафо: таблица': /14/.test(text('#cafo')),
  'задачи: строка': /Интеграция к релизу/.test(text('#tasks')),
  'настройки: значения': /tmp\/data|не задан/.test(text('#settings'))
}
let failed = 0
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`)
  if (!ok) failed++
}
console.log('ошибок исполнения:', errors.length, errors.slice(0, 2).join('; '))
process.exit(failed || errors.length ? 1 : 0)
