const STALE = 'устарело'
const UNKNOWN = 'не сверено'

function citationOf(fact, sourceStatus) {
  const status = sourceStatus?.[fact.sourceRef]
  const marker = status === STALE ? ' — источник устарел' : status === UNKNOWN ? ' — источник не сверен' : ''
  return `(${fact.sourceRef}${marker})`
}

export function buildDraft(input = {}) {
  const facts = Array.isArray(input.facts) ? input.facts : []
  const sourceStatus = input.sourceStatus ?? {}
  const request = String(input.request ?? '').trim()
  const subject = String(input.subject ?? '').trim()

  const confirmed = facts.filter(fact => fact.status === 'подтверждён' && !fact.supersededBy)
  const proposed = facts.filter(fact => fact.status === 'предложен')
  const superseded = facts.filter(fact => fact.supersededBy)

  const warnings = []
  for (const fact of confirmed) {
    const status = sourceStatus[fact.sourceRef]
    if (status === STALE) warnings.push(`источник факта «${fact.claim}» устарел: ${fact.sourceRef}`)
    if (status === UNKNOWN) warnings.push(`источник факта «${fact.claim}» не сверен: ${fact.sourceRef}`)
  }
  if (proposed.length > 0) {
    warnings.push(`требуют подтверждения: ${proposed.length} утверждений`)
  }

  const lines = ['Коллеги, добрый день.']
  if (subject) lines.push('', `По вопросу: ${subject}`)

  if (confirmed.length === 0) {
    lines.push(
      '',
      'Подтверждённых оснований для ответа нет.',
      'Нужно подтвердить факты или добавить источник — без этого отвечать не следует.'
    )
  } else {
    lines.push('', 'Позиция:')
    lines.push(confirmed[0].claim + '.')
    lines.push('', 'Обоснование:')
    for (const fact of confirmed) {
      lines.push(`— ${fact.claim} ${citationOf(fact, sourceStatus)}`)
    }
  }

  if (proposed.length > 0) {
    lines.push('', 'Требует подтверждения (в ответ не включено):')
    for (const fact of proposed) lines.push(`— ${fact.claim}`)
  }

  if (superseded.length > 0) {
    lines.push('', 'Ранее действовало, но заменено:')
    for (const fact of superseded) lines.push(`— ${fact.claim} (заменён на ${fact.supersededBy})`)
  }

  if (request) lines.push('', 'Следующий шаг: согласовать на ближайшем комитете и обновить КАФО.')

  return {
    text: lines.join('\n'),
    citations: confirmed.map(fact => ({ factId: fact.id, sourceRef: fact.sourceRef })),
    warnings,
    counts: { confirmed: confirmed.length, proposed: proposed.length, superseded: superseded.length }
  }
}

export function isSafeToSend(draft) {
  return draft.counts.confirmed > 0 && draft.warnings.every(warning => !warning.startsWith('источник факта'))
}
