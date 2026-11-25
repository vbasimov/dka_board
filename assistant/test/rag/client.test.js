import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRagClient, normalizeItem } from '../../src/rag/client.js'

function fakeScript(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rag-'))
  const path = join(dir, 'sbm-search')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test('разбирает ответ поиска и нормализует поля', async () => {
  const command = fakeScript('echo \'[{"pageId":"42","title":"КАФО: Платежи","snippet":"Kafka","score":0.91,"source_type":"md","path":"/kb/platezhi.md"}]\'')
  const client = createRagClient({ command })
  const items = await client.search('Kafka')
  assert.equal(items.length, 1)
  assert.deepEqual(items[0], {
    id: '42', title: 'КАФО: Платежи', snippet: 'Kafka', score: 0.91, sourceType: 'md', path: '/kb/platezhi.md'
  })
})

test('пустой запрос отклоняется без запуска команды', async () => {
  const client = createRagClient({ command: '/nonexistent/sbm-search' })
  await assert.rejects(() => client.search('   '), /пустой поисковый запрос/)
})

test('ошибка поиска превращается в понятный текст', async () => {
  const command = fakeScript('echo "индекс не собран" >&2; exit 3')
  const client = createRagClient({ command })
  await assert.rejects(() => client.search('Kafka'), /поиск завершился с ошибкой/)
})

test('нечитаемый ответ не выдаётся за результат', async () => {
  const command = fakeScript('echo "не json"')
  const client = createRagClient({ command })
  await assert.rejects(() => client.search('Kafka'), /не удалось разобрать/)
})

test('нормализация терпит пустые поля', () => {
  assert.deepEqual(normalizeItem({}), { id: '', title: '', snippet: '', score: 0, sourceType: '', path: '' })
})
