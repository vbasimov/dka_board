import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCafoCache } from '../../src/cafo/cache.js'

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cafo-'))
  return { dir, cache: createCafoCache(dir) }
}

const page = {
  pageId: '123',
  title: 'КАФО: Платежи',
  spaceKey: 'ARCH',
  version: 12,
  body: '# Платежи\n\nСервис передаёт события в Kafka.',
  url: 'https://confluence.internal/pages/viewpage.action?pageId=123'
}

test('кэш хранит страницу с версией и телом', () => {
  const { cache } = fresh()
  cache.put(page)
  const cached = cache.get('123')
  assert.equal(cached.meta.version, 12)
  assert.match(cached.body, /Kafka/)
  assert.equal(cached.meta.status, 'свежо')
})

test('совпадение версий подтверждает свежесть и обновляет дату проверки', async () => {
  const { cache } = fresh()
  cache.put(page)
  const result = await cache.sync('123', async () => ({ version: 12 }))
  assert.equal(result.status, 'свежо')
  assert.ok(result.meta.checkedAt)
})

test('рост версии даёт «устарело» с числом правок, тело остаётся прежним до перекачки', async () => {
  const { cache } = fresh()
  cache.put(page)
  const result = await cache.sync('123', async () => ({ version: 14 }))
  assert.equal(result.status, 'устарело')
  assert.equal(result.diff, 2)
  assert.equal(cache.get('123').meta.version, 12)
})

test('недоступный источник даёт «не сверено» и не меняет версию', async () => {
  const { cache } = fresh()
  cache.put(page)
  const result = await cache.sync('123', async () => null)
  assert.equal(result.status, 'не_сверено')
  assert.equal(result.meta.version, 12)
})

test('состояние сохраняется между запусками', async () => {
  const { dir, cache } = fresh()
  cache.put(page)
  await cache.sync('123', async () => ({ version: 14 }))
  const reopened = createCafoCache(dir)
  assert.equal(reopened.list()[0].status, 'устарело')
})

test('в метаданных хранятся предки страницы', () => {
  const { cache } = fresh()
  cache.put({ ...page, ancestors: ['КАФО', 'Трайб B2C'] })
  assert.deepEqual(cache.get('123').meta.ancestors, ['КАФО', 'Трайб B2C'])
})

test('при росте версии страница перекачивается и кэш обновляется', async () => {
  const { cache } = fresh()
  cache.put(page)
  let fetched = 0
  const result = await cache.sync(
    '123',
    async () => ({ version: 15 }),
    async () => {
      fetched += 1
      return { version: 15, title: 'КАФО: Платежи и возвраты', spaceKey: 'ARCH', body: 'новое тело', ancestors: ['КАФО'] }
    }
  )
  assert.equal(fetched, 1)
  assert.equal(result.refreshed, true)
  assert.equal(result.meta.version, 15)
  assert.match(cache.get('123').body, /новое тело/)
  assert.equal(cache.list().length, 1)
})

test('переименование страницы не создаёт вторую запись', async () => {
  const { cache } = fresh()
  cache.put(page)
  await cache.sync('123', async () => ({ version: 13 }), async () => ({ version: 13, title: 'Платежи (новая область)', body: 'x' }))
  const items = cache.list()
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Платежи (новая область)')
  assert.equal(items[0].pageId, '123')
})

test('если перекачка не удалась, остаётся статус «устарело»', async () => {
  const { cache } = fresh()
  cache.put(page)
  const result = await cache.sync('123', async () => ({ version: 15 }), async () => null)
  assert.equal(result.status, 'устарело')
  assert.equal(result.refreshed, undefined)
  assert.equal(cache.get('123').meta.version, 12)
})
