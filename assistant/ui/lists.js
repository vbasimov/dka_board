import { esc } from './today.js'

const CAFO_BADGE = { 'свежо': 'ok', 'устарело': 'warn', 'не_сверено': 'bad' }

function badge(status) {
  const cls = CAFO_BADGE[status] ?? ''
  return `<span class="badge ${cls}">${esc(status ?? 'неизвестно')}</span>`
}

export function renderTasks(items = []) {
  if (!items.length) {
    return '<div class="empty"><p><b>Задач пока нет.</b></p><p class="muted">Добавьте задачу из письма или вручную.</p><button class="btn" type="button" data-action="quick-add">Новая задача</button></div>'
  }
  const rows = items
    .map(
      task =>
        `<tr><td>${esc(task.title)}</td><td>${esc(task.source)}</td><td>${esc(task.dueAt ?? '—')}</td><td>${esc(task.status)}</td></tr>`
    )
    .join('')
  return `<table>
  <thead><tr><th>Задача</th><th>Источник</th><th>Срок</th><th>Состояние</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="row" style="margin-top:var(--space-3)">
  <button class="btn" type="button" data-action="quick-add">Новая задача</button>
  <button class="btn ghost" type="button" data-action="quick-add-mail">Добавить из письма</button>
</div>`
}

export function renderCafo(items = []) {
  if (!items.length) {
    return '<div class="empty"><p><b>Кэш КАФО пуст.</b></p><p class="muted">Укажите папку с выгрузкой в «Настройках» и нажмите «Сверить версии».</p><button class="btn" type="button" data-action="sync-cafo">Сверить версии</button></div>'
  }
  const rows = items
    .map(meta => {
      const status = CAFO_BADGE[meta.status] ?? ''
      const checked = (meta.checkedAt ?? '').slice(0, 10) || '—'
      return `<tr data-status="${esc(status)}" data-page-id="${esc(meta.pageId ?? '')}">
    <td>${esc(meta.title || meta.pageId)}</td>
    <td>${esc(meta.spaceKey || '—')}</td>
    <td>${esc(meta.version)}</td>
    <td>${esc(checked)}</td>
    <td>${badge(meta.status)}</td>
    <td><button class="btn sm ghost" type="button" data-refresh data-page-id="${esc(meta.pageId ?? '')}">Обновить</button></td>
  </tr>`
    })
    .join('')
  return `<div class="row" style="margin-bottom:var(--space-3); justify-content:space-between">
  <label class="row" style="gap:6px"><input type="checkbox" id="cafo-filter"> <span class="muted">Только устаревшие</span></label>
  <span class="faint" id="cafo-count">Показано ${esc(items.length)} из ${esc(items.length)}</span>
</div>
<table>
  <thead><tr><th>Страница</th><th>Область</th><th>Версия</th><th>Сверено</th><th>Состояние</th><th></th></tr></thead>
  <tbody id="cafo-body">${rows}</tbody>
</table>`
}

function parseReviewMarkdown(markdown) {
  const lines = String(markdown).split(/\r?\n/)
  let title = ''
  let disclaimer = ''
  const sections = []
  let current = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h1 = /^#\s+(.*)/.exec(line)
    if (h1) {
      title = h1[1]
      continue
    }
    const h2 = /^##\s+(.*)/.exec(line)
    if (h2) {
      current = { heading: h2[1], items: [] }
      sections.push(current)
      continue
    }
    const bullet = /^—\s*(.*)/.exec(line)
    if (bullet && current) {
      current.items.push(bullet[1])
      continue
    }
    if (current) disclaimer = line
  }
  return { title, sections, disclaimer }
}

export function renderReview(markdown) {
  if (!markdown) {
    return '<div class="empty"><p><b>Отчёт не собран.</b></p><p class="muted">Нажмите «Собрать ревью».</p><button class="btn" type="button" data-action="build-review">Собрать ревью</button></div>'
  }
  const { title, sections, disclaimer } = parseReviewMarkdown(markdown)
  const body = sections
    .map(
      section =>
        `<div class="panel-box" style="margin-bottom:var(--space-2)">
  <h3 class="sub" style="margin-top:0">${esc(section.heading)}</h3>
  <ul>${(section.items.length ? section.items : ['нет']).map(item => `<li>${esc(item)}</li>`).join('')}</ul>
</div>`
    )
    .join('')
  return `<div class="page-context">${esc(title || 'Ревью недели')}</div>
${body}
<div class="banner">${esc(disclaimer || 'Отчёт — подсказка программы и требует проверки человеком. Решение всегда за вами.')}</div>`
}

export function renderComparison(result) {
  if (!result) {
    return '<div class="empty"><p><b>Сравнение пока не выполнено.</b></p><p class="muted">Выберите файл схемы и нажмите «Сверить».</p></div>'
  }
  const edge = item => `${esc(item.from)} → ${esc(item.to)}${item.label ? ` (${esc(item.label)})` : ''}`
  const reason = item => esc(item.reason ?? 'требует вашего взгляда')
  const list = (items, render, emptyText) =>
    items.length ? `<ul>${items.map(item => `<li>${render(item)}</li>`).join('')}</ul>` : `<p class="muted">${esc(emptyText)}</p>`

  const onlyInDiagram = Array.isArray(result.onlyInDiagram) ? result.onlyInDiagram : []
  const onlyInCafo = Array.isArray(result.onlyInCafo) ? result.onlyInCafo : []
  const needsEyes = Array.isArray(result.needsEyes) ? result.needsEyes : []

  return `<div class="cols3">
  <div class="col">
    <div class="col-head"><h3>Есть в схеме, нет в КАФО</h3></div>
    ${list(onlyInDiagram, edge, 'нет расхождений')}
  </div>
  <div class="col">
    <div class="col-head"><h3>Есть в КАФО, нет в схеме</h3></div>
    ${list(onlyInCafo, edge, 'нет расхождений')}
  </div>
  <div class="col look-closer">
    <div class="col-head"><h3>Требует вашего взгляда</h3></div>
    ${list(needsEyes, reason, 'нет неоднозначных элементов')}
  </div>
</div>`
}
