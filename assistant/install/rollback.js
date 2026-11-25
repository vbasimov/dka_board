import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releasesDir = process.env.AA_RELEASES ?? new URL('../releases/', import.meta.url).pathname
  const pointerFile = process.env.AA_CURRENT ?? new URL('../current', import.meta.url).pathname
  const manager = createReleaseManager({ releasesDir, pointerFile })
  const [flag, value] = process.argv.slice(2)
  try {
    if (flag === '--activate' && value) console.log(`активирована версия ${manager.activate(value)}`)
    else if (flag === '--rollback') console.log(`откат на версию ${manager.rollback()}`)
    else if (flag === '--current') console.log(manager.current() ?? 'версия не выбрана')
    else if (flag === '--list') console.log(manager.versions().join('\n') || 'версий нет')
    else {
      console.error('использование: node install/rollback.js --activate <версия> | --rollback | --current | --list')
      process.exit(2)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
