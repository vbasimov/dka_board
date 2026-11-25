import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'
import { createDraftStore } from '../../src/drafts/store.js'
import { createDecisionStore } from '../../src/decisions/store.js'
import { createServer } from '../../src/server/app.js'

test('черновик сохраняется файлом и попадает в решения', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-save-'))
  const drafts = createDraftStore(dir)
  const decisions = createDecisionStore(dir)
  const server = createServer({ store: createStore(dir), drafts, decisions })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'Интеграция с антифродом',
        text: 'Коллеги, интеграция описана в КАФО.',
        citations: [{ factId: 'f1', sourceRef: 'page_id=123; version=14' }]
      })
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.match(body.draft.name, /\.md$/)
    assert.equal(body.decision.source, 'черновик')
    assert.equal(body.decision.sourceRef, body.draft.name)

    const list = await (await fetch(`http://127.0.0.1:${port}/api/drafts/saved`)).json()
    assert.equal(list.items.length, 1)

    const saved = await (await fetch(`http://127.0.0.1:${port}/api/drafts/saved/${encodeURIComponent(body.draft.name)}`)).json()
    assert.match(saved.content, /интеграция описана в КАФО/)

    const debts = await (await fetch(`http://127.0.0.1:${port}/api/decisions?debts=1`)).json()
    assert.equal(debts.debts, 1)
  } finally {
    server.close()
  }
})

test('пустой черновик не сохраняется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'draft-save-'))
  const server = createServer({ store: createStore(dir), drafts: createDraftStore(dir) })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/drafts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  ' })
    })
    assert.equal(response.status, 400)
  } finally {
    server.close()
  }
})
