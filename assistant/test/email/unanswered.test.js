import test from 'node:test'
import assert from 'node:assert/strict'
import { threadKeyOf, isMine, unansweredFrom } from '../../src/email/model.js'

const me = ['arch@example.com']
const message = over => ({ from: 'analyst@example.com', date: '2026-11-20T09:00:00Z', seen: false, messageId: 'm-1', ...over })

test('цепочка определяется по References, затем по In-Reply-To', () => {
  assert.equal(threadKeyOf({ references: ['root@x'], inReplyTo: 'mid@x' }), 'root@x')
  assert.equal(threadKeyOf({ inReplyTo: 'mid@x' }), 'mid@x')
  assert.equal(threadKeyOf({ messageId: 'only@x' }), 'only@x')
})

test('свои адреса распознаются и в формате «Имя <адрес>»', () => {
  assert.equal(isMine({ from: 'Архитектор <ARCH@example.com>' }, me), true)
  assert.equal(isMine({ from: 'analyst@example.com' }, me), false)
})

test('письмо без ответа попадает в список', () => {
  const result = unansweredFrom([message({})], me)
  assert.equal(result.length, 1)
  assert.equal(result[0].unread, true)
})

test('письмо с ответом после него не считается неотвеченным', () => {
  const result = unansweredFrom([
    message({ messageId: 'm-1', date: '2026-11-20T09:00:00Z' }),
    message({ from: 'arch@example.com', messageId: 'm-2', inReplyTo: 'm-1', date: '2026-11-20T10:00:00Z' })
  ], me)
  assert.equal(result.length, 0)
})

test('ответ до письма не закрывает более позднее', () => {
  const result = unansweredFrom([
    message({ from: 'arch@example.com', messageId: 'm-2', date: '2026-11-20T08:00:00Z' }),
    message({ messageId: 'm-1', references: ['m-2'], date: '2026-11-20T11:00:00Z' })
  ], me)
  assert.equal(result.length, 1)
  assert.equal(result[0].threadId, 'm-2')
})

test('разные цепочки считаются раздельно и сортируются по дате', () => {
  const result = unansweredFrom([
    message({ messageId: 'a', threadKey: 'a', date: '2026-11-19T09:00:00Z' }),
    message({ messageId: 'b', date: '2026-11-21T09:00:00Z' })
  ], me)
  assert.equal(result.length, 2)
  assert.equal(result[0].messageId, 'b')
})

test('отвеченное и прочитанное отличаются по флагу seen', () => {
  const result = unansweredFrom([message({ seen: true })], me)
  assert.equal(result[0].unread, false)
})
