import { randomUUID } from 'node:crypto'

const REQUIRED = ['claim', 'subject', 'relation', 'fo', 'sourceType', 'sourceRef']

export const FACT_STATUS = {
  PROPOSED: 'предложен',
  CONFIRMED: 'подтверждён',
  SUPERSEDED: 'заменён',
  REJECTED: 'отклонён',
  UNRELIABLE: 'недостоверен'
}

export function createFact(input = {}, options = {}) {
  for (const key of REQUIRED) {
    if (!String(input[key] ?? '').trim()) {
      throw new Error(`поле ${key} обязательно: факт без него не создаётся`)
    }
  }
  const createdAt = options.now ? new Date(options.now).toISOString() : new Date().toISOString()
  return {
    id: input.id ?? randomUUID(),
    claim: String(input.claim).trim(),
    subject: String(input.subject).trim(),
    relation: String(input.relation).trim(),
    object: input.object == null ? null : String(input.object).trim(),
    fo: String(input.fo).trim(),
    sourceType: String(input.sourceType).trim(),
    sourceRef: String(input.sourceRef).trim(),
    confidence: input.confidence ?? 'средняя',
    status: FACT_STATUS.PROPOSED,
    supersedes: input.supersedes ?? null,
    supersededBy: null,
    validFrom: input.validFrom ?? createdAt.slice(0, 10),
    createdAt,
    confirmedBy: null,
    confirmedAt: null
  }
}

export function planSupersession(existing, candidate) {
  const alive = existing.filter(
    fact => fact.status !== FACT_STATUS.REJECTED && fact.status !== FACT_STATUS.SUPERSEDED
  )
  const sameSubject = alive.filter(
    fact => fact.fo === candidate.fo && fact.subject === candidate.subject && fact.relation === candidate.relation
  )
  const exact = sameSubject.filter(fact => (fact.object ?? '') === (candidate.object ?? ''))
  const conflicts = sameSubject.filter(fact => (fact.object ?? '') !== (candidate.object ?? ''))
  return {
    superseded: exact.map(fact => fact.id),
    conflicts: conflicts.map(fact => fact.id)
  }
}

export function canBeUsedInAnswer(fact) {
  return fact.status === FACT_STATUS.CONFIRMED && !fact.supersededBy
}

export function isUnreliable(fact) {
  return fact.status === FACT_STATUS.UNRELIABLE
}

export function quizCandidates(facts, now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10)
  return facts.filter(fact => {
    if (fact.status !== FACT_STATUS.PROPOSED) return false
    const skipped = fact.skippedAt ? String(fact.skippedAt).slice(0, 10) : null
    return skipped !== today
  })
}
