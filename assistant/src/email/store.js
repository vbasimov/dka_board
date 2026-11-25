import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { messageKey } from './model.js'

const DIR = 'письма'

export function createEmailStore(dir) {
  const folder = join(dir, DIR)
  mkdirSync(folder, { recursive: true })
  const byKey = new Map()

  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.json')) continue
    try {
      const message = JSON.parse(readFileSync(join(folder, file), 'utf8'))
      byKey.set(messageKey(message) || message.messageId || message.id, message)
    } catch {
      // повреждённый файл не ломает запуск
    }
  }

  function keyOf(message) {
    return messageKey(message) || String(message.messageId ?? message.id ?? '')
  }

  function save(message) {
    const target = join(folder, `${keyOf(message).replace(/[^\w.-]/g, '_')}.json`)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify(message, null, 2), 'utf8')
    renameSync(temporary, target)
  }

  return {
    add(message) {
      const key = keyOf(message)
      if (!key) throw new Error('у письма нет идентификатора: сохранение невозможно')
      const exists = byKey.has(key)
      const stored = { ...message, id: message.id ?? key }
      byKey.set(key, stored)
      save(stored)
      return { created: !exists, message: stored }
    },
    all() {
      return [...byKey.values()]
    },
    count() {
      return byKey.size
    }
  }
}
