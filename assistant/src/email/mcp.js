import { parseListMessages, parseMessage } from './parse.js'

export function createMailClient({ mcp, folder = 'INBOX' }) {
  return {
    async fetch({ limit = 20, read = 5, mailbox = folder } = {}) {
      const listText = await mcp.callTool('list_messages', { folder: mailbox, limit })
      const listed = parseListMessages(listText)
      const messages = []

      for (const item of listed.slice(0, read)) {
        const text = await mcp.callTool('read_message', { seq: item.seq, folder: mailbox })
        const parsed = parseMessage(text)
        messages.push({
          folder: mailbox,
          uid: parsed.uid ?? item.seq,
          seq: parsed.seq ?? item.seq,
          from: parsed.from || item.from,
          to: parsed.to,
          cc: parsed.cc || '',
          subject: parsed.subject || item.subject,
          date: parsed.date || item.date,
          flags: parsed.flags,
          unread: item.unread,
          body: parsed.body
        })
      }

      return { listed, messages }
    }
  }
}
