import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDecision, DECISION_STATE, isDebt } from './model.js'

const DIR = 'решения'

export function createDecisionStore(dir) {
  const folder = join(dir, DIR)
  mkdirSync(folder, { recursive: true })
  const byId = new Map()

  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.json')) continue
    try {
      const decision = JSON.parse(readFileSync(join(folder, file), 'utf8'))
      byId.set(decision.id, decision)
    } catch {
      // повреждённый файл не ломает запуск
    }
  }

  function save(decision) {
    const target = join(folder, `${decision.id}.json`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(decision, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  return {
    add(input) {
      const decision = createDecision(input)
      byId.set(decision.id, decision)
      save(decision)
      return decision
    },
    byId(id) {
      return byId.get(id)
    },
    all() {
      return [...byId.values()].sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
    },
    debts() {
      return this.all().filter(isDebt)
    },
    markInCafo(id, cafoPageId) {
      const decision = byId.get(id)
      if (!decision) throw new Error(`решение ${id} не найдено`)
      const updated = {
        ...decision,
        inCafo: true,
        state: DECISION_STATE.IN_CAFO,
        cafoPageId: cafoPageId ? String(cafoPageId) : decision.cafoPageId
      }
      byId.set(id, updated)
      save(updated)
      return updated
    },
    count() {
      return byId.size
    }
  }
}
