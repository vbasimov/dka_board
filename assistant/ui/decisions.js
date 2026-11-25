import { esc } from './today.js'

export function renderDecisions(state = {}) {
  const items = Array.isArray(state.items) ? state.items : []
  const debts = items.filter(item => item.inCafo !== true).length

  const rows = items.length
    ? items
        .map(
          item => `<tr>
        <td>${esc(item.title)}</td>
        <td>${esc(item.decidedAt)}</td>
        <td>${esc(item.source)}${item.sourceRef ? ` · ${esc(item.sourceRef)}` : ''}</td>
        <td>${item.inCafo ? '<span class="badge ok">в КАФО</span>' : '<span class="badge warn">долг</span>'}</td>
        <td>${item.inCafo ? '' : `<button class="btn sm ghost" type="button" data-action="decision-cafo" data-id="${esc(item.id)}">В КАФО</button>`}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5">Решений пока нет. Зафиксируйте первое — оно попадёт в список долгов перед КАФО.</td></tr>'

  return `<div class="toolbar">
    <input id="decision-title" type="text" placeholder="Что решили" aria-label="Название решения">
    <input id="decision-source" type="text" placeholder="Источник: письмо, протокол, схема" aria-label="Источник решения">
    <button class="btn sm" type="button" data-action="decision-add">Зафиксировать</button>
    <span class="muted" id="decision-hint" role="status"></span>
  </div>
  <p class="muted">Долгов перед КАФО: ${esc(debts)}</p>
  <table>
    <thead><tr><th>Решение</th><th>Дата</th><th>Источник</th><th>Состояние</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}
