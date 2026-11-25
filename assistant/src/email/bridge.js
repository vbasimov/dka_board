import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

function frontmatterValue(value) {
  return `"${String(value ?? '').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

export function toMarkdown(message) {
  const lines = [
    '---',
    `title: ${frontmatterValue(message.subject || '(без темы)')}`,
    'source_type: "email"',
    `email_from: ${frontmatterValue(message.from)}`,
    `email_to: ${frontmatterValue(message.to)}`,
    `email_cc: ${frontmatterValue(message.cc)}`,
    `email_date: ${frontmatterValue(message.date)}`,
    `email_folder: ${frontmatterValue(message.folder)}`,
    `email_uid: ${frontmatterValue(message.uid)}`,
    'status: "pending"',
    'tags: ["почта"]',
    '---',
    '',
    `# ${message.subject || '(без темы)'}`,
    '',
    `От: ${message.from || 'неизвестно'}  `,
    `Кому: ${message.to || 'неизвестно'}  `,
    `Дата: ${message.date || 'неизвестно'}  `,
    `Папка: ${message.folder || ''} · UID: ${message.uid ?? ''}`,
    '',
    String(message.body ?? '').trim(),
    ''
  ]
  return lines.join('\n')
}

export function fileNameOf(message) {
  const uid = message.uid ?? message.seq ?? 'unknown'
  const date = String(message.date ?? '').slice(0, 10) || 'без-даты'
  return `${date}-${String(message.folder ?? 'INBOX').toLowerCase()}-${uid}.md`
}

export function createEmailBridge({ dir, index }) {
  const target = join(dir, 'письма-для-индекса')
  mkdirSync(target, { recursive: true })

  return {
    async sync(messages = [], options = {}) {
      let written = 0
      let skipped = 0
      for (const message of messages) {
        const markdown = toMarkdown(message)
        const file = join(target, fileNameOf(message))
        const hash = createHash('sha256').update(markdown).digest('hex')
        if (existsSync(file)) {
          const current = readFileSync(file, 'utf8')
          if (createHash('sha256').update(current).digest('hex') === hash) {
            skipped += 1
            continue
          }
        }
        const temporary = `${file}.tmp`
        writeFileSync(temporary, markdown, 'utf8')
        renameSync(temporary, file)
        written += 1
      }

      let indexed = false
      if (options.index === true && index) {
        await index()
        indexed = true
      }

      return { written, skipped, indexed, target }
    }
  }
}
