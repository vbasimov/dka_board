export const STATUS = {
  FRESH: 'свежо',
  STALE: 'устарело',
  UNKNOWN: 'не_сверено'
}

export function freshnessOf(cached, remote) {
  if (!remote || typeof remote.version !== 'number') {
    return { status: STATUS.UNKNOWN, diff: 0 }
  }
  const diff = remote.version - cached.version
  if (diff === 0) return { status: STATUS.FRESH, diff: 0 }
  return { status: STATUS.STALE, diff }
}

export async function fetchMeta(pageId, options = {}) {
  const { baseUrl, timeoutMs = 3000, headers = {} } = options
  if (!baseUrl) return null
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/content/${encodeURIComponent(pageId)}?expand=version`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers
    })
    if (!response.ok) return null
    const body = await response.json()
    const version = body?.version?.number
    return typeof version === 'number' ? { version } : null
  } catch {
    return null
  }
}

export async function fetchPage(pageId, options = {}) {
  const { baseUrl, timeoutMs = 3000, headers = {} } = options
  if (!baseUrl) return null
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/content/${encodeURIComponent(pageId)}?expand=version,body.storage,ancestors`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
    if (!response.ok) return null
    const body = await response.json()
    const version = body?.version?.number
    if (typeof version !== 'number') return null
    return {
      version,
      title: String(body.title ?? ''),
      spaceKey: String(body.space?.key ?? ''),
      body: String(body?.body?.storage?.value ?? ''),
      url: String(body?._links?.webui ?? ''),
      ancestors: Array.isArray(body.ancestors) ? body.ancestors.map(item => String(item.title ?? '')) : []
    }
  } catch {
    return null
  }
}
