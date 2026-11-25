import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTasks, renderCafo, renderFacts, renderReview, renderComparison } from '../../ui/lists.js'

test('список задач показывает источник, срок и состояние', () => {
  const html = renderTasks([{ title: 'Согласовать интеграцию', source: 'письмо', dueAt: 'сегодня', status: 'в работе' }])
  assert.match(html, /Согласовать интеграцию/)
  assert.match(html, /письмо/)
  assert.match(html, /сегодня/)
  assert.match(html, /в работе/)
})

test('пустой список задач объясняет, что делать, одним действием', () => {
  const html = renderTasks([])
  assert.match(html, /Добавьте задачу/)
  const buttons = html.match(/<button/g) || []
  assert.equal(buttons.length, 1)
})

test('пустое КАФО объясняет, что делать', () => {
  assert.match(renderCafo([]), /Сверить версии/)
})

test('КАФО: строки получают data-status для фильтра «только устаревшие»', () => {
  const html = renderCafo([
    { pageId: 'p1', title: 'Платежи', version: 14, status: 'устарело', checkedAt: '2026-11-25T00:00:00Z' },
    { pageId: 'p2', title: 'Расчёты', version: 8, status: 'свежо', checkedAt: '2026-11-25T00:00:00Z' },
    { pageId: 'p3', title: 'Биллинг', version: 11, status: 'не_сверено' }
  ])
  assert.match(html, /id="cafo-filter"/)
  assert.match(html, /Только устаревшие/)
  assert.match(html, /<tr data-status="warn"/)
  assert.match(html, /<tr data-status="ok"/)
  assert.match(html, /<tr data-status="bad"/)
  assert.match(html, /Показано 3 из 3/)
  assert.match(html, /badge warn">устарело/)
  assert.match(html, /badge bad">не_сверено/)
})

test('каждая строка КАФО имеет видимую кнопку «Обновить»', () => {
  const html = renderCafo([{ pageId: 'p1', title: 'Платежи', version: 14, status: 'устарело' }])
  assert.match(html, /data-refresh data-page-id="p1">Обновить/)
})

test('ревью разбирает markdown на блоки «что произошло» / «что не учли» и дисклеймер', () => {
  const markdown = [
    '# Ревью недели, 2026-11-25',
    '',
    '## Что произошло',
    '— Пять запросов на обоснование',
    '',
    '## Что не учли',
    '— Решение по очереди событий висит 4 дня',
    '',
    'Отчёт — подсказка программы и требует проверки человеком.'
  ].join('\n')
  const html = renderReview(markdown)
  assert.match(html, /Что произошло/)
  assert.match(html, /Пять запросов на обоснование/)
  assert.match(html, /Что не учли/)
  assert.match(html, /Решение по очереди событий висит 4 дня/)
  assert.match(html, /class="banner">Отчёт — подсказка программы/)
})

test('без отчёта — понятное пустое состояние с действием собрать ревью', () => {
  const html = renderReview('')
  assert.match(html, /Отчёт не собран/)
  assert.match(html, /data-action="build-review"/)
})

test('расхождения схем группируются в три списка, третий — нейтральный "требует взгляда"', () => {
  const html = renderComparison({
    onlyInDiagram: [{ from: 'Расчёты', to: 'Биллинг' }],
    onlyInCafo: [],
    needsEyes: [{ id: '9', reason: 'у ребра <b>нет</b> конца' }]
  })
  assert.match(html, /class="cols3"/)
  assert.match(html, /Расчёты → Биллинг/)
  assert.match(html, /Есть в схеме, нет в КАФО/)
  assert.match(html, /Есть в КАФО, нет в схеме/)
  assert.match(html, /col look-closer/)
  assert.match(html, /Требует вашего взгляда/)
  assert.doesNotMatch(html, /<b>нет<\/b>/)
})

test('без сравнения — пустое состояние с подсказкой', () => {
  assert.match(renderComparison(null), /Сравнение пока не выполнено/)
})

test('у факта видна двусторонняя связь версий', () => {
  const html = renderFacts([
    { claim: 'Новая формулировка', fo: 'Платежи', status: 'подтверждён', sourceRef: 'v5', supersedes: 'f1' },
    { claim: 'Старая формулировка', fo: 'Платежи', status: 'заменён', sourceRef: 'v4', supersededBy: 'f2' }
  ])
  assert.match(html, /заменил f1/)
  assert.match(html, /заменён на f2/)
})
