const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

export function isDue(now, options = {}) {
  const weekday = options.weekday ?? 'пятница'
  const hour = options.hour ?? 16
  const lastRunDate = options.lastRunDate ?? null
  const current = new Date(now)
  const currentWeekday = WEEKDAYS[current.getDay()]
  const currentDate = current.toISOString().slice(0, 10)

  if (currentWeekday !== weekday) return { due: false, reason: `сегодня ${currentWeekday}, отчёт по ${weekday}` }
  if (current.getHours() < hour) return { due: false, reason: `ещё рано: отчёт после ${hour}:00` }
  if (lastRunDate === currentDate) return { due: false, reason: 'за сегодня уже собран' }
  return { due: true, reason: `пора собирать (${weekday}, после ${hour}:00)` }
}

export function startScheduler({ run, now = () => new Date(), intervalMs = 30 * 60 * 1000, options = {} }) {
  let lastRunDate = null
  let timer = null

  async function tick() {
    const moment = now()
    const verdict = isDue(moment, { ...options, lastRunDate })
    if (!verdict.due) return { ran: false, reason: verdict.reason }
    const result = await run(moment)
    lastRunDate = moment.toISOString().slice(0, 10)
    return { ran: true, result }
  }

  timer = setInterval(() => {
    tick().catch(error => console.error('Ревью по расписанию не удалось:', error.message))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    tick,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
