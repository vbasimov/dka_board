import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TASKS_DIR = 'задачи'

function normalize(input) {
  const source = (input.source ?? '').trim()
  if (!source) throw new Error('источник обязателен: задача без источника не создаётся')
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('название задачи обязательно')
  return {
    id: input.id ?? randomUUID(),
    title,
    source,
    sourceRef: input.sourceRef ?? null,
    dueAt: input.dueAt ?? null,
    owner: input.owner ?? null,
    fromManager: input.fromManager === true,
    escalation: input.escalation === true,
    status: input.status ?? 'новая',
    createdAt: input.createdAt ?? new Date().toISOString()
  }
}

export function createStore(dir) {
  const tasksDir = join(dir, TASKS_DIR)
  mkdirSync(tasksDir, { recursive: true })

  const byId = new Map()
  const bySourceRef = new Map()

  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const task = JSON.parse(readFileSync(join(tasksDir, file), 'utf8'))
      byId.set(task.id, task)
      if (task.sourceRef) bySourceRef.set(task.sourceRef, task.id)
    } catch {
      // повреждённый файл не должен ломать запуск
    }
  }

  function save(task) {
    const target = join(tasksDir, `${task.id}.json`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(task, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  return {
    add(input) {
      const task = normalize(input)
      if (task.sourceRef && bySourceRef.has(task.sourceRef)) {
        return { created: false, task: byId.get(bySourceRef.get(task.sourceRef)) }
      }
      byId.set(task.id, task)
      if (task.sourceRef) bySourceRef.set(task.sourceRef, task.id)
      save(task)
      return { created: true, task }
    },
    byId(id) {
      return byId.get(id)
    },
    setStatus(id, status) {
      const task = byId.get(id)
      if (!task) throw new Error(`задача ${id} не найдена`)
      const updated = { ...task, status }
      byId.set(id, updated)
      save(updated)
      return updated
    },
    search(query) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (!needle) return [...byId.values()]
      return [...byId.values()].filter(task => task.title.toLowerCase().includes(needle))
    },
    count() {
      return byId.size
    },
    all() {
      return [...byId.values()]
    }
  }
}
