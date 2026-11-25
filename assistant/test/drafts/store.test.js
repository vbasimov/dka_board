import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../../src/drafts/store.js'

const fresh = () => createDraftStore(mkdtempSync(join(tmpdir(), 'drafts-store-')))

const draft = {
  subject: 'Интеграция с антифродом',
  text: 'Коллеги, интеграция описана в КАФО.',
  citations: [{ factId: 'f1', sourceRef: 'page_id=123; version=14' }]
}

test('черновик сохраняется файлом с фронтматтером и источниками', () => {
  const store = fresh()
  const saved = store.save(draft)
  assert.match(saved.name, /\.md$/)
  const text = store.read(saved.name)
  assert.match(text, /source_type: "draft"/)
  assert.match(text, /Коллеги, интеграция описана в КАФО\./)
  assert.match(text, /page_id=123; version=14/)
})

test('повторное сохранение не перезаписывает предыдущий черновик', () => {
  const store = fresh()
  const first = store.save(draft)
  const second = store.save(draft)
  assert.notEqual(first.name, second.name)
  assert.equal(store.list().length, 2)
})

test('пустой черновик не сохраняется', () => {
  assert.throws(() => fresh().save({ text: '   ' }), /пустой черновик/)
})

test('чтение чужого файла отклоняется', () => {
  const store = fresh()
  assert.throws(() => store.read('../secret.md'), /не найден/)
})
