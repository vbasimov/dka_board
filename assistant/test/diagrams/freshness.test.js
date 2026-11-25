import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileDigest } from '../../src/parse/sources.js'
import { attachmentState, diagramState, synonymCandidates } from '../../src/diagrams/freshness.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('fileDigest возвращает sha256 содержимого файла', t => {
  const dir = tempDir(t)
  const file = join(dir, 'схема.drawio')
  const content = '<mxfile><diagram name="Схема"/></mxfile>'
  writeFileSync(file, content, 'utf8')
  const expected = createHash('sha256').update(content, 'utf8').digest('hex')
  assert.equal(fileDigest(file), expected)
  assert.match(fileDigest(file), /^[0-9a-f]{64}$/)
})

test('fileDigest объясняет отсутствие файла по-русски', t => {
  const dir = tempDir(t)
  assert.throws(() => fileDigest(join(dir, 'нет.drawio')), /файл схемы не найден/)
})

test('совпадение хэша — свежо', t => {
  const dir = tempDir(t)
  const file = join(dir, 'схема.drawio')
  writeFileSync(file, '<mxfile/>', 'utf8')
  const digest = fileDigest(file)
  const state = diagramState({ filePath: file, cached: { digest, version: 1 } })
  assert.deepEqual(state, { status: 'свежо', digest, reason: '' })
})

test('изменение файла — устарело, новый хэш отличается от сохранённого', t => {
  const dir = tempDir(t)
  const file = join(dir, 'схема.drawio')
  writeFileSync(file, '<mxfile/>', 'utf8')
  const saved = fileDigest(file)
  writeFileSync(file, '<mxfile><diagram/></mxfile>', 'utf8')
  const state = diagramState({ filePath: file, cached: { digest: saved, version: 1 } })
  assert.equal(state.status, 'устарело')
  assert.notEqual(state.digest, saved)
  assert.equal(state.digest, fileDigest(file))
  assert.match(state.reason, /изменился/)
})

test('отсутствующий файл — не сверено с причиной', t => {
  const dir = tempDir(t)
  const state = diagramState({
    filePath: join(dir, 'пропала.drawio'),
    cached: { digest: 'a'.repeat(64), version: 2 }
  })
  assert.equal(state.status, 'не сверено')
  assert.equal(state.digest, null)
  assert.match(state.reason, /не найден/)
})

test('без сохранённого хэша сверка невозможна — не сверено', t => {
  const dir = tempDir(t)
  const file = join(dir, 'схема.drawio')
  writeFileSync(file, '<mxfile/>', 'utf8')
  const state = diagramState({ filePath: file, cached: { version: 2 } })
  assert.equal(state.status, 'не сверено')
  assert.equal(state.digest, fileDigest(file))
  assert.match(state.reason, /нет сохранённого хэша/)
})

test('версия вложения выросла — устарело', () => {
  const state = attachmentState({ cachedVersion: 3, remoteVersion: 4 })
  assert.equal(state.status, 'устарело')
  assert.match(state.reason, /3/)
  assert.match(state.reason, /4/)
})

test('версия вложения совпала — свежо', () => {
  assert.deepEqual(attachmentState({ cachedVersion: 4, remoteVersion: 4 }), {
    status: 'свежо',
    reason: ''
  })
})

test('версия вложения не получена — не сверено, а не свежо', () => {
  assert.equal(attachmentState({ cachedVersion: 4 }).status, 'не сверено')
  assert.match(attachmentState({ cachedVersion: 4 }).reason, /не получена/)
})

test('синонимы находят варианты «Kafka», «кафка», «Kafka Cluster»', () => {
  const candidates = synonymCandidates(['Kafka', 'кафка', 'Kafka Cluster'])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].key, 'kafka')
  assert.deepEqual(candidates[0].variants, ['Kafka', 'кафка', 'Kafka Cluster'])
})

test('синонимы замечают регистр, пробелы, ё/е и окончания', () => {
  const candidates = synonymCandidates(['Задача', 'задачи', '  ЗАДАЧИ ', 'Платёж', 'Платеж'])
  assert.equal(candidates.length, 2)
  const task = candidates.find(item => item.variants.includes('Задача'))
  assert.deepEqual(task.variants, ['Задача', 'задачи', 'ЗАДАЧИ'])
  const payment = candidates.find(item => item.variants.includes('Платёж'))
  assert.deepEqual(payment.variants, ['Платёж', 'Платеж'])
})

test('похожие подписи остаются только кандидатами и не склеиваются', () => {
  const labels = ['Kafka', 'кафка', 'CRM']
  const candidates = synonymCandidates(labels)
  assert.deepEqual(labels, ['Kafka', 'кафка', 'CRM'])
  assert.equal(candidates.length, 1)
  assert.ok(candidates.every(item => !item.variants.includes('CRM')))
  assert.deepEqual(synonymCandidates(['Kafka']), [])
})

test('пустой список синонимов даёт пустой результат', () => {
  assert.deepEqual(synonymCandidates([]), [])
  assert.deepEqual(synonymCandidates(), [])
  assert.deepEqual(synonymCandidates(['', '   ', null, 42]), [])
})
