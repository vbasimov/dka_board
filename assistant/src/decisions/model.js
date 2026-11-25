export const DECISION_STATE = {
  DEBT: 'долг',
  IN_CAFO: 'в КАФО'
}

export function createDecision(input = {}) {
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('название решения обязательно')
  const source = String(input.source ?? '').trim()
  if (!source) throw new Error('источник решения обязателен: решение без источника не фиксируется')
  const decidedAt = input.decidedAt ? String(input.decidedAt) : new Date().toISOString().slice(0, 10)
  const inCafo = input.inCafo === true
  return {
    id: input.id ?? `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    rationale: String(input.rationale ?? '').trim(),
    source,
    sourceRef: input.sourceRef ? String(input.sourceRef) : null,
    decidedAt,
    inCafo,
    cafoPageId: input.cafoPageId ? String(input.cafoPageId) : null,
    state: inCafo ? DECISION_STATE.IN_CAFO : DECISION_STATE.DEBT,
    createdAt: input.createdAt ?? new Date().toISOString()
  }
}

export function isDebt(decision) {
  return decision.inCafo !== true
}
