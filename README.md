# Ассистент архитектора

Локальный инструмент для корпоративного архитектора: собирает задачи из почты и файлов, готовит ответы со ссылками на источники, следит за свежестью КАФО, сверяет схемы draw.io с описанием архитектуры и раз в неделю показывает, что не учли.

Работает офлайн, без внешних зависимостей и сетевых вызовов: HTML/JS-интерфейс, локальный помощник на Node.js, данные в обычной папке (Markdown + JSON).

## Быстрый старт

```bash
cd assistant
node --test          # 312 тестов
node bin/serve.js    # http://127.0.0.1:7777
```

Сборка архива для установки: `node assistant/install/build.js` → `assistant/dist/architect-assistant.zip`.

## Что где лежит

| Путь | Что это |
|---|---|
| `assistant/` | программа: сервер, интерфейс, модули, тесты, установка |
| `assistant/src/` | домен: задачи, приоритет, факты, КАФО, схемы, черновики, ревью, почта, плагины, экспорт |
| `assistant/ui/` | интерфейс: 10 экранов, вёрстка без сборки |
| `docs/` | проектная документация: интент, требования, дизайн, приёмка, runbook |
| `docs/design/` | спецификация интерфейса, макеты, скрипты проверки |

## Документация

- [Интент продукта](docs/product-intent-architect-assistant.md) — зачем, для кого, что не делаем.
- [Требования](docs/requirements.md) — 53 требования с трассировкой в [traceability.md](docs/traceability.md).
- [Спецификация интерфейса](docs/design/ui-spec.md) и [макет](docs/mockup-v2.html).
- [Инструкция для пользователя](docs/user-guide.md) — простыми словами.
- [Runbook](docs/runbook.md) — установка и эксплуатация в закрытом контуре.
- [Сценарий «первый день»](docs/demo-first-day.md) — проверка за 15 минут.
- [Протокол приёмки](docs/acceptance-protocol.md) — ворота и подписи.
- [Итоговый отчёт](docs/final-report.md) и [состояние проекта](docs/progress.md).

## Настройка в контуре

Переменные окружения (секреты — только через окружение процесса):

```bash
AA_DATA=/var/lib/architect-assistant
AA_CONFLUENCE=https://confluence.internal
AA_MY_ADDRESSES=arch@company.ru
AA_MAIL_CMD="node /opt/mcp-email/dist/index.js"
AA_MCP_CMD="sbm-search-mcp"
AA_INDEX_CMD="sbm-search index --incremental --dir /var/lib/sbm"
AA_PLUGINS_DIR=/var/lib/architect-assistant/плагины
AA_REVIEW_SCHEDULE="пятница,16"
```

Подробности и проверки — в [runbook](docs/runbook.md).

## Ограничения

Письма группируются по теме (mcp-email не отдаёт `Message-ID`/`References`), пометить письмо прочитанным нельзя, вложения не читаются, КАФО обновляется по кнопке «Сверить версии». Плагины выполняются в процессе программы — доверять можно только прочитанному коду. Полный список — в [итоговом отчёте](docs/final-report.md).

## Лицензия

Внутренний инструмент, лицензия не задана.
