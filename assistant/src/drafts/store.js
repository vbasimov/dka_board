import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'черновики'

function slugify(text) {
  return String(text ?? 'черновик')
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'черновик'
}

export function createDraftStore(dir) {
  const folder = join(dir, DIR)
  mkdirSync(folder, { recursive: true })

  return {
    save(input = {}) {
      const text = String(input.text ?? '').trim()
      if (!text) throw new Error('пустой черновик сохранять нечего')
      const subject = String(input.subject ?? '').trim() || 'Черновик ответа'
      const date = new Date().toISOString().slice(0, 10)
      const base = `${date}-${slugify(subject)}`
      let name = `${base}.md`
      let counter = 2
      while (readdirSync(folder).includes(name)) {
        name = `${base}-${counter}.md`
        counter += 1
      }

      const citations = Array.isArray(input.citations) ? input.citations : []
      const lines = [
        '---',
        `title: "${subject.replace(/"/g, '\\"')}"`,
        'source_type: "draft"',
        `draft_date: "${date}"`,
        `status: "draft"`,
        'tags: ["черновик"]',
        '---',
        '',
        text,
        '',
        '## Источники',
        '',
        citations.length
          ? citations.map(item => `- ${item.sourceRef}${item.factId ? ` (факт ${item.factId})` : ''}`).join('\n')
          : '- нет подтверждённых источников',
        ''
      ].join('\n')

      const target = join(folder, name)
      const temporary = `${target}.tmp`
      writeFileSync(temporary, lines, 'utf8')
      renameSync(temporary, target)
      return { name, path: target, subject, date }
    },

    list() {
      return readdirSync(folder)
        .filter(name => name.endsWith('.md'))
        .sort()
        .reverse()
        .map(name => ({ name }))
    },

    read(name) {
      const safe = String(name ?? '').replace(/[^\p{L}\p{N}._-]/gu, '')
      if (!safe.endsWith('.md')) throw new Error('ожидается файл черновика')
      const target = join(folder, safe)
      try {
        return readFileSync(target, 'utf8')
      } catch {
        throw new Error('черновик не найден')
      }
    }
  }
}
