const REQUIRED_FIELDS = ['id', 'title', 'when', 'body']

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g

export const TEMPLATES = [
  {
    id: 'diagram-request',
    title: 'Запрос схемы',
    when: 'Нужна актуальная схема компонентов или потоков данных перед обсуждением решения.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Чтобы обсуждать решение предметно, нужна схема по запросу: {{request}}.',
      'Прошу прислать актуальную схему компонентов и потоков данных, а также указать владельца схемы.',
      '',
      'Ориентир по сроку: {{deadline}}.',
      'Источник, на который будем опираться: {{source}}.',
      '',
      'Если схема есть, но устарела, пришлите её с пометкой — зафиксируем расхождения отдельно.'
    ].join('\n')
  },
  {
    id: 'decision-rationale',
    title: 'Обоснование решения',
    when: 'Нужно объяснить, почему выбрано решение и на чём оно держится.',
    body: [
      'Коллеги, добрый день.',
      '',
      'По запросу «{{request}}» предлагаю решение: {{decision}}.',
      '',
      'Обоснование:',
      '— что нашли и проверили: {{found}};',
      '— на какой источник опираемся: {{source}};',
      '— какие ограничения учитываем: срок {{deadline}}.',
      '',
      'Решение обратимо, если появятся новые данные. Прошу зафиксировать его в КАФО и сообщить, если видите противоречие.'
    ].join('\n')
  },
  {
    id: 'refusal-with-alternative',
    title: 'Отказ с альтернативой',
    when: 'Запрос выполнить в текущем виде нельзя, но есть рабочий обходной вариант.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Запрос «{{request}}» в текущем виде выполнить не можем: {{reason}}.',
      'Предлагаю альтернативу: {{alternative}}.',
      '',
      'Что это даёт: результат можно получить к {{deadline}}, без риска для существующих интеграций.',
      'Источник ограничений: {{source}}.',
      '',
      'Если альтернатива не подходит, обсудим другой вариант — напишите, что для вас критично.'
    ].join('\n')
  },
  {
    id: 'data-request',
    title: 'Запрос данных',
    when: 'Для проработки вопроса не хватает данных или выгрузки из системы-источника.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Для проработки «{{request}}» нужны данные: {{data}}.',
      'Прошу предоставить их в виде выгрузки или ссылки на источник.',
      '',
      'Нужно до {{deadline}}. Со стороны источника: {{source}}.',
      'Если данных нет или они неполные, скажите об этом прямо — тогда зафиксируем допущение и не будем выдавать его за факт.'
    ].join('\n')
  },
  {
    id: 'integration-approval',
    title: 'Согласование интеграции',
    when: 'Интеграция проверена и готова к подтверждению принимающей стороной.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Согласовываю интеграцию по запросу «{{request}}».',
      'Что проверил: {{found}}.',
      'Контракт и владельцы согласованы, источник: {{source}}.',
      '',
      'Ограничения: {{constraints}}.',
      'Прошу подтвердить готовность принимающей стороны до {{deadline}}.',
      '',
      'После подтверждения обновлю схему и добавлю запись в КАФО.'
    ].join('\n')
  },
  {
    id: 'deadline-shift',
    title: 'Перенос срока',
    when: 'Срок срывается по объективной причине и нужен явный перенос с планом.',
    body: [
      'Коллеги, добрый день.',
      '',
      'По запросу «{{request}}» вынужден перенести срок с {{deadline}} на {{newDeadline}}.',
      'Причина: {{reason}}.',
      'Что уже сделано: {{found}}.',
      '',
      'Что нужно, чтобы уложиться в новый срок: {{action}}.',
      'Источник по текущему статусу: {{source}}.',
      '',
      'Если перенос критичен, прошу явно сообщить — зафиксируем риск и решение.'
    ].join('\n')
  },
  {
    id: 'escalation',
    title: 'Эскалация',
    when: 'Вопрос заблокирован и не решается на текущем уровне ответственности.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Эскалирую вопрос по «{{request}}»: {{blocker}}.',
      'Решение не удаётся принять на текущем уровне, потому что {{reason}}.',
      '',
      'Что уже сделано: {{found}}.',
      'Нужно решение до {{deadline}}; от кого: {{owner}}.',
      'Источник: {{source}}.',
      '',
      'Прошу назначить ответственного и зафиксировать решение — дальше работа останавливается.'
    ].join('\n')
  },
  {
    id: 'security-requirements',
    title: 'Новые требования безопасности',
    when: 'Появились обязательные требования ИБ, которые меняют решение или сроки.',
    body: [
      'Коллеги, добрый день.',
      '',
      'По «{{request}}» появились новые требования безопасности: {{requirements}}.',
      'Основание: {{source}}.',
      'Срок учёта требований: {{deadline}}.',
      '',
      'Что меняется в решении: {{impact}}.',
      'Прошу подтвердить, что требования полные; если нет — дайте список до срока.',
      '',
      'Пока требования не подтверждены, решение остаётся в статусе «требует проверки».'
    ].join('\n')
  },
  {
    id: 'cafo-question',
    title: 'Вопрос по КАФО',
    when: 'Данные на странице КАФО расходятся с фактами или требуют подтверждения.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Вопрос по странице КАФО: {{cafoPage}}.',
      'Что именно не сходится: {{question}}.',
      '',
      'По моим данным: {{found}}.',
      'Источник: {{source}}.',
      '',
      'Прошу подтвердить или опровергнуть со ссылкой на версию страницы до {{deadline}}.',
      'Пока ответа нет, считаю текущую версию не подтверждённой.'
    ].join('\n')
  },
  {
    id: 'committee-request',
    title: 'Запрос на комитет',
    when: 'Решение требует обсуждения и фиксации на архитектурном комитете.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Прошу включить в повестку комитета вопрос «{{request}}».',
      'Решение, которое требуется: {{decision}}.',
      'Комитет: {{committeeDate}}.',
      '',
      'Материалы: {{found}}.',
      'Источник: {{source}}.',
      '',
      'Формат — короткий доклад и один слайд с вариантами. Если нужен другой формат, скажите до {{deadline}}.'
    ].join('\n')
  },
  {
    id: 'answer-analysts',
    title: 'Ответ аналитикам',
    when: 'Аналитики просят подтвердить вводные для требований или модели данных.',
    body: [
      'Коллеги, добрый день.',
      '',
      'Отвечаю на вопрос аналитиков по «{{request}}».',
      'Что подтверждено: {{found}}.',
      'Источник: {{source}}.',
      '',
      'Что пока не подтверждено: {{unknown}} — это допущение, а не факт.',
      'Ограничение по срокам: {{deadline}}.',
      '',
      'Если нужна выгрузка или уточнение, напишите — подготовлю.'
    ].join('\n')
  },
  {
    id: 'answer-adjacent-team',
    title: 'Ответ смежной команде',
    when: 'Смежная команда задала вопрос по границам ответственности или интеграции.',
    body: [
      'Коллеги, добрый день.',
      '',
      'По запросу смежной команды «{{request}}» отвечаю: {{answer}}.',
      'Основание: {{found}}.',
      'Источник: {{source}}.',
      '',
      'Что от вас нужно: {{action}} до {{deadline}}.',
      'Если что-то расходится с вашим пониманием, пришлите свои вводные — сверю и обновлю ответ.'
    ].join('\n')
  }
]

