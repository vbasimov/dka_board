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

export const DEFAULT_ORDER = ['escalation', 'due', 'manager', 'hasDue', 'other']

export function normalizeOrder(order) {
  if (!Array.isArray(order)) return DEFAULT_ORDER
  const known = order.filter(group => DEFAULT_ORDER.includes(group))
  const rest = DEFAULT_ORDER.filter(group => !known.includes(group))
  return [...known, ...rest]
}

export function groupOf(task, now) {
  if (task.status === 'закрыта') return 'closed'
  if (task.escalation) return 'escalation'
  const due = dueDate(task, now)
  if (due && due <= localDate(now)) return 'due'
  if (task.fromManager) return 'manager'
  if (due) return 'hasDue'
  return 'other'
}

export function rank(task, now, options = {}) {
  const group = groupOf(task, now)
  if (group === 'closed') return RANK.CLOSED
  const order = options.order ? normalizeOrder(options.order) : DEFAULT_ORDER
  const index = order.indexOf(group)
  return index === -1 ? order.length : index
}

export function compareTasks(a, b, now, options = {}) {
  const byRank = rank(a, now, options) - rank(b, now, options)
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
