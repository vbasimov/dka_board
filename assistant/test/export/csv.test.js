import test from 'node:test'
import assert from 'node:assert/strict'
import { tasksToCsv, factsToMarkdown } from '../../src/export/csv.js'

test('CSV содержит заголовок и строки задач', () => {
  const csv = tasksToCsv([{ id: 't1', title: 'Согласовать интеграцию', source: 'письмо', dueAt: '2026-11-25', status: 'новая', createdAt: '2026-11-24T09:00:00Z' }])
  assert.match(csv, /^id,title,source,dueAt,status,createdAt\n/)
  assert.match(csv, /t1,Согласовать интеграцию,письмо,2026-11-25,новая/)
})

test('запятые и кавычки экранируются', () => {
  const csv = tasksToCsv([{ id: 't2', title: 'A, B "C"', source: 'письмо' }])
  assert.match(csv, /"A, B ""C"""/)
})

test('пустой список даёт только заголовок', () => {
  assert.equal(tasksToCsv([]).trim().split('\n').length, 1)
})

test('факты выгружаются в markdown-таблицу', () => {
  const md = factsToMarkdown([{ claim: 'Платежи в Kafka', fo: 'Платежи', status: 'подтверждён', sourceRef: 'page_id=1' }])
  assert.match(md, /source_type: "export"/)
  assert.match(md, /\| Платежи в Kafka \| Платежи \| подтверждён \| page_id=1 \|/)
})

test('вертикальная черта в тексте не ломает таблицу', () => {
  const md = factsToMarkdown([{ claim: 'A | B', fo: 'x', status: 'y', sourceRef: 'z' }])
  assert.match(md, /A \\\| B/)
})
