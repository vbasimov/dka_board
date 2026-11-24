import { createServer as httpCreateServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareTasks, dueDate, rank, reasonOf, todayKey } from '../domain/priority.js'
import { fetchMeta } from '../cafo/freshness.js'

function send(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  response.end(payload)
}

const UI_DIR = fileURLToPath(new URL('../../ui/', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  const target = join(UI_DIR, relative)
  if (!target.startsWith(UI_DIR) || !existsSync(target)) return false
  const body = readFileSync(target)
  response.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store'
  })
  response.end(body)
  return true
}

function readJson(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('слишком большой запрос'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('некорректный JSON в запросе'))
      }
    })
    request.on('error', reject)
  })
}

export function createApp({ store, facts, cafo, cafoBaseUrl }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const isWrite = request.method === 'POST'
    if (request.method !== 'GET' && !isWrite) {
      send(response, 405, { error: 'метод не поддерживается' })
      return
    }
    if (!url.pathname.startsWith('/api/') && serveStatic(response, url.pathname)) return
    if (url.pathname === '/api/tasks') {
      const query = url.searchParams.get('q') ?? ''
      send(response, 200, { items: store.search(query), total: store.count() })
      return
    }
    if (url.pathname === '/api/state') {
      const now = new Date()
      const today = todayKey(now)
      const ranked = store
        .all()
        .filter(task => task.status !== 'закрыта')
        .map(task => ({ ...task, rank: rank(task, now), reason: reasonOf(task, now) }))
        .sort((a, b) => compareTasks(a, b, now))
      const counts = {
        today: ranked.filter(task => task.rank <= 1).length,
        overdue: ranked.filter(task => {
          const due = dueDate(task, now)
          return Boolean(due) && due < today
        }).length,
        notInCafo: 0
      }
      send(response, 200, { counts, tasks: ranked.slice(0, 3), feed: [] })
      return
    }
    if (url.pathname === '/api/facts') {
      if (!facts) {
        send(response, 200, { items: [] })
        return
      }
      const mode = url.searchParams.get('mode')
      send(response, 200, { items: mode === 'answer' ? facts.answerable() : facts.all() })
      return
    }
    if (url.pathname.startsWith('/api/facts/') && url.pathname.endsWith('/confirm') && isWrite) {
      if (!facts) {
        send(response, 404, { error: 'реестр фактов не подключён' })
        return
      }
      const id = url.pathname.split('/')[3]
      try {
        const body = await readJson(request)
        const fact = facts.confirm(id, body.by)
        send(response, 200, { fact })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/cafo') {
      send(response, 200, { items: cafo ? cafo.list() : [] })
      return
    }
    if (url.pathname === '/api/cafo/sync' && isWrite) {
      if (!cafo) {
        send(response, 404, { error: 'кэш КАФО не подключён' })
        return
      }
      try {
        const results = await cafo.syncAll(pageId => fetchMeta(pageId, { baseUrl: cafoBaseUrl }))
        send(response, 200, { results })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/health') {
      send(response, 200, { ok: true, tasks: store.count() })
      return
    }
    send(response, 404, { error: 'не найдено' })
  }
}

export function createServer({ store, facts, cafo, cafoBaseUrl, host = '127.0.0.1' }) {
  const server = httpCreateServer(createApp({ store, facts, cafo, cafoBaseUrl }))
  server.host = host
  return server
}