function placeholdersIn(text) {
  return [...String(text).matchAll(PLACEHOLDER_PATTERN)].map(match => match[1].trim())
}

export function listTemplates() {
  return TEMPLATES.map(({ id, title, when }) => ({ id, title, when }))
}

export function getTemplate(id) {
  const key = String(id ?? '').trim()
  const template = TEMPLATES.find(item => item.id === key)
  if (!template) throw new Error(`шаблон ${key} не найден`)
  return template
}

export function fillTemplate(id, values = {}) {
  const template = getTemplate(id)
  const source = values ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('значения подстановок должны быть объектом')
  }

  const missing = []
  const text = template.body.replace(PLACEHOLDER_PATTERN, (placeholder, rawKey) => {
    const key = rawKey.trim()
    const value = source[key]
    const isFilled = value !== undefined && value !== null && String(value).trim() !== ''
    if (isFilled) return String(value)
    if (!missing.includes(key)) missing.push(key)
    return placeholder
  })

  return { text, missing }
}

export function validateTemplates() {
  const errors = []

  if (!Array.isArray(TEMPLATES)) {
    return { ok: false, errors: ['шаблоны должны быть массивом'] }
  }

  const seen = new Set()

  TEMPLATES.forEach((template, index) => {
    const isObject = template !== null && typeof template === 'object' && !Array.isArray(template)
    if (!isObject) {
      errors.push(`шаблон #${index + 1}: ожидается объект с полями ${REQUIRED_FIELDS.join(', ')}`)
      return
    }

    const id = typeof template.id === 'string' ? template.id.trim() : ''
    const label = id ? `шаблон «${id}»` : `шаблон #${index + 1}`

    for (const field of REQUIRED_FIELDS) {
      if (typeof template[field] !== 'string' || template[field].trim() === '') {
        errors.push(`${label}: отсутствует обязательное поле «${field}»`)
      }
    }

    if (id && !ID_PATTERN.test(id)) {
      errors.push(`${label}: id должен быть в kebab-case`)
    }

    if (id) {
      if (seen.has(id)) errors.push(`${label}: id повторяется`)
      else seen.add(id)
    }

    if (typeof template.when === 'string' && /[\r\n]/.test(template.when)) {
      errors.push(`${label}: поле «when» должно быть одной строкой`)
    }

    if (typeof template.body === 'string') {
      for (const key of placeholdersIn(template.body)) {
        if (key === '') errors.push(`${label}: пустая подстановка в тексте`)
      }
    }
  })

  return { ok: errors.length === 0, errors }
}
