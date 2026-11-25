function normalizeAddress(value) {
  const text = String(value ?? '').toLowerCase()
  const match = /<([^>]+)>/.exec(text)
  return (match ? match[1] : text).trim()
}

export function threadKeyOf(message) {
  const references = Array.isArray(message.references) ? message.references.filter(Boolean) : []
  if (references.length > 0) return String(references[0]).trim()
  if (message.inReplyTo) return String(message.inReplyTo).trim()
  return String(message.messageId ?? message.id ?? '').trim()
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
          unread: message.seen !== true
        })
      }
    }
  }

  return result.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
}
