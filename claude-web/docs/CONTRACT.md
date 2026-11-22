# claude-web — контракт реализации (для команды)

Источник требований: `docs/claude-pwa-plan.md` (архитектура, инварианты) и
`docs/claude-pwa-runbook.md` (root-развёртывание). Этот файл фиксирует **интерфейсы**,
чтобы три потока (runtime / pwa / deploy) писали код независимо.

## 0. Границы репозитория

```
claude-web/
  README.md                 # Lead
  package.json              # Lead: root deps (@anthropic-ai/claude-agent-sdk 0.3.330), scripts
  scripts/build.mjs         # Lead: сборка web + копирование pwa
  server/**                 # Runtime-поток
  test/server/**            # Runtime-поток (node:test)
  web/**, pwa/**            # PWA-поток
  test/pwa/**               # PWA-поток
  deploy/**                 # Edge-поток (unit, Caddy-фрагмент, install/acceptance/rollback)
  test/deploy/**            # Edge-поток
```

Один писатель на каталог. Пересечения — только правкой этого контракта через Lead.

## 1. Внешние условия (production)

- Публичный origin: `https://vps-4692.tailfbc4b2.ts.net:10000` (Tailscale Funnel → Caddy
  `127.0.0.1:8081`).
- Приложение: `127.0.0.1:3090`, `BASE_PATH=/claude/`.
- Прямо перед приложением Caddy: `forward_auth 127.0.0.1:9090 /verify` → ставит
  `X-Auth-User: <12 hex>`; и `header_up X-Claude-Edge: <64 hex>`, `header_up -Cookie`
  (cookie шлюза приложение **не** видит никогда).
- `/verify` = 200 + `X-Auth-User: sha256("tg:<id>").slice(0,12)` при валидной сессии, 401 иначе.
  Живой `ALLOWED_USER_HASH` вычислен на сервере: `8d9462ad9d8e` (не секрет).
- Публично (без сессии) Caddy отдаёт только 5 install-ассетов из `/srv/claude-web/public/
  claude/{manifest.webmanifest,icons/...}`. Приложение анонимных путей не имеет.
- Node 24, `User=claudeapp`, `HOME=/var/lib/claude-web`,
  `CLAUDE_CONFIG_DIR=/var/lib/claude-web/claude-config`, workspace — `/srv/claude-web/workspaces`.
- Секреты: `/etc/claude-web/env` `0600 root:root` (`EDGE_SECRET`, `ALLOWED_USER_HASH`,
  `CLAUDE_CODE_OAUTH_TOKEN`). В git/логи/UI не попадают.

## 2. Переменные окружения приложения

| Переменная | Обяз. | Значение / валидация |
|---|---|---|
| `HOST` | prod | `127.0.0.1` (иначе fail-closed) |
| `PORT` | prod | `3090` |
| `PUBLIC_ORIGIN` | prod | `https://…:10000`, парсится URL |
| `BASE_PATH` | да | `/claude/` (со слешами на концах) |
| `WORKSPACES` | да | `/srv/claude-web/workspaces` |
| `AUDIT_LOG` | да | `/var/log/claude-web/audit.jsonl` |
| `STATE_DIR` | да | `/var/lib/claude-web` (sessions.json, transcript-метаданные) |
| `EDGE_SECRET` | prod | `/^[0-9a-f]{64}$/i` иначе fail-closed |
| `ALLOWED_USER_HASH` | prod | `/^[0-9a-f]{12}$/` иначе fail-closed |
| `CLAUDE_CODE_OAUTH_TOKEN` | prod | непустой; в лог/ответы/audit не попадает |
| `MAX_SESSIONS` | нет | `2` |
| `APPROVAL_TIMEOUT_MS` | нет | `300000` |
| `IDLE_CLOSE_MS` | нет | `900000` |
| `SSE_MAX_MS` | нет | `900000` |
| `SSE_HEARTBEAT_TIMEOUT_MS` | нет | `120000` |
| `MAX_BODY_BYTES` | нет | `1048576` |
| `MAX_MESSAGE_BYTES` | нет | `32768` |
| `CLAUDE_RUNTIME` | нет | `sdk` (prod) / `fake` (локально, тесты) |
| `AUTH_MODE` | нет | `prod` (по умолчанию) / `dev` |
| `DEV_USER_HASH` | dev | обязателен в `AUTH_MODE=dev`, 12 hex; `dev` разрешён **только** при `HOST=127.0.0.1` и `PORT=3091` |

