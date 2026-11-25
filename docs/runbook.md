# Runbook: установка и запуск в закрытом контуре

Документ для того, кто разворачивает программу. Все шаги проверяемы, секретов в файлах репозитория нет.

## 1. Что нужно

| Компонент | Требование | Проверка |
|---|---|---|
| Node.js | 20 или новее | `node -v` |
| Архив программы | `dist/architect-assistant.zip` (≈120 КБ) | `unzip -l` |
| gigacode | локальная модель, доступная из контура | `gigacode --version` |
| sbm-search (поиск) | Python 3.10+, venv с пакетом, модель эмбеддингов офлайн | `sbm-search --help`, `sbm-search stats` |
| mcp-email (почта) | `node dist/index.js`, учётные данные IMAP | `node <путь>/dist/index.js` |

## 2. Установка

```bash
unzip architect-assistant.zip -d /opt/architect-assistant
cd /opt/architect-assistant
node bin/serve.js            # проверить, что поднимается
```

Программа слушает только `127.0.0.1:7777`. Наружу порт не публикуется.

## 3. Файл окружения

Создать `/etc/architect-assistant.env` (права `600`, владелец — пользователь программы):

```bash
AA_DATA=/var/lib/architect-assistant
AA_PORT=7777
AA_CONFLUENCE=https://confluence.internal
AA_MY_ADDRESSES=arch@company.ru
AA_MAIL_CMD="node /opt/mcp-email/dist/index.js"
AA_MAIL_FOLDER=INBOX
AA_MCP_CMD="sbm-search-mcp"
AA_INDEX_CMD="sbm-search index --incremental --dir /var/lib/sbm"
AA_PLUGINS_DIR=/var/lib/architect-assistant/плагины
```

Почтовые переменные (`USER`, `PASSWORD`, `SMTP_FROM`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`) передаются только через окружение процесса, в файл не пишутся.

## 4. Проверки после запуска

| Что | Как | Ожидаемо |
|---|---|---|
| Программа жива | `curl -s http://127.0.0.1:7777/api/health` | `{"ok":true,...}` |
| Статика отдаётся | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/` | `200` |
| Поиск по знаниям | `curl -s 'http://127.0.0.1:7777/api/rag/search?q=согласование'` | список `items`, без `error` |
| Почта | `curl -s -X POST -H 'content-type: application/json' -d '{"limit":10,"read":3}' http://127.0.0.1:7777/api/email/sync` | `{"listed":N,"read":M,"created":K}` |
| Мост в индекс | `curl -s -X POST -H 'content-type: application/json' -d '{"index":true}' http://127.0.0.1:7777/api/email/bridge` | `written > 0`, `indexed: true` |
| Свежесть КАФО | `curl -s http://127.0.0.1:7777/api/cafo` | страницы со статусами |
| Тесты | `cd /opt/architect-assistant && node --test` | `pass` без `fail` |

## 5. Ограничения, о которых надо знать заранее

- Письма: `limit` ≤ 100, пагинации нет — забираются последние N; поиск по отправителю на сервере не поддерживается.
- Письма: пометить прочитанным нельзя, «не прочитано» — состояние на момент синхронизации.
- Письма: вложения и HTML-тело недоступны, текст — до 1 МБ.
- Лимиты вызовов mcp-email: списки 30/мин, поиск 10/мин, отправка 5/мин (отправку программа не использует).
- КАФО: сверка версий требует доступа к метаданным страниц Confluence.
- Поиск: при отсутствии модели эмбеддингов остаётся только полнотекстовый режим.

## 6. Обновление

```bash
systemctl stop architect-assistant 2>/dev/null || pkill -f 'bin/serve.js'
unzip -o architect-assistant.zip -d /opt/architect-assistant
systemctl start architect-assistant
```

Папка `AA_DATA` не затрагивается: задачи, письма, факты и отчёты остаются на месте.

## 7. Резервная копия

Копировать только `AA_DATA`: `задачи/`, `факты/`, `письма/`, `кэш-кафо/`, `отчёты/`, `письма-для-индекса/`. Восстановление — вернуть папку на место до запуска.

## 8. Если что-то не работает

| Симптом | Причина | Что делать |
|---|---|---|
| `/api/rag/search` → 503 | не задан `AA_MCP_CMD`/`AA_RAG_CMD` | проверить переменные и путь к серверу |
| `/api/email/sync` → 503 | не задан `AA_MAIL_CMD` | указать путь к `dist/index.js` |
| `/api/email/sync` → 400 «остановился» | сервер упал или неверные учётные данные | смотреть stderr процесса mcp-email |
| Все источники «не сверено» | Confluence недоступен или нет прав | проверить `AA_CONFLUENCE` и доступ |
| Поиск пуст, хотя индекс есть | не задан каталог или режим | `sbm-search stats`, затем `--mode fts` |
| Тесты падают на портах | занят порт из прошлого запуска | освободить порт, повторить |

## 9. Безопасность

- Никаких внешних сетевых вызовов: проверяется `grep -RInE "https?://|//cdn|@import" ui` — пусто, и отсутствием зависимостей.
- Программа не отправляет письма: только готовит текст.
- Данные лежат в `AA_DATA`; в папке могут быть копии писем — не размещать в общих ресурсах.
- Секреты — только в окружении процесса, файл `600`.
- Плагины выполняются в процессе программы: доверяйте только тем, чей код вы читали. Сетевые импорты и выход за папку плагина загрузчик блокирует, но это защита от случайности, а не песочница.
