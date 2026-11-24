import { randomUUID } from 'node:crypto'

function normalizeDue(value) {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10)
  return text
}

export function makeTask(input = {}) {
  const source = String(input.source ?? '').trim()
  if (!source) throw new Error('источник обязателен: задача без источника не создаётся')
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('название задачи обязательно')
  return {
    id: input.id ?? randomUUID(),
    title,
    source,
    sourceRef: input.sourceRef ?? null,
    dueAt: normalizeDue(input.dueAt),
    owner: input.owner ?? null,
    fromManager: input.fromManager === true,
    escalation: input.escalation === true,
    answered: input.answered === true,
    nextStep: input.nextStep ?? null,
    parkedAt: input.parkedAt ?? null,
    status: input.status ?? 'новая',
    createdAt: input.createdAt ?? new Date().toISOString()
  }
}
