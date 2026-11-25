import { renderToday, esc } from './today.js'
import { renderOnepager } from './onepager.js'
import { renderQuiz } from './quiz.js'
import { renderSearch } from './search.js'
import { renderDecisions } from './decisions.js'
import { renderCard } from './card.js'
import { renderTasks, renderCafo, renderReview, renderComparison } from './lists.js'
import { renderSettings } from './settings.js'

const $ = selector => document.querySelector(selector)

let selectedTaskId = null
let quizTotal = null
let lastConfig = {}

async function getJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `ответ ${response.status}`)
  return body
}

function fail(target, error) {
  $(target).innerHTML = `<div class="error-banner" role="alert"><b>Не удалось получить данные</b><p>${esc(error.message)}</p></div>`
}

let searchState = {}

function paintSearch() {
  const host = $('#search')
  if (!host) return
  host.innerHTML = renderSearch(searchState)
  const input = $('#rag-q')
  if (input) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        runSearch()
      }
    })
  }
}

async function runSearch() {
  const input = $('#rag-q')
  const query = input ? input.value.trim() : ''
  if (!query) return
  searchState = { query, loading: true }
  paintSearch()
  try {
    const body = await getJson(`/api/rag/search?q=${encodeURIComponent(query)}`)
    searchState = { query, items: body.items }
  } catch (error) {
    searchState = { query, error: error.message }
  }
  paintSearch()
}

async function loadSummary() {
  try {
    const [onepager, state, quiz] = await Promise.all([
      getJson('/api/onepager'),
      getJson('/api/state'),
      getJson('/api/quiz')
    ])
    const counts = {
      today: state.counts?.today ?? 0,
      overdue: state.counts?.overdue ?? 0,
      notInCafo: state.counts?.notInCafo ?? onepager.counts?.cafoStale ?? 0,
      toCheck: Array.isArray(quiz.items) ? quiz.items.length : 0
    }
    $('#summary').innerHTML = renderOnepager({
      counts,
      cafo: onepager.cafo,
      unanswered: onepager.unanswered,
      burning: onepager.burning,
      resume: onepager.resume
    })
  } catch (error) {
    fail('#summary', error)
  }
}

async function loadToday() {
  try {
    $('#today').innerHTML = renderToday(await getJson('/api/state'))
  } catch (error) {
    fail('#today', error)
  }
}

async function loadTasks() {
  try {
    const body = await getJson('/api/tasks')
    $('#tasks').innerHTML = renderTasks(body.items)
  } catch (error) {
    fail('#tasks', error)
  }
}

function wireCafoFilter() {
  const filter = document.getElementById('cafo-filter')
  const count = document.getElementById('cafo-count')
  const body = document.getElementById('cafo-body')
  if (!filter || !count || !body) return
  const rows = Array.prototype.slice.call(body.querySelectorAll('tr'))
  function apply() {
    const onlyStale = filter.checked
    let visible = 0
    rows.forEach(tr => {
      const stale = tr.dataset.status !== 'ok'
      const showRow = onlyStale ? stale : true
      tr.dataset.hidden = showRow ? 'false' : 'true'
      if (showRow) visible++
    })
    count.textContent = `Показано ${visible} из ${rows.length}`
  }
  filter.addEventListener('change', apply)
  apply()
}

async function loadCafo() {
  try {
    const body = await getJson('/api/cafo')
    $('#cafo').innerHTML = renderCafo(body.items)
    wireCafoFilter()
  } catch (error) {
    fail('#cafo', error)
  }
}

async function syncCafo(button) {
  if (button) {
    button.disabled = true
    button.textContent = 'Сверяю…'
  }
  const hint = $('#cafo-hint')
  if (hint) hint.textContent = 'Сверяю…'
  try {
    const body = await getJson('/api/cafo/sync', { method: 'POST' })
    const stale = (body.results ?? []).filter(item => item.status === 'устарело').length
    if (hint) hint.textContent = stale ? `Устарело страниц: ${stale}` : 'Все страницы свежие'
    await loadCafo()
    await loadSummary()
  } catch (error) {
    if (hint) hint.textContent = `Не удалось сверить: ${error.message}`
  }
}

