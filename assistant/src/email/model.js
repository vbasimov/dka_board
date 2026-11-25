const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|ответ|пересл|aw|sv)\s*:\s*)+/i

export function normalizeAddress(value) {
  const text = String(value ?? '').toLowerCase()
  const match = /<([^>]+)>/.exec(text)
  return (match ? match[1] : text).trim()
}

export function normalizeSubject(subject) {
  return String(subject ?? '')
    .replace(REPLY_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function messageKey(message) {
  const folder = String(message.folder ?? '')
  if (message.uid !== undefined && message.uid !== null) return `${folder}:uid:${message.uid}`
  if (message.seq !== undefined && message.seq !== null) return `${folder}:seq:${message.seq}`
  if (message.messageId) return `mid:${message.messageId}`
  return ''
}

export function isSeen(message) {
  if (Array.isArray(message.flags)) {
    return message.flags.some(flag => String(flag).replace(/^\\+/, '').toLowerCase() === 'seen')
  }
  return message.seen === true
}

export function threadKeyOf(message) {
  const references = Array.isArray(message.references) ? message.references.filter(Boolean) : []
  if (references.length > 0) return `ref:${String(references[0]).trim()}`
  if (message.inReplyTo) return `ref:${String(message.inReplyTo).trim()}`
  const subject = normalizeSubject(message.subject)
  if (subject) return `subject:${subject}`
  return messageKey(message) || ''
}

export function isMine(message, myAddresses = []) {
  const mine = new Set(myAddresses.map(normalizeAddress))
  return mine.has(normalizeAddress(message.from))
}

export function unansweredFrom(messages = [], myAddresses = []) {
  const byThread = new Map()
  for (const message of messages) {
    const key = threadKeyOf(message)
    if (!key) continue
    if (!byThread.has(key)) byThread.set(key, [])
    byThread.get(key).push(message)
  }

  const result = []
  for (const [thread, items] of byThread) {
    const sorted = [...items].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
    for (const message of sorted) {
      if (isMine(message, myAddresses)) continue
      const replied = sorted.some(
        candidate => isMine(candidate, myAddresses) && String(candidate.date ?? '') >= String(message.date ?? '')
      )
      if (!replied) {
        result.push({
          ...message,
          threadId: thread,
          threadBy: thread.startsWith('subject:') ? 'тема' : 'заголовки',
          unread: !isSeen(message)
        })
      }
    }
  }

  return result.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
}
