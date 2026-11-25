import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'

function normalizeItem(item) {
  return {
    id: String(item.pageId ?? item.noteId ?? item.id ?? ''),
    title: String(item.title ?? ''),
    snippet: String(item.snippet ?? item.summary ?? ''),
    score: Number(item.rrf_score ?? item.score ?? item.semantic_score ?? 0),
    sourceType: String(item.source_type ?? item.sourceType ?? ''),
    path: String(item.path ?? '')
  }
}

export function createMcpClient(options = {}) {
  const command = options.command ?? 'sbm-search-mcp'
  const args = options.args ?? []
  const env = { ...process.env, ...(options.env ?? {}) }
  const timeoutMs = options.timeoutMs ?? 8000

  let child = null
  let buffer = ''
  let nextId = 1
  let ready = null
  const pending = new Map()
  let lastStderr = ''

  function failAll(error) {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id === undefined || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(`поиск вернул ошибку: ${message.error.message ?? 'без описания'}`))
    else entry.resolve(message.result)
  }

  function start() {
    if (child) return
    child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) handleLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      lastStderr = (lastStderr + chunk).split('\n').slice(-3).join(' ').trim()
    })
    child.on('exit', code => {
      child = null
      ready = null
      failAll(new Error(lastStderr ? `поиск остановился: ${lastStderr}` : `поиск остановился с кодом ${code}`))
    })
    child.on('error', error => {
      child = null
      ready = null
      failAll(new Error(`не удалось запустить поиск: ${error.message}`))
    })
  }

  function request(method, params) {
    start()
    const id = nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('поиск не ответил вовремя'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(payload)
    })
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async function initialize() {
    await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'architect-assistant', version: '0.0.1' }
    })
    notify('notifications/initialized')
  }

  async function callTool(name, args = {}) {
    if (!ready) ready = initialize()
    await ready
    const result = await request('tools/call', { name, arguments: args })
    const textPart = (result?.content ?? []).find(part => part.type === 'text')
    if (!textPart) throw new Error(`инструмент ${name} вернул пустой ответ`)
    if (result?.isError) throw new Error(String(textPart.text).trim().slice(0, 300))
    return textPart.text
  }

  return {
    callTool,
    async search(query, searchOptions = {}) {
      const text = String(query ?? '').trim()
      if (!text) throw new Error('пустой поисковый запрос')
      if (!ready) ready = initialize()
      await ready

      const args_ = { query: text, limit: searchOptions.limit ?? 8 }
      if (searchOptions.status) args_.status = searchOptions.status
      if (searchOptions.sourceType) args_.source_type = searchOptions.sourceType

      const result = await request('tools/call', { name: 'search_hybrid', arguments: args_ })
      const textPart = (result?.content ?? []).find(part => part.type === 'text')
      if (!textPart) throw new Error('поиск вернул пустой ответ')
      let parsed
      try {
        parsed = JSON.parse(textPart.text)
      } catch {
        throw new Error('поиск вернул ответ, который не удалось разобрать')
      }
      if (parsed && !Array.isArray(parsed) && parsed.error) throw new Error(`поиск недоступен: ${parsed.error}`)
      if (!Array.isArray(parsed)) throw new Error('поиск вернул неожиданный формат ответа')
      return parsed.map(normalizeItem)
    },
    close() {
      if (child) {
        child.kill()
        child = null
        ready = null
      }
    }
  }
}
