import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDrawio } from '../../src/parse/drawio.js'

const read = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

test('разбирает простую схему: вершины, подписи, ребро', () => {
  const { diagrams } = parseDrawio(read('plain.drawio'))
  assert.equal(diagrams.length, 1)
  const [d] = diagrams
  assert.deepEqual(d.nodes.map(n => n.label), ['Kafka', 'CRM'])
  assert.equal(d.nodes[0].kind, 'хранилище')
  assert.equal(d.edges.length, 1)
  assert.equal(d.edges[0].label, 'события заказа')
  assert.equal(d.edges[0].dashed, true)
  assert.equal(d.unparsed.length, 0)
})

test('разделяет мультистраничный файл на отдельные диаграммы', () => {
  const { diagrams } = parseDrawio(read('multi.drawio'))
  assert.equal(diagrams.length, 3)
  assert.deepEqual(diagrams.map(d => d.name), ['Платежи', 'Расчёты', 'Риски'])
  assert.equal(diagrams[0].nodes[0].kind, 'сервис')
  assert.equal(diagrams[1].nodes[1].kind, 'внешняя система')
  assert.equal(diagrams[2].nodes[0].kind, 'сервис')
  assert.equal(diagrams[2].nodes[1].kind, 'актор')
})

test('распаковывает сжатую диаграмму', () => {
  const { diagrams } = parseDrawio(read('compressed.drawio'))
  assert.equal(diagrams.length, 1)
  assert.equal(diagrams[0].name, 'Сжатая')
  assert.ok(diagrams[0].nodes.length >= 2)
  assert.equal(diagrams[0].edges.length, 1)
})

test('ребро без концов попадает в unparsed, а не выдумывается', () => {
  const xml =
    '<mxfile><diagram name="x"><mxGraphModel><root>' +
    '<mxCell id="2" value="A" vertex="1" parent="1"/>' +
    '<mxCell id="9" edge="1" style="" parent="1"/>' +
    '</root></mxGraphModel></diagram></mxfile>'
  const [d] = parseDrawio(xml).diagrams
  assert.equal(d.edges.length, 0)
  assert.deepEqual(d.unparsed.map(u => u.id), ['9'])
})

test('контейнер становится зоной, а не обычной вершиной', () => {
  const xml =
    '<mxfile><diagram name="z"><mxGraphModel><root>' +
    '<mxCell id="z1" value="ФО Платежи" style="swimlane" vertex="1" parent="1"/>' +
    '<mxCell id="n1" value="Kafka" style="shape=cylinder3" vertex="1" parent="z1"/>' +
    '</root></mxGraphModel></diagram></mxfile>'
  const [d] = parseDrawio(xml).diagrams
  assert.deepEqual(d.zones.map(z => z.label), ['ФО Платежи'])
  assert.deepEqual(d.nodes.map(n => n.label), ['Kafka'])
  assert.equal(d.nodes[0].parent, 'z1')
})

test('подписи очищаются от разметки и сущностей', () => {
  const xml =
    '<mxfile><diagram name="l"><mxGraphModel><root>' +
    '<mxCell id="1" value="&lt;b&gt;Сервис&lt;/b&gt;&lt;br&gt;платежей" vertex="1" parent="0"/>' +
    '</root></mxGraphModel></diagram></mxfile>'
  const [d] = parseDrawio(xml).diagrams
  assert.equal(d.nodes[0].label, 'Сервис платежей')
})
