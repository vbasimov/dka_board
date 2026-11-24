import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEmail } from '../../src/domain/email.js'

const now = new Date('2026-11-24T10:00:00+03:00')

test('находит срок «сегодня» и эскалацию', () => {
  const result = parseEmail('От: Антифрод\nТема: Интеграция к релизу\nНужен ответ сегодня, пишу повторно.', { now })
  assert.equal(result.dueAt, 'сегодня')
  assert.equal(result.escalation, true)
  assert.equal(result.sender, 'Антифрод')
  assert.equal(result.title, 'Интеграция к релизу')
})

test('не выдумывает срок, если его нет', () => {
  const result = parseEmail('Тема: Как устроены расчёты\nРасскажите, пожалуйста, подробнее.', { now })
  assert.equal(result.dueAt, null)
  assert.equal(result.escalation, false)
  assert.equal(result.fromManager, false)
})

test('понимает «завтра»', () => {
  const result = parseEmail('Тема: Ответ\nПришлите, пожалуйста, завтра.', { now })
  assert.equal(result.dueAt, 'завтра')
})

test('понимает дату «до 30.11»', () => {
  const result = parseEmail('Тема: Срок\nНужно до 30.11, иначе не успеем.', { now })
  assert.equal(result.dueAt, '2026-11-30')
})

test('распознаёт поручение руководителя', () => {
  const result = parseEmail('Тема: Поручение\nЭто поручение руководителя, прошу приоритет.', { now })
  assert.equal(result.fromManager, true)
})

test('письмо без темы берёт первую содержательную строку', () => {
  const result = parseEmail('Коллеги, добрый день.\nВопрос по интеграции.', { now })
  assert.match(result.title, /Коллеги/)
})
