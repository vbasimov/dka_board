const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char])
}

function number(value, label) {
  return `<div class="num"><b>${esc(value)}</b><span>${esc(label)}</span></div>`
}

function card(task) {
  const reason = task.reason ? `<span class="chip">${esc(task.reason)}</span>` : ''
  const due = task.dueAt ? `<span class="chip p2">срок: ${esc(task.dueAt)}</span>` : ''
  const owner = task.owner ? `<span class="muted">ждёт: ${esc(task.owner)}</span>` : ''
  return `<div class="card"><b>${esc(task.title)}</b><div class="row">${reason}${due}${owner}</div></div>`
}

export function renderToday(state = {}) {
  const counts = state.counts ?? {}
  const tasks = Array.isArray(state.tasks) ? state.tasks.slice(0, 3) : []
  const feed = Array.isArray(state.feed) ? state.feed : []

  const cards = tasks.length
    ? tasks.map(card).join('')
    : '<div class="card"><b>На сегодня дел нет</b><div class="muted">Новые задачи появятся здесь, когда придут из почты или будут добавлены вручную.</div></div>'

  const feedItems = feed.length
    ? `<ul class="plain">${feed.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '<div class="muted">Изменений нет</div>'

  return `
<section class="today">
  <div class="nums">
    ${number(counts.today ?? 0, 'нужны ваше решение или ответ сегодня')}
    ${number(counts.overdue ?? 0, 'просрочено')}
    ${number(counts.notInCafo ?? 0, 'решения не зафиксированы в КАФО')}
  </div>
  <h3>Сделать сегодня</h3>
  ${cards}
  <h3>Что происходит</h3>
  ${feedItems}
</section>`.trim()
}
