import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginRegistry } from '../../src/plugins/registry.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'plugins-'))
}

function createLogger() {
  return {
    logs: [],
    errors: [],
    log(message) {
      this.logs.push(String(message))
    },
    error(message) {
      this.errors.push(String(message))
    }
  }
}

function writePlugin(root, folder, manifest, source) {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }
  if (source !== undefined) writeFileSync(join(dir, 'index.js'), source, 'utf8')
  return dir
}

function manifest(overrides = {}) {
  return {
    name: 'echo',
    version: '1.0.0',
    apiVersion: '1',
    entry: 'index.js',
    commands: [{ id: 'echo', title: 'Эхо' }],
    ...overrides
  }
}

function writeData(dataDir) {
  mkdirSync(join(dataDir, 'задачи'), { recursive: true })
  mkdirSync(join(dataDir, 'факты'), { recursive: true })
  writeFileSync(join(dataDir, 'задачи', '1.json'), JSON.stringify({ id: '1', title: 'Свести требования' }), 'utf8')
  writeFileSync(join(dataDir, 'факты', '1.json'), JSON.stringify({ id: '1', claim: 'Срок — пятница' }), 'utf8')
  writeFileSync(join(dataDir, 'задачи', 'broken.json'), '{не json', 'utf8')
}

const ECHO_SOURCE = `
export default function (api) {
  return {
    commands: {
      echo(payload) {
        api.log('задач: ' + api.readTasks().length)
        return {
          echoed: payload,
          tasks: api.readTasks().map(task => task.title),
          facts: api.readFacts().map(fact => fact.claim),
          surface: Object.keys(api).sort()
        }
      },
      save() {
        return api.writeOwnFile('итог.md', '# Итог')
      },
      escape() {
        return api.writeOwnFile('../escape.txt', 'нельзя')
      }
    }
  }
}
`

test('load собирает валидные плагины, список отдаёт сводку', () => {
  const root = tempRoot()
  writePlugin(root, 'echo', manifest(), ECHO_SOURCE)
  const registry = createPluginRegistry({ dir: root, logger: createLogger() })

  const loaded = registry.load()

  assert.equal(loaded.rejected.length, 0)
  assert.deepEqual(registry.list(), [
    {
      name: 'echo',
      version: '1.0.0',
      apiVersion: '1',
      commands: [{ id: 'echo', title: 'Эхо' }]
    }
  ])
  assert.equal(registry.plugins[0].dir, join(root, 'echo'))
})

test('run вызывает команду плагина и возвращает результат, api даёт чтение и журнал', async () => {
  const root = tempRoot()
  const dataDir = join(root, 'данные')
  writeData(dataDir)
  writePlugin(root, 'echo', manifest(), ECHO_SOURCE)
  const logger = createLogger()
  const registry = createPluginRegistry({ dir: root, dataDir, logger })
  registry.load()

  const result = await registry.run('echo', 'echo', { text: 'привет' })

  assert.deepEqual(result, {
    echoed: { text: 'привет' },
    tasks: ['Свести требования'],
    facts: ['Срок — пятница'],
    surface: ['log', 'readFacts', 'readTasks', 'writeOwnFile']
  })
  assert.ok(logger.logs.some(line => /задач: 1/.test(line)))
})

test('writeOwnFile пишет внутрь папки плагина и не выпускает наружу', async () => {
  const root = tempRoot()
  writePlugin(root, 'echo', manifest(), ECHO_SOURCE)
  const registry = createPluginRegistry({ dir: root, logger: createLogger() })
  registry.load()

  const target = await registry.run('echo', 'save')
  assert.match(String(target), /итог\.md$/)
  assert.equal(readFileSync(join(root, 'echo', 'итог.md'), 'utf8'), '# Итог')

  await assert.rejects(() => registry.run('echo', 'escape'), /внутри папки плагина/)
  assert.equal(existsSync(join(root, 'escape.txt')), false)
})

test('отсутствие папки плагинов — не ошибка', async () => {
  const root = join(tempRoot(), 'нет-такой')
  const logger = createLogger()
  const registry = createPluginRegistry({ dir: root, logger })

  const loaded = registry.load()

  assert.deepEqual(loaded, { plugins: [], rejected: [] })
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.errors.length, 0)
  await assert.rejects(() => registry.run('нет', 'run'), /не найден/)
})

