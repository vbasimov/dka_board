import { esc } from './today.js'

function badge(status) {
  const map = { 'свежо': 'ok', 'устарело': 'warn', 'не_сверено': 'bad' }
  return `<span class="badge ${map[status] ?? ''}">${esc(status ?? 'неизвестно')}</span>`
}

export function renderTasks(items = []) {
  if (!items.length) return '<div class="card"><b>Задач пока нет</b><div class="muted">Добавьте задачу из письма или вручную.</div></div>'
  const rows = items
    .map(task => `<tr><td>${esc(task.title)}</td><td>${esc(task.source)}</td><td>${esc(task.dueAt ?? '—')}</td><td>${esc(task.status)}</td></tr>`)
    .join('')
  return `<table><thead><tr><th>Задача</th><th>Источник</th><th>Срок</th><th>Состояние</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function renderCafo(items = []) {
  if (!items.length) return '<div class="card"><b>Кэш КАФО пуст</b><div class="muted">Укажите адрес Confluence и нажмите «Сверить версии».</div></div>'
  const rows = items
    .map(meta => `<tr><td>${esc(meta.title || meta.pageId)}</td><td>${esc(meta.version)}</td><td>${esc((meta.checkedAt ?? '').slice(0, 10) || '—')}</td><td>${badge(meta.status)}</td></tr>`)
    .join('')
  return `<table><thead><tr><th>Страница</th><th>Версия</th><th>Проверено</th><th>Состояние</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function renderFacts(items = []) {
  if (!items.length) return '<div class="card"><b>Фактов пока нет</b><div class="muted">Факты появляются при разборе источников.</div></div>'
  const rows = items
    .map(fact => `<tr><td>${esc(fact.claim)}</td><td>${esc(fact.fo)}</td><td>${esc(fact.status)}</td><td>${esc(fact.sourceRef)}</td></tr>`)
    .join('')
  return `<table><thead><tr><th>Утверждение</th><th>Область</th><th>Состояние</th><th>Источник</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function renderReview(markdown) {
  if (!markdown) return '<div class="card"><b>Отчёт не собран</b><div class="muted">Нажмите «Собрать ревью».</div></div>'
  return `<pre class="draft">${esc(markdown)}</pre>`
}

export function renderComparison(result) {
  if (!result) return ''
  const line = item => `<li>${esc(item.from)} → ${esc(item.to)}${item.label ? ` (${esc(item.label)})` : ''}</li>`
  const block = (title, items) =>
    `<div class="card"><b>${esc(title)}</b>${items.length ? `<ul class="plain">${items.map(line).join('')}</ul>` : '<div class="muted">нет</div>'}</div>`
  return [
    block('Есть в схеме, нет в КАФО', result.onlyInDiagram ?? []),
    block('Есть в КАФО, нет в схеме', result.onlyInCafo ?? []),
    block('Требует взгляда', result.needsEyes ?? [])
  ].join('')
}
