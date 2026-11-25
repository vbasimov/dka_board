import { esc } from './today.js'

const MAX_ROWS = 7
const CAFO_BADGE = { 'свежо': 'ok', 'устарело': 'warn', 'не_сверено': 'bad' }

function cafoBadge(status) {
  const cls = CAFO_BADGE[status] ?? ''
  return `<span class="badge ${cls}">${esc(status ?? 'неизвестно')}</span>`
}

function capped(items, goto) {
  const rows = Array.isArray(items) ? items : []
  const visible = rows.slice(0, MAX_ROWS)
  const more = rows.length - visible.length
  const showAll = more > 0
    ? `<button class="show-all" type="button" data-goto="${esc(goto)}">Показать все ${esc(rows.length)}</button>`
    : ''
  return { visible, showAll }
}

function cafoLine(meta) {
  const sub = [meta.version != null ? `версия ${esc(meta.version)}` : null, meta.checkedAt ? `сверено ${esc(String(meta.checkedAt).slice(0, 10))}` : null]
    .filter(Boolean)
    .join(' · ')
  return `<div class="line">
    <div class="line-main">
      <div class="line-title">${esc(meta.title || meta.pageId || 'без названия')}</div>
      <div class="line-sub">${sub}</div>
    </div>
    ${cafoBadge(meta.status)}
  </div>`
}

function unansweredLine(task) {
  return `<div class="line">
    <div class="line-main">
      <div class="line-title">${esc(task.title)}</div>
      <div class="line-sub">${esc(task.reason ?? 'ждёт ответа')}${task.threadBy === 'тема' ? ' · цепочка по теме' : ''}</div>
    </div>
    <button class="btn sm ghost" type="button" data-goto="card" data-id="${esc(task.id ?? '')}">Ответить</button>
  </div>`
}

function burningLine(task) {
  return `<div class="line">
    <div class="line-main">
      <div class="line-title">${esc(task.title)}</div>
      <div class="line-sub">${esc(task.reason ?? 'срок сегодня')}</div>
    </div>
    <span class="line-time">${esc(task.dueAt ?? 'сегодня')}</span>
  </div>`
}

function resumeLine(task) {
  return `<div class="line">
    <div class="line-main">
      <div class="line-title">${esc(task.title)}</div>
      <div class="line-sub">следующий шаг: ${esc(task.nextStep ?? 'не сохранён')}</div>
    </div>
    <button class="btn sm ghost" type="button" data-goto="card" data-id="${esc(task.id ?? '')}">Вернуться</button>
  </div>`
}

function column(title, countLabel, items, lineFn, emptyText, goto, extraClass = '') {
  const { visible, showAll } = capped(items, goto)
  const body = visible.length
    ? `<div class="lines">${visible.map(lineFn).join('')}</div>${showAll}`
    : `<div class="empty"><p class="muted">${esc(emptyText)}</p></div>`
  return `<div class="col ${extraClass}">
    <div class="col-head"><h3>${esc(title)}</h3><span class="count">${esc(countLabel)}</span></div>
    ${body}
  </div>`
}

export function renderOnepager(state = {}) {
  const counts = state.counts ?? {}
  const cafo = Array.isArray(state.cafo) ? state.cafo : []
  const unanswered = Array.isArray(state.unanswered) ? state.unanswered : []
  const burning = Array.isArray(state.burning) ? state.burning : []
  const resume = Array.isArray(state.resume) ? state.resume : []

  const statbar = `<div class="statbar">
    <div class="stat ${(counts.today ?? 0) > 0 ? 'is-bad' : ''}"><b>${esc(counts.today ?? 0)}</b><span>нужны решение или ответ сегодня</span></div>
    <div class="stat ${(counts.overdue ?? 0) > 0 ? 'is-bad' : ''}"><b>${esc(counts.overdue ?? 0)}</b><span>просрочено</span></div>
    <div class="stat ${(counts.notInCafo ?? 0) > 0 ? 'is-warn' : ''}"><b>${esc(counts.notInCafo ?? 0)}</b><span>решения не в КАФО</span></div>
    <div class="stat"><b>${esc(counts.toCheck ?? 0)}</b><span>проверить фактов</span></div>
  </div>`

  const toolbar = `<div class="toolbar" role="group" aria-label="Почта">
    <button class="btn sm" type="button" data-action="mail-sync">Обновить почту</button>
    <button class="btn sm ghost" type="button" data-action="mail-bridge">Отправить письма в индекс</button>
    <span class="muted" id="mail-hint" role="status"></span>
  </div>`

  const cols = `<div class="cols3">
    ${column('Статусы КАФО', `${esc(cafo.length)} страницы`, cafo, cafoLine, 'Укажите папку с выгрузкой и сверьте версии.', 'cafo')}
    ${column('Неотвеченные сообщения', String(unanswered.length), unanswered, unansweredLine, 'Неотвеченных сообщений нет.', 'tasks')}
    ${column('Горящие сроки сегодня', String(burning.length), burning, burningLine, 'Горящих сроков нет.', 'tasks')}
  </div>`

  const { visible: resumeVisible, showAll: resumeShowAll } = capped(resume, 'tasks')
  const resumeBody = resumeVisible.length
    ? `<div class="lines">${resumeVisible.map(resumeLine).join('')}</div>${resumeShowAll}`
    : `<div class="empty"><p class="muted">Незавершённых дел с сохранённым шагом нет.</p></div>`
  const continueBlock = `<div class="panel-box continue">
    <div class="col-head"><h3>Продолжить</h3><span class="count">${esc(resume.length)} незавершённых</span></div>
    ${resumeBody}
  </div>`

  return `${statbar}${toolbar}${cols}${continueBlock}`
}
