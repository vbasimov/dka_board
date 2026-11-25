import test from 'node:test'
import assert from 'node:assert/strict'
import { parseListMessages, parseMessage } from '../../src/email/parse.js'

const listSample = `📦 Объём всей папки (47 писем): 12.3 MB (12902400 Б)

● #0001 2026-11-25 14:32  ivanov@company.ru  Re: Согласование архитектуры Q4
    Нужно закрыть вопросы по статусу инкремента
  #0002 2026-11-25 11:15  petrov@company.ru  План митинга по переводу
● #0003 2026-11-24 18:47  system@company.ru  [System] Уведомление о деплое`

const messageSample = `📧 От: ivanov@company.ru
   Кому: user@company.ru
   Дата: 2026-11-25T14:32:00.000Z
   Тема: Re: Согласование архитектуры Q4
   Seq: 1 | UID: 40512 | Flags: \\Seen, \\Flagged
─── Текст письма ───
Привет,

Нужно закрыть вопросы по статусу инкремента ФО.09.01.

С уважением,
Иванов`

test('список писем разбирается на seq, дату, отправителя и тему', () => {
  const items = parseListMessages(listSample)
  assert.equal(items.length, 3)
  assert.deepEqual(items[0], {
    unread: true, seq: 1, date: '2026-11-25T14:32', from: 'ivanov@company.ru', subject: 'Re: Согласование архитектуры Q4'
  })
  assert.equal(items[1].unread, false)
  assert.equal(items[2].seq, 3)
})

test('письмо разбирается на заголовки, uid, флаги и тело', () => {
  const message = parseMessage(messageSample)
  assert.equal(message.from, 'ivanov@company.ru')
  assert.equal(message.to, 'user@company.ru')
  assert.equal(message.subject, 'Re: Согласование архитектуры Q4')
  assert.equal(message.seq, 1)
  assert.equal(message.uid, 40512)
  assert.deepEqual(message.flags, ['\\Seen', '\\Flagged'])
  assert.match(message.body, /ФО\.09\.01/)
})

test('пустой или частичный ответ не ломает разбор', () => {
  assert.deepEqual(parseListMessages(''), [])
  const message = parseMessage('📧 От: a@b\n─── Текст письма ───\nтело')
  assert.equal(message.from, 'a@b')
  assert.equal(message.uid, null)
  assert.equal(message.body, 'тело')
})
