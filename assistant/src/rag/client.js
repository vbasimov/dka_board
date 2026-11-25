import { execFile } from 'node:child_process'

const DEFAULT_TIMEOUT = 8000
const MAX_OUTPUT = 4 * 1024 * 1024

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.signal) {
          reject(new Error('поиск не ответил вовремя'))
          return
        }
        const detail = String(stderr || '').trim().split('\n').slice(-3).join(' ')
        reject(new Error(detail ? `поиск завершился с ошибкой: ${detail}` : 'поиск завершился с ошибкой'))
        return
      }
      resolve(String(stdout))
    })
  })
}

export function normalizeItem(item) {
  return {
    id: String(item.pageId ?? item.id ?? ''),
    title: String(item.title ?? ''),
    snippet: String(item.snippet ?? ''),
    score: Number(item.score ?? 0),
    sourceType: String(item.source_type ?? item.sourceType ?? ''),
    path: String(item.path ?? '')
  }
}

export function createRagClient(options = {}) {
  const command = options.command ?? 'sbm-search'
  const baseArgs = options.args ?? []
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  return {
    async search(query, searchOptions = {}) {
      const text = String(query ?? '').trim()
      if (!text) throw new Error('пустой поисковый запрос')
      const args = [...baseArgs, 'search', text, '--format', 'json', '--limit', String(searchOptions.limit ?? 8)]
      if (searchOptions.mode) args.push('--mode', searchOptions.mode)
      if (searchOptions.sourceType) args.push('--source-type', searchOptions.sourceType)
      if (searchOptions.status) args.push('--status', searchOptions.status)

      const stdout = await run(command, args, timeoutMs)
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        throw new Error('поиск вернул ответ, который не удалось разобрать')
      }
      if (!Array.isArray(parsed)) throw new Error('поиск вернул неожиданный формат ответа')
      return parsed.map(normalizeItem)
    }
  }
}
