import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOnepager } from '../../ui/onepager.js'

test('сводка содержит три блока: КАФО, неотвеченные сообщения, горящие сроки', () => {
  const html = renderOnepager({
    cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }],
    unanswered: [{ title: 'Интеграция к релизу', reason: 'эскалация' }],
    burning: [{ title: 'Согласовать антифрод', reason: 'срок сегодня' }],
    counts: { cafo: 1, cafoStale: 1, unanswered: 1, burning: 1 }
  })
  assert.match(html, /Статусы КАФО/)
  assert.match(html, /Неотвеченные сообщения/)
  assert.match(html, /Горящие сроки сегодня/)
  assert.match(html, /КАФО: Платежи/)
  assert.match(html, /Интеграция к релизу/)
  assert.match(html, /Согласовать антифрод/)
})

test('устаревшая страница получает предупреждающую метку', () => {
  const html = renderOnepager({ cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }] })
  assert.match(html, /badge warn/)
  assert.match(html, /устарело/)
})

test('пустые блоки объясняют, что делать', () => {
  const html = renderOnepager({})
  assert.match(html, /Страниц в кэше нет/)
  assert.match(html, /Неотвеченных сообщений нет/)
  assert.match(html, /Горящих сроков на сегодня нет/)
})

test('содержимое блоков экранируется', () => {
  const html = renderOnepager({ burning: [{ title: '<script>alert(1)</script>' }] })
  assert.doesNotMatch(html, /<script>/)
})

test('блок «Продолжить» показывает незавершённое дело и сохранённый шаг', () => {
  const html = renderOnepager({ resume: [{ title: 'Согласовать интеграцию', nextStep: 'написать в антифрод' }] })
  assert.match(html, /Продолжить/)
  assert.match(html, /написать в антифрод/)
})

test('без незавершённых дел блок объясняет, что возвращаться не к чему', () => {
  assert.match(renderOnepager({}), /Незавершённых дел с сохранённым шагом нет/)
})
