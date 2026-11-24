import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshnessOf, STATUS } from './freshness.js'

const CACHE_DIR = 'кэш-кафо'

export function createCafoCache(dir) {
  const root = join(dir, CACHE_DIR)
  mkdirSync(root, { recursive: true })
  const metas = new Map()

  for (const entry of readdirSync(root)) {
    const metaPath = join(root, entry, 'meta.json')
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      metas.set(meta.pageId, meta)
    } catch {
      // страница без метаданных не участвует в сверке
    }
  }

  function saveMeta(meta) {
    const pageDir = join(root, meta.pageId)
    mkdirSync(pageDir, { recursive: true })
    const target = join(pageDir, 'meta.json')
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(meta, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  return {
    put({ pageId, title, spaceKey, version, body, url }) {
      if (!pageId) throw new Error('pageId обязателен')
      const now = new Date().toISOString()
      const meta = {
        pageId,
        title: title ?? '',
        spaceKey: spaceKey ?? '',
        version: Number(version),
        url: url ?? '',
        fetchedAt: now,
        checkedAt: now,
        status: STATUS.FRESH
      }
      const pageDir = join(root, pageId)
      mkdirSync(pageDir, { recursive: true })
      writeFileSync(join(pageDir, `page-${meta.version}.md`), String(body ?? ''), 'utf8')
      saveMeta(meta)
      metas.set(pageId, meta)
      return meta
    },

    get(pageId) {
      const meta = metas.get(pageId)
      if (!meta) return null
      const body = readFileSync(join(root, pageId, `page-${meta.version}.md`), 'utf8')
      return { meta, body }
    },

    list() {
      return [...metas.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    },

    async sync(pageId, fetchMeta) {
      const meta = metas.get(pageId)
      if (!meta) throw new Error(`страница ${pageId} отсутствует в кэше`)
      const remote = await fetchMeta(pageId)
      const result = freshnessOf(meta, remote)
      const updated = {
        ...meta,
        status: result.status,
        checkedAt: remote ? new Date().toISOString() : meta.checkedAt
      }
      saveMeta(updated)
      metas.set(pageId, updated)
      return { ...result, meta: updated }
    },

    async syncAll(fetchMeta) {
      const results = []
      for (const meta of metas.values()) {
        results.push({ pageId: meta.pageId, ...(await this.sync(meta.pageId, fetchMeta)) })
      }
      return results
    }
  }
}
