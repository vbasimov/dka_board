import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'отчёты'

export function createReviewStore(dir) {
  const folder = join(dir, DIR)
  mkdirSync(folder, { recursive: true })

  return {
    save(markdown, options = {}) {
      const text = String(markdown ?? '').trim()
      if (!text) throw new Error('пустой отчёт сохранять нечего')
      const date = new Date().toISOString().slice(0, 10)
      const suffix = options.suffix ? `-${String(options.suffix)}` : ''
      const name = `ревью-${date}${suffix}-правка.md`
      writeFileSync(join(folder, name), text, 'utf8')
      return { name, path: join(folder, name) }
    },
    latest() {
      const files = readdirSync(folder).filter(file => file.endsWith('.md')).sort()
      if (!files.length) return null
      const name = files[files.length - 1]
      return { name, content: readFileSync(join(folder, name), 'utf8') }
    }
  }
}
