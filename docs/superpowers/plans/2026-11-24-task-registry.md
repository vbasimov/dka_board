# Реестр задач и экран «Сегодня» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающий кусок продукта: задача попадает в реестр из письма или вручную, экран «Сегодня» показывает три числа и три дела в правильном порядке приоритета.

**Architecture:** Домен (задача, приоритет, разбор письма) — чистые функции без ввода-вывода, проверяются табличными тестами. Хранилище и сервер — тонкие обёртки. Интерфейс собирает разметку функциями, возвращающими строки, поэтому проверяется без браузера.

**Tech Stack:** Node.js 20+, `node:test`, статичный HTML/JS без сборки.

**Spec:** `docs/requirements.md` (FR-01–FR-10), `docs/product-experience.md` (раздел 3), `docs/architecture.md`, `docs/fact-ontology.md`

## Global Constraints

- Задача без источника не создаётся: `source` обязателен, иначе исключение с русским текстом.
- Приоритет строго: эскалация → срок → поручение руководителя. Порядок проверяется 15 эталонами (FR-07), совпадение 100%.
- Никаких внешних зависимостей и сетевых вызовов, кроме `127.0.0.1`.
- Все суммы и даты — в локальном часовом поясе, формат ДД.ММ.ГГГГ в интерфейсе.
- Ничего не удаляется: закрытые задачи переходят в состояние `закрыта`, файл остаётся.

## Review Focus

- Задача из письма без явного срока: срок не выдумывается, поле остаётся пустым, карточка не попадает в «сегодня».
- Два письма об одном и том же: дедупликация по внешнему идентификатору, иначе реестр начнёт врать.
- Просроченная задача без эскалации: остаётся видимой, но не выше эскалации.
- Поручение руководителя без срока: считается срочным, но не выше задачи с дедлайном сегодня.
- Задача, созданная в 23:59: «сегодня» определяется по локальной дате, а не по UTC.

---

### Task 1: Модель задачи и валидация

**Files:**
- Create: `assistant/src/domain/task.js`
- Create: `assistant/test/domain/task.test.js`

**Interfaces:**
- Produces: `makeTask(input) -> Task` с полями `{ id, title, source, sourceRef, dueAt, owner, fromManager, escalation, status, createdAt }`; бросает `Error('источник обязателен')` при отсутствии `source`; статус по умолчанию `новая`.

- [ ] **Step 1: Написать падающие тесты**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTask } from '../src/domain/task.js'

test('создаёт задачу с обязательным источником', () => {
  const t = makeTask({ title: 'Ответить антифроду', source: 'письмо', sourceRef: 'msg-1' })
  assert.equal(t.status, 'новая')
  assert.equal(t.source, 'письмо')
  assert.ok(t.id.length > 0)
  assert.ok(t.createdAt)
})

test('без источника падает с понятным текстом', () => {
  assert.throws(() => makeTask({ title: 'Без источника' }), /источник обязателен/)
})

