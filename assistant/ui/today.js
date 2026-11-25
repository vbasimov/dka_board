const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char])
}

function priorityChip(reason) {
  if (!reason) return ''
  if (/эскалац/.test(reason)) return `<span class="chip priority-escalation">${esc(reason)}</span>`
  if (/срок|просрочен/.test(reason)) return `<span class="chip priority-deadline">${esc(reason)}</span>`
  if (/поручение/.test(reason)) return `<span class="chip priority-instruction">${esc(reason)}</span>`
  return `<span class="chip">${esc(reason)}</span>`
}

function taskCard(task) {
  const reason = priorityChip(task.reason)
  const due = task.dueAt ? `<span class="chip priority-deadline">срок: ${esc(task.dueAt)}</span>` : ''
  const owner = task.owner ? `<span class="muted">ждёт: ${esc(task.owner)}</span>` : ''
  return `<article class="panel-box" tabindex="0"><b>${esc(task.title)}</b><div class="row" style="margin-top:4px">${reason}${due}${owner}</div></article>`
}

export function renderToday(state = {}) {
  const counts = state.counts ?? {}
  const tasks = Array.isArray(state.tasks) ? state.tasks.slice(0, 3) : []
  const feed = Array.isArray(state.feed) ? state.feed : []

  const cards = tasks.length
    ? `<div class="stack">${tasks.map(taskCard).join('')}</div>`
    : '<div class="empty"><p><b>На сегодня дел нет</b></p><p class="muted">Новые задачи появятся из почты или добавьте вручную.</p><button class="btn" type="button" data-goto="tasks">Новая задача</button></div>'

  const feedItems = feed.length
    ? `<ul class="plain">${feed.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '<p class="faint">Изменений нет.</p>'

  return `
<div class="page-context">Сегодня</div>
<div class="statbar">
  <div class="stat ${(counts.today ?? 0) > 0 ? 'is-bad' : ''}"><b>${esc(counts.today ?? 0)}</b><span>нужны ваше решение или ответ сегодня</span></div>
  <div class="stat ${(counts.overdue ?? 0) > 0 ? 'is-bad' : ''}"><b>${esc(counts.overdue ?? 0)}</b><span>просрочено</span></div>
  <div class="stat ${(counts.notInCafo ?? 0) > 0 ? 'is-warn' : ''}"><b>${esc(counts.notInCafo ?? 0)}</b><span>решения не зафиксированы в КАФО</span></div>
</div>
<h3 class="sub" style="margin-top:0">Сделать сегодня</h3>
${cards}
<h3 class="sub">Что происходит</h3>
${feedItems}`.trim()
}
