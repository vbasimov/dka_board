import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createReleaseManager({ releasesDir, pointerFile }) {
  function versions() {
    if (!existsSync(releasesDir)) return []
    return readdirSync(releasesDir)
      .filter(name => existsSync(join(releasesDir, name)))
      .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }))
  }

  function current() {
    if (!existsSync(pointerFile)) return null
    const value = readFileSync(pointerFile, 'utf8').trim()
    return value || null
  }

  function activate(version) {
    if (!versions().includes(version)) throw new Error(`версия ${version} не найдена в ${releasesDir}`)
    writeFileSync(pointerFile, `${version}\n`, 'utf8')
    return version
  }

  function rollback() {
    const list = versions()
    const active = current()
    if (!active) throw new Error('текущая версия не выбрана')
    const index = list.indexOf(active)
    if (index <= 0) throw new Error('предыдущей версии нет: откатываться некуда')
    return activate(list[index - 1])
  }

  return { versions, current, activate, rollback, releasesDir, pointerFile }
}
