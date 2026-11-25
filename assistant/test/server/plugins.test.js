import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createPluginRegistry } from '../../src/plugins/registry.js'
import { createServer } from '../../src/server/app.js'

function makePluginDir() {
  const dir = mkdtempSync(join(tmpdir(), 'plugins-'))
  const plugin = join(dir, 'demo')
  mkdirSync(plugin)
  writeFileSync(join(plugin, 'manifest.json'), JSON.stringify({
    name: 'demo', version: '1.0.0', apiVersion: '1', entry: 'index.js', commands: [{ id: 'hello', title: 'Привет' }]
  }))
  writeFileSync(join(plugin, 'index.js'), `export default function(api) { return { commands: { hello: payload => ({ ok: true, payload }) } } }\n`)
  return dir
}

test('плагин загружается и команда выполняется через API', async () => {
  const dir = makePluginDir()
  const registry = createPluginRegistry({ dir, dataDir: mkdtempSync(join(tmpdir(), 'plugin-data-')) })
  registry.load()
  const server = createServer({ store: createStore(mkdtempSync(join(tmpdir(), 'store-'))), plugins: registry })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/api/plugins`)).json()
    assert.equal(list.plugins[0].name, 'demo')

    const response = await fetch(`http://127.0.0.1:${port}/api/plugins/demo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'hello', payload: { a: 1 } })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.result.ok, true)
  } finally {
    server.close()
  }
})

test('неизвестный плагин даёт понятную ошибку', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugins-empty-'))
  const registry = createPluginRegistry({ dir, dataDir: mkdtempSync(join(tmpdir(), 'plugin-data-')) })
  const server = createServer({ store: createStore(mkdtempSync(join(tmpdir(), 'store-'))), plugins: registry })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/plugins/none/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'x' })
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.match(body.error, /не найден/)
  } finally {
    server.close()
  }
})
