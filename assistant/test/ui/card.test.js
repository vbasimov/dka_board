import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCard } from '../../ui/card.js'

const task = { id: 't1', title: 'Нужна интеграция к релизу', source: 'антифрод', dueAt: 'сегодня', owner: 'архитектор ФО Риски', escalation: true }

test('без выбранного запроса — пустое состояние с одним действием', () => {
  const html = renderCard({})
  assert.match(html, /Карточка не выбрана/)
  const buttons = html.match(/<button/g) || []
  assert.equal(buttons.length, 1)
  assert.match(html, /data-goto="summary"/)
})

test('карточка показывает метаданные запроса и причину приоритета', () => {
  const html = renderCard({ task, cafoItems: [], factItems: [] })
  assert.match(html, /антифрод/)
  assert.match(html, /срок сегодня/)
  assert.match(html, /архитектор ФО Риски/)
  assert.match(html, /эскалация/)
})

test('устаревший источник КАФО показан бейджем с текстом рядом с версией', () => {
  const html = renderCard({
    task,
    cafoItems: [{ pageId: 'p1', title: 'Платежи', version: 14, status: 'устарело', checkedAt: '2026-11-25T09:00:00Z' }],
    factItems: []
  })
  assert.match(html, /badge warn">устарело/)
  assert.match(html, /версия 14/)
  assert.match(html, /class="banner/)
})

test('подтверждённые факты формируют черновик ответа, иначе честное сообщение', () => {
  const withFacts = renderCard({
    task,
    cafoItems: [],
    factItems: [{ id: 'f1', claim: 'Событие передаётся в Kafka', status: 'подтверждён', sourceRef: 'v12' }]
  })
  assert.match(withFacts, /class="draft"/)
  assert.match(withFacts, /Событие передаётся в Kafka/)

  const withoutFacts = renderCard({ task, cafoItems: [], factItems: [] })
  assert.match(withoutFacts, /Подтверждённых фактов пока нет/)
})

test('недостоверный факт помечен бейджем bad, а не только цветом', () => {
  const html = renderCard({
    task,
    cafoItems: [],
    factItems: [{ id: 'f2', claim: 'Факт под вопросом', status: 'недостоверен', sourceRef: 'протокол' }]
  })
  assert.match(html, /badge bad">недостоверен/)
})

test('отправка только вручную — дисклеймер виден на карточке', () => {
  const html = renderCard({ task, cafoItems: [], factItems: [] })
  assert.match(html, /Эта программа писем не отправляет/)
})

test('содержимое запроса и источников экранируется', () => {
  const html = renderCard({
    task: { ...task, title: '<img src=x onerror=1>' },
    cafoItems: [{ pageId: 'p1', title: '<b>Платежи</b>', version: 1, status: 'свежо' }],
    factItems: [{ id: 'f3', claim: '<script>alert(1)</script>', status: 'подтверждён', sourceRef: 'x' }]
  })
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /<b>Платежи/)
  assert.doesNotMatch(html, /<script>alert/)
})

test('на карточке есть отложить со следующим шагом', () => {
  const html = renderCard({ task: { id: 't1', title: 'Разобрать схему' }, cafoItems: [], factItems: [] })
  assert.match(html, /data-action="park"/)
  assert.match(html, /id="next-step"/)
  assert.match(html, /На чём остановились/)
})
