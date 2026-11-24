import { inflateRawSync } from 'node:zlib'

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

export function cleanLabel(raw) {
  if (!raw) return ''
  const text = decodeEntities(raw)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

function attributes(raw) {
  const out = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(raw)) !== null) out[m[1]] = m[2]
  return out
}

export function kindOf(style = '') {
  if (/shape=(cylinder3|datastore|database)/.test(style)) return 'хранилище'
  if (/shape=ellipse/.test(style)) return 'актор'
  if (/shape=cloud/.test(style)) return 'внешняя система'
  if (/shape=(hexagon|step)/.test(style)) return 'сервис'
  return 'неизвестно'
}

function inflateDiagram(body) {
  const compact = body.replace(/\s+/g, '')
  if (!compact || /[<>]/.test(compact)) return null
  try {
    const inflated = inflateRawSync(Buffer.from(compact, 'base64')).toString('utf8')
    const decoded = decodeURIComponent(inflated)
    return decoded.includes('<mxGraphModel') ? decoded : null
  } catch {
    return null
  }
}

function cellsOf(xml) {
  const cells = []
  const re = /<mxCell\b([^>]*)>/g
  let m
  while ((m = re.exec(xml)) !== null) cells.push(attributes(m[1]))
  return cells
}

function parseModel(name, xml) {
  const cells = cellsOf(xml)
  const byId = new Map(cells.map(cell => [cell.id ?? '', cell]))
  const nodes = []
  const edges = []
  const unparsed = []

  for (const cell of cells) {
    if (cell.vertex === '1') {
      nodes.push({
        id: cell.id ?? '',
        label: cleanLabel(cell.value),
        kind: kindOf(cell.style ?? ''),
        parent: cell.parent ?? null,
        style: cell.style ?? ''
      })
      continue
    }
    if (cell.edge === '1') {
      const from = cell.source ?? ''
      const to = cell.target ?? ''
      if (!from || !to) {
        unparsed.push({ id: cell.id ?? '', reason: 'у ребра нет начала или конца' })
        continue
      }
      edges.push({
        from,
        to,
        label: cleanLabel(cell.value),
        dashed: /(^|;)dashed=1(;|$)/.test(cell.style ?? ''),
        confidence: 'высокая'
      })
    }
  }

  const parents = new Set(nodes.map(node => node.parent).filter(Boolean))
  const zoneIds = new Set(
    nodes
      .filter(node => parents.has(node.id) || /swimlane/.test(byId.get(node.id)?.style ?? ''))
      .map(node => node.id)
  )
  const zones = nodes
    .filter(node => zoneIds.has(node.id))
    .map(node => ({ id: node.id, label: node.label, parent: node.parent }))

  return {
    name,
    zones,
    nodes: nodes
      .filter(node => !zoneIds.has(node.id))
      .map(({ id, label, kind, parent }) => ({ id, label, kind, parent })),
    edges,
    unparsed
  }
}

export function parseDrawio(xml) {
  const diagrams = []
  const re = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const name = attributes(m[1]).name ?? ''
    let body = m[2]
    if (!body.includes('<mxGraphModel')) {
      const inflated = inflateDiagram(body)
      if (inflated) body = inflated
    }
    diagrams.push(parseModel(name, body))
  }
  return { diagrams }
}
