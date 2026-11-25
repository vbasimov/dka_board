import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmailBridge, fileNameOf, toMarkdown } from '../../src/email/bridge.js'

const message = over => ({
  folder: 'INBOX', uid: 40512, from: 'ivanov@company.ru', to: 'arch@example.com', cc: '',
  subject: 'Re: Согласование "Q4"', date: '2026-11-25T14:32:00.000Z', body: 'Нужно закрыть вопросы.', ...over
})

test('письмо превращается в markdown с фронтматтером', () => {
  const md = toMarkdown(message({}))
  assert.match(md, /^---\n/)
  assert.match(md, /source_type: "email"/)
  assert.match(md, /email_uid: "40512"/)
  assert.match(md, /status: "pending"/)
  assert.match(md, /Re: Согласование \\"Q4\\"/)
  assert.match(md, /Нужно закрыть вопросы\./)
})

test('имя файла: дата, папка и uid', () => {
  assert.equal(fileNameOf(message({})), '2026-11-25-inbox-40512.md')
})

test('повторная запись того же письма не перезаписывает файл', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  const bridge = createEmailBridge({ dir })
  const first = await bridge.sync([message({})])
  assert.equal(first.written, 1)
  const second = await bridge.sync([message({})])
  assert.equal(second.skipped, 1)
  assert.equal(readdirSync(first.target).length, 1)
})

test('изменившееся письмо перезаписывается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  const bridge = createEmailBridge({ dir })
  const { target } = await bridge.sync([message({})])
  const result = await bridge.sync([message({ body: 'Обновлённый текст.' })])
  assert.equal(result.written, 1)
  assert.match(readFileSync(join(target, fileNameOf(message({}))), 'utf8'), /Обновлённый текст/)
})

test('индексация вызывается только по запросу', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  let calls = 0
  const bridge = createEmailBridge({ dir, index: async () => { calls += 1 } })
  await bridge.sync([message({})])
  assert.equal(calls, 0)
  const result = await bridge.sync([message({})], { index: true })
  assert.equal(calls, 1)
  assert.equal(result.indexed, true)
})
