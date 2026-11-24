import { renderToday } from './today.js'

const root = document.getElementById('root')

async function load() {
  try {
    const response = await fetch('/api/state')
    if (!response.ok) throw new Error(`ответ ${response.status}`)
    root.innerHTML = renderToday(await response.json())
  } catch (error) {
    root.innerHTML = `<div class="card"><b>Не удалось загрузить состояние</b><div class="muted">${String(error.message)}</div></div>`
  }
}

load()
