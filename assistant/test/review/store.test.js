import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewStore } from '../../src/review/store.js'

test('правка отчёта сохраняется и находится как последняя', () => {
  const store = createReviewStore(mkdtempSync(join(tmpdir(), 'review-store-')))
  const saved = store.save('# Ревью\n\nмоя правка')
  assert.match(saved.name, /правка\.md$/)
  const latest = store.latest()
  assert.equal(latest.name, saved.name)
  assert.match(latest.content, /моя правка/)
})

test('пустой отчёт не сохраняется', () => {
  const store = createReviewStore(mkdtempSync(join(tmpdir(), 'review-store-')))
  assert.throws(() => store.save('   '), /пустой отчёт/)
})

test('если отчётов нет, latest возвращает null', () => {
  assert.equal(createReviewStore(mkdtempSync(join(tmpdir(), 'review-store-'))).latest(), null)
})
