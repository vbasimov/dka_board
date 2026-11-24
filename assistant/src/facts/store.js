import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canBeUsedInAnswer, createFact, FACT_STATUS, planSupersession } from './model.js'

const FACTS_DIR = 'факты'

export function createFactStore(dir) {
  const factsDir = join(dir, FACTS_DIR)
  mkdirSync(factsDir, { recursive: true })
  const byId = new Map()

  for (const file of readdirSync(factsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const fact = JSON.parse(readFileSync(join(factsDir, file), 'utf8'))
      byId.set(fact.id, fact)
    } catch {
      // повреждённый файл не должен ломать запуск
    }
  }

  function save(fact) {
    const target = join(factsDir, `${fact.id}.json`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(fact, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  function update(id, changes) {
    const current = byId.get(id)
    if (!current) throw new Error(`факт ${id} не найден`)
    const updated = { ...current, ...changes }
    byId.set(id, updated)
    save(updated)
    return updated
  }

  return {
    apply(input, options) {
      const candidate = createFact(input, options)
      const plan = planSupersession([...byId.values()], candidate)
      if (plan.superseded.length === 1) candidate.supersedes = plan.superseded[0]
      for (const id of plan.superseded) {
        update(id, { status: FACT_STATUS.SUPERSEDED, supersededBy: candidate.id })
      }
      byId.set(candidate.id, candidate)
      save(candidate)
      return { fact: candidate, superseded: plan.superseded, conflicts: plan.conflicts }
    },
    confirm(id, by) {
      const fact = byId.get(id)
      if (!fact) throw new Error(`факт ${id} не найден`)
      if (fact.status === FACT_STATUS.SUPERSEDED) throw new Error('нельзя подтвердить заменённый факт')
      return update(id, {
        status: FACT_STATUS.CONFIRMED,
        confirmedBy: by ?? 'архитектор',
        confirmedAt: new Date().toISOString()
      })
    },
    reject(id, by) {
      return update(id, {
        status: FACT_STATUS.REJECTED,
        confirmedBy: by ?? 'архитектор',
        confirmedAt: new Date().toISOString()
      })
    },
    byId(id) {
      return byId.get(id)
    },
    all() {
      return [...byId.values()]
    },
    answerable() {
      return [...byId.values()].filter(canBeUsedInAnswer)
    },
    historyOf(id) {
      const chain = []
      let current = byId.get(id)
      const seen = new Set()
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        chain.push(current)
        current = current.supersedes ? byId.get(current.supersedes) : null
      }
      return chain
    }
  }
}
