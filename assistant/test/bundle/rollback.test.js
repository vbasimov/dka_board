import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReleaseManager } from '../../install/rollback.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'releases-'))
  const releasesDir = join(dir, 'releases')
  mkdirSync(join(releasesDir, '0.1.0'), { recursive: true })
  mkdirSync(join(releasesDir, '0.2.0'), { recursive: true })
  return createReleaseManager({ releasesDir, pointerFile: join(dir, 'current') })
}

test('переключение на версию и откат на предыдущую', () => {
  const manager = setup()
  assert.deepEqual(manager.versions(), ['0.1.0', '0.2.0'])
  manager.activate('0.2.0')
  assert.equal(manager.current(), '0.2.0')
  assert.equal(manager.rollback(), '0.1.0')
  assert.equal(manager.current(), '0.1.0')
})

test('откат с самой первой версии отклоняется понятной ошибкой', () => {
  const manager = setup()
  manager.activate('0.1.0')
  assert.throws(() => manager.rollback(), /предыдущей версии нет/)
})

test('выбор несуществующей версии отклоняется', () => {
  const manager = setup()
  assert.throws(() => manager.activate('9.9.9'), /не найдена/)
})
