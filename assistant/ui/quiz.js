import { esc } from './today.js'

export function renderQuiz(items = [], total) {
  const remaining = Array.isArray(items) ? items : []
  const known = typeof total === 'number' ? total : remaining.length

  if (known === 0) {
    return `<p class="quiz-progress">На сегодня проверять нечего</p>
<div class="quiz-card empty">
  <p><b>На сегодня проверять нечего.</b></p>
  <p class="muted">Новые факты появятся после разбора писем и схем.</p>
</div>`
  }

  if (remaining.length === 0) {
    return `<p class="quiz-progress">Проверено ${esc(known)} из ${esc(known)}</p>
<div class="quiz-card empty">
  <p><b>Все факты на сегодня проверены.</b></p>
  <p class="muted">Пропущенные факты вернутся не раньше завтра.</p>
  <button class="btn" type="button" data-goto="summary">Вернуться в сводку</button>
</div>`
  }

  const fact = remaining[0]
  return `<p class="quiz-progress">Осталось проверить: ${esc(remaining.length)} из ${esc(known)}</p>
<article class="quiz-card" data-id="${esc(fact.id)}" tabindex="0">
  <div class="quiz-claim">${esc(fact.claim)}</div>
  <div class="quiz-source">Источник: ${esc(fact.sourceType)} · ${esc(fact.sourceRef)}</div>
  <div class="quiz-actions">
    <button class="btn" type="button" data-verdict="confirm"><span class="kbd">1</span>Подтвердить</button>
    <button class="btn ghost" type="button" data-verdict="unreliable"><span class="kbd">2</span>Недостоверно</button>
    <button class="btn ghost" type="button" data-verdict="skip"><span class="kbd">3</span>Пропустить</button>
  </div>
  <div class="quiz-hint">Пропущенный факт вернётся не раньше следующего дня.</div>
</article>`
}
