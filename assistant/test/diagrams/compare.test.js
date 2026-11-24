import test from 'node:test'
import assert from 'node:assert/strict'
import { compareIntegrations, integrationKey } from '../../src/diagrams/compare.js'

const diagram = {
  nodes: [
    { id: '2', label: 'Сервис платежей' },
    { id: '3', label: 'Kafka' },
    { id: '4', label: 'Биллинг' }
  ],
  edges: [
    { from: '2', to: '3', label: 'события', dashed: true },
    { from: '2', to: '4', label: 'суммы' }
  ],
  unparsed: []
}

test('связь из схемы, которой нет в КАФО, попадает в «только в схеме»', () => {
  const result = compareIntegrations({ diagram, cafo: ['Сервис платежей → Kafka'] })
  assert.equal(result.onlyInDiagram.length, 1)
  assert.equal(result.onlyInDiagram[0].to, 'Биллинг')
  assert.equal(result.summary.missingInCafo, 1)
})

test('связь из КАФО, которой нет в схеме, попадает в «только в КАФО»', () => {
  const result = compareIntegrations({ diagram, cafo: ['Kafka → Хранилище'] })
  assert.equal(result.onlyInCafo.length, 1)
  assert.equal(result.onlyInCafo[0].from, 'Kafka')
})

test('сравнение не зависит от регистра и лишних пробелов', () => {
  const result = compareIntegrations({ diagram, cafo: ['сервис   платежей → kafka'] })
  assert.equal(result.matched.length, 1)
  assert.equal(result.onlyInCafo.length, 0)
  assert.equal(integrationKey('Сервис  Платежей', 'KAFKA'), 'сервис платежей→kafka')
})

test('связи без подписи участника не выдумываются, а уходят в «требует взгляда»', () => {
  const broken = { nodes: [{ id: '2', label: 'Сервис' }], edges: [{ from: '2', to: '9' }], unparsed: [] }
  const result = compareIntegrations({ diagram: broken, cafo: [] })
  assert.equal(result.onlyInDiagram.length, 0)
  assert.equal(result.needsEyes.length, 1)
  assert.match(result.needsEyes[0].reason, /подпись/)
})

test('неразобранные связи исходной схемы попадают в «требует взгляда»', () => {
  const withUnparsed = { ...diagram, unparsed: [{ id: '9', reason: 'у ребра нет начала или конца' }] }
  const result = compareIntegrations({ diagram: withUnparsed, cafo: ['Сервис платежей → Kafka'] })
  assert.ok(result.needsEyes.some(item => item.id === '9'))
})

test('совпавшие связи не попадают ни в один из списков расхождений', () => {
  const result = compareIntegrations({
    diagram,
    cafo: ['Сервис платежей → Kafka', 'Сервис платежей → Биллинг']
  })
  assert.equal(result.onlyInDiagram.length, 0)
  assert.equal(result.onlyInCafo.length, 0)
  assert.equal(result.matched.length, 2)
})
