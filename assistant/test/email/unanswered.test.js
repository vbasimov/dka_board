import test from 'node:test'
import assert from 'node:assert/strict'
import { threadKeyOf, isMine, isSeen, messageKey, unansweredFrom } from '../../src/email/model.js'

const me = ['arch@example.com']
const message = over => ({ folder: 'INBOX', uid: 1, from: 'analyst@example.com', subject: 'Интеграция', date: '2026-11-20T09:00:00Z', flags: [], ...over })

test('цепочка строится по заголовкам, если они есть', () => {
  assert.equal(threadKeyOf({ references: ['root@x'], inReplyTo: 'mid@x' }), 'ref:root@x')
  assert.equal(threadKeyOf({ inReplyTo: 'mid@x' }), 'ref:mid@x')
})

test('без заголовков цепочка строится по теме без префиксов ответа', () => {
  assert.equal(threadKeyOf({ subject: 'Re: Интеграция' }), 'subject:интеграция')
  assert.equal(threadKeyOf({ subject: 'RE: FWD: Интеграция' }), 'subject:интеграция')
  assert.equal(threadKeyOf({ subject: 'Ответ: Интеграция' }), 'subject:интеграция')
  assert.equal(threadKeyOf({ subject: 'Интеграция' }), 'subject:интеграция')
})

test('свои адреса распознаются и в формате «Имя <адрес>»', () => {
  assert.equal(isMine({ from: 'Архитектор <ARCH@example.com>' }, me), true)
  assert.equal(isMine({ from: 'analyst@example.com' }, me), false)
})

test('непрочитанность берётся из флагов IMAP, затем из поля seen', () => {
  assert.equal(isSeen({ flags: ['\\Seen'] }), true)
  assert.equal(isSeen({ flags: ['\\Flagged'] }), false)
  assert.equal(isSeen({ seen: true }), true)
})

test('письмо без ответа попадает в список с пометкой способа группировки', () => {
  const result = unansweredFrom([message({})], me)
  assert.equal(result.length, 1)
  assert.equal(result[0].unread, true)
  assert.equal(result[0].threadBy, 'тема')
})

test('письмо с ответом после него не считается неотвеченным', () => {
  const result = unansweredFrom([
    message({ uid: 1, subject: 'Интеграция', date: '2026-11-20T09:00:00Z' }),
    message({ uid: 2, from: 'arch@example.com', subject: 'Re: Интеграция', date: '2026-11-20T10:00:00Z' })
  ], me)
  assert.equal(result.length, 0)
})

test('ответ до письма не закрывает более позднее', () => {
  const result = unansweredFrom([
    message({ uid: 2, from: 'arch@example.com', subject: 'Интеграция', date: '2026-11-20T08:00:00Z' }),
    message({ uid: 1, subject: 'Re: Интеграция', date: '2026-11-20T11:00:00Z' })
  ], me)
  assert.equal(result.length, 1)
  assert.equal(result[0].threadId, 'subject:интеграция')
})

test('разные темы — разные цепочки, сортировка по дате', () => {
  const result = unansweredFrom([
    message({ uid: 1, subject: 'Интеграция', date: '2026-11-19T09:00:00Z' }),
    message({ uid: 2, subject: 'Схемы', date: '2026-11-21T09:00:00Z' })
  ], me)
  assert.equal(result.length, 2)
  assert.equal(result[0].subject, 'Схемы')
})

test('ключ письма строится по папке и uid, затем по seq', () => {
  assert.equal(messageKey({ folder: 'INBOX', uid: 42 }), 'INBOX:uid:42')
  assert.equal(messageKey({ folder: 'INBOX', seq: 7 }), 'INBOX:seq:7')
})