test('невалидный манифест попадает в rejected с причиной, валидный загружается', () => {
  const root = tempRoot()
  writePlugin(root, 'echo', manifest(), ECHO_SOURCE)
  writePlugin(root, 'broken', { name: 'broken', apiVersion: '1', entry: 'index.js' })
  const logger = createLogger()
  const registry = createPluginRegistry({ dir: root, logger })

  const loaded = registry.load()

  assert.deepEqual(loaded.plugins.map(plugin => plugin.name), ['echo'])
  assert.equal(loaded.rejected.length, 1)
  assert.equal(loaded.rejected[0].name, 'broken')
  assert.match(loaded.rejected[0].reason, /version/)
  assert.ok(loaded.rejected[0].errors.length > 0)
  assert.ok(logger.errors.some(line => /broken/.test(line)))
})

test('невалидный JSON манифеста и отсутствие entry не роняют загрузку', () => {
  const root = tempRoot()
  const badDir = join(root, 'bad-json')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(join(badDir, 'manifest.json'), '{не json', 'utf8')
  writePlugin(root, 'no-entry', manifest({ name: 'no-entry', entry: 'missing.js' }))

  const registry = createPluginRegistry({ dir: root, logger: createLogger() })
  const loaded = registry.load()

  assert.equal(loaded.plugins.length, 0)
  assert.equal(loaded.rejected.length, 2)
  assert.match(loaded.rejected.map(item => item.reason).join('\n'), /manifest\.json/)
  assert.match(loaded.rejected.map(item => item.reason).join('\n'), /не найден/)
})

test('падение плагина не ломает реестр и пишется в журнал errors', async () => {
  const root = tempRoot()
  writePlugin(root, 'bad', manifest({ name: 'bad', commands: [{ id: 'boom', title: 'Падение' }] }), `
export default function () {
  return { commands: { boom() { throw new Error('плохо') } } }
}
`)
  writePlugin(root, 'good', manifest({ name: 'good', commands: [{ id: 'ok', title: 'Норма' }] }), `
export default function () {
  return { commands: { ok(payload) { return { ok: payload } } } }
}
`)
  const logger = createLogger()
  const registry = createPluginRegistry({ dir: root, logger })
  registry.load()

  await assert.rejects(() => registry.run('bad', 'boom'), /плохо/)
  assert.equal(registry.errors.length, 1)
  assert.equal(registry.errors[0].plugin, 'bad')
  assert.equal(registry.errors[0].command, 'boom')
  assert.match(registry.errors[0].message, /плохо/)
  assert.ok(logger.errors.some(line => /bad/.test(line)))

  assert.deepEqual(await registry.run('good', 'ok', 7), { ok: 7 })
  assert.deepEqual(await registry.run('good', 'ok', 8), { ok: 8 })
})

test('зависшая команда прерывается по таймауту 2 с, остальные плагины работают', async () => {
  const root = tempRoot()
  writePlugin(root, 'slow', manifest({ name: 'slow', commands: [{ id: 'forever', title: 'Вечность' }] }), `
export default function () {
  return { commands: { forever() { return new Promise(() => {}) } } }
}
`)
  writePlugin(root, 'good', manifest({ name: 'good', commands: [{ id: 'ok', title: 'Норма' }] }), `
export default function () {
  return { commands: { ok() { return 'готово' } } }
}
`)
  const registry = createPluginRegistry({ dir: root, logger: createLogger() })
  registry.load()

  const startedAt = Date.now()
  await assert.rejects(() => registry.run('slow', 'forever'), /не ответил|таймаут/)
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed >= 1900, `таймаут сработал слишком рано: ${elapsed} мс`)
  assert.ok(elapsed < 5000, `таймаут сработал слишком поздно: ${elapsed} мс`)
  assert.equal(registry.errors.length, 1)
  assert.match(registry.errors[0].message, /2000/)
  assert.equal(await registry.run('good', 'ok'), 'готово')
})

test('неизвестный плагин и неизвестная команда отклоняются понятным текстом', async () => {
  const root = tempRoot()
  writePlugin(root, 'echo', manifest(), ECHO_SOURCE)
  const registry = createPluginRegistry({ dir: root, logger: createLogger() })
  registry.load()

  await assert.rejects(() => registry.run('ghost', 'run'), /плагин "ghost" не найден/)
  await assert.rejects(() => registry.run('echo', 'missing'), /нет команды "missing"/)
  await assert.rejects(() => registry.run('echo', ''), /команда/)
})

test('плагин с сетевым импортом не запускается, отказ попадает в errors', async () => {
  const root = tempRoot()
  writePlugin(root, 'net', manifest({ name: 'net', commands: [{ id: 'ping', title: 'Сеть' }] }), `
import http from 'node:http'
export default function () {
  return { commands: { ping() { return http } } }
}
`)
  const registry = createPluginRegistry({ dir: root, logger: createLogger() })
  registry.load()

  await assert.rejects(() => registry.run('net', 'ping'), /сетев/)
  assert.equal(registry.errors.length, 1)
  assert.match(registry.errors[0].message, /сетев/)
})
