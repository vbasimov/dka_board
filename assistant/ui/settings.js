import { esc } from './today.js'

function checkBadge(ok, okText, badText) {
  return ok ? `<span class="badge ok">${esc(okText)}</span>` : `<span class="badge warn">${esc(badText)}</span>`
}

export function renderSettings(config = {}) {
  const entries = Object.entries(config)
  const rows = entries.length
    ? entries.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value || 'не задано')}</td></tr>`).join('')
    : '<tr><td colspan="2">Параметры пока не загружены.</td></tr>'

  const dataOk = Boolean(config['папка данных']) && config['папка данных'] !== 'не задана'
  const sourceOk = Boolean(config['адрес Confluence']) && config['адрес Confluence'] !== 'не задан'

  return `<table><tbody>${rows}</tbody></table>
<div class="check-row" role="group" aria-label="Результат проверки">
  ${checkBadge(dataOk, 'данные: подключены', 'данные: папка не задана')}
  ${checkBadge(sourceOk, 'источники: подключены', 'источники: адрес Confluence не задан')}
  <span class="badge ok">режим: ${esc(config['режим'] || 'локальный')}</span>
</div>
<div class="toolbar">
  <button class="btn sm" type="button" data-action="recheck-settings">Проверить</button>
  <button class="btn sm ghost" type="button" data-action="open-data-folder">Открыть папку данных</button>
</div>`
}
