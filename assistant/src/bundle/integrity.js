import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function collectFiles(dir, base = dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      collectFiles(full, base, files)
      continue
    }
    if (entry === 'manifest.json') continue
    files.push({ path: relative(base, full).split('\\').join('/'), sha256: sha256(readFileSync(full)) })
  }
  return files
}

export function buildManifest(dir, meta = {}) {
  return {
    version: meta.version ?? '0.0.0',
    generatedAt: new Date().toISOString(),
    files: collectFiles(dir).sort((a, b) => a.path.localeCompare(b.path))
  }
}

export function verifyManifest(dir, manifest) {
  const missing = []
  const modified = []
  for (const file of manifest.files ?? []) {
    const full = join(dir, file.path)
    if (!existsSync(full)) {
      missing.push(file.path)
      continue
    }
    if (sha256(readFileSync(full)) !== file.sha256) modified.push(file.path)
  }
  return {
    ok: missing.length === 0 && modified.length === 0,
    checked: (manifest.files ?? []).length,
    missing,
    modified
  }
}
