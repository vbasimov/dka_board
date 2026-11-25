# Трассировка требований

Сверка: требование → где реализовано → чем проверено → состояние. Обновлено 25.11.2026.

Состояния: **готово** — есть код и автоматическая проверка; **частично** — код есть, но не всё из формулировки; **нет** — не реализовано.

## 1. Реестр задач

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-01 | `src/domain/email.js`, `POST /api/tasks`, кнопка «Добавить из письма» | `test/domain/email.test.js` | частично: разбор по правилам, без модели; точность на 30 письмах не измерялась |
| FR-02 | быстрая форма в `ui/app.js` (`quick-add`) | теста нет | частично |
| FR-03 | `src/import/files.js`, `/api/import/files`, `/api/import/tasks`; дедупликация по `sourceRef` | `test/import/files.test.js`, `test/server/import.test.js` | готово: папки и универсальный приём элементов; конкретный Jira-адаптер — конфигурация источника, а не код) |
| FR-04 | `store.search`, `/api/tasks`, фильтры по названию, источнику и состоянию в интерфейсе | `test/store/tasks.test.js` (10 000 задач, 3 мс), `test/ui/page.test.js`, jsdom-прогон | готово |
| FR-05 | `src/export/csv.js`, `/api/export/tasks.csv`, `/api/export/facts.md` | `test/export/csv.test.js`, `test/server/export.test.js` | готово |

## 2. Сводка и приоритет

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-06 | `ui/onepager.js`, `/api/onepager` | `test/server/onepager.test.js`, `test/ui/onepager.test.js`, jsdom | готово |
| FR-07 | `src/domain/priority.js` | `test/domain/priority.test.js` — 15 эталонов | готово |
| FR-08 | счётчики `overdue`/`burning` | `test/server/onepager.test.js` | готово |
| FR-09 | `reasonOf` в `priority.js`, причина на карточке | `test/domain/priority.test.js` | готово |
| FR-10 | `normalizeOrder` в `src/domain/priority.js`, `AA_SETTINGS`/`настройки.json`, `priorityOrder` | `test/domain/priority.test.js`, `test/server/priority-config.test.js` | готово |

## 3. Черновики ответов

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-11 | `src/drafts/build.js`, `/api/drafts/build` | `test/drafts/build.test.js` | готово |
| FR-12 | блок «требует подтверждения», ссылки на источники | `test/drafts/build.test.js` | готово |
| FR-13 | маршрута отправки нет вовсе | проверяется отсутствием | готово (по замыслу) |
| FR-14 | структура «позиция — обоснование — риски — шаг» | `test/drafts/build.test.js` | готово |
| FR-15 | `src/drafts/store.js`, `/api/drafts/save`, кнопка в карточке | `test/drafts/store.test.js`, `test/server/drafts-save.test.js` | готово |
| FR-16 | `src/templates/library.js`, `/api/templates`, `templateId` в `/api/drafts/build` | `test/templates/library.test.js`, `test/server/templates.test.js` | готово |

## 4. КАФО и свежесть

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-17 | `src/cafo/cache.js` — `pageId`, `version`, `checkedAt`, `url`, `ancestors` | `test/cafo/cache.test.js` | готово |
| FR-18 | `src/cafo/freshness.js` | `test/cafo/freshness.test.js`, 7 тестов | готово |
| FR-19 | статус в строке источника в черновике | `test/drafts/build.test.js` | готово |
| FR-20 | перекачка страницы при росте версии (`fetchPage`), замена фактов | `test/cafo/cache.test.js`, `test/server/cafo-refresh.test.js` | готово |
| FR-21 | таймаут 200 мс в тесте, «не сверено» | `test/cafo/freshness.test.js` | готово |
| FR-22 | ключ по `pageId`, переименование обновляет запись | `test/cafo/cache.test.js` | готово |

## 5. Схемы draw.io

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-23 | `src/parse/sources.js`, `src/parse/drawio.js`, маршрут сравнения принимает `path` | `test/parse/sources.test.js`, `test/server/diagrams-path.test.js` | готово: файл, XML, PNG со встроенной схемой, вложение — через путь к файлу |
| FR-24 | мультистраничность, `inflateRaw` | `test/parse/drawio.test.js` | готово |
| FR-25 | дерево зон, `unparsed` | `test/parse/drawio.test.js` | готово |
| FR-26 | нормализованный JSON | `test/parse/drawio.test.js` | готово |
| FR-27 | `src/diagrams/compare.js` | `test/diagrams/compare.test.js` | готово |
| FR-28 | `loadDiagram` в `src/parse/sources.js` | `test/parse/sources.test.js`, `test/server/diagrams-path.test.js` | готово: PNG без схемы → `unsupported` с причиной |
| FR-29 | `src/diagrams/freshness.js`, `fileDigest` в `sources.js`, маршрут сравнения возвращает `freshness` | `test/diagrams/freshness.test.js`, `test/server/diagrams-path.test.js` | готово |

