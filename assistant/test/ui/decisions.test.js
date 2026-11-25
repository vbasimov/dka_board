import test from 'node:test'
import assert from 'node:assert/strict'
import { renderDecisions } from '../../ui/decisions.js'

test('таблица решений показывает состояние и действие для долга', () => {
  const html = renderDecisions({ items: [
    { id: 'd1', title: 'Платежи в Kafka', decidedAt: '2026-11-20', source: 'протокол', inCafo: false },
    { id: 'd2', title: 'Журналы — год', decidedAt: '2026-11-24', source: 'письмо', inCafo: true }
  ] })
  assert.match(html, /Платежи в Kafka/)
  assert.match(html, /долг/)
  assert.match(html, /в КАФО/)
  assert.match(html, /data-action="decision-cafo" data-id="d1"/)
  assert.match(html, /Долгов перед КАФО: 1/)
})

test('пустой журнал объясняет, что делать', () => {
  const html = renderDecisions({ items: [] })
  assert.match(html, /Решений пока нет/)
  assert.match(html, /Зафиксировать/)
})

test('значения экранируются', () => {
  const html = renderDecisions({ items: [{ id: 'x', title: '<img onerror=1>', decidedAt: '2026-01-01', source: 'a', inCafo: false }] })
  assert.doesNotMatch(html, /<img/)
})
