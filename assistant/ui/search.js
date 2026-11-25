import { esc } from './today.js'

export function renderSearch(state = {}) {
  const items = Array.isArray(state.items) ? state.items : []
  const query = String(state.query ?? '')
  const error = state.error ? `<div class="banner bad">${esc(state.error)}</div>` : ''

  const results = state.loading
    ? '<div class="muted">Ищу…</div>'
    : items.length
      ? `<ul class="plain search-results">${items
          .map(
            item => `<li>
  <div class="row"><b>${esc(item.title || item.path)}</b><span class="badge">${esc(item.sourceType || 'документ')}</span><span class="faint">релевантность ${esc(Number(item.score ?? 0).toFixed(2))}</span></div>
  <div class="muted">${esc(item.snippet)}</div>
</li>`
          )
          .join('')}</ul>`
      : query
        ? '<div class="muted">Ничего не найдено. Попробуйте другие слова.</div>'
        : '<div class="muted">Введите запрос: программа ищет по индексу знаний, включая письма и схемы.</div>'

  return `<div class="search-bar">
  <input id="rag-q" type="search" value="${esc(query)}" placeholder="Например: интеграция платежей с антифродом" aria-label="Поисковый запрос">
  <button class="btn" data-action="rag-search">Найти</button>
</div>
${error}
${results}`
}
