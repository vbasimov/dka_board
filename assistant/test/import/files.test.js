import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTaskFiles, createTaskImporter } from '../../src/import/files.js'
import { createStore } from '../../src/store/tasks.js'

test('читает задачи из файлов каталога и сообщает о битых', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'))
  writeFileSync(join(dir, 'a.json'), JSON.stringify([{ title: 'A', source: 'файл' }, { title: 'B', source: 'файл' }]))
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ title: 'C', source: 'файл' }))
  writeFileSync(join(dir, 'bad.json'), '{ не json')
  const result = readTaskFiles(dir)
  assert.equal(result.items.length, 3)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].reason, /JSON/)
})

test('повторный импорт не создаёт дублей по внешнему идентификатору', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'import-store-')))
  const importer = createTaskImporter({ store })
  const items = [{ title: 'A', source: 'jira', sourceRef: 'JIRA-1' }]
  const first = importer.import(items)
  const second = importer.import(items)
  assert.equal(first.created, 1)
  assert.equal(second.created, 0)
  assert.equal(second.duplicate, 1)
  assert.equal(store.count(), 1)
})

test('задачи без источника отклоняются поимённо, импорт продолжается', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'import-store-')))
  const result = createTaskImporter({ store }).import([
    { title: 'без источника' },
    { title: 'нормальная', source: 'файл' }
  ])
  assert.equal(result.created, 1)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /источник/)
})
