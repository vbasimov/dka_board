import { fileDigest } from '../parse/sources.js'

export const FRESHNESS_STATUS = {
  FRESH: 'свежо',
  STALE: 'устарело',
  UNVERIFIED: 'не сверено'
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function isVersion(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function diagramState(input = {}) {
  const { filePath, cached } = input ?? {}

  let digest
  try {
    digest = fileDigest(filePath)
  } catch (error) {
    return {
      status: FRESHNESS_STATUS.UNVERIFIED,
      digest: null,
      reason: error.message
    }
  }

  const cachedDigest = normalizeDigest(cached?.digest)
  if (!cachedDigest) {
    return {
      status: FRESHNESS_STATUS.UNVERIFIED,
      digest,
      reason: 'нет сохранённого хэша файла — сверка невозможна'
    }
  }

  if (cachedDigest === digest) {
    return { status: FRESHNESS_STATUS.FRESH, digest, reason: '' }
  }

  return {
    status: FRESHNESS_STATUS.STALE,
    digest,
    reason: 'хэш файла изменился после сохранения схемы'
  }
}

export function attachmentState(input = {}) {
  const { cachedVersion, remoteVersion } = input ?? {}

  if (!isVersion(remoteVersion)) {
    return {
      status: FRESHNESS_STATUS.UNVERIFIED,
      reason: 'версия вложения в Confluence не получена'
    }
  }

  if (!isVersion(cachedVersion)) {
    return {
      status: FRESHNESS_STATUS.UNVERIFIED,
      reason: 'нет сохранённой версии вложения — сверка невозможна'
    }
  }

  if (cachedVersion === remoteVersion) {
    return { status: FRESHNESS_STATUS.FRESH, reason: '' }
  }

  return {
    status: FRESHNESS_STATUS.STALE,
    reason: `версия вложения изменилась: сохранена ${cachedVersion}, в Confluence ${remoteVersion}`
  }
}

const CYRILLIC_TO_LATIN = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya'
}

const TOKEN_ENDINGS = new Set(['а', 'ы', 'я', 'и', 'е', 'у', 'ю', 'о', 'a', 'e', 'i', 'o', 'u', 'y', 's'])

function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function transliterate(text) {
  let result = ''
  for (const char of text) result += CYRILLIC_TO_LATIN[char] ?? char
  return result
}

function stem(token) {
  if (token.length < 4) return token
  return TOKEN_ENDINGS.has(token.at(-1)) ? token.slice(0, -1) : token
}

function makeItem(label) {
  const original = label.trim()
  const normalized = normalizeLabel(original)
  if (!normalized) return null
  const canonical = transliterate(normalized)
  const tokens = canonical.split(' ').filter(Boolean).map(stem)
  if (tokens.length === 0) return null
  return { original, canonical, tokens, signature: [...tokens].sort().join(' ') }
}

function similar(a, b) {
  if (a.tokens.length === b.tokens.length) return a.signature === b.signature
  const [short, long] = a.tokens.length < b.tokens.length ? [a, b] : [b, a]
  return short.tokens.every((token, index) => long.tokens[index] === token)
}

export function synonymCandidates(labels = []) {
  const items = []
  for (const label of Array.isArray(labels) ? labels : []) {
    if (typeof label !== 'string') continue
    const item = makeItem(label)
    if (item) items.push(item)
  }

  const parent = items.map((_, index) => index)
  const find = index => {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (similar(items[i], items[j])) union(i, j)
    }
  }

  const groups = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(item)
  })

  const candidates = []
  for (const group of groups.values()) {
    const variants = []
    for (const item of group) {
      if (!variants.includes(item.original)) variants.push(item.original)
    }
    if (variants.length < 2) continue
    const key = group
      .map(item => item.canonical)
      .sort((left, right) => left.length - right.length || left.localeCompare(right))[0]
    candidates.push({ key, variants })
  }
  return candidates
}
