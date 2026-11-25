import { posix, win32 } from 'node:path'

export const SUPPORTED_API_VERSIONS = ['1']

export const PLUGIN_HOOKS = ['onStart', 'onTaskCreated', 'onDraftBuilt']

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeEntry(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  if (posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)) return null
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) return null

  const normalized = posix.normalize(trimmed.replace(/\\/g, '/'))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  if (normalized.split('/').includes('..')) return null
  return normalized
}

function validateCommands(value, errors) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('commands: ожидается массив объектов {id, title}')
    return []
  }

  const commands = []
  const seen = new Set()
  value.forEach((command, index) => {
    if (!isPlainObject(command)) {
      errors.push(`commands[${index}]: ожидается объект {id, title}`)
      return
    }
    if (!nonEmptyString(command.id)) {
      errors.push(`commands[${index}].id: обязательное непустое поле`)
    } else if (seen.has(command.id)) {
      errors.push(`commands[${index}].id: значение "${command.id}" повторяется`)
    } else {
      seen.add(command.id)
    }
    if (!nonEmptyString(command.title)) {
      errors.push(`commands[${index}].title: обязательное непустое поле`)
    }
    if (nonEmptyString(command.id) && nonEmptyString(command.title)) {
      commands.push({ id: command.id, title: command.title })
    }
  })
  return commands
}

function validateHooks(value, errors) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`hooks: ожидается массив; допустимые значения: ${PLUGIN_HOOKS.join(', ')}`)
    return []
  }

  const hooks = []
  const seen = new Set()
  value.forEach((hook, index) => {
    if (!PLUGIN_HOOKS.includes(hook)) {
      errors.push(`hooks[${index}]: неизвестный хук ${JSON.stringify(hook)}; допустимые значения: ${PLUGIN_HOOKS.join(', ')}`)
      return
    }
    if (seen.has(hook)) {
      errors.push(`hooks[${index}]: хук "${hook}" повторяется`)
      return
    }
    seen.add(hook)
    hooks.push(hook)
  })
  return hooks
}

export function validateManifest(object) {
  if (!isPlainObject(object)) {
    return { ok: false, errors: ['манифест должен быть объектом'] }
  }

  const errors = []

  if (!nonEmptyString(object.name)) {
    errors.push('name: обязательное поле, строка в kebab-case (например, review-helper)')
  } else if (!NAME_PATTERN.test(object.name)) {
    errors.push('name: ожидается kebab-case: строчные латинские буквы и цифры через дефис')
  }

  if (!nonEmptyString(object.version)) {
    errors.push('version: обязательное поле, версия в формате semver (например, 1.0.0)')
  } else if (!SEMVER_PATTERN.test(object.version)) {
    errors.push('version: ожидается версия в формате semver (например, 1.0.0)')
  }

  if (!nonEmptyString(object.apiVersion)) {
    errors.push(`apiVersion: обязательное поле, строка; поддерживается только "1"`)
  } else if (typeof object.apiVersion !== 'string' || !SUPPORTED_API_VERSIONS.includes(object.apiVersion)) {
    errors.push(`apiVersion: поддерживается только "1"`)
  }

  const entry = normalizeEntry(object.entry)
  if (!nonEmptyString(object.entry)) {
    errors.push('entry: обязательное поле, путь к файлу внутри папки плагина')
  } else if (entry === null) {
    errors.push('entry: путь должен быть относительным и оставаться внутри папки плагина')
  }

  const commands = validateCommands(object.commands, errors)
  const hooks = validateHooks(object.hooks, errors)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    manifest: {
      name: object.name,
      version: object.version,
      apiVersion: object.apiVersion,
      entry,
      commands,
      hooks
    }
  }
}
