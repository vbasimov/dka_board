import test from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest } from '../../src/plugins/contract.js'

const VALID = {
  name: 'review-helper',
  version: '1.2.3',
  apiVersion: '1',
  entry: 'index.js',
  commands: [{ id: 'review', title: 'Недельное ревью' }],
  hooks: ['onStart', 'onTaskCreated']
}

test('валидный манифест принимается целиком', () => {
  const result = validateManifest(VALID)
  assert.equal(result.ok, true)
  assert.deepEqual(result.manifest, VALID)
})

test('в манифесте достаточно обязательных полей', () => {
  const result = validateManifest({ name: 'hello', version: '0.1.0', apiVersion: '1', entry: 'src/index.js' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.manifest, {
    name: 'hello',
    version: '0.1.0',
    apiVersion: '1',
    entry: 'src/index.js',
    commands: [],
    hooks: []
  })
})

test('невалидный манифест возвращает все причины на русском', () => {
  const result = validateManifest({})
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 4)
  assert.ok(result.errors.every(message => /обязательн/.test(message)))
  assert.ok(result.errors.some(message => message.startsWith('name:')))
  assert.ok(result.errors.some(message => message.startsWith('version:')))
  assert.ok(result.errors.some(message => message.startsWith('apiVersion:')))
  assert.ok(result.errors.some(message => message.startsWith('entry:')))
})

test('имя плагина проверяется на kebab-case', () => {
  const result = validateManifest({ ...VALID, name: 'Review_Helper' })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /name:.*kebab-case/)
})

test('версия плагина проверяется как semver', () => {
  for (const version of ['1.0', 'v1.0.0', '1.0.0.0', 1]) {
    const result = validateManifest({ ...VALID, version })
    assert.equal(result.ok, false, `версия ${version} не должна приниматься`)
    assert.match(result.errors.join('\n'), /version:.*semver/)
  }
})

test('поддерживается только строка apiVersion "1"', () => {
  for (const apiVersion of [1, '2', '1.1']) {
    const result = validateManifest({ ...VALID, apiVersion })
    assert.equal(result.ok, false, `apiVersion ${apiVersion} не должен приниматься`)
    assert.match(result.errors.join('\n'), /apiVersion:.*"1"/)
  }
})

test('entry не может выходить за папку плагина', () => {
  for (const entry of ['../secret.js', '/etc/passwd', 'lib/../../secret.js', 'C:\\secret.js', '']) {
    const result = validateManifest({ ...VALID, entry })
    assert.equal(result.ok, false, `entry ${entry} не должен приниматься`)
    assert.match(result.errors.join('\n'), /entry:/)
  }
})

test('commands проверяются по форме {id, title} и не повторяются', () => {
  const noTitle = validateManifest({ ...VALID, commands: [{ id: 'run' }] })
  assert.equal(noTitle.ok, false)
  assert.match(noTitle.errors.join('\n'), /commands\[0\]\.title/)

  const duplicate = validateManifest({
    ...VALID,
    commands: [{ id: 'run', title: 'Запуск' }, { id: 'run', title: 'Ещё запуск' }]
  })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.errors.join('\n'), /commands\[1\]\.id.*повтор/)

  const notArray = validateManifest({ ...VALID, commands: 'run' })
  assert.equal(notArray.ok, false)
  assert.match(notArray.errors.join('\n'), /commands:.*массив/)
})

test('hooks ограничены списком onStart, onTaskCreated, onDraftBuilt', () => {
  const unknown = validateManifest({ ...VALID, hooks: ['onStart', 'onMail'] })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join('\n'), /hooks\[1\].*onMail/)

  const notArray = validateManifest({ ...VALID, hooks: 'onStart' })
  assert.equal(notArray.ok, false)
  assert.match(notArray.errors.join('\n'), /hooks:.*массив/)
})

test('не объект не считается манифестом', () => {
  for (const value of [null, [], 'manifest', 42]) {
    const result = validateManifest(value)
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /объектом/)
  }
})
