import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManifest, verifyManifest, sha256 } from '../../src/bundle/integrity.js'

function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'index.html'), '<h1>ok</h1>')
  writeFileSync(join(dir, 'ui', 'app.js'), 'export const a = 1')
  return dir
}

test('манифест собирается по всем файлам, кроме себя', () => {
  const dir = bundle()
  const manifest = buildManifest(dir, { version: '1.0.0' })
  assert.equal(manifest.version, '1.0.0')
  assert.deepEqual(manifest.files.map(f => f.path), ['index.html', 'ui/app.js'])
})

test('неизменённый набор проходит проверку', () => {
  const dir = bundle()
  const manifest = buildManifest(dir)
  const result = verifyManifest(dir, manifest)
  assert.equal(result.ok, true)
  assert.equal(result.checked, 2)
})

test('подмена файла обнаруживается', () => {
  const dir = bundle()
  const manifest = buildManifest(dir)
  writeFileSync(join(dir, 'index.html'), '<h1>взлом</h1>')
  const result = verifyManifest(dir, manifest)
  assert.equal(result.ok, false)
  assert.deepEqual(result.modified, ['index.html'])
})

test('удалённый файл обнаруживается отдельно от подмены', () => {
  const dir = bundle()
  const manifest = buildManifest(dir)
  rmSync(join(dir, 'ui', 'app.js'))
  const result = verifyManifest(dir, manifest)
  assert.deepEqual(result.missing, ['ui/app.js'])
  assert.deepEqual(result.modified, [])
})

test('хэш считается по содержимому, а не по имени', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
