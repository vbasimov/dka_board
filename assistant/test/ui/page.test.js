import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../ui/index.html', import.meta.url), 'utf8')

test('страница содержит все разделы из макета', () => {
  for (const panel of ['today', 'tasks', 'cafo', 'diagrams', 'facts', 'review', 'settings']) {
    assert.match(html, new RegExp(`id="p-${panel}"`), `нет раздела ${panel}`)
  }
})

test('страница не тянет внешние ресурсы', () => {
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /<link[^>]+href="\/\//)
})

test('модули подключены как type=module, без сборки', () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/)
})