async function loadQuiz() {
  try {
    const body = await getJson('/api/quiz')
    const items = Array.isArray(body.items) ? body.items : []
    if (quizTotal === null) quizTotal = items.length
    $('#quiz').innerHTML = renderQuiz(items, quizTotal)
  } catch (error) {
    fail('#quiz', error)
  }
}

async function loadCard() {
  try {
    const [cafoBody, factsBody] = await Promise.all([getJson('/api/cafo'), getJson('/api/facts')])
    let task = null
    if (selectedTaskId) {
      const tasksBody = await getJson('/api/tasks')
      task = (tasksBody.items ?? []).find(item => item.id === selectedTaskId) ?? null
    }
    $('#card').innerHTML = renderCard({ task, cafoItems: cafoBody.items, factItems: factsBody.items })
  } catch (error) {
    fail('#card', error)
  }
}

async function loadDecisions() {
  try {
    const body = await getJson('/api/decisions')
    $('#decisions').innerHTML = renderDecisions({ items: body.items })
  } catch (error) {
    fail('#decisions', error)
  }
}

async function loadSettings() {
  try {
    lastConfig = await getJson('/api/config')
    $('#settings').innerHTML = renderSettings(lastConfig)
  } catch (error) {
    fail('#settings', error)
  }
}

function show(panel) {
  document.querySelectorAll('.panel').forEach(section => {
    section.hidden = section.id !== `p-${panel}`
  })
  document.querySelectorAll('#nav button').forEach(button => {
    button.setAttribute('aria-current', String(button.dataset.p === panel))
  })
}

document.querySelectorAll('#nav button').forEach(button => {
  button.addEventListener('click', () => show(button.dataset.p))
})

document.addEventListener('click', event => {
  const el = event.target.closest('[data-goto]')
  if (!el) return
  event.preventDefault()
  if (el.dataset.id) selectedTaskId = el.dataset.id
  show(el.dataset.goto)
  if (el.dataset.goto === 'card') loadCard()
})

document.addEventListener('click', async event => {
  const mailSync = event.target.closest('[data-action="mail-sync"]')
  const mailBridge = event.target.closest('[data-action="mail-bridge"]')
  if (mailSync || mailBridge) {
    const hint = () => $('#mail-hint')
    if (hint()) hint().textContent = mailSync ? 'Обновляю почту…' : 'Отправляю в индекс…'
    try {
      if (mailSync) {
        const result = await getJson('/api/email/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ limit: 20, read: 10 })
        })
        await loadSummary()
        if (hint()) hint().textContent = `Писем получено: ${result.read}`
      } else {
        const result = await getJson('/api/email/bridge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index: false })
        })
        await loadSummary()
        if (hint()) hint().textContent = `Записано в индекс: ${result.written}`
      }
    } catch (error) {
      if (hint()) hint().textContent = `Не получилось: ${error.message}`
    }
    return
  }

  if (event.target.closest('[data-action="rag-search"]')) {
    await runSearch()
    return
  }
  const button = event.target.closest('#quiz [data-verdict]')
  if (!button) return
  const card = button.closest('.quiz-card')
  const id = card?.dataset.id
  if (!id) return
  document.querySelectorAll('#quiz [data-verdict]').forEach(b => {
    b.disabled = true
  })
  try {
    await getJson('/api/quiz/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, verdict: button.dataset.verdict })
    })
    await loadQuiz()
    await loadSummary()
  } catch (error) {
    card.insertAdjacentHTML('beforeend', `<p class="faint">Не удалось записать ответ: ${esc(error.message)}</p>`)
    document.querySelectorAll('#quiz [data-verdict]').forEach(b => {
      b.disabled = false
    })
  }
})

