const list = `● #0001 2026-11-25 14:32  ivanov@company.ru  Re: Согласование архитектуры Q4
  #0002 2026-11-25 11:15  petrov@company.ru  План митинга`

const one = `📧 От: ivanov@company.ru
   Кому: arch@example.com
   Дата: 2026-11-25T14:32:00.000Z
   Тема: Re: Согласование архитектуры Q4
   Seq: 1 | UID: 40512 | Flags: \Flagged
─── Текст письма ───
Привет, нужно закрыть вопросы по инкременту.`

const two = `📧 От: petrov@company.ru
   Кому: arch@example.com
   Дата: 2026-11-25T11:15:00.000Z
   Тема: План митинга
   Seq: 2 | UID: 40513 | Flags: \\Seen
─── Текст письма ───
Встреча в 16:00.`

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mail' } })
    } else if (message.method === 'tools/call') {
      const name = message.params.name
      const text =
        name === 'list_messages' ? list : name === 'read_message' ? (message.params.arguments.seq === 1 ? one : two) : ''
      reply({ content: [{ type: 'text', text }] })
    }
  }
})
