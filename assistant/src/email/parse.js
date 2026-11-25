const LIST_LINE = /^\s*(●)?\s*#(\d+)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\s+(\S+)\s+(.*)$/

export function parseListMessages(text) {
  const items = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = LIST_LINE.exec(line)
    if (!match) continue
    items.push({
      unread: match[1] === '●',
      seq: Number(match[2]),
      date: match[3].replace(' ', 'T'),
      from: match[4],
      subject: match[5].trim()
    })
  }
  return items
}

function header(text, names) {
  const cut = text.indexOf('───')
  const head = cut > 0 ? text.slice(0, cut) : text
  for (const name of names) {
    const match = new RegExp(`^[^\\p{L}\\p{N}]*${name}\\s*:\\s*(.+)$`, 'mu').exec(head)
    if (match) return match[1].trim()
  }
  return ''
}

export function parseMessage(text) {
  const raw = String(text ?? '')
  const meta = /Seq\s*:\s*(\d+)\s*\|\s*UID\s*:\s*(\d+)\s*\|\s*Flags\s*:\s*(.*)$/mi.exec(raw)
  const bodyMatch = /───\s*Текст письма\s*───\s*\n([\s\S]*)$/i.exec(raw)

  return {
    from: header(raw, ['От', 'From']),
    to: header(raw, ['Кому', 'To']),
    cc: header(raw, ['Копия', 'Cc']),
    date: header(raw, ['Дата', 'Date']),
    subject: header(raw, ['Тема', 'Subject']),
    seq: meta ? Number(meta[1]) : null,
    uid: meta ? Number(meta[2]) : null,
    flags: meta ? meta[3].split(',').map(flag => flag.trim()).filter(Boolean) : [],
    body: bodyMatch ? bodyMatch[1].trim() : ''
  }
}
