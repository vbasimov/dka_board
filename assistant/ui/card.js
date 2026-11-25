import { esc } from './today.js'

const CAFO_BADGE = { 'свежо': 'ok', 'устарело': 'warn', 'не_сверено': 'bad' }
const FACT_BADGE = { 'подтверждён': 'ok', 'предложен': 'warn', 'недостоверен': 'bad', 'заменён': 'bad' }
const FACT_LABEL = { 'подтверждён': 'подтверждён', 'предложен': 'не подтверждён', 'недостоверен': 'недостоверен', 'заменён': 'заменён' }

function reasonLine(task) {
  const parts = []
  if (task.escalation) parts.push('эскалация')
  if (task.fromManager) parts.push('поручение руководителя')
  if (task.dueAt) parts.push(`срок ${task.dueAt}`)
  return parts.length ? parts.join(' · ') : 'без срока'
}

function cafoSource(meta) {
  const cls = CAFO_BADGE[meta.status] ?? ''
  return `<div class="src">
    <span class="badge ${cls}">${esc(meta.status ?? 'неизвестно')}</span>
    <span class="text">КАФО «${esc(meta.title || meta.pageId)}», версия ${esc(meta.version)}${meta.checkedAt ? `, сверено ${esc(String(meta.checkedAt).slice(0, 10))}` : ''}</span>
    <a class="open" href="#" data-goto="cafo">Открыть источник</a>
  </div>`
}

function factSource(fact) {
  const cls = FACT_BADGE[fact.status] ?? ''
  const label = FACT_LABEL[fact.status] ?? fact.status
  return `<div class="src">
    <span class="badge ${cls}">${esc(label ?? 'неизвестно')}</span>
    <span class="text">${esc(fact.claim)} — ${esc(fact.sourceRef)}</span>
    <a class="open" href="#" data-goto="quiz">Открыть источник</a>
  </div>`
}

function buildDraftText(factItems) {
  const confirmed = factItems.filter(fact => fact.status === 'подтверждён')
  if (!confirmed.length) {
    return 'Подтверждённых фактов пока нет. Проверьте факты на экране «Проверка фактов», прежде чем собирать ответ.'
  }
  const lines = ['Коллеги, добрый день.', '', 'Обоснование:']
  for (const fact of confirmed) lines.push(`— ${fact.claim} (${fact.sourceRef})`)
  return lines.join('\n')
}

export function renderCard(data = {}) {
  const task = data.task ?? null
  const cafoItems = Array.isArray(data.cafoItems) ? data.cafoItems : []
  const factItems = Array.isArray(data.factItems) ? data.factItems : []

  if (!task) {
    return `<div class="empty">
  <p><b>Карточка не выбрана.</b></p>
  <p class="muted">Откройте запрос из «Сводки» или «Задач», чтобы увидеть разбор и черновик ответа.</p>
  <button class="btn" type="button" data-goto="summary">В сводку</button>
</div>`
  }

  const staleSources = cafoItems.filter(meta => meta.status !== 'свежо')
  const banner = staleSources.length
    ? `<div class="banner${staleSources.some(meta => meta.status === 'не_сверено') ? ' bad' : ''}">Не все источники свежие: ${esc(staleSources.length)} из ${esc(cafoItems.length)} требуют проверки перед отправкой.</div>`
    : ''

  const sources = [...cafoItems.map(cafoSource), ...factItems.map(factSource)].join('')
    || '<p class="muted">Источников пока нет.</p>'

  return `
<div class="split2">
  <div>
    <div class="mail-meta">От «${esc(task.source)}» · ${task.dueAt ? `срок ${esc(task.dueAt)}` : 'срок не указан'} · ждёт: ${esc(task.owner ?? 'не указан')}</div>
    <div class="mail-body">Полный текст письма программа не хранит — показаны только разобранные поля.

Тема: ${esc(task.title)}</div>
    <p class="faint" style="margin-top:12px">Приоритет выставлен по признакам: ${esc(reasonLine(task))}.</p>
  </div>
  <div>
    ${banner}
    <h3 class="sub" style="margin-top:0">Черновик ответа</h3>
    <div class="draft" id="draft-text">${esc(buildDraftText(factItems))}</div>
    ${sources}
    <div class="row" style="margin-top:var(--space-4)">
      <button class="btn" type="button" id="copy-draft">Скопировать черновик</button>
      <button class="btn ghost" type="button" data-action="draft-save">Сохранить как решение</button>
      <span class="muted" id="draft-hint" role="status"></span>
      <button class="btn ghost" type="button" data-action="postpone" data-id="${esc(task.id ?? '')}">Отложить</button>
    </div>
    <p class="faint" style="margin-top:8px">Отправка только вручную, из почтовой программы. Эта программа писем не отправляет.</p>
  </div>
</div>`.trim()
}
