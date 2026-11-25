import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFromPng, loadDiagram, readDrawioFile } from '../../src/parse/sources.js'
import { parseDrawio } from '../../src/parse/drawio.js'

const FIXTURE = new URL('../fixtures/plain.drawio', import.meta.url)

const EMBEDDED_XML =
  '<mxfile><diagram name="Встроенная"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Kafka" style="shape=cylinder3" vertex="1" parent="1"/>' +
  '<mxCell id="3" value="CRM" vertex="1" parent="1"/>' +
  '<mxCell id="4" value="события" edge="1" parent="1" source="2" target="3"/>' +
  '</root></mxGraphModel></diagram></mxfile>'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), 8 + data.length)
  return chunk
}

function makePng(text, keyword = 'mxfile') {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunks = [pngChunk('IHDR', ihdr)]
  if (text !== null) {
    const payload = Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(text, 'utf8')
    ])
    chunks.push(pngChunk('tEXt', payload))
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat([PNG_SIGNATURE, ...chunks])
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sources-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('читает файл .drawio с диска', () => {
  const xml = readDrawioFile(fileURLToPath(FIXTURE))
  assert.equal(typeof xml, 'string')
  assert.match(xml, /<mxfile/)
  assert.equal(parseDrawio(xml).diagrams[0].nodes.length, 2)
})

test('принимает расширения .xml и .drawio.xml', t => {
  const dir = tempDir(t)
  const xmlPath = join(dir, 'схема.xml')
  const doublePath = join(dir, 'схема.drawio.xml')
  copyFileSync(FIXTURE, xmlPath)
  copyFileSync(FIXTURE, doublePath)
  assert.match(readDrawioFile(xmlPath), /<mxfile/)
  assert.match(readDrawioFile(doublePath), /<mxfile/)
})

test('неизвестное расширение и отсутствующий файл дают русские ошибки', t => {
  const dir = tempDir(t)
  const garbage = join(dir, 'схема.txt')
  writeFileSync(garbage, '<mxfile/>', 'utf8')
  assert.throws(() => readDrawioFile(garbage), /неизвестное расширение файла схемы/)
  assert.throws(() => readDrawioFile(join(dir, 'нет.drawio')), /файл схемы не найден/)
  assert.throws(() => readDrawioFile(''), /не указан путь к файлу схемы/)
})

test('извлекает XML из текстового чанка tEXt с ключом mxfile', () => {
  assert.equal(extractFromPng(makePng(EMBEDDED_XML)), EMBEDDED_XML)
})

test('раскодирует URL-кодированный XML, как во встроенных диаграммах draw.io', () => {
  const png = makePng(encodeURIComponent(EMBEDDED_XML))
  assert.equal(extractFromPng(png), EMBEDDED_XML)
})

test('обычный PNG без исходных данных не даёт XML', t => {
  const dir = tempDir(t)
  const png = join(dir, 'обычная.png')
  writeFileSync(png, makePng(null))
  assert.equal(extractFromPng(makePng(null)), null)
  assert.deepEqual(loadDiagram({ path: png }), {
    unsupported: true,
    reason: 'это изображение без исходных данных схемы'
  })
})

test('бинарный мусор не распознаётся как PNG и как схема', t => {
  const dir = tempDir(t)
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
  assert.equal(extractFromPng(garbage), null)
  assert.equal(extractFromPng(Buffer.from('совсем не png', 'utf8')), null)
  assert.equal(extractFromPng(Buffer.alloc(0)), null)

  const broken = join(dir, 'мусор.png')
  writeFileSync(broken, garbage)
  assert.deepEqual(loadDiagram({ path: broken }), {
    unsupported: true,
    reason: 'это изображение без исходных данных схемы'
  })
  assert.throws(() => loadDiagram({ path: join(dir, 'мусор.bin') }), /неизвестное расширение/)
})

test('loadDiagram читает .drawio и возвращает XML', t => {
  const dir = tempDir(t)
  const path = join(dir, 'копия.drawio')
  copyFileSync(FIXTURE, path)
  const result = loadDiagram({ path })
  assert.equal(result.unsupported, undefined)
  assert.match(result.xml, /<mxfile/)
})

test('loadDiagram и parseDrawio вместе дают узлы и рёбра', t => {
  const dir = tempDir(t)
  const path = join(dir, 'схема.drawio.png')
  writeFileSync(path, makePng(EMBEDDED_XML))
  const loaded = loadDiagram({ path })
  assert.equal(loaded.unsupported, undefined)
  const [diagram] = parseDrawio(loaded.xml).diagrams
  assert.deepEqual(diagram.nodes.map(node => node.label), ['Kafka', 'CRM'])
  assert.equal(diagram.nodes[0].kind, 'хранилище')
  assert.equal(diagram.edges.length, 1)
  assert.equal(diagram.edges[0].from, '2')
  assert.equal(diagram.edges[0].to, '3')
})
