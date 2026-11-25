import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installRelease } from '../../install/update.js'
import { buildManifest } from '../../src/bundle/integrity.js'

function makeRelease() {
  const dir = mkdtempSync(join(tmpdir(), 'release-src-'))
  writeFileSync(join(dir, 'index.html'), '<h1>ok</h1>')
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui', 'app.js'), 'export const a = 1')
  const manifest = buildManifest(dir, { version: '0.3.0' })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

test('установка распаковывает версию, проверяет целостность и активирует', async () => {
  const { dir } = makeRelease()
  const root = mkdtempSync(join(tmpdir(), 'releases-'))
  const releasesDir = join(root, 'releases')
  const pointerFile = join(root, 'current')

  writeFileSync(join(root, 'fake.zip'), 'not a zip')
  const second = await installRelease({
    archivePath: join(root, 'fake.zip'),
    releasesDir,
    pointerFile,
    readVersion: async () => ({ version: '0.3.0', manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) }),
    extract: async (_archive, target) => cpSync(dir, target, { recursive: true })
  })
  assert.equal(second.ok, true)
  assert.equal(second.version, '0.3.0')
  assert.equal(readFileSync(pointerFile, 'utf8').trim(), '0.3.0')
})

test('если файлы повреждены, версия не активируется', async () => {
  const { dir } = makeRelease()
  const root = mkdtempSync(join(tmpdir(), 'releases-'))
  const releasesDir = join(root, 'releases')
  const pointerFile = join(root, 'current')
  writeFileSync(join(root, 'fake.zip'), 'not a zip')

  const result = await installRelease({
    archivePath: join(root, 'fake.zip'),
    releasesDir,
    pointerFile,
    readVersion: async () => ({ version: '0.3.0', manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) }),
    extract: async (_archive, target) => {
      cpSync(dir, target, { recursive: true })
      writeFileSync(join(target, 'index.html'), '<h1>взлом</h1>')
    }
  })

  assert.equal(result.ok, false)
  assert.match(result.reason, /целостность/)
  assert.equal(existsSyncSafe(pointerFile), false)
})

function existsSyncSafe(path) {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}
