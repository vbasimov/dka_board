export const RANK = {
  ESCALATION: 0,
  DUE_SOON: 1,
  MANAGER: 2,
  HAS_DUE: 3,
  OTHER: 4,
  CLOSED: 9
}

const DAY = 24 * 60 * 60 * 1000

function localDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayKey(now) {
  return localDate(now)
}

export function dueDate(task, now) {
  const raw = task.dueAt
  if (!raw) return null
  if (raw === 'сегодня') return localDate(now)
  if (raw === 'завтра') return localDate(new Date(now.getTime() + DAY))
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return null
}

export function rank(task, now) {
  if (task.status === 'закрыта') return RANK.CLOSED
  if (task.escalation) return RANK.ESCALATION

  const due = dueDate(task, now)
  if (due && due <= localDate(now)) return RANK.DUE_SOON
  if (task.fromManager) return RANK.MANAGER
  if (due) return RANK.HAS_DUE
  return RANK.OTHER
}

export function compareTasks(a, b, now) {
  const byRank = rank(a, now) - rank(b, now)
  if (byRank !== 0) return byRank
  const dueA = dueDate(a, now) ?? '9999-12-31'
  const dueB = dueDate(b, now) ?? '9999-12-31'
  if (dueA !== dueB) return dueA < dueB ? -1 : 1
  return String(a.title).localeCompare(String(b.title), 'ru')
}

export function reasonOf(task, now) {
  if (task.escalation) return 'эскалация'
  const due = dueDate(task, now)
  if (due && due < localDate(now)) return 'просрочено'
  if (due && due === localDate(now)) return 'срок сегодня'
  if (task.fromManager) return 'поручение руководителя'
  if (due) return 'есть срок'
  return 'без срока'
}
