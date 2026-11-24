import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToday, esc } from '../../ui/today.js'

const tasks = [
  { title: 'Согласовать интеграцию', rank: 0, reason: 'эскалация', dueAt: 'сегодня' },
  { title: 'Ответить на запрос', rank: 1, reason: 'срок сегодня' },
  { title: 'Зафиксировать решение', rank: 3, reason: 'есть срок' },
  { title: 'Четвёртая', rank: 4, reason: 'без срока' }
]

test('показывает три числа', () => {
  const html = renderToday({ counts: { today: 4, overdue: 2, notInCafo: 3 }, tasks, feed: [] })
  assert.match(html, />4</)
  assert.match(html, />2</)
  assert.match(html, />3</)
})

test('в «Сделать сегодня» не больше трёх карточек', () => {
  const html = renderToday({ counts: { today: 4, overdue: 2, notInCafo: 3 }, tasks, feed: [] })
  const cards = html.match(/class="card"/g) || []
  assert.equal(cards.length, 3)
  assert.doesNotMatch(html, /Четвёртая/)
})

test('причина приоритета видна на карточке', () => {
  const html = renderToday({ counts: { today: 0, overdue: 0, notInCafo: 0 }, tasks, feed: [] })
  assert.match(html, /эскалация/)
})

test('пустой день даёт понятное сообщение, а не пустой экран', () => {
  const html = renderToday({ counts: { today: 0, overdue: 0, notInCafo: 0 }, tasks: [], feed: [] })
  assert.match(html, /На сегодня дел нет/)
})

test('разметка в тексте задачи экранируется', () => {
  const html = renderToday({
    counts: { today: 1, overdue: 0, notInCafo: 0 },
    tasks: [{ title: '<img src=x onerror=alert(1)>', reason: 'срок' }],
    feed: []
  })
  assert.doesNotMatch(html, /<img/)
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;')
})
