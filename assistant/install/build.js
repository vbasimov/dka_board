import { readdirSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const OUT_DIR = join(ROOT, 'dist')
const INCLUDE = ['bin', 'src', 'ui', 'package.json', 'README.md', 'start.sh', 'start.cmd']

function collect(entry, files = []) {
  const full = join(ROOT, entry)
  if (statSync(full).isDirectory()) {
    for (const child of readdirSync(full)) collect(join(entry, child), files)
    return files
  }
  files.push({ path: entry.replace(/\\/g, '/'), data: readFileSync(full) })
  return files
}

function u16(buffer, value, offset) {
  buffer.writeUInt16LE(value, offset)
}

function u32(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset)
}

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    u32(local, 0x04034b50, 0)
    u16(local, 20, 4)
    u16(local, 0, 6)
    u16(local, 0, 8)
    u16(local, 0, 10)
    u16(local, 0, 12)
    u32(local, crc, 14)
    u32(local, file.data.length, 18)
    u32(local, file.data.length, 22)
    u16(local, name.length, 26)
    u16(local, 0, 28)
    chunks.push(local, name, file.data)

    const entry = Buffer.alloc(46)
    u32(entry, 0x02014b50, 0)
    u16(entry, 20, 4)
    u16(entry, 20, 6)
    u16(entry, 0, 8)
    u16(entry, 0, 10)
    u16(entry, 0, 12)
    u16(entry, 0, 14)
    u32(entry, crc, 16)
    u32(entry, file.data.length, 20)
    u32(entry, file.data.length, 24)
    u16(entry, name.length, 28)
    u16(entry, 0, 30)
    u16(entry, 0, 32)
    u16(entry, 0, 34)
    u16(entry, 0, 36)
    u32(entry, 0, 38)
    u32(entry, offset, 42)
    central.push(entry, name)

    offset += local.length + name.length + file.data.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  u32(end, 0x06054b50, 0)
  u16(end, 0, 4)
  u16(end, 0, 6)
  u16(end, files.length, 8)
  u16(end, files.length, 10)
  u32(end, centralSize, 12)
  u32(end, offset, 16)
  u16(end, 0, 20)

  return Buffer.concat([...chunks, ...central, end])
}

const files = INCLUDE.flatMap(entry => collect(entry))
const archive = buildZip(files)
mkdirSync(OUT_DIR, { recursive: true })
const target = join(OUT_DIR, 'architect-assistant.zip')
writeFileSync(target, archive)

const total = files.reduce((sum, file) => sum + file.data.length, 0)
console.log(`собрано: ${relative(ROOT, target)}`)
console.log(`файлов: ${files.length}, данных: ${Math.round(total / 1024)} КБ, архив: ${Math.round(archive.length / 1024)} КБ`)
for (const file of files) console.log(`  ${file.path}`)
