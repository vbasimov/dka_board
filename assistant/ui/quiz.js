import { esc } from './today.js'

export function renderQuiz(items = []) {
  if (!items.length) {
    return '<div class="card"><b>На сегодня проверять нечего</b><div class="muted">Новые факты появятся после разбора писем и схем.</div></div>'
  }
  const cards = items
    .map(
      fact => `<div class="card quiz" data-id="${esc(fact.id)}">
  <b>${esc(fact.claim)}</b>
  <div class="muted">Источник: ${esc(fact.sourceType)} · ${esc(fact.sourceRef)}</div>
  <div class="row" style="margin-top:8px">
    <button class="btn" data-verdict="confirm">Подтвердить</button>
    <button class="btn ghost" data-verdict="unreliable">Недостоверно</button>
    <button class="btn ghost" data-verdict="skip">Пропустить</button>
  </div>
</div>`
    )
    .join('')
  return `<p class="muted">${items.length} факт(ов) ждут решения. Занимает около минуты.</p>${cards}`
}