`loadConfig(env)` — чистая функция, бросает `ConfigError` с понятным кодом. Никаких секретов
в тексте ошибок. В production обязательны `EDGE_SECRET`, `ALLOWED_USER_HASH`,
`CLAUDE_CODE_OAUTH_TOKEN`, `WORKSPACES`, `AUDIT_LOG`, `STATE_DIR`, `CLAUDE_CONFIG_DIR`
(последний — в SDK-режиме); отсутствие любого — отказ старта.

## 3. Рантайм: интерфейс (fake и sdk обязаны совпадать)

`server/runtime/index.mjs`:

```js
export function createRuntime(config)        // -> { mode: 'sdk'|'fake', createSession }
```

`runtime.createSession({ sessionId, cwd, resume, emit, requestApproval })` → объект:

```js
{
  sendUserText(text): Promise<void>,   // кладёт сообщение в очередь child
  interrupt(): Promise<void>,          // abort текущего турна/approval
  close(): Promise<void>,              // terminate child, идемпотентно
  info(): { sdkSessionId: string|null, status: string }
}
```

`emit(event)` — рантайм **не** знает про SSE; отдаёт объект события (см. §5).
`requestApproval({ reqId, tool, input, cwd, warnings })` → `Promise<{decision:'allow'|'deny',
reason?:string}>`; рантайм ждёт ≤ `APPROVAL_TIMEOUT_MS`, затем `deny` с `reason:'timeout'`;
`interrupt()` отклоняет ожидание как `deny`/`reason:'interrupted'`.

Fake-рантайм (для тестов/локального UI): `sendUserText('...')` → 2–4 `assistant_delta` +
`assistant_message` + `result`; если текст содержит `tool:` — эмитит `tool_request`
(`Edit`/`Write`), ждёт `requestApproval`, эмитит `tool_result`; `interrupt` обрывает поток.

## 4. Модули сервера

```js
config.mjs        loadConfig(env) -> Config
auth.mjs          checkRequest(req, config) -> {ok:true,userHash}|{ok:false,status,code,message?}
http-util.mjs     json(res,status,body,extraHeaders?), readJsonBody(req,max), securityHeaders(config)
static.mjs        serveStatic(req,res,{distDir,basePath,urlPath}) -> boolean
workspaces.mjs    listWorkspaces(config), resolveCwd(config, input) -> absPath (400/403)
sessions.mjs      createSessionManager({config,runtime,sse,audit,now}) -> SessionManager
sse.mjs           createSseHub({config,now}) -> {open, publish, closeSession, closeAll}
audit.mjs         createAudit({path,mode,now}) -> {write(event,fields), close, size}
runtime/hook.mjs  makePathGuard({workspacesRoot}) -> { checkPath(abs) -> {allowed,reason},
                                                     preToolUse(sdkInput) -> {decision,reason} }
runtime/sdk.mjs   реальный провайдер (Agent SDK 0.3.330)
runtime/fake.mjs  fake-провайдер
app.mjs           createApp({config,deps}) -> (req,res)=>Promise<void>
index.mjs         сборка зависимостей, server.listen(HOST,PORT), graceful shutdown
```

### SessionManager

```js
list() -> [{id,title,cwd,mode,status,lastActive,createdAt}]
create({cwd, mode}) -> Session            // cwd проверяется resolveCwd
get(id) -> Session                          // 404 при отсутствии
sendMessage(id, text)                      // 413/429 по лимитам
interrupt(id)
close(id)                                  // остановить child, оставить метаданные (resume)
remove(id)                                 // остановить + удалить метаданные/транскрипт-ссылку
resolveApproval(id, reqId, decision, reason?)
snapshot(id) -> {session, pendingApprovals}
touchHeartbeat(connectionId)               // из POST /api/heartbeat
subscribe(id) -> {replay(lastEventId), unsubscribe}
```

Статусы: `waiting` (нет свободного слота child), `active` (child запущен), `idle`
(child закрыт после простоя, метаданные живы), `closed`, `error`.
`MAX_SESSIONS=2` ограничивает число **одновременно запущенных child**, не число сессий.
Метаданные сессий — `STATE_DIR/sessions.json` (0600, атомарная запись); после рестарта
сессии восстановимы через `resume`.

### SSE

