import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const TASKS_DIR = 'задачи'
const FACTS_DIR = 'факты'

function isInside(base, target) {
  const path = relative(base, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createPluginApi(options = {}) {
  const pluginName = String(options.pluginName ?? 'плагин')
  if (!options.pluginDir) throw new Error('не указана папка плагина: api без неё не создаётся')
  if (!options.dataDir) throw new Error('не указана папка данных: api без неё не создаётся')

  const pluginDir = resolve(options.pluginDir)
  const dataDir = resolve(options.dataDir)
  const logger = options.logger ?? null

  let realPluginDir = pluginDir
  try {
    realPluginDir = realpathSync(pluginDir)
  } catch {
    // папка плагина проверяется при загрузке; здесь достаточно исходного пути
  }

  function writeToLogger(level, message) {
    try {
      if (!logger) return
      if (typeof logger === 'function') {
        logger(message)
        return
      }
      const write =
        typeof logger[level] === 'function'
          ? logger[level]
          : level === 'log' && typeof logger.info === 'function'
            ? logger.info
            : logger.log
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      // журнал не должен ронять плагин
    }
  }

  function readCollection(folder) {
    let entries
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        writeToLogger('error', `плагин "${pluginName}": не удалось прочитать ${folder}: ${messageOf(error)}`)
      }
      return []
    }

    const items = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        items.push(JSON.parse(readFileSync(join(folder, entry.name), 'utf8')))
      } catch {
        // повреждённый файл не должен ломать плагин
      }
    }
    return items
  }

  function writeOwnFile(name, content) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('имя файла обязательно: плагин не может писать безымянный файл')
    }
    if (name.includes('\0')) throw new Error('в имени файла недопустимый символ')
    if (isAbsolute(name)) throw new Error('имя файла должно быть относительным: плагин пишет только у себя')

    const target = resolve(pluginDir, name)
    if (target === pluginDir || !isInside(pluginDir, target)) {
      throw new Error('плагин может писать только внутри папки плагина')
    }

    try {
      mkdirSync(dirname(target), { recursive: true })
      const realParent = realpathSync(dirname(target))
      if (!isInside(realPluginDir, realParent)) {
        throw new Error('плагин может писать только внутри папки плагина')
      }
      try {
        if (lstatSync(target).isSymbolicLink()) {
          throw new Error('запись через символическую ссылку запрещена')
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    } catch (error) {
      if (
        error?.message === 'плагин может писать только внутри папки плагина' ||
        error?.message === 'запись через символическую ссылку запрещена'
      ) {
        throw error
      }
      throw new Error(`не удалось подготовить файл плагина: ${messageOf(error)}`)
    }

    const payload =
      typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content ?? null, null, 2)
    try {
      writeFileSync(target, payload, 'utf8')
    } catch (error) {
      throw new Error(`не удалось записать файл плагина: ${messageOf(error)}`)
    }
    return target
  }

  return Object.freeze({
    readTasks() {
      return readCollection(join(dataDir, TASKS_DIR))
    },
    readFacts() {
      return readCollection(join(dataDir, FACTS_DIR))
    },
    writeOwnFile,
    log(message) {
      writeToLogger('log', `плагин "${pluginName}": ${String(message ?? '')}`)
    }
  })
}
