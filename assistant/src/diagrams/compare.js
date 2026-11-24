function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function integrationKey(from, to) {
  return `${normalize(from)}→${normalize(to)}`
}

export function toIntegrations(diagram) {
  const byId = new Map(diagram.nodes.map(node => [node.id, node]))
  const integrations = []
  const needsEyes = []

  for (const edge of diagram.edges ?? []) {
    const from = byId.get(edge.from)?.label ?? ''
    const to = byId.get(edge.to)?.label ?? ''
    if (!from || !to) {
      needsEyes.push({ id: edge.from || edge.to, reason: 'у связи не найдена подпись участника' })
      continue
    }
    integrations.push({
      from,
      to,
      label: edge.label ?? '',
      sync: edge.dashed !== true,
      confidence: edge.confidence ?? 'высокая'
    })
  }

  for (const item of diagram.unparsed ?? []) {
    needsEyes.push({ id: item.id, reason: item.reason })
  }

  return { integrations, needsEyes }
}

export function compareIntegrations({ diagram, cafo = [] }) {
  const { integrations, needsEyes } = toIntegrations(diagram)
  const cafoList = cafo.map(item => {
    if (typeof item === 'string') {
      const [from, to] = item.split('→').map(part => part.trim())
      return { from: from ?? '', to: to ?? '', label: '' }
    }
    return { from: item.from ?? '', to: item.to ?? '', label: item.label ?? '' }
  })

  const diagramKeys = new Set(integrations.map(item => integrationKey(item.from, item.to)))
  const cafoKeys = new Set(cafoList.map(item => integrationKey(item.from, item.to)))

  const onlyInDiagram = integrations.filter(item => !cafoKeys.has(integrationKey(item.from, item.to)))
  const onlyInCafo = cafoList.filter(item => !diagramKeys.has(integrationKey(item.from, item.to)))
  const matched = integrations.filter(item => cafoKeys.has(integrationKey(item.from, item.to)))

  return {
    onlyInDiagram,
    onlyInCafo,
    matched,
    needsEyes,
    summary: {
      diagram: integrations.length,
      cafo: cafoList.length,
      matched: matched.length,
      missingInCafo: onlyInDiagram.length,
      missingInDiagram: onlyInCafo.length
    }
  }
}
