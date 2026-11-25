import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSettings } from '../../ui/settings.js'

test('таблица параметров показывает ключ и значение', () => {
  const html = renderSettings({ 'папка данных': 'C:/данные', 'адрес Confluence': 'http://wiki.local', 'режим': 'локальный, без выхода в сеть' })
  assert.match(html, /папка данных/)
  assert.match(html, /C:\/данные/)
  assert.match(html, /локальный, без выхода в сеть/)
})

test('незаданные значения честно помечены текстом «не задано»', () => {
  const html = renderSettings({ 'папка данных': '' })
  assert.match(html, /не задано/)
})

test('три отметки проверки показаны бейджами с текстом рядом', () => {
  const html = renderSettings({ 'папка данных': 'C:/данные', 'адрес Confluence': 'http://wiki.local', 'режим': 'локальный' })
  assert.match(html, /class="check-row"/)
  assert.match(html, /badge ok">данные: подключены/)
  assert.match(html, /badge ok">источники: подключены/)
  assert.match(html, /badge ok">режим: локальный/)
})

test('не заданный источник честно помечен предупреждением, а не скрыт', () => {
  const html = renderSettings({ 'адрес Confluence': 'не задан' })
  assert.match(html, /badge warn">источники: адрес Confluence не задан/)
})

test('содержимое настроек экранируется', () => {
  const html = renderSettings({ '<script>x</script>': '<img src=x onerror=1>' })
  assert.doesNotMatch(html, /<script>x/)
  assert.doesNotMatch(html, /<img/)
})

test('на настройках есть кнопки проверки и открытия папки данных', () => {
  const html = renderSettings({ 'папка данных': '/tmp/data' })
  assert.match(html, /data-action="recheck-settings"/)
  assert.match(html, /data-action="open-data-folder"/)
  assert.match(html, /Проверить/)
})