`GET {base}api/sessions/:id/events` — `text/event-stream`; заголовки: `Cache-Control: no-store`,
`X-Accel-Buffering: no`, `Connection: keep-alive`. Формат:
`id: <n>\nevent: <type>\ndata: <json>\n\n`.
На открытие — `snapshot` (сессия + pending approvals), затем `replay(lastEventId)` из ring
buffer (200 событий). `ping` — комментарий/событие каждые 15 с. Закрытие: через
`SSE_HEARTBEAT_TIMEOUT_MS` без успешного `POST /api/heartbeat` **или** через `SSE_MAX_MS`;
клиент переподключается и получает `snapshot`.

### Ошибки HTTP

`{ "error": "<человеческий текст>" , "code": "<machine_code>" }`.
Коды: `unauthorized`(401), `forbidden`(403), `not_found`(404), `limit`(409),
`payload_too_large`(413), `unsupported_media_type`(415), `rate_limited`(429), `internal`(500).

## 5. События SSE (типы и поля)

```
snapshot         {session, pendingApprovals}
assistant_delta  {text}
assistant_message{text, messageId?}
tool_request     {reqId, tool, input, cwd, warnings:[...], expiresAt, auto:boolean}
tool_result      {reqId, tool, ok, summary}
status           {status: 'running'|'idle'|'waiting_approval'|'waiting'|'error'}
result           {text, usage?, stopReason?}
error            {code, message}
session_expired  {next:'/auth/tg'}
ping             {}
```

`auto:true` — read-only вызов (Read/Glob/Grep), уже разрешён рантаймом, подтверждение НЕ
требуется, `tool_result` придёт сразу; UI показывает информационную карточку без кнопок и
не переводит статус в `waiting_approval`. `auto:false` (или отсутствие) — требуется решение
пользователя; такой запрос попадает в `pendingApprovals`. `tool_request` всегда
предшествует `tool_result` с тем же `reqId`. `snapshot` содержит `pendingApprovals` для
восстановления UI после разрыва.

## 6. API (все пути под `{base}api/`)

| Метод | Путь | Тело/параметры | Ответ |
|---|---|---|---|
| GET | `health` | — | `{ok,version,active,max,mode}` |
| GET | `workspaces` | — | `[{id,name,path}]` |
| GET | `sessions` | — | `[{id,title,cwd,mode,status,lastActive,createdAt}]` |
| POST | `sessions` | `{cwd}` | `{id}` 201 |
| GET | `sessions/:id` | — | `{session,pendingApprovals}` |
| GET | `sessions/:id/events` | SSE | — |
| POST | `sessions/:id/messages` | `{text}` | `{ok:true}` 202 |
| POST | `sessions/:id/approvals/:reqId` | `{decision:'allow'\|'deny',reason?}` | `{ok:true}` |
| POST | `sessions/:id/interrupt` | — | `{ok:true}` |
| POST | `sessions/:id/close` | — | `{ok:true}` |
| DELETE | `sessions/:id` | — | `{ok:true}` |
| POST | `heartbeat` | — | `{ok:true,ts}` |

Лимиты: тело ≤ 1 МБ (413), `text` ≤ 32 КБ (413), 30 сообщений/мин на сессию (429), approvals —
5 мин. Все POST требуют `Content-Type: application/json`.

### Проверки запроса (`checkRequest`), порядок

1. `req.socket.remoteAddress` — loopback (в prod и dev).
2. `X-Claude-Edge` — timingSafeEqual с `EDGE_SECRET` (hex → Buffer), иначе 403 **до чтения тела**.
3. `X-Auth-User` === `ALLOWED_USER_HASH` (или `DEV_USER_HASH` в dev), иначе 403.
4. `Host` — хост:порт из `PUBLIC_ORIGIN` (dev: `127.0.0.1:3091`|`localhost:3091`), иначе 403.
5. Если `Origin` присутствует и ≠ `PUBLIC_ORIGIN` → 403 (и для GET).
6. `Sec-Fetch-Site: cross-site` → 403.
7. Unsafe-метод: `Origin` обязателен и равен `PUBLIC_ORIGIN`; `Content-Type: application/json`.

### Безопасность статики