## 6. Факты

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-30 | `src/facts/model.js` | `test/facts/model.test.js` | готово |
| FR-31 | замена без удаления | `test/facts/store.test.js` | готово |
| FR-32 | `answerable()` | `test/facts/store.test.js` | готово |
| FR-33 | `supersedes`/`supersededBy`, экран «Факты» с колонкой связи версий | `test/facts/store.test.js`, `test/ui/lists.test.js` | готово |

## 7. Ревью, почта, решения

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-34 | `src/review/build.js` | `test/review/build.test.js` | готово |
| FR-35 | `src/review/schedule.js`, `AA_REVIEW_SCHEDULE`, файл `ревью-<дата>-по-расписанию.md` | `test/review/schedule.test.js` | готово |
| FR-36 | ручной запуск, правка отчёта сохраняется файлом | `test/review/store.test.js`, `test/server/review.test.js` | готово |
| FR-45 | `ui/onepager.js` | `test/server/onepager.test.js`, `test/ui/onepager.test.js` | готово |
| FR-46 | `ui/quiz.js`, `/api/quiz` | `test/facts/quiz.test.js`, `test/ui/quiz.test.js` | готово |
| FR-47 | `store.park`, кнопка «Отложить» на карточке, блок «Продолжить» | `test/server/park.test.js`, `test/ui/card.test.js` | готово |
| FR-48 | `src/email/mcp.js`, `/api/email/sync` | `test/email/mcp.test.js`, `test/server/email-sync.test.js` | готово |
| FR-49 | `src/email/bridge.js`, `/api/email/bridge` | `test/email/bridge.test.js`, `test/server/email-bridge.test.js` | готово |
| FR-50 | `threadKeyOf`, поле `threadBy` | `test/email/unanswered.test.js` | частично: способ группировки не выводится в интерфейсе |
| FR-51 | `src/decisions/model.js` | `test/decisions/model.test.js` | готово |
| FR-52 | счётчик `notInCafo`, `debts()` | `test/server/decisions.test.js` | готово |
| FR-53 | `/api/decisions/:id/cafo` | `test/decisions/store.test.js` | готово |

## 8. Плагины и установка

| FR | Реализация | Проверка | Состояние |
|---|---|---|---|
| FR-37 | `src/plugins/contract.js`, `src/plugins/registry.js`, `docs/plugins.md` | `test/plugins/contract.test.js`, `test/plugins/registry.test.js` | готово |
| FR-38 | отказ при сетевых импортах в `registry.js` | `test/plugins/registry.test.js` | готово |
| FR-39 | таймаут 2 с, перехват падений, журнал `errors` | `test/plugins/registry.test.js` | готово |
| FR-40 | проверка `apiVersion`, миграция в `docs/plugins.md` | `test/plugins/contract.test.js` | готово |
| FR-41 | `install/build.js`, `start.cmd`, `start.sh` | распаковка и запуск проверены вручную | готово |
| FR-42 | `src/bundle/integrity.js`, `manifest.json` в архиве, `/api/health` | `test/bundle/integrity.test.js`, живая проверка подмены файла | готово |
| FR-43 | `install/update.js`: распаковка, проверка целостности, активация; откат `install/rollback.js` | `test/bundle/update.test.js`, живой прогон на архиве | готово |
| FR-44 | `install/rollback.js` | `test/bundle/rollback.test.js` | готово |

## 9. Итог

- **Готово:** 50 требований из 53.
- **Частично:** 3.
- **Нет:** 0.

**Чего не хватает больше всего** (по влиянию на приёмку):

1. Плагины (FR-37–FR-40) — без них заявленная расширяемость не работает, а обещание «каждый архитектор соберёт своё» остаётся словами.
3. Четыре источника схем draw.io (FR-23) — вложение Confluence и PNG не поддержаны, а именно там схемы чаще всего и лежат.
4. Проверка целостности бандла (FR-42) и откат (FR-44) — для распространения в контуре важнее, чем кажется.
5. Экспорт (FR-05), шаблоны (FR-16), настройка приоритетов (FR-10), «не распознано» для картинок (FR-28).

**Что это значит.** Ядро сценария — сводка, задачи, обоснования, свежесть КАФО, схемы, факты, ревью, почта, решения — закрыто и покрыто тестами. Периферия (плагины, экспорт, шаблоны, целостность бандла) не сделана, и в отчёте это должно звучать прямо, а не прятаться за словом «готово».
