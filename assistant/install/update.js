import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyManifest } from '../src/bundle/integrity.js'
import { createReleaseManager } from './rollback.js'

function unzip(args) {
  return new Promise((resolve, reject) => {
    execFile('unzip', args, { timeout: 120000 }, error => {
      if (error) reject(new Error(`распаковка не удалась: ${error.message}`))
      else resolve()
    })
  })
}

export async function readArchiveVersion(archivePath) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-p', archivePath, 'manifest.json'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error('в архиве нет manifest.json: версия не определена'))
        return
      }
      try {
        const manifest = JSON.parse(stdout)
        resolve({ version: String(manifest.version ?? ''), manifest })
      } catch {
        reject(new Error('manifest.json в архиве повреждён'))
      }
    })
  })
}

export async function installRelease({ archivePath, releasesDir, pointerFile, extract = async (archive, target) => unzip(['-q', archive, '-d', target]), readVersion = readArchiveVersion }) {
  if (!existsSync(archivePath)) throw new Error(`архив не найден: ${archivePath}`)
  const { version, manifest } = await readVersion(archivePath)
  if (!version) throw new Error('в манифесте не указана версия')

  const target = join(releasesDir, version)
  mkdirSync(target, { recursive: true })
  await extract(archivePath, target)

  const check = verifyManifest(target, manifest)
  if (!check.ok) {
    return {
      ok: false,
      version,
      reason: `целостность не подтверждена: ${[...check.missing, ...check.modified].join(', ')}`,
      path: target
    }
  }

  const manager = createReleaseManager({ releasesDir, pointerFile })
  manager.activate(version)
  return { ok: true, version, path: target, checked: check.checked }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flagIndex = process.argv.indexOf('--archive')
  const releasesDir = process.env.AA_RELEASES ?? fileURLToPath(new URL('../releases/', import.meta.url))
  const pointerFile = process.env.AA_CURRENT ?? fileURLToPath(new URL('../current', import.meta.url))
  try {
    if (process.argv.includes('--rollback')) {
      const manager = createReleaseManager({ releasesDir, pointerFile })
      console.log(`откат на версию ${manager.rollback()}`)
    } else if (flagIndex > 0) {
      const result = await installRelease({ archivePath: process.argv[flagIndex + 1], releasesDir, pointerFile })
      if (!result.ok) {
        console.error(`версия ${result.version} не активирована: ${result.reason}`)
        process.exit(1)
      }
      console.log(`установлена версия ${result.version}, проверено файлов: ${result.checked}`)
    } else {
      console.error('использование: node install/update.js --archive <архив> | --rollback')
      process.exit(2)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
