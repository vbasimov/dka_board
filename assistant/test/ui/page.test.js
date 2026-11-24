import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8')

test('страница содержит все разделы из макета', () => {
  for (const panel of ['summary', 'today', 'tasks', 'cafo', 'diagrams', 'facts', 'review', 'settings']) {
    assert.match(html, new RegExp(`id="p-${panel}"`), `нет раздела ${panel}`)
  }
})

test('страница не тянет внешние ресурсы', () => {
  assert.doesNotMatch(html, /<script[^>]+src="https?:/)
  assert.doesNotMatch(html, /<link[^>]+href="(https?:)?\/\//)
  assert.doesNotMatch(html, /<img[^>]+src="https?:/)
})

test('модули подключены как type=module, без сборки', () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/)
})

test('на экране «Сегодня» есть короткая обучалка из пяти шагов', () => {
  assert.match(html, /Как начать: пять шагов/)
  const steps = html.split('Как начать: пять шагов')[1].match(/<li>/g) ?? []
  assert.ok(steps.length >= 5, `шагов: ${steps.length}`)
})
