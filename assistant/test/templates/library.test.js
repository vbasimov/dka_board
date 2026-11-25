import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATES,
  listTemplates,
  getTemplate,
  fillTemplate,
  validateTemplates
} from '../../src/templates/library.js'

test('в библиотеке ровно 12 шаблонов с обязательными полями', () => {
  assert.equal(TEMPLATES.length, 12)

  const ids = new Set()
  for (const template of TEMPLATES) {
    assert.match(template.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `id не в kebab-case: ${template.id}`)
    assert.equal(ids.has(template.id), false, `id повторяется: ${template.id}`)
    ids.add(template.id)

    for (const field of ['id', 'title', 'when', 'body']) {
      assert.equal(typeof template[field], 'string', `поле ${field} должно быть строкой`)
      assert.ok(template[field].trim(), `поле ${field} не должно быть пустым`)
    }

    assert.doesNotMatch(template.when, /[\r\n]/, 'when должен быть одной строкой')
    assert.match(template.body, /\{\{[a-z]+\}\}/, 'в теле должна быть хотя бы одна подстановка')
  }

  assert.deepEqual([...ids].sort(), listTemplates().map(item => item.id).sort())
})

test('listTemplates возвращает только id, title и when, без тел', () => {
  const list = listTemplates()
  assert.equal(list.length, 12)

  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'title', 'when'])
    assert.equal('body' in item, false)
  }
})

test('fillTemplate заменяет известные подстановки и не считает их пропущенными', () => {
  const values = {
    request: 'согласовать обмен заказами',
    decision: 'использовать очередь событий',
    found: 'сервис заказов уже публикует события',
    source: 'page_id=42; version=7',
    deadline: '1 декабря'
  }
  const { text, missing } = fillTemplate('decision-rationale', values)

  assert.deepEqual(missing, [])
  for (const value of Object.values(values)) {
    assert.ok(text.includes(value), `в тексте нет значения ${value}`)
  }
  assert.doesNotMatch(text, /\{\{(request|decision|found|source|deadline)\}\}/)
})

test('неизвестные подстановки остаются видимыми и попадают в missing', () => {
  const { text, missing } = fillTemplate('deadline-shift', { request: 'перенести поставку' })

  assert.ok(text.includes('перенести поставку'))
  assert.doesNotMatch(text, /\{\{request\}\}/)

  for (const key of ['deadline', 'newDeadline', 'reason', 'found', 'action', 'source']) {
    assert.ok(text.includes(`{{${key}}}`), `подстановка {{${key}}} должна остаться видимой`)
    assert.ok(missing.includes(key), `ключ ${key} должен быть в missing`)
  }

  assert.equal(missing.includes('request'), false)
  assert.equal(new Set(missing).size, missing.length, 'missing не должен содержать повторов')
})

test('пустое значение считается незаполненным и не подставляется', () => {
  const { text, missing } = fillTemplate('data-request', { request: '   ', data: 'выгрузка заказов' })

  assert.ok(text.includes('{{request}}'))
  assert.ok(missing.includes('request'))
  assert.ok(missing.includes('deadline'))
  assert.equal(missing.includes('data'), false)
})

test('getTemplate возвращает шаблон и выбрасывает ошибку на несуществующий id', () => {
  assert.equal(getTemplate('diagram-request').id, 'diagram-request')
  assert.throws(() => getTemplate('нет-такого-шаблона'), /шаблон .* не найден/)
  assert.throws(() => getTemplate(''), /шаблон .* не найден/)
})

test('validateTemplates проходит без ошибок', () => {
  assert.deepEqual(validateTemplates(), { ok: true, errors: [] })
})

test('значения вставляются как текст и не экранируются', () => {
  const raw = '<script>alert("x")</script> & "кавычки"'
  const { text, missing } = fillTemplate('data-request', {
    request: raw,
    data: 'выгрузка заказов',
    deadline: 'пятница',
    source: 'КАФО'
  })

  assert.deepEqual(missing, [])
  assert.ok(text.includes(raw))
  assert.doesNotMatch(text, /&lt;|&gt;|&amp;|&quot;/)
})