Только из `distDir`; `realpath` + префикс; запрет `..`, NUL, dotfiles; `sw.js` —
`Cache-Control: no-store`, без `Service-Worker-Allowed`; `/assets/*` — `public, max-age=86400,
immutable`; HTML/API — `no-store`. Заголовки на **все** ответы приложения: полный CSP
(`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Permissions-Policy` (как в Caddy), `X-Robots-Tag: noindex`.

## 7. PWA / фронтенд

- `web/`: Vite 7 + Preact 10 + TS, `base: '/claude/'`, `build.outDir: 'dist'`, JSX через
  esbuild `jsxImportSource: 'preact'` (без плагинов, если возможно).
- `index.html`: `<meta http-equiv="Content-Security-Policy" content="…">` (полный CSP), `<meta
  name="theme-color" content="#1a1917">`, ссылка на `/claude/manifest.webmanifest`? — манифест
  подключается через `/claude/manifest.webmanifest` (`<link rel="manifest">`), иконки абсолютные
  `/claude/icons/...`.
- Экраны: список сессий + создание (выбор workspace), чат (поток, Markdown-рендер **без** raw
  HTML — только безопасный рендер/экранирование), tool-карточки с `Разрешить/Запретить`,
  stop, «сессия истекла» (кнопка `/auth/tg` + поллинг `/auth/status`), offline/5xx retry,
  баннер обновления SW.
- Heartbeat: `POST {base}api/heartbeat` каждые 60 с; `401` → экран «Сессия завершилась»,
  закрыть SSE. SSE — `EventSource` (cookie не нужна: Caddy проверяет сам), реконнект с
  backoff, `Last-Event-ID` (EventSource сам), при `snapshot` — сброс состояния.
- SW (`pwa/sw.js`, копируется в `web/dist/sw.js`): scope `/claude/`, cache только
  `/claude/assets/*` (cache-first, ≤100, проверка типа/HTML), manifest/icons — SWR,
  навигация — только сеть (timeout 10 с), API/SSE/heartbeat не перехватывать,
  `401/403` → «сессия истекла», `5xx`/сеть → «сервер недоступен»; `skipWaiting` **не** в
  install (по сообщению `SKIP_WAITING`); префикс кэшей `claude-pwa-`, версия в `VERSION`,
  чистка старых.
- Проверка контроллера: если `navigator.serviceWorker.controller?.scriptURL` не оканчивается на
  `/claude/sw.js` — перерегистрировать Claude-SW и один `location.reload()`.
- Иконки: zero-dependency генератор PNG (`pwa/gen-icons.mjs`) → `pwa/public/claude/icons/`:
  192/512 any, 512 maskable (safe zone ≥80%), apple-touch-180, favicon-96; PNG RGBA, свой
  знак (не логотип Anthropic), тёмный непрозрачный фон.
- Манифест: `id/start_url/scope = /claude/`, `display standalone`,
  `display_override ["standalone","minimal-ui"]`, тема `#1a1917`, `lang ru`.
- Сборка: `npm run build` (Lead) → `web/dist` + копии `pwa/public/claude/*` → `web/dist/claude/*`,
  `pwa/sw.js` → `web/dist/sw.js`; install-ассеты берутся из `web/dist/claude/*` в
  `/srv/claude-web/public/claude/*`.

## 8. Деплой (Edge-поток)

- `deploy/claude-web.service` — ровно как runbook §4 (hardening, `ReadWritePaths`, лимиты).
- `deploy/Caddyfile.fragment` — точный фрагмент из runbook §5 (CSP-блок + `handle`-блоки), с
  плейсхолдером `__EDGE_SECRET__`.
- `deploy/apply-caddy.py` + `deploy/apply-caddy.sh` — вставка в **копию** живого Caddyfile:
  CSP-блок сразу после `route {` (до глобального `header`), остальное — перед финальным
  `handle {`; `--dry-run`, `caddy validate`, `caddy adapt`, `diff` с redaction; установка и
  `systemctl restart dsh-gateway-caddy` — только по явному флагу `--install` (выполняет Lead).
- `deploy/install.sh` — root: пользователь/каталоги/права, `/opt/claude-web` (npm ci
  --omit=dev --ignore-scripts + проверка native CLI), `/srv/claude-web/public`,
  systemd unit, проверки; идемпотентно; **не** трогает Caddy и env (env создаётся отдельно).
- `deploy/acceptance.sh` — проверки runbook §6 (аноним/сессия/CSP/спуфинг/3090/DSH/логи/права),
  exit≠0 при провале.
- `deploy/rollback.sh` — восстановление Caddyfile из бэкапа + restart + `systemctl stop
  claude-web` по флагу; проверка DSH.
- `test/deploy/*.mjs` — статические проверки артефактов (unit-lint: matcher'ы, порядок, права,
  плейсхолдеры, наличие `-Cookie`, `X-Claude-Edge`, `flush_interval -1`).
