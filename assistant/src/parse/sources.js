import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_EXTENSIONS = new Set(['.drawio', '.xml', '.drawio.xml'])
const UNSUPPORTED_IMAGE_REASON = 'это изображение без исходных данных схемы'

function resolvePath(value) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new Error('путь к файлу схемы должен быть локальным')
    return fileURLToPath(value)
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('не указан путь к файлу схемы')
  }
  return value
}

function extensionOf(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.drawio.xml')) return '.drawio.xml'
  return extname(lower)
}

function readFile(filePath) {
  try {
    return readFileSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`файл схемы не найден: ${filePath}`)
    throw new Error(`не удалось прочитать файл схемы: ${filePath}`)
  }
}

export function readDrawioFile(filePath) {
  const path = resolvePath(filePath)
  const extension = extensionOf(path)
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw new Error('неизвестное расширение файла схемы: ожидается .drawio, .xml или .drawio.xml')
  }
  return readFile(path).toString('utf8')
}

function normalizeXml(raw) {
  const text = raw.trim()
  if (!text) return null
  const candidates = [text]
  try {
    candidates.push(decodeURIComponent(text))
  } catch {
    // не URL-кодирование — оставляем только исходный вариант
  }
  for (const candidate of candidates) {
    const value = candidate.trim()
    if (value.includes('<mxfile') || value.includes('<mxGraphModel')) return value
  }
  return null
}

function textChunkValue(data) {
  const separator = data.indexOf(0)
  if (separator < 0) return null
  const keyword = data.subarray(0, separator).toString('latin1')
  if (keyword !== 'mxfile') return null
  return data.subarray(separator + 1).toString('utf8')
}

export function extractFromPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) return null
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null

  let offset = PNG_SIGNATURE.length
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > buffer.length) return null

    if (type === 'tEXt') {
      const value = textChunkValue(buffer.subarray(dataStart, dataEnd))
      if (value !== null) {
        const xml = normalizeXml(value)
        if (xml) return xml
      }
    }

    if (type === 'IEND') break
    offset = dataEnd + 4
  }
  return null
}

export function loadDiagram(input = {}) {
  const path = resolvePath(input?.path)
  const extension = extensionOf(path)
  if (extension === '.png') {
    const xml = extractFromPng(readFile(path))
    return xml ? { xml } : { unsupported: true, reason: UNSUPPORTED_IMAGE_REASON }
  }
  return { xml: readDrawioFile(path) }
}

export function fileDigest(filePath) {
  const path = resolvePath(filePath)
  return createHash('sha256').update(readFile(path)).digest('hex')
}
