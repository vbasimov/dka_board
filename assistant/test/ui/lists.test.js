import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTasks, renderCafo, renderFacts, renderReview, renderComparison } from '../../ui/lists.js'

test('список задач показывает источник и состояние', () => {
  const html = renderTasks([{ title: 'Согласовать интеграцию', source: 'письмо', dueAt: 'сегодня', status: 'в работе' }])
  assert.match(html, /Согласовать интеграцию/)
  assert.match(html, /письмо/)
  assert.match(html, /сегодня/)
})

test('пустые списки объясняют, что делать', () => {
  assert.match(renderTasks([]), /Добавьте задачу/)
  assert.match(renderCafo([]), /Сверить версии/)
  assert.match(renderFacts([]), /Факты появляются/)
})

test('КАФО показывает состояние свежести', () => {
  const html = renderCafo([{ title: 'КАФО: Платежи', version: 14, status: 'устарело', checkedAt: '2026-11-24T09:00:00Z' }])
  assert.match(html, /устарело/)
  assert.match(html, /14/)
})

test('ревью выводится как текст, а не как разметка', () => {
  const html = renderReview('# Ревью\n— факт')
  assert.match(html, /<pre class="draft">/)
  assert.match(html, /# Ревью/)
})

test('расхождения схем группируются в три списка и экранируются', () => {
  const html = renderComparison({
    onlyInDiagram: [{ from: 'Расчёты', to: 'Биллинг' }],
    onlyInCafo: [],
    needsEyes: [{ id: '9', reason: 'у ребра <b>нет</b> конца' }]
  })
  assert.match(html, /Расчёты → Биллинг/)
  assert.match(html, /Требует взгляда/)
  assert.doesNotMatch(html, /<b>нет<\/b>/)
})
