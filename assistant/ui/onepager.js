import { esc } from './today.js'

const BADGE = { 'свежо': 'ok', 'устарело': 'warn', 'не_сверено': 'bad' }

function badge(status) {
  return `<span class="badge ${BADGE[status] ?? ''}">${esc(status ?? 'неизвестно')}</span>`
}

function empty(text) {
  return `<div class="muted">${esc(text)}</div>`
}

export function renderOnepager(state = {}) {
  const cafo = Array.isArray(state.cafo) ? state.cafo : []
  const unanswered = Array.isArray(state.unanswered) ? state.unanswered : []
  const burning = Array.isArray(state.burning) ? state.burning : []
  const counts = state.counts ?? {}

  const cafoBlock = cafo.length
    ? `<ul class="plain">${cafo
        .map(meta => `<li>${esc(meta.title || meta.pageId)} — v${esc(meta.version)} ${badge(meta.status)}</li>`)
        .join('')}</ul>`
    : empty('Страниц в кэше нет. Укажите адрес хранилища и сверьте версии.')

  const unansweredBlock = unanswered.length
    ? `<ul class="plain">${unanswered
        .map(task => `<li><b>${esc(task.title)}</b> <span class="chip">${esc(task.reason ?? 'ждёт ответа')}</span></li>`)
        .join('')}</ul>`
    : empty('Неотвеченных сообщений нет.')

  const burningBlock = burning.length
    ? `<ul class="plain">${burning
        .map(task => `<li><b>${esc(task.title)}</b> <span class="chip p1">${esc(task.reason ?? 'срок')}</span></li>`)
        .join('')}</ul>`
    : empty('Горящих сроков на сегодня нет.')

  return `
<section class="onepager">
  <div class="column">
    <h3>Статусы КАФО <span class="chip">${esc(counts.cafo ?? cafo.length)} · устарело ${esc(counts.cafoStale ?? 0)}</span></h3>
    ${cafoBlock}
  </div>
  <div class="column">
    <h3>Неотвеченные сообщения <span class="chip">${esc(counts.unanswered ?? unanswered.length)}</span></h3>
    ${unansweredBlock}
  </div>
  <div class="column">
    <h3>Горящие сроки сегодня <span class="chip p1">${esc(counts.burning ?? burning.length)}</span></h3>
    ${burningBlock}
  </div>
</section>`.trim()
}
