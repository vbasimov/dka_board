import test from 'node:test'
import assert from 'node:assert/strict'
import { renderOnepager } from '../../ui/onepager.js'

test('счётная полоса показывает четыре числа крупнее подписей', () => {
  const html = renderOnepager({ counts: { today: 4, overdue: 2, notInCafo: 3, toCheck: 6 } })
  assert.match(html, /class="statbar"/)
  const stats = html.match(/<div class="stat[^"]*"><b>(\d+)<\/b>/g) || []
  assert.equal(stats.length, 4)
  assert.match(html, />4</)
  assert.match(html, />2</)
  assert.match(html, />3</)
  assert.match(html, />6</)
})

test('сводка содержит три колонки: КАФО, неотвеченные сообщения, горящие сроки', () => {
  const html = renderOnepager({
    cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }],
    unanswered: [{ id: 't1', title: 'Интеграция к релизу', reason: 'эскалация' }],
    burning: [{ title: 'Согласовать антифрод', reason: 'срок сегодня', dueAt: '18:00' }],
    counts: { cafo: 1, cafoStale: 1, unanswered: 1, burning: 1 }
  })
  assert.match(html, /class="cols3"/)
  assert.match(html, /Статусы КАФО/)
  assert.match(html, /Неотвеченные сообщения/)
  assert.match(html, /Горящие сроки сегодня/)
  assert.match(html, /КАФО: Платежи/)
  assert.match(html, /Интеграция к релизу/)
  assert.match(html, /Согласовать антифрод/)
})

test('порядок колонок соответствует макету: КАФО, неотвеченные, горящие сроки', () => {
  const html = renderOnepager({
    cafo: [{ title: 'Платежи', version: 1, status: 'свежо' }],
    unanswered: [{ title: 'Письмо A' }],
    burning: [{ title: 'Срок B' }]
  })
  const posCafo = html.indexOf('Статусы КАФО')
  const posUnanswered = html.indexOf('Неотвеченные сообщения')
  const posBurning = html.indexOf('Горящие сроки сегодня')
  assert.ok(posCafo < posUnanswered)
  assert.ok(posUnanswered < posBurning)
})

test('устаревшая страница КАФО получает текстовый бейдж, а не только цвет', () => {
  const html = renderOnepager({ cafo: [{ title: 'КАФО: Платежи', version: 14, status: 'устарело' }] })
  assert.match(html, /badge warn">устарело/)
})

test('кнопка «Ответить» у неотвеченного сообщения ведёт к карточке запроса', () => {
  const html = renderOnepager({ unanswered: [{ id: 'task-1', title: 'Письмо' }] })
  assert.match(html, /data-goto="card" data-id="task-1">Ответить/)
})

test('не больше семи строк в колонке, остаток — через «показать все»', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ title: `Страница ${i}`, version: i, status: 'свежо' }))
  const html = renderOnepager({ cafo: many })
  const lines = html.match(/line-title/g) || []
  assert.equal(lines.length, 7)
  assert.match(html, /Показать все 9/)
})

test('пустые блоки объясняют, что делать, одним действием', () => {
  const html = renderOnepager({})
  assert.match(html, /Укажите папку с выгрузкой и сверьте версии/)
  assert.match(html, /Неотвеченных сообщений нет/)
  assert.match(html, /Горящих сроков нет/)
})

test('содержимое блоков экранируется', () => {
  const html = renderOnepager({ burning: [{ title: '<script>alert(1)</script>' }] })
  assert.doesNotMatch(html, /<script>/)
})

test('блок «Продолжить» показывает незавершённое дело и сохранённый следующий шаг', () => {
  const html = renderOnepager({ resume: [{ id: 'task-9', title: 'Согласовать интеграцию', nextStep: 'написать в антифрод' }] })
  assert.match(html, /Продолжить/)
  assert.match(html, /написать в антифрод/)
  assert.match(html, /data-goto="card" data-id="task-9">Вернуться/)
})

test('без незавершённых дел блок честно объясняет, что возвращаться не к чему', () => {
  assert.match(renderOnepager({}), /Незавершённых дел с сохранённым шагом нет/)
})

test('на сводке есть кнопки почты и индекса', () => {
  const html = renderOnepager({})
  assert.match(html, /data-action="mail-sync"/)
  assert.match(html, /data-action="mail-bridge"/)
  assert.match(html, /Обновить почту/)
  assert.match(html, /Отправить письма в индекс/)
})

test('подсказка состояния почты присутствует и объявлена для скринридера', () => {
  const html = renderOnepager({})
  assert.match(html, /id="mail-hint"/)
  assert.match(html, /role="status"/)
})

test('у письма видно, что цепочка собрана по теме', () => {
  const html = renderOnepager({ unanswered: [{ id: 'm1', title: 'Re: Интеграция', reason: 'от a@b', threadBy: 'тема' }] })
  assert.match(html, /цепочка по теме/)
})
