const MANAGER = /поручени|руководител/i
const ESCALATION = /эскалац|повторн|второй раз/i

function matchOf(text, re) {
  const m = re.exec(text)
  return m ? m[1].trim() : null
}

function normalizeDate(day, month, year, now) {
  const y = year ? (year.length === 2 ? `20${year}` : year) : String(now.getFullYear())
  const d = String(day).padStart(2, '0')
  const m = String(month).padStart(2, '0')
  const valid = Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12
  return valid ? `${y}-${m}-${d}` : null
}

export function parseEmail(text, options = {}) {
  const now = options.now ?? new Date()
  const raw = String(text ?? '')
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const sender = matchOf(raw, /^От:\s*(.+)$/mi)
  const subject = matchOf(raw, /^Тема:\s*(.+)$/mi)
  const firstContent = lines.find(line => !/^От:|^Тема:|^Кому:/i.test(line)) ?? ''

  let dueAt = null
  if (/сегодня/i.test(raw)) dueAt = 'сегодня'
  else if (/завтра/i.test(raw)) dueAt = 'завтра'
  else {
    const dateMatch = /(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/.exec(raw)
    if (dateMatch) dueAt = normalizeDate(dateMatch[1], dateMatch[2], dateMatch[3], now)
  }

  return {
    title: (subject ?? firstContent).slice(0, 160),
    dueAt,
    fromManager: MANAGER.test(raw),
    escalation: ESCALATION.test(raw),
    sender
  }
}
