import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createFactStore } from '../../src/facts/store.js'
import { createCafoCache } from '../../src/cafo/cache.js'
import { createServer } from '../../src/server/app.js'

test('ревью собирается, сохраняется файлом и перечисляет пропуски', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'))
  const facts = createFactStore(dir)
  const cafo = createCafoCache(dir)
  const store = createStore(dir)

  facts.apply({
    claim: 'Расчёты берут суммы из биллинга',
    subject: 'Расчёты', relation: 'интеграция', object: 'Биллинг',
    fo: 'Расчёты', sourceType: 'схема', sourceRef: 'page_id=9; version=1'
  })
  cafo.put({ pageId: '9', title: 'КАФО: Расчёты', version: 4, body: '# Расчёты' })
  store.add({ id: 't1', title: 'Согласовать интеграцию', source: 'письмо' })

  const server = createServer({ store, facts, cafo, dataDir: dir })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/review/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diagramDiffs: [{ diagram: 'Расчёты', onlyInDiagram: [{ from: 'Расчёты', to: 'Биллинг' }] }] })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.markdown, /Согласовать интеграцию/)
    assert.match(body.markdown, /Расчёты → Биллинг/)
    assert.ok(body.counts.gaps >= 2)
    assert.ok(existsSync(body.savedTo))
  } finally {
    server.close()
  }
})
