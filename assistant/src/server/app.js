import { createServer as httpCreateServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareTasks, dueDate, rank, reasonOf, todayKey } from '../domain/priority.js'
import { fetchMeta } from '../cafo/freshness.js'
import { buildDraft } from '../drafts/build.js'
import { parseDrawio } from '../parse/drawio.js'
import { compareIntegrations } from '../diagrams/compare.js'
import { loadDiagram } from '../parse/sources.js'
import { buildReview } from '../review/build.js'
import { unansweredFrom } from '../email/model.js'

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

export function createApp({ store, facts, cafo, cafoBaseUrl, dataDir, rag, email, myAddresses = [], mail, bridge, decisions, drafts, plugins, integrity = 'нет манифеста' }) {
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
        notInCafo: decisions ? decisions.debts().length : 0
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
    if (url.pathname === '/api/tasks' && isWrite) {
      try {
        const body = await readJson(request)
        const result = store.add(body)
        send(response, 200, result)
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/park') && isWrite) {
      try {
        const id = url.pathname.split('/')[3]
        const body = await readJson(request)
        send(response, 200, { task: store.park(id, body.nextStep) })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
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
    if (url.pathname === '/api/quiz') {
      send(response, 200, { items: facts ? facts.quiz().slice(0, 10) : [] })
      return
    }
    if (url.pathname === '/api/quiz/answer' && isWrite) {
      if (!facts) {
        send(response, 404, { error: 'реестр фактов не подключён' })
        return
      }
      try {
        const body = await readJson(request)
        const verdict = String(body.verdict ?? '')
        const id = String(body.id ?? '')
        if (!id) throw new Error('не передан идентификатор факта')
        if (verdict === 'confirm') send(response, 200, { fact: facts.confirm(id, body.by) })
        else if (verdict === 'unreliable') send(response, 200, { fact: facts.markUnreliable(id, body.by) })
        else if (verdict === 'skip') send(response, 200, { fact: facts.skip(id) })
        else throw new Error('вердикт должен быть: confirm, unreliable или skip')
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
    if (url.pathname === '/api/drafts/build' && isWrite) {
      try {
        const body = await readJson(request)
        const sourceStatus = {}
        for (const meta of cafo ? cafo.list() : []) {
          sourceStatus[`page_id=${meta.pageId}; version=${meta.version}`] = meta.status
        }
        let ragItems = []
        if (body.ragQuery && rag) {
          try {
            ragItems = await rag.search(body.ragQuery, { limit: 5 })
          } catch {
            ragItems = []
          }
        }
        const draft = buildDraft({
          subject: body.subject,
          request: body.request,
          facts: facts ? facts.all() : [],
          sourceStatus,
          ragItems
        })
        send(response, 200, { draft })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/diagrams/compare' && isWrite) {
      try {
        const body = await readJson(request)
        let xml = String(body.xml ?? '')
        if (!xml && body.path) {
          const loaded = await loadDiagram({ path: String(body.path) })
          if (loaded.unsupported) {
            send(response, 200, { unsupported: true, reason: loaded.reason })
            return
          }
          xml = loaded.xml
        }
        if (!xml.includes('<mxfile')) throw new Error('ожидается файл draw.io (mxfile)')
        const [diagram] = parseDrawio(xml).diagrams
        if (!diagram) throw new Error('в файле не найдено ни одной схемы')
        send(response, 200, { diagram: diagram.name, result: compareIntegrations({ diagram, cafo: body.cafo ?? [] }) })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/review/build' && isWrite) {
      try {
        const body = await readJson(request)
        const review = buildReview({
          tasks: store.all(),
          facts: facts ? facts.all() : [],
          cafo: cafo ? cafo.list() : [],
          diagramDiffs: body.diagramDiffs ?? []
        })
        let savedTo = null
        if (dataDir) {
          const reportsDir = join(dataDir, 'отчёты')
          mkdirSync(reportsDir, { recursive: true })
          savedTo = join(reportsDir, `ревью-${new Date().toISOString().slice(0, 10)}.md`)
          writeFileSync(savedTo, review.markdown, 'utf8')
        }
        send(response, 200, { ...review, savedTo })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/onepager') {
      const now = new Date()
      const today = todayKey(now)
      const open = store.all().filter(task => task.status !== 'закрыта')
      const burning = open
        .filter(task => {
          const due = dueDate(task, now)
          return Boolean(due) && due <= today
        })
        .map(task => ({ ...task, rank: rank(task, now), reason: reasonOf(task, now) }))
        .sort((a, b) => compareTasks(a, b, now))
      const fromEmail = email ? unansweredFrom(email.all(), myAddresses) : []
      const unanswered = fromEmail.length
        ? fromEmail.map(message => ({
            id: message.id,
            title: message.subject ?? '(без темы)',
            reason: message.unread ? `от ${message.from}: не прочитано` : `от ${message.from}`,
            source: 'письмо',
            threadBy: message.threadBy,
            dueAt: null
          }))
        : open.filter(task => task.source === 'письмо' && task.answered !== true)
        .map(task => ({ ...task, rank: rank(task, now), reason: reasonOf(task, now) }))
        .sort((a, b) => compareTasks(a, b, now))
      const pages = cafo ? cafo.list() : []
      const resume = store.parked().map(task => ({ ...task, rank: rank(task, now), reason: reasonOf(task, now) }))
      send(response, 200, {
        cafo: pages,
        unanswered,
        burning,
        resume,
        counts: {
          cafo: pages.length,
          cafoStale: pages.filter(meta => meta.status === 'устарело').length,
          cafoUnchecked: pages.filter(meta => meta.status === 'не_сверено').length,
          unanswered: unanswered.length,
          burning: burning.length,
          resume: resume.length,
          notInCafo: decisions ? decisions.debts().length : 0
        }
      })
      return
    }
    if (url.pathname === '/api/rag/search') {
      if (!rag) {
        send(response, 503, { error: 'поиск по знаниям не подключён: задайте путь к sbm-search' })
        return
      }
      try {
        const query = url.searchParams.get('q') ?? ''
        const items = await rag.search(query, {
          limit: Number(url.searchParams.get('limit') ?? 8),
          mode: url.searchParams.get('mode') ?? undefined,
          sourceType: url.searchParams.get('sourceType') ?? undefined,
          status: url.searchParams.get('status') ?? undefined
        })
        send(response, 200, { query, items })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/drafts/save' && isWrite) {
      if (!drafts) {
        send(response, 503, { error: 'хранилище черновиков не подключено' })
        return
      }
      try {
        const body = await readJson(request)
        const saved = drafts.save({
          subject: body.subject,
          text: body.text,
          citations: body.citations
        })
        let decision = null
        if (decisions) {
          decision = decisions.add({
            title: saved.subject,
            source: 'черновик',
            sourceRef: saved.name,
            rationale: String(body.text ?? '').slice(0, 240)
          })
        }
        send(response, 200, { draft: saved, decision })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/drafts/saved' && !isWrite) {
      send(response, 200, { items: drafts ? drafts.list() : [] })
      return
    }
    if (url.pathname.startsWith('/api/drafts/saved/')) {
      if (!drafts) {
        send(response, 503, { error: 'хранилище черновиков не подключено' })
        return
      }
      try {
        const name = decodeURIComponent(url.pathname.replace('/api/drafts/saved/', ''))
        send(response, 200, { name, content: drafts.read(name) })
      } catch (error) {
        send(response, 404, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/decisions' && !isWrite) {
      if (!decisions) {
        send(response, 200, { items: [] })
        return
      }
      const onlyDebts = url.searchParams.get('debts') === '1'
      send(response, 200, { items: onlyDebts ? decisions.debts() : decisions.all(), debts: decisions.debts().length })
      return
    }
    if (url.pathname === '/api/decisions' && isWrite) {
      if (!decisions) {
        send(response, 503, { error: 'журнал решений не подключён' })
        return
      }
      try {
        const body = await readJson(request)
        send(response, 200, { decision: decisions.add(body) })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname.startsWith('/api/decisions/') && url.pathname.endsWith('/cafo') && isWrite) {
      if (!decisions) {
        send(response, 503, { error: 'журнал решений не подключён' })
        return
      }
      try {
        const id = url.pathname.split('/')[3]
        const body = await readJson(request)
        send(response, 200, { decision: decisions.markInCafo(id, body.cafoPageId) })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/email/messages' && isWrite) {
      if (!email) {
        send(response, 503, { error: 'хранилище писем не подключено' })
        return
      }
      try {
        const body = await readJson(request)
        const incoming = Array.isArray(body.messages) ? body.messages : []
        let created = 0
        for (const message of incoming) {
          if (email.add(message).created) created += 1
        }
        send(response, 200, { accepted: incoming.length, created, total: email.count() })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/email/sync' && isWrite) {
      if (!mail || !email) {
        send(response, 503, { error: 'почтовый сервер не подключён: задайте путь к mcp-email' })
        return
      }
      try {
        const body = await readJson(request)
        const result = await mail.fetch({
          mailbox: body.folder ?? 'INBOX',
          limit: Number(body.limit ?? 20),
          read: Number(body.read ?? 10)
        })
        let created = 0
        for (const message of result.messages) {
          if (email.add(message).created) created += 1
        }
        send(response, 200, { listed: result.listed.length, read: result.messages.length, created, total: email.count() })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/email/bridge' && isWrite) {
      if (!bridge || !email) {
        send(response, 503, { error: 'мост в индекс не подключён' })
        return
      }
      try {
        const body = await readJson(request)
        let messages = email.all()
        if (body.fetch === true && mail) {
          const fetched = await mail.fetch({ mailbox: body.folder ?? 'INBOX', limit: Number(body.limit ?? 20), read: Number(body.read ?? 10) })
          for (const message of fetched.messages) email.add(message)
          messages = fetched.messages.length ? fetched.messages : messages
        }
        const result = await bridge.sync(messages, { index: body.index === true })
        send(response, 200, result)
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/email/unanswered') {
      if (!email) {
        send(response, 200, { items: [] })
        return
      }
      const list = unansweredFrom(email.all(), myAddresses)
      send(response, 200, {
        items: list.map(message => ({
          id: message.id,
          title: message.subject ?? '(без темы)',
          from: message.from ?? '',
          date: message.date ?? '',
          unread: message.unread === true,
          threadId: message.threadId
        })),
        total: list.length
      })
      return
    }
    if (url.pathname === '/api/plugins' && !isWrite) {
      send(response, 200, plugins ? { plugins: plugins.list(), rejected: plugins.rejected ?? [] } : { plugins: [], rejected: [] })
      return
    }
    if (url.pathname.startsWith('/api/plugins/') && url.pathname.endsWith('/run') && isWrite) {
      if (!plugins) {
        send(response, 503, { error: 'плагины не подключены' })
        return
      }
      try {
        const name = url.pathname.split('/')[3]
        const body = await readJson(request)
        const result = await plugins.run(name, String(body.command ?? ''), body.payload ?? {})
        send(response, 200, { result })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return
    }
    if (url.pathname === '/api/config') {
      send(response, 200, {
        'папка данных': dataDir ?? 'не задана',
        'адрес Confluence': cafoBaseUrl || 'не задан',
        'режим': 'локальный, без выхода в сеть'
      })
      return
    }
    if (url.pathname === '/api/health') {
      send(response, 200, { ok: true, tasks: store.count(), integrity })
      return
    }
    send(response, 404, { error: 'не найдено' })
  }
}

export function createServer({ store, facts, cafo, cafoBaseUrl, dataDir, rag, email, myAddresses = [], mail, bridge, decisions, drafts, plugins, integrity, host = '127.0.0.1' }) {
  const server = httpCreateServer(createApp({ store, facts, cafo, cafoBaseUrl, dataDir, rag, email, myAddresses, mail, bridge, decisions, drafts, plugins, integrity }))
  server.host = host
  return server
}