document.addEventListener('keydown', event => {
  const panel = document.getElementById('p-quiz')
  if (!panel || panel.hidden) return
  const tag = event.target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  const map = { '1': 'confirm', '2': 'unreliable', '3': 'skip' }
  const verdict = map[event.key]
  if (!verdict) return
  const button = document.querySelector(`#quiz [data-verdict="${verdict}"]`)
  if (button) button.click()
})

document.addEventListener('click', event => {
  const button = event.target.closest('#copy-draft')
  if (!button) return
  const text = document.getElementById('draft-text')?.textContent ?? ''
  function done(ok) {
    button.textContent = ok ? 'Скопировано' : 'Выделите и скопируйте вручную'
    setTimeout(() => {
      button.textContent = 'Скопировать черновик'
    }, 1400)
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false))
  } else {
    done(false)
  }
})

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action="postpone"]')
  if (!button) return
  const id = button.dataset.id
  if (!id) return
  const nextStep = window.prompt('Следующий шаг при возвращении:', '') ?? ''
  if (!nextStep) return
  try {
    await getJson(`/api/tasks/${id}/park`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nextStep })
    })
    await loadSummary()
    show('summary')
  } catch (error) {
    window.alert(`Не удалось отложить: ${error.message}`)
  }
})

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action="quick-add"], [data-action="quick-add-mail"]')
  if (!button) return
  const fromMail = button.dataset.action === 'quick-add-mail'
  const title = window.prompt(fromMail ? 'Тема письма:' : 'Текст задачи:', '')
  if (!title) return
  try {
    await getJson('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, source: fromMail ? 'письмо' : 'вручную' })
    })
    await loadTasks()
    await loadSummary()
  } catch (error) {
    window.alert(`Не удалось добавить задачу: ${error.message}`)
  }
})

document.addEventListener('click', event => {
  if (event.target.closest('[data-action="recheck-settings"]')) loadSettings()
  if (event.target.closest('[data-action="open-data-folder"]')) {
    window.alert(`Папка данных: ${lastConfig['папка данных'] ?? 'не задана'}`)
  }
  if (event.target.closest('[data-action="sync-cafo"]')) syncCafo(null)
  if (event.target.closest('[data-action="build-review"]')) $('#build-review')?.click()
})

$('#cafo')?.addEventListener('click', event => {
  const button = event.target.closest('[data-refresh]')
  if (!button) return
  syncCafo(button)
})

$('#sync-cafo')?.addEventListener('click', () => syncCafo($('#sync-cafo')))

$('#build-review')?.addEventListener('click', async () => {
  const hint = $('#review-hint')
  if (hint) hint.textContent = 'Собираю…'
  try {
    const body = await getJson('/api/review/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    if (hint) hint.textContent = body.savedTo ? `Сохранено: ${body.savedTo}` : ''
    $('#review').innerHTML = renderReview(body.markdown)
  } catch (error) {
    $('#review').innerHTML = `<div class="error-banner" role="alert"><b>Не удалось собрать ревью</b><p>${esc(error.message)}</p></div>`
  }
})

$('#compare')?.addEventListener('click', async () => {
  const file = $('#diagram-file').files[0]
  if (!file) {
    $('#comparison').innerHTML = '<div class="empty"><p><b>Выберите файл схемы.</b></p></div>'
    return
  }
  const cafo = $('#cafo-list').value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  try {
    const body = await getJson('/api/diagrams/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xml: await file.text(), cafo })
    })
    $('#comparison').innerHTML = `<p class="muted">Схема «${esc(body.diagram)}»</p>${renderComparison(body.result)}`
  } catch (error) {
    $('#comparison').innerHTML = `<div class="error-banner" role="alert"><b>Не удалось сверить</b><p>${esc(error.message)}</p></div>`
  }
})

paintSearch()
loadSummary()
loadQuiz()
loadToday()
loadTasks()
loadCafo()
loadSettings()
loadCard()
