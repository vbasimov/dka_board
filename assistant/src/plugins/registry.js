import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateManifest } from './contract.js'
import { createPluginApi } from './api.js'

export const DEFAULT_TIMEOUT_MS = 2000

const NETWORK_MODULES = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dns',
  'dgram',
  'undici',
  'ws',
  'axios',
  'node-fetch',
  'got'
])

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function isInside(base, target) {
  const path = relative(base, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function networkImports(source) {
  const found = new Set()
  for (const match of String(source).matchAll(IMPORT_PATTERN)) {
    const specifier = match[1]
    const withoutNode = specifier.startsWith('node:') ? specifier.slice(5) : specifier
    const base = withoutNode.split('/')[0]
    if (NETWORK_MODULES.has(withoutNode) || NETWORK_MODULES.has(base)) found.add(specifier)
  }
  return [...found]
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function detectDataDir(dir) {
  const parent = dirname(dir)
  const hasStore = folder => existsSync(join(folder, 'задачи')) || existsSync(join(folder, 'факты'))
  if (hasStore(parent)) return parent
  if (hasStore(dir)) return dir
  return parent
}

export function createPluginRegistry(options = {}) {
  if (!options.dir) throw new Error('не указана папка плагинов')
  const dir = resolve(options.dir)
  const logger = options.logger ?? null
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS
  const dataDir = options.dataDir ? resolve(options.dataDir) : detectDataDir(dir)

  const plugins = []
  const rejected = []
  const errors = []
  const instances = new Map()
  let loadedOnce = false

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
      // журнал не должен ронять реестр
    }
  }

  function record(pluginName, command, error) {
    const entry = {
      at: new Date().toISOString(),
      plugin: pluginName ?? null,
      command: command ?? null,
      message: messageOf(error)
    }
    errors.push(entry)
    writeToLogger(
      'error',
      `плагин ${pluginName ?? '—'}${command ? `, команда ${command}` : ''}: ${entry.message}`
    )
    return entry
  }

  function reject(folderName, pluginDir, declaredName, messages) {
    const name = typeof declaredName === 'string' && declaredName ? declaredName : folderName
    const reasons = messages.map(message => String(message))
    const entry = {
      name,
      folder: folderName,
      dir: pluginDir,
      reason: reasons.join('; '),
      errors: reasons
    }
    rejected.push(entry)
    record(name, null, new Error(entry.reason))
    return entry
  }

  function readManifest(pluginDir, folderName) {
    const manifestPath = join(pluginDir, 'manifest.json')
    let text
    try {
      text = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      return {
        ok: false,
        declaredName: folderName,
        errors:
          error?.code === 'ENOENT'
            ? ['manifest.json не найден в папке плагина']
            : [`manifest.json не удалось прочитать: ${messageOf(error)}`]
      }
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, declaredName: folderName, errors: ['manifest.json: некорректный JSON'] }
    }

    const result = validateManifest(raw)
    if (!result.ok) {
      return {
        ok: false,
        declaredName: raw && typeof raw === 'object' ? raw.name : folderName,
        errors: result.errors
      }
    }
    return { ok: true, manifest: result.manifest }
  }

  function load() {
    loadedOnce = true
    plugins.length = 0
    rejected.length = 0
    instances.clear()

    const result = () => ({ plugins: [...plugins], rejected: [...rejected] })

    if (!existsSync(dir)) return result()

    let isDirectory = false
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      record(null, null, new Error(`путь плагинов не является папкой: ${dir}`))
      return result()
    }

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      record(null, null, new Error(`не удалось прочитать папку плагинов: ${messageOf(error)}`))
      return result()
    }

    const seen = new Set()
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const pluginDir = join(dir, entry.name)
      const read = readManifest(pluginDir, entry.name)
      if (!read.ok) {
        reject(entry.name, pluginDir, read.declaredName, read.errors)
        continue
      }

      const manifest = read.manifest
      if (seen.has(manifest.name)) {
        reject(entry.name, pluginDir, manifest.name, [`плагин с именем "${manifest.name}" уже загружен`])
        continue
      }

      const entryPath = resolve(pluginDir, manifest.entry)
      if (!isInside(pluginDir, entryPath)) {
        reject(entry.name, pluginDir, manifest.name, ['entry: путь выходит за папку плагина'])
        continue
      }

      let entryStats
      try {
        entryStats = statSync(entryPath)
      } catch {
        reject(entry.name, pluginDir, manifest.name, [`entry: файл "${manifest.entry}" не найден в папке плагина`])
        continue
      }
      if (!entryStats.isFile()) {
        reject(entry.name, pluginDir, manifest.name, [`entry: "${manifest.entry}" не является файлом`])
        continue
      }

      let realPluginDir = pluginDir
      let realEntryPath = entryPath
      try {
        realPluginDir = realpathSync(pluginDir)
        realEntryPath = realpathSync(entryPath)
      } catch {
        // если realpath недоступен, остаются проверенные обычные пути
      }
      if (!isInside(realPluginDir, realEntryPath)) {
        reject(entry.name, pluginDir, manifest.name, ['entry: файл указывает за пределы папки плагина'])
        continue
      }

      seen.add(manifest.name)
      plugins.push({
        ...manifest,
        dir: pluginDir,
        entryPath
      })
    }

    return result()
  }

  function list() {
    if (!loadedOnce) load()
    return plugins.map(plugin => ({
      name: plugin.name,
      version: plugin.version,
      apiVersion: plugin.apiVersion,
      commands: plugin.commands.map(({ id, title }) => ({ id, title }))
    }))
  }

  async function createInstance(plugin) {
    let source
    try {
      source = readFileSync(plugin.entryPath, 'utf8')
    } catch (error) {
      record(plugin.name, null, error)
      throw new Error(`плагин "${plugin.name}" не удалось прочитать: ${messageOf(error)}`)
    }

    const network = networkImports(source)
    if (network.length > 0) {
      const error = new Error(
        `плагину "${plugin.name}" запрещены сетевые вызовы (FR-38): ${network.join(', ')}`
      )
      record(plugin.name, null, error)
      throw error
    }

    let module
    try {
      module = await withTimeout(
        import(pathToFileURL(plugin.entryPath).href),
        timeoutMs,
        `таймаут ${timeoutMs} мс: плагин "${plugin.name}" не ответил`
      )
    } catch (error) {
      record(plugin.name, null, error)
      throw new Error(`плагин "${plugin.name}" не загрузился: ${messageOf(error)}`)
    }

    if (typeof module.default !== 'function') {
      const error = new Error(`плагин "${plugin.name}" должен экспортировать default function(api)`)
      record(plugin.name, null, error)
      throw error
    }

    const api = createPluginApi({
      pluginName: plugin.name,
      pluginDir: plugin.dir,
      dataDir,
      logger
    })

    let instance
    try {
      instance = await withTimeout(
        Promise.resolve().then(() => module.default(api)),
        timeoutMs,
        `таймаут ${timeoutMs} мс: плагин "${plugin.name}" не ответил`
      )
    } catch (error) {
      record(plugin.name, null, error)
      throw new Error(`плагин "${plugin.name}" не запустился: ${messageOf(error)}`)
    }

    let commands
    try {
      commands = instance && typeof instance === 'object' ? instance.commands : undefined
    } catch (error) {
      record(plugin.name, null, error)
      throw new Error(`плагин "${plugin.name}" не вернул объект с commands: ${messageOf(error)}`)
    }
    if (!commands || typeof commands !== 'object') {
      const error = new Error(`плагин "${plugin.name}" не вернул объект с commands`)
      record(plugin.name, null, error)
      throw error
    }

    return instance
  }

  async function getInstance(plugin) {
    if (!instances.has(plugin.name)) {
      instances.set(plugin.name, await createInstance(plugin))
    }
    return instances.get(plugin.name)
  }

  async function run(name, commandId, payload) {
    if (!loadedOnce) load()
    if (typeof name !== 'string' || !name.trim()) throw new Error('имя плагина обязательно')
    if (typeof commandId !== 'string' || !commandId.trim()) throw new Error('команда обязательна: укажите идентификатор')

    const plugin = plugins.find(item => item.name === name)
    if (!plugin) throw new Error(`плагин "${name}" не найден`)

    const instance = await getInstance(plugin)
    let command
    try {
      command = instance.commands[commandId]
    } catch (error) {
      record(name, commandId, error)
      throw new Error(`плагин "${name}", команда "${commandId}": ${messageOf(error)}`)
    }
    if (typeof command !== 'function') {
      throw new Error(`у плагина "${name}" нет команды "${commandId}"`)
    }

    try {
      return await withTimeout(
        Promise.resolve().then(() => command(payload)),
        timeoutMs,
        `таймаут ${timeoutMs} мс: команда "${commandId}" плагина "${name}" не ответила`
      )
    } catch (error) {
      record(name, commandId, error)
      throw new Error(`плагин "${name}", команда "${commandId}": ${messageOf(error)}`)
    }
  }

  return {
    dir,
    dataDir,
    timeoutMs,
    plugins,
    rejected,
    errors,
    load,
    list,
    run
  }
}
