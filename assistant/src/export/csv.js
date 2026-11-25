function quote(value) {
  const text = String(value ?? '')
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function tasksToCsv(tasks = []) {
  const header = ['id', 'title', 'source', 'dueAt', 'status', 'createdAt']
  const rows = tasks.map(task => header.map(key => quote(task[key])).join(','))
  return [header.join(','), ...rows].join('\n') + '\n'
}

export function factsToMarkdown(facts = []) {
  const lines = [
    '---',
    'title: "Факты об архитектуре"',
    'source_type: "export"',
    `exported_at: "${new Date().toISOString().slice(0, 10)}"`,
    '---',
    '',
    '| Утверждение | Область | Состояние | Источник |',
    '|---|---|---|---|',
    ...facts.map(fact => `| ${escapeCell(fact.claim)} | ${escapeCell(fact.fo)} | ${escapeCell(fact.status)} | ${escapeCell(fact.sourceRef)} |`),
    ''
  ]
  return lines.join('\n')
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
