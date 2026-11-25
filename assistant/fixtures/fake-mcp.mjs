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
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }) + '\n')
    } else if (message.method === 'tools/call') {
      const items = [{ pageId: '42', title: 'КАФО: Платежи', snippet: 'События в Kafka', rrf_score: 0.87, source_type: 'md', path: '/kb/platezhi.md' }]
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(items) }] } }) + '\n')
    }
  }
})
