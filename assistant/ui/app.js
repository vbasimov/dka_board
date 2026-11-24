import { renderToday } from './today.js'
import { renderOnepager } from './onepager.js'
import { renderQuiz } from './quiz.js'
import { renderTasks, renderCafo, renderFacts, renderReview, renderComparison } from './lists.js'
import { esc } from './today.js'

const $ = selector => document.querySelector(selector)

async function getJson(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `ответ ${response.status}`)
  return body
}

function fail(target, error) {
  $(target).innerHTML = `<div class="card"><b>Не удалось получить данные</b><div class="muted">${esc(error.message)}</div></div>`
}

async function loadToday() {
  try {
    $('#today').innerHTML = renderToday(await getJson('/api/state'))
  } catch (error) {
    fail('#today', error)
  }
}

async function loadSummary() {
  try {
    $('#summary').innerHTML = renderOnepager(await getJson('/api/onepager'))
  } catch (error) {
    fail('#summary', error)
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

async function loadCafo() {
  try {
    const body = await getJson('/api/cafo')
    $('#cafo').innerHTML = renderCafo(body.items)
  } catch (error) {
    fail('#cafo', error)
  }
}

async function loadFacts() {
  try {
    const body = await getJson('/api/facts')
    $('#facts').innerHTML = renderFacts(body.items)
  } catch (error) {
    fail('#facts', error)
  }
}

async function loadQuiz() {
  try {
    $('#quiz').innerHTML = renderQuiz((await getJson('/api/quiz')).items)
  } catch (error) {
    fail('#quiz', error)
  }
}

async function loadConfig() {
  try {
    const config = await getJson('/api/config')
    const rows = Object.entries(config)
      .map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value || 'не задано')}</td></tr>`)
      .join('')
    $('#config').innerHTML = `<tbody>${rows}</tbody>`
  } catch (error) {
    fail('#config', error)
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

$('#quiz')?.addEventListener('click', async event => {
  const button = event.target.closest('button[data-verdict]')
  if (!button) return
  const card = button.closest('.quiz')
  const id = card?.dataset.id
  if (!id) return
  button.disabled = true
  try {
    await getJson('/api/quiz/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, verdict: button.dataset.verdict })
    })
    $('#quiz-hint').textContent = 'Ответ записан'
    await loadQuiz()
    await loadFacts()
    await loadSummary()
  } catch (error) {
    $('#quiz-hint').textContent = `Не удалось записать ответ: ${error.message}`
    button.disabled = false
  }
})

$('#sync-cafo')?.addEventListener('click', async () => {
  $('#cafo-hint').textContent = 'Сверяю…'
  try {
    const body = await getJson('/api/cafo/sync', { method: 'POST' })
    const stale = body.results.filter(item => item.status === 'устарело').length
    $('#cafo-hint').textContent = stale ? `Устарело страниц: ${stale}` : 'Все страницы свежие'
    await loadCafo()
  } catch (error) {
    $('#cafo-hint').textContent = `Не удалось сверить: ${error.message}`
  }
})

$('#build-review')?.addEventListener('click', async () => {
  $('#review-hint').textContent = 'Собираю…'
  try {
    const body = await getJson('/api/review/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    $('#review-hint').textContent = body.savedTo ? `Сохранено: ${body.savedTo}` : ''
    $('#review').innerHTML = renderReview(body.markdown)
  } catch (error) {
    $('#review').innerHTML = `<div class="card"><b>Не удалось собрать ревью</b><div class="muted">${esc(error.message)}</div></div>`
  }
})

$('#compare')?.addEventListener('click', async () => {
  const file = $('#diagram-file').files[0]
  if (!file) {
    $('#comparison').innerHTML = '<div class="card"><b>Выберите файл схемы</b></div>'
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
    $('#comparison').innerHTML = `<h3>${esc(body.diagram)}</h3>${renderComparison(body.result)}`
  } catch (error) {
    $('#comparison').innerHTML = `<div class="card"><b>Не удалось сверить</b><div class="muted">${esc(error.message)}</div></div>`
  }
})

loadSummary()
loadQuiz()
loadToday()
loadTasks()
loadCafo()
loadFacts()
loadConfig()
