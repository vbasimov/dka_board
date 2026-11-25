import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSearch } from '../../ui/search.js'

test('результаты поиска показывают заголовок, тип и фрагмент', () => {
  const html = renderSearch({ query: 'Kafka', items: [{ id: '1', title: 'КАФО: Платежи', sourceType: 'md', score: 0.912, snippet: 'События в Kafka' }] })
  assert.match(html, /КАФО: Платежи/)
  assert.match(html, /События в Kafka/)
  assert.match(html, /0\.91/)
})

test('пустой результат объясняет, что искать дальше', () => {
  assert.match(renderSearch({ query: 'нет такого' }), /Ничего не найдено/)
})

test('без запроса показывается подсказка', () => {
  assert.match(renderSearch({}), /Введите запрос/)
})

test('ошибка поиска выводится человеческим текстом и экранируется', () => {
  const html = renderSearch({ query: 'x', error: 'поиск не подключён <b>' })
  assert.match(html, /поиск не подключён/)
  assert.doesNotMatch(html, /<b>/)
})

test('во время поиска показывается состояние загрузки', () => {
  assert.match(renderSearch({ loading: true }), /Ищу…/)
})
