import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readTaskFiles(dir) {
  const items = []
  const errors = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) items.push(item)
    } catch (error) {
      errors.push({ file, reason: error.message })
    }
  }
  return { items, errors }
}

export function createTaskImporter({ store }) {
  return {
    import(items = []) {
      let created = 0
      let duplicate = 0
      const rejected = []
      for (const item of items) {
        try {
          const result = store.add(item)
          if (result.created) created += 1
          else duplicate += 1
        } catch (error) {
          rejected.push({ title: item?.title ?? null, reason: error.message })
        }
      }
      return { created, duplicate, rejected }
    }
  }
}