test('срок приводится к дате без времени, если время не указано', () => {
  const t = makeTask({ title: 'x', source: 'письмо', dueAt: '2026-11-24' })
  assert.equal(t.dueAt, '2026-11-24')
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/domain/task.test.js`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать `makeTask`**

Идентификатор — `crypto.randomUUID()`. `createdAt` — ISO-строка с локальным смещением. Никакой нормализации текста заголовка: обрезка пробелов и всё.

- [ ] **Step 4: Тесты до зелёного и коммит**

Run: `cd assistant && node --test test/domain/task.test.js`
Expected: PASS, 3 теста.
Run: `git add assistant && git commit -m "feat: модель задачи с обязательным источником"`

---

### Task 2: Приоритет

**Files:**
- Create: `assistant/src/domain/priority.js`
- Create: `assistant/test/domain/priority.test.js`

**Interfaces:**
- Produces: `compareTasks(a, b, now) -> number` для сортировки; `rank(task, now) -> number`, где меньшее значение выше.
- Правило: `эскалация` = 0, `срок сегодня или просрочен` = 1, `поручение руководителя` = 2, `есть срок` = 3, `остальное` = 4.

- [ ] **Step 1: Написать таблицу из 15 эталонов**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { rank } from '../src/domain/priority.js'

const now = new Date('2026-11-24T10:00:00+03:00')
const t = (o) => ({ dueAt: null, escalation: false, fromManager: false, ...o })

test('порядок приоритета', () => {
  assert.equal(rank(t({ escalation: true, dueAt: '2027-01-01' }), now), 0)
  assert.equal(rank(t({ dueAt: '2026-11-24' }), now), 1)
  assert.equal(rank(t({ dueAt: '2026-11-20' }), now), 1)
  assert.equal(rank(t({ fromManager: true }), now), 2)
  assert.equal(rank(t({ dueAt: '2026-12-01' }), now), 3)
  assert.equal(rank(t({}), now), 4)
})

test('эскалация важнее срока, срок важнее поручения', () => {
  const esc = t({ escalation: true, dueAt: '2027-01-01' })
  const due = t({ dueAt: '2026-11-24' })
  const mgr = t({ fromManager: true })
  assert.ok(rank(esc, now) < rank(due, now))
  assert.ok(rank(due, now) < rank(mgr, now))
})

test('поручение руководителя с просрочкой остаётся в группе срока', () => {
  assert.equal(rank(t({ fromManager: true, dueAt: '2026-11-01' }), now), 1)
})
```

Дополнить таблицу до 15 строк по образцу FR-07: эскалация с дедлайном и без, срок сегодня, срок вчера, срок завтра, поручение с далёким сроком, поручение без срока, задача без срока и без флагов, закрытая задача исключается из выдачи.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/domain/priority.test.js`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать `rank` и `compareTasks`**

Сравнение дат — по локальной дате: строки `YYYY-MM-DD` сравниваются как строки, это корректно и не зависит от пояса. `now` передаётся явно, внутри функции `new Date()` не вызывается.

- [ ] **Step 4: Тесты до зелёного и коммит**

Run: `cd assistant && node --test test/domain/priority.test.js`
Expected: PASS, 15 эталонов.
Run: `git add assistant && git commit -m "feat: приоритет задач по правилу эскалация-срок-поручение"`

---

### Task 3: Хранилище с дедупликацией

**Files:**
- Modify: `assistant/src/store/tasks.js`
- Create: `assistant/test/store/dedup.test.js`

**Interfaces:**
- Consumes: `Task` из Task 1.
- Produces: `store.add(task)` возвращает `{ created: boolean, task }`; повторный `sourceRef` не создаёт дубль; `store.setStatus(id, status)`.

- [ ] **Step 1: Написать падающий тест на дедупликацию**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/store/tasks.js'

test('повторный импорт того же письма не создаёт дубль', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'store-')))
  const first = store.add({ title: 'Интеграция', source: 'письмо', sourceRef: 'msg-1' })
  const second = store.add({ title: 'Интеграция', source: 'письмо', sourceRef: 'msg-1' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(store.count(), 1)
})

test('закрытая задача не удаляется, а меняет состояние', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'store-')))
  const { task } = store.add({ title: 'x', source: 'письмо', sourceRef: 'msg-2' })
  store.setStatus(task.id, 'закрыта')
  assert.equal(store.byId(task.id).status, 'закрыта')
  assert.equal(store.count(), 1)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/store/dedup.test.js`
Expected: FAIL: `add` возвращает задачу, а не объект.

- [ ] **Step 3: Реализовать дедупликацию по `sourceRef` и смену состояния**

Индекс `sourceRef → id` строится при загрузке и обновляется при добавлении.

- [ ] **Step 4: Тесты до зелёного и коммит**

Run: `cd assistant && node --test test/store/dedup.test.js`
Expected: PASS.
Run: `git add assistant && git commit -m "feat: дедупликация задач по источнику"`

---

### Task 4: Разбор письма в черновик задачи

**Files:**
- Create: `assistant/src/domain/email.js`
- Create: `assistant/test/domain/email.test.js`

**Interfaces:**
- Produces: `parseEmail(text) -> { title, dueAt|null, fromManager, escalation, sender }` — только по правилам, без модели.
- Правила: `title` — первая содержательная строка или тема; `dueAt` — первое распознанное «сегодня», «завтра», ДД.ММ или ДД.ММ.ГГГГ; `fromManager` — при словах «поручение», «руководитель»; `escalation` — при «эскалац», «повторно», «второй раз»; `sender` — из строки вида «От: …».

- [ ] **Step 1: Написать тесты на пяти образцах писем**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEmail } from '../src/domain/email.js'

test('находит срок «сегодня» и эскалацию', () => {
  const r = parseEmail('От: Антифрод\nТема: Интеграция к релизу\nНужен ответ сегодня, пишу повторно.')
  assert.equal(r.dueAt, 'сегодня')
  assert.equal(r.escalation, true)
  assert.equal(r.sender, 'Антифрод')
})

test('не выдумывает срок, если его нет', () => {
  const r = parseEmail('Тема: Как устроены расчёты\nРасскажите, пожалуйста, подробнее.')
  assert.equal(r.dueAt, null)
  assert.equal(r.escalation, false)
  assert.equal(r.fromManager, false)
})
```

Дополнить: «завтра», «до 30.11», «поручение руководителя», письмо без темы.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/domain/email.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать правила**

Возвращать `dueAt` строкой в том виде, как распознано (`сегодня`, `завтра`), либо нормализованной датой `YYYY-MM-DD`; нормализацию «сегодня/завтра» делает Task 2 при сравнении. Модель не используется.

- [ ] **Step 4: Тесты до зелёного и коммит**

Run: `cd assistant && node --test test/domain/email.test.js`
Expected: PASS, 5 образцов.
Run: `git add assistant && git commit -m "feat: разбор письма в черновик задачи по правилам"`

---

### Task 5: Экран «Сегодня» — сборка разметки

**Files:**
- Create: `assistant/ui/today.js`
- Create: `assistant/test/ui/today.test.js`

**Interfaces:**
- Produces: `renderToday({ counts, tasks, feed }) -> string` — HTML-строка; `counts = { today, overdue, notInCafo }`.
- Требования: три числа в верхней строке, не более трёх дел в блоке «Сделать сегодня», у каждой карточки видимая причина приоритета.

- [ ] **Step 1: Написать падающие тесты на разметку**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToday } from '../ui/today.js'

const tasks = [
  { title: 'Согласовать интеграцию', rank: 0, reason: 'эскалация' },
  { title: 'Ответить на запрос', rank: 1, reason: 'срок' },
  { title: 'Зафиксировать решение', rank: 3, reason: 'виснет 4 дня' },
  { title: 'Четвёртая', rank: 4, reason: 'остальное' }
]

test('показывает три числа', () => {
  const html = renderToday({ counts: { today: 4, overdue: 2, notInCafo: 3 }, tasks, feed: [] })
  assert.match(html, />4</)
  assert.match(html, />2</)
  assert.match(html, />3</)
})

test('в «Сделать сегодня» не больше трёх карточек', () => {
  const html = renderToday({ counts: { today: 4, overdue: 2, notInCafo: 3 }, tasks, feed: [] })
  const cards = html.match(/class="card"/g) || []
  assert.equal(cards.length, 3)
  assert.doesNotMatch(html, /Четвёртая/)
})

test('причина приоритета видна на карточке', () => {
  const html = renderToday({ counts: { today: 0, overdue: 0, notInCafo: 0 }, tasks, feed: [] })
  assert.match(html, /эскалация/)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/ui/today.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `renderToday`**

Экранирование текста обязательно: функция `esc()` подставляет `&`, `<`, `>`, `"`. Стили — в `assistant/ui/style.css`, разметка повторяет макет `docs/mockup-v1.html`.

- [ ] **Step 4: Тесты до зелёного и коммит**

Run: `cd assistant && node --test test/ui/today.test.js`
Expected: PASS, 3 теста.
Run: `git add assistant && git commit -m "feat: экран Сегодня"`

---

### Task 6: Сводка для экрана и ручная проверка

**Files:**
- Modify: `assistant/src/server/app.js`
- Create: `assistant/ui/index.html`, `assistant/ui/app.js`
- Create: `assistant/test/server/state.test.js`

**Interfaces:**
- Produces: `GET /api/state` → `{ counts, tasks: Task[3], feed }`; считает `today` — задачи с рангом ≤ 1, `overdue` — срок раньше сегодняшней даты, `notInCafo` — решения без отметки.

- [ ] **Step 1: Написать падающий тест сводки**

```js
test('сводка отдаёт три числа и не более трёх задач', async () => {
  // store с 12 задачами разных рангов
  const res = await fetch(`http://127.0.0.1:${port}/api/state`)
  const body = await res.json()
  assert.equal(typeof body.counts.today, 'number')
  assert.ok(body.tasks.length <= 3)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `cd assistant && node --test test/server/state.test.js`
Expected: FAIL, 404.

- [ ] **Step 3: Реализовать маршрут и подключить интерфейс**

`assistant/ui/index.html` — статичная страница с контейнером; `app.js` запрашивает `/api/state` и вставляет результат `renderToday`. Открывать через помощник (см. `docs/architecture.md`, Q11).

- [ ] **Step 4: Ручная проверка по чек-листу**

Открыть экран, проверить: три числа совпадают с содержимым хранилища; в блоке ровно три карточки; причина приоритета видна; порядок совпадает с таблицей Task 2; при пустом хранилище — понятное сообщение, а не пустой экран.

- [ ] **Step 5: Все тесты и коммит**

Run: `cd assistant && node --test`
Expected: PASS, все тесты реестра и экрана.
Run: `git add assistant && git commit -m "feat: сводка состояния для экрана Сегодня"`

---

## Итог этапа (заполняется после выполнения)

| Проверка | Порог | Факт |
|---|---|---|
| Задача без источника | отклоняется | |
| Порядок приоритета | 15 из 15 эталонов | |
| Дедупликация по источнику | 0 дублей | |
| Три карточки на экране | не больше трёх | |
| Поиск и старт | ≤ 500 мс и ≤ 3 с | |
| Ручная проверка экрана | по чек-листу | |
