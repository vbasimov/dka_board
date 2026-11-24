import { dueDate, todayKey } from '../domain/priority.js'

function list(items, render) {
  return items.length ? items.map(item => `— ${render(item)}`).join('\n') : '— нет'
}

export function buildReview({ now = new Date(), tasks = [], facts = [], cafo = [], diagramDiffs = [] } = {}) {
  const today = todayKey(now)
  const open = tasks.filter(task => task.status !== 'закрыта')
  const overdue = open.filter(task => {
    const due = dueDate(task, now)
    return Boolean(due) && due < today
  })
  const proposed = facts.filter(fact => fact.status === 'предложен')
  const stale = cafo.filter(meta => meta.status === 'устарело')
  const unchecked = cafo.filter(meta => meta.status === 'не_сверено')

  const gaps = []
  for (const fact of proposed) gaps.push(`факт не подтверждён: «${fact.claim}»`)
  for (const meta of stale) gaps.push(`КАФО «${meta.title}» обновилась до версии ${meta.version}, кэш старее`)
  for (const meta of unchecked) gaps.push(`КАФО «${meta.title}» не сверена: нет доступа к источнику`)
  for (const diff of diagramDiffs) {
    for (const item of diff.onlyInDiagram ?? []) gaps.push(`в схеме «${diff.diagram}» есть связь ${item.from} → ${item.to}, в КАФО её нет`)
    for (const item of diff.onlyInCafo ?? []) gaps.push(`в КАФО есть связь ${item.from} → ${item.to}, в схеме «${diff.diagram}» её нет`)
  }

  const actions = []
  if (proposed.length) actions.push(`подтвердить или отклонить ${proposed.length} факт(ов) перед отправкой обоснований`)
  if (stale.length) actions.push(`обновить кэш ${stale.length} страниц(ы) КАФО`)
  if (overdue.length) actions.push(`разобрать ${overdue.length} просроченных задач(и)`)
  if (diagramDiffs.length) actions.push('сверить расхождения схем с КАФО и решить, что верно')

  const lines = []
  lines.push(`# Ревью недели, ${today}`)
  lines.push('')
  lines.push('## Что произошло')
  lines.push(list(open.slice(0, 10).map(task => task.title), title => title))
  lines.push('')
  lines.push('## Что не учли')
  lines.push(gaps.length ? gaps.map(gap => `— ${gap}`).join('\n') : '— существенных пропусков не найдено')
  lines.push('')
  lines.push('## Что предлагаю')
  lines.push(actions.length ? actions.map(action => `— ${action}`).join('\n') : '— ничего не требуется')
  lines.push('')
  lines.push('Отчёт — подсказка. Решение всегда за человеком.')

  return {
    markdown: lines.join('\n'),
    counts: {
      openTasks: open.length,
      overdue: overdue.length,
      proposedFacts: proposed.length,
      stalePages: stale.length,
      uncheckedPages: unchecked.length,
      gaps: gaps.length
    }
  }
}
