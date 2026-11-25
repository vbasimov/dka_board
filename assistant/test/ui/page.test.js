import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const uiDir = fileURLToPath(new URL('../../ui/', import.meta.url))
const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8')

test('страница содержит все разделы макета v2', () => {
  for (const panel of ['summary', 'today', 'quiz', 'card', 'search', 'decisions', 'cafo', 'diagrams', 'tasks', 'review', 'settings']) {
    assert.match(html, new RegExp(`id="p-${panel}"`), `нет раздела ${panel}`)
  }
})

test('навигация содержит кнопку на каждый раздел с текстом на русском', () => {
  for (const [p, label] of [
    ['summary', 'Сводка'],
    ['today', 'Сегодня'],
    ['quiz', 'Проверка фактов'],
    ['card', 'Карточка запроса'],
    ['cafo', 'КАФО'],
    ['diagrams', 'Схемы'],
    ['tasks', 'Задачи'],
    ['review', 'Ревью'],
    ['settings', 'Настройки']
  ]) {
    assert.match(html, new RegExp(`data-p="${p}"[^>]*>${label}`))
  }
})

test('страница не тянет внешние ресурсы', () => {
  assert.doesNotMatch(html, /<script[^>]+src="https?:/)
  assert.doesNotMatch(html, /<link[^>]+href="(https?:)?\/\//)
  assert.doesNotMatch(html, /<img[^>]+src="https?:/)
})

test('ни один файл ui не содержит внешних сетевых адресов или @import', () => {
  const files = readdirSync(uiDir).filter(name => /\.(html|css|js)$/.test(name))
  assert.ok(files.length > 0)
  for (const file of files) {
    const content = readFileSync(`${uiDir}${file}`, 'utf8')
    const addresses = content.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
    const outside = addresses.filter(address => !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(address))
    assert.deepEqual(outside, [], `внешний адрес в ${file}`)
    assert.doesNotMatch(content, /\/\/cdn/i, `cdn в ${file}`)
    assert.doesNotMatch(content, /@import/, `@import в ${file}`)
  }
})

test('модуль подключён как type=module, без сборки', () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/)
})

test('первый экран показывает скелетон без ожидания данных', () => {
  const summarySection = html.split('id="p-summary"')[1].split('id="p-today"')[0]
  assert.match(summarySection, /class="skeleton/)
})

test('в интерфейсе нет эмодзи в разметке навигации', () => {
  const nav = html.split('<nav')[1].split('</nav>')[0]
  assert.doesNotMatch(nav, /[\u{1F300}-\u{1FAFF}☀-➿]/u)
})

test('на сводке есть обучалка «Как начать» с шагами почты', () => {
  assert.match(html, /Как начать/)
  const block = html.split('Как начать')[1] ?? ''
  assert.ok((block.match(/<li>/g) ?? []).length >= 6)
  assert.match(block, /Обновить почту/)
})
