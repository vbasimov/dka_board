import test from 'node:test'
import assert from 'node:assert/strict'
import { isDue, startScheduler } from '../../src/review/schedule.js'

const friday = new Date(2026, 10, 27, 16, 30)
const fridayMorning = new Date(2026, 10, 27, 9, 0)
const saturday = new Date(2026, 10, 28, 16, 30)

test('в пятницу после 16:00 отчёт нужен', () => {
  const verdict = isDue(friday, {})
  assert.equal(verdict.due, true)
})

test('в пятницу утром отчёт ещё не нужен', () => {
  const verdict = isDue(fridayMorning, {})
  assert.equal(verdict.due, false)
  assert.match(verdict.reason, /рано/)
})

test('в субботу отчёт не собирается', () => {
  const verdict = isDue(saturday, {})
  assert.equal(verdict.due, false)
  assert.match(verdict.reason, /пятница/)
})

test('повторно за тот же день отчёт не собирается', () => {
  const verdict = isDue(friday, { lastRunDate: '2026-11-27' })
  assert.equal(verdict.due, false)
  assert.match(verdict.reason, /за сегодня/)
})

test('день и час можно перенастроить', () => {
  assert.equal(isDue(saturday, { weekday: 'суббота', hour: 10 }).due, true)
})

test('планировщик собирает отчёт один раз в день', async () => {
  let calls = 0
  const scheduler = startScheduler({
    run: async () => { calls += 1; return { ok: true } },
    now: () => friday,
    intervalMs: 60_000
  })
  try {
    const first = await scheduler.tick()
    const second = await scheduler.tick()
    assert.equal(first.ran, true)
    assert.equal(second.ran, false)
    assert.equal(calls, 1)
  } finally {
    scheduler.stop()
  }
})
