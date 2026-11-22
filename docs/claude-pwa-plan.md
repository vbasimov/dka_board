# Claude PWA на VPS: план работ и инструкция для команды

Дата: 2026-11-21. Статус: **план, система не изменялась**. Публичный вход:
`https://vps-4692.tailfbc4b2.ts.net:10000/`.

Связанные документы:

- [claude-runtime.md](research/claude-runtime.md) — SDK/spawn, auth, permission-режимы, память, лимиты.
- [gateway-route.md](research/gateway-route.md) — `/verify`, Caddy, WS/SSE, root-шаги, откат.
- [pwa-assets.md](research/pwa-assets.md) — манифест, SW, иконки, вложенный scope, приёмка.
- [dsh-pwa-android.md](dsh-pwa-android.md) — почему WebAPK требует публичных manifest/icons.
- [claude-pwa-runbook.md](claude-pwa-runbook.md) — root-развёртывание по шагам (отдельный документ).

---

## 0. Решение (TL;DR)

1. **Свой веб-UI к Claude Code** (не обёртка claude.ai и не готовый чужой UI), работает на VPS
   под Node 24 через официальный `@anthropic-ai/claude-agent-sdk@0.3.330`. SDK несёт собственный
   CLI 2.1.330 (~429 МБ `node_modules`), глобальный `/usr/bin/claude` для работы не нужен.
2. **Доступ — тот же**: тот же origin `https://vps-4692.tailfbc4b2.ts.net:10000/`, та же сессия
   `__Host-dsh_session`, тот же пароль+TOTP/Telegram. Claude живёт по пути **`/claude/`**;
   Caddy делает `forward_auth /verify` в существующий шлюз и проксирует в Claude-приложение,
   **не трогая код шлюза и DSH**. Публичный Funnel не меняется (только порт 10000).
3. **PWA пересобирается заново**: отдельный манифест, service worker `/claude/sw.js` со scope
   `/claude/`, свои иконки; `dsh-web-pwa` не переиспользуется как код и не меняется.
4. **Безопасность — ручные подтверждения**: никакого `bypassPermissions`, `acceptEdits`,
   `--dangerously-skip-permissions` и allow-правил, обходящих `canUseTool`. **MVP работает
   только в safe-режиме без Bash/WebFetch/WebSearch**; Power-режим (Bash) отложен до отдельного
   дизайна с изоляцией control-plane, потому что общий UID и env-секрет делают его небезопасным.
5. **Изоляция**: отдельный системный пользователь `claudeapp`, свой `CLAUDE_CONFIG_DIR`,
   рабочее пространство `/srv/claude-web/workspaces`, systemd-hardening, приложение слушает
   **только `127.0.0.1:3090`** и требует `X-Claude-Edge` (секрет Caddy↔app).
6. **Главный организационный блокер**: у `dsh` нет sudo, а systemd-юнит, пользователь, Caddy и
   токен требуют root. Развёртывание выполняет владелец/ops по
   [runbook](claude-pwa-runbook.md), в окне обслуживания; `dsh`-агенты готовят код и проверки,
   но **не** выполняют root-шаги.

### 0.1. Что изменено после независимого security-ревью

- Вместо Unix-сокета/`SupplementaryGroups=caddy` — `127.0.0.1:3090` + `X-Claude-Edge`
  (256-bit, constant-time); `claudeapp` не входит в группу `caddy` и не читает Caddyfile/логи.
- Публичные install-ассеты отдаёт Caddy `file_server`; приложение анонимно недоступно,
  cookie шлюза в app не уходит.
- CSP ставится в Caddy **в начало `route`**, до глобального `header` (иначе перетирается);
  в HTML — `<meta>` как backstop; приёмка `curl -I`.
- Токен: `/etc/claude-web/env` `0600 root:root`, временные файлы — root-only `umask 077`, без `/tmp`;
  `ALLOWED_USER_HASH` обязателен, приложение fail-closed на пустом/коротком edge-секрете.
- Power/Bash **выключен**; safe-only; `PreToolUse`-хук с `realpath`/симлинками для
  Read/Edit/Write/Grep/Glob; `ReadWritePaths` сужен до workspace.
- SSE: 15 мин cap + закрытие через 120 с без успешного heartbeat (revoke ≤ ~2 мин).

---

## 1. Цель, границы, что не делаем

**Цель:** мобильный и десктопный PWA-интерфейс к Claude Code на своём VPS: список сессий,
потоковый чат, показ инструментов и ручное подтверждение, остановка, возобновление, установка
на Android/iOS/десктоп, тот же вход, что у DSH.

**В границах:**

- сервер Node 24 + `@anthropic-ai/claude-agent-sdk`;
- SPA (Preact + TypeScript + Vite), SSE-стриминг, REST для действий;
- PWA: манифест, service worker, иконки, install-метаданные;
- Caddy-маршрут `/claude/*` и systemd-юнит;
- тесты, приёмка, откат, эксплуатационная документация.

**Не в границах (сознательно):**

- изменения кода auth-шлюза, DSH и `dsh-web-pwa`;
- новый публичный порт/поддомен, изменения Tailscale Funnel/xray/firewall;
- мультипользовательский режим и шаринг подписки (запрещено условиями Anthropic);
- загрузка файлов, голос, несколько моделей, субагенты в UI;
- «полная песочница» для произвольного Bash без root: это отдельная фаза после MVP.

---

## 2. Подтверждённые решения

| Вопрос | Решение |
|---|---|
| Что такое «Claude PWA» | Свой веб-UI к Claude Code на VPS, полная аналогия с DSH |
| Доступ | Тот же адрес, путь `/claude/`, та же сессия и вход |
| Права инструментов | Ручное подтверждение опасных вызовов; read-only — по правилам Claude Code |
| PWA | Пересобрать: свой manifest/SW/иконки, scope `/claude/` |
| Кто выполняет root | Владелец/ops по runbook; субагенты — только код/проверки |

---

## 3. Архитектура

```
телефон/десктоп (PWA, scope /claude/)
        │ HTTPS :10000 (Tailscale Funnel, TLS терминирует tailscaled)
        v
Caddy 127.0.0.1:8081  (существующий dsh-gateway-caddy, admin off)
  ├─ /tg, /auth/*, /healthz ──────────────► auth-gateway 127.0.0.1:9090
  ├─ /claude/manifest.webmanifest,
  │  /claude/icons/*  (публично) ─────────► file_server из /srv/claude-web/public
  ├─ /claude/*  ── forward_auth /verify ──► claude-web 127.0.0.1:3090
  └─ всё остальное ───────────────────────► auth-gateway → DSH 127.0.0.1:3080
                                              (не меняется)
claude-web (Node 24, User=claudeapp)
  ├─ HTTP/SSE только на 127.0.0.1:3090; требует X-Claude-Edge + X-Auth-User
  ├─ Agent SDK ── spawn ──► claude child (2.1.330) × до 2 сессий
  │    cwd = /srv/claude-web/workspaces/<project>
  │    CLAUDE_CONFIG_DIR=/var/lib/claude-web/claude-config
  │    CLAUDE_CODE_OAUTH_TOKEN из /etc/claude-web/env (0600 root:root)
  └─ audit /var/log/claude-web/audit.jsonl (0600), сессии в /var/lib/claude-web
```

**Почему не через шлюз как прокси.** Шлюз — полноценный прокси в DSH: он подставляет серверную
DSH-cookie, владеет WS и рассчитан на один upstream. Второй upstream внутри него — правка
security-critical кода и риск для DSH. Вариант «Caddy → forward_auth → Claude» даёт ту же сессию,
не меняя Node-код шлюза, и легко откатывается одним Caddyfile.

**Почему SSE, а не WebSocket.** Поток ассистента, статусы и запросы подтверждений — односторонний
поток сервер→клиент; действия идут обычными POST. SSE проще проходит Caddy (`flush_interval -1`),
не требует own WS-протокола и не конфликтует с WS-механикой шлюза. Клиент держит heartbeat
`POST /claude/api/heartbeat` раз в 60 с: это одновременно проверка сессии через Caddy и признак
живого вкладки.

**Порт и trust boundary.** Приложение слушает **только `127.0.0.1:3090`**. Так как на хосте
есть другие локальные пользователи (`xray`, `mtg`, `telegram-bot`) и известны случаи утечки
cookie в `/tmp`, одного loopback недостаточно: Caddy добавляет случайный
`X-Claude-Edge: <256-bit>`, приложение проверяет его `timingSafeEqual` и требует
`X-Auth-User`, который Caddy ставит только после успешного `/verify`. Без секрета прямой
запрос к `:3090` получает `403` до разбора тела.

Unix-сокет с `SupplementaryGroups=caddy` — **не** основной вариант: пользователь `claudeapp`
в группе `caddy` получил бы чтение `/etc/dsh-gateway-caddy/Caddyfile` (0640 root:caddy) и,
возможно, логов Caddy — лишнее расширение прав. Если понадобится сокет, нужна отдельная
группа `claude-sock` (caddy + claudeapp) или ACL, а не группа `caddy`.

---

## 4. Доступ и сессия («один и тот же вход»)

### 4.1. Что даёт существующий шлюз

- cookie `__Host-dsh_session`: Secure, HttpOnly, SameSite=Lax, Path=/, idle 60 мин, absolute 12 ч;
- `/verify` (только loopback): требует `X-Forwarded-Method` + `X-Forwarded-Uri`, при валидной
  сессии отдаёт `200` и `X-Auth-User` (12 hex от `sha256("tg:<id>")`), иначе `401`; cookie не
  трогает, `Set-Cookie` не ставит;
- Origin/`Sec-Fetch-Site` `/verify` **не** проверяет — это обязанность edge;
- сессия общая: выход из DSH завершает и Claude-сессию. Это принято как часть «один вход».

### 4.2. Caddy-маршрут (схема)

Точный фрагмент и порядок директив — в [gateway-route.md §5](research/gateway-route.md) и
[runbook](claude-pwa-runbook.md). Обязательные свойства:

1. Точный публичный матчер **только** для 5 install-ассетов; `GET/HEAD`; до `forward_auth`;
   отдаёт `file_server` из `/srv/claude-web/public` (не приложение), поэтому аноним не попадает
   в app и не зависит от его auth-кода.
2. `handle /claude` → `308 /claude/` (относительные URL не должны улетать в корень DSH).
3. Origin-guard **до** install-ветки и `forward_auth`: любой запрос `/claude/*` с заголовком
   `Origin`, отличным от `https://vps-4692.tailfbc4b2.ts.net:10000` (плюс значения из
   `GATEWAY_EXTRA_ALLOWED_ORIGINS`, если появятся), получает `403`. Сравнение — по всему
   заголовку, без опоры на регистр `Upgrade`; так закрываются POST и WS. Приложение независимо
   проверяет `Origin`/`Sec-Fetch-Site` для unsafe-методов.
4. `handle /claude/*`: `forward_auth 127.0.0.1:9090 { uri /verify; copy_headers X-Auth-User }`,
   затем `reverse_proxy 127.0.0.1:3090`; `flush_interval -1`; `header_up X-Forwarded-Proto https`;
   **`header_up -Cookie`** — сессионная cookie шлюза не должна попадать в приложение;
   `header_up X-Claude-Edge <secret>`; `header_up -Authorization`, `-X-Forwarded-User`,
   `-X-Real-IP`.
5. Приложение требует **и** `X-Claude-Edge` (секрет Caddy↔app, `timingSafeEqual`), **и**
   `X-Auth-User` (Caddy ставит только после успешного `/verify`); глобальный
   `request_header -X-Auth-*` вырезает клиентские подделки. Прямой запрос к `:3090` без
   секрета — `403` до чтения тела.
6. CSP: приложение отдаёт полный `Content-Security-Policy` (`default-src 'self'`,
   `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`,
   `object-src 'none'`) **и** дублирует его `<meta http-equiv="Content-Security-Policy">`.
   Глобальный `header` Caddy проверенно перетирает CSP upstream, поэтому в Caddy нужен
   отдельный `header /claude/*` с этим же CSP, вставленный **ПОСЛЕ** глобальных
   header-директив `route` (в `route` выигрывает последний setter; проверено на Caddy
   2.11.9: блок до глобального `header` теряет `default-src 'self'`). Приёмка —
   `curl -I /claude/` содержит `default-src 'self'`. `Cache-Control`: manifest `no-cache` +
   ETag, иконки `public, max-age=86400`, assets `public, max-age=86400, immutable`,
   HTML/API `no-store`; глобальный `no-store` перекрывается матчерными `header … { >Cache-Control … }`
   в секции B (без `>` значения складываются и побеждает `no-store`).
7. `/claude/sw.js` — **не** публичный; браузер обновляет SW со своей сессией.
8. Никакого `Service-Worker-Allowed: /` у Claude-SW: scope только `/claude/`.

### 4.3. Логин и истечение сессии

- Первый вход: открыть `/auth/tg`, войти, затем `/claude/`.
- PWA установлена: при истечении сессии SW показывает страницу «Сессия завершилась» с кнопкой
  «Войти» (`/auth/tg`) и опросом `/auth/status`; после успешного входа страница сама
  перезагружает `/claude/`. Шлюз пока игнорирует `next`, поэтому опрос — единственный способ
  не заставлять пользователя вручную возвращаться.
- Heartbeat раз в 60 с; при `401` клиент закрывает SSE и показывает login-страницу. Сервер
  закрывает SSE через 120 с без **успешного** heartbeat и в любом случае через 15 мин; после
  revoke Caddy отдаёт `401` на новый heartbeat, поэтому чтение прекращается в пределах ~2 мин
  (остаточный риск — до 2 мин, а не «навсегда»).

### 4.4. CSRF/Origin/Host

Приложение само проверяет: `Host` — публичный authority (или loopback в dev), `Origin` —
публичный origin для unsafe-методов, `Sec-Fetch-Site != cross-site`, `Content-Type:
application/json` для POST, лимит тела 1 МБ. Caddy-guard — первый барьер, приложение — второй.

---

## 5. PWA: что именно пересобираем

### 5.1. Идентичность и URL

| Поле | Значение |
|---|---|
| `id` | `/claude/` |
| `start_url` | `/claude/` |
| `scope` | `/claude/` (со слешем; `/claude` захватывал бы лишнее) |
| `name` / `short_name` | `Claude Workspace` / `Claude` (рабочие варианты) |
| `display` | `standalone`, `display_override: ["standalone","minimal-ui"]` |
| `theme_color` / `background_color` | тёмные, `#1a1917` / `#1a1917` |
| `lang` / `dir` | `ru` / `ltr` |
| Иконки | 192 any, 512 any, 512 maskable, 180 apple-touch, 96 favicon; PNG, непрозрачный фон, safe zone |

Публично (без cookie) — ровно: `/claude/manifest.webmanifest`,
`/claude/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon-180.png`. Их отдаёт Caddy `file_server` из
`/srv/claude-web/public` (дерево `public/claude/...`), не приложение. Всё остальное — за
сессией.

### 5.2. Service worker

- файл `/claude/sw.js`, scope `/claude/`, без `Service-Worker-Allowed`;
- навигация — только сеть, таймаут 10 с; HTML не кэшируется никогда;
- `401/403` → страница «сессия истекла»; `5xx`/сеть → «сервер недоступен» + retry;
- кэш только `/claude/assets/*` (cache-first, лимит ~100, проверка типа/редиректа/HTML);
- manifest/иконки — stale-while-revalidate;
- API/SSE/heartbeat — **не перехватывать**;
- обновление: **без `skipWaiting()` в install**; новый worker ждёт, UI показывает «Доступно
  обновление», по кнопке `SKIP_WAITING` + один `location.reload()`;
- префикс кэшей `claude-pwa-*`, версия в `VERSION`, старые кэши чистить.

### 5.3. Иконки

В системе нет ImageMagick/rsvg/Inkscape/PIL/canvas/Chromium; `sharp` есть только внутри DSH.
Берём **zero-dependency генератор PNG** (проверен в исследовании): рисуем собственную метку
(не официальный логотип Anthropic — trademark), генерируем 5 размеров, проверяем PNG-сигнатуру,
размеры, непрозрачность и safe zone. Генератор — dev-скрипт, артефакты коммитятся.

### 5.4. Риск вложенного scope (важно)

DSH занимает `/` со своим root-SW; Claude — `/claude/`. Chrome не любит вложенные scope: при
уже установленном DSH предложение установки Claude может не появиться, а ссылки могут уходить
в DSH-приложение. План:

- ставить Claude **вручную** через меню Chrome «Установить приложение», а не ждать prompt;
- приложение проверяет `navigator.serviceWorker.controller?.scriptURL`: если это не
  `/claude/sw.js` (например, root-SW DSH после `skipWaiting`/`clients.claim()`), оно
  перерегистрирует Claude-SW и делает один reload; это же проверяется на приёмке;
- проверить на Android до разработки всего UI (gate G1);
- если установка невозможна — зафиксировать это как ограничение пути `/claude/` и обсудить
  отдельный origin (второй Funnel-порт/нода) как отдельный проект; **не** ломать DSH ради этого.

---

## 6. Рантайм Claude

### 6.1. SDK и сессии

- `@anthropic-ai/claude-agent-sdk@0.3.330` (точная версия в lockfile), Node 24;
- `query({ prompt: AsyncIterable, options })`: `cwd`, `resume`, `includePartialMessages`,
  `canUseTool`, `interrupt()`;
- `settingSources: []`, `strictMcpConfig: true`, никаких чужих MCP/плагинов/хуков;
- один child на активную сессию; лимит **2** одновременных; idle-close 15 мин, при возврате —
  `resume`; `maxTurns` на сообщение (например, 30);
- транскрипты — в `CLAUDE_CONFIG_DIR`, retention 14 дней, удаление сессии из UI.

### 6.2. Auth

- `claude setup-token` (владелец, браузер) → `CLAUDE_CODE_OAUTH_TOKEN` на 1 год;
- файл `/etc/claude-web/env` 0600 root:root (systemd читает как root); в git/логи/браузер не
  попадает, `claudeapp` его не читает;
- **не** использовать файловый OAuth `~/.claude/.credentials.json` для сервиса: access token
  живёт ~8 ч и требует записи refresh-файла; read-only/sandbox-контекст ломает refresh → 401;
- `CLAUDE_CONFIG_DIR` — отдельный, writable; `HOME=/var/lib/claude-web`;
- дочернему Claude-процессу передаётся **минимальный env**, а не `{...process.env}`: только
  `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` и нужные лимиты; **без**
  `EDGE_SECRET`, без переменных DSH/Telegram/прокси;
- `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (проверить, что не ломает
  auth), `DO_NOT_TRACK=1`;
- при 401 в UI — «Обновите вход» и инструкция ротации токена, без авто-ретраев.

### 6.3. Права и режимы

**MVP — только safe-режим.** Power-режим (Bash/WebFetch/WebSearch) **не включается**: Bash
наследует env с токеном и edge-секретом, `bwrap --unshare-net` не закрывает AF_UNIX, а общий UID
не даёт отделить control-plane от инструментов. Для Power нужен отдельный дизайн (token-proxy /
отдельный UID / systemd-сокет, принадлежащий edge), это вне MVP.

| Режим | Инструменты | Подтверждения |
|---|---|---|
| **Safe (MVP, по умолчанию)** | Read, Glob, Grep, Edit, Write | Edit/Write — вручную; Bash/WebFetch/WebSearch/Agent — недоступны |
| Power (не в MVP) | + Bash, WebFetch/WebSearch | требует отдельного security-дизайна |

Инварианты:

- `permissionMode: 'default'`; никаких `acceptEdits`/`auto`/`bypassPermissions`;
- **никаких allow-правил**, которые обходят `canUseTool`; «разрешить всегда» в MVP не предлагаем;
- `canUseTool` показывает инструмент, вход, cwd, предупреждения (запись вне workspace, сеть,
  sudo/systemctl/ssh/curl, путь к секретам); таймаут 5 мин → deny; `interrupt()` рвёт ожидание;
- `permissions.deny`: `~/.claude`, `~/.dsh`, `~/.ssh`, `~/.gnupg`, `/etc`, `/root`, `.env`,
  **`/etc/claude-web/**`** (env с токеном), **`/proc/**`** (environ процесса),
  **`Read/Edit(//var/lib/claude-web/**)`**, **`Read/Edit(//var/log/claude-web/**)`** — модель
  не должна читать/портить audit, транскрипты и конфиг; это defense-in-depth, не sandbox.
  Файл env — `0600 root:root` (systemd читает его как root до drop privileges), поэтому
  `claudeapp` не читает его и через Read-инструмент;
- рабочее пространство: только `/srv/claude-web/workspaces/<id>`; сервер валидирует `realpath`,
  префикс, отсутствие `..`/симлинков и не принимает `cwd` из клиента вслепую; `additionalDirectories: []`;
- **`PreToolUse`-хук — реальная граница для путей**: для `Read/Edit/Write/Grep/Glob` он делает
  `realpath` входа и разрешает только `/srv/claude-web/workspaces/**` (плюс явный read-only
  allowlist), запрещает `/proc`, `/etc`, `/var/lib/claude-web`, `/var/log/claude-web`, `~/.claude`,
  `~/.dsh`; симлинки в workspace отклоняются (нельзя обойти deny через `link → /proc/self/environ`
  или записать в audit через `link → /var/log/...`); `Grep/Glob` покрыты тем же хуком, а не
  только `Read`-deny. Тест: `Read`/`Grep` симлинка на `/proc/self/environ` → deny; `Write`
  симлинка в `/var/lib/claude-web` → deny;
- `AskUserQuestion` показываем как обычный запрос с вариантами;
- все вызовы инструментов эмитим в UI (hook `PreToolUse`) даже если Claude Code не спрашивает
  (read-only), чтобы был виден ход работы и аудит.

### 6.4. Память и лимиты

Измерено: ~206 МБ child + ~80 МБ host на сессию; старт ~1.8 с. На 2 ГБ с DSH (~400 МБ):
1 сессия — комфортно, 2 — норма, 3 — риск OOM. Поэтому:

- `MAX_SESSIONS=2`, очередь «waiting»;
- `MemoryMax=1150M`, `MemoryHigh=950M`, `CPUQuota=150%`, `TasksMax=256`;
- idle-close 15 мин; SSE max 15 мин, затем клиент переподключается;
- мониторинг RSS/OOM в журнале; kill switch — `systemctl stop claude-web`.

---

## 7. Безопасность

### 7.1. Инварианты (проверяются на приёмке)

1. Новых публичных портов нет; Funnel только 10000; приложение слушает только `127.0.0.1:3090`
   и требует `X-Claude-Edge` (256-bit), который ставит Caddy.
2. Второго пароля/формы входа нет; используется та же сессия; cookie шлюза **не** уходит в
   Claude-приложение (`header_up -Cookie`).
3. Публично — только 5 инертных install-ассетов; `/claude/sw.js`, `/claude/assets/*`, API/SSE —
   за сессией.
4. Нет auto-approve/bypass; таймаут подтверждения = deny; allow-правила не обходят callback;
   **MVP — только safe-режим**, Bash/WebFetch/WebSearch выключены.
5. Отдельный UID `claudeapp` **без группы `caddy`** (иначе чтение Caddyfile/логов Caddy);
   `ProtectHome=yes`; нет доступа к `/home/dsh` и секретам DSH; workspace только
   `/srv/claude-web/workspaces`.
6. Токен — только в env-файле `0600 root:root` (systemd читает как root; `claudeapp` файл не
   читает); не в браузере, логах, git, audit; ротация раз в год и при инциденте.
7. CSP `default-src 'self'` (плюс `connect-src 'self'`) в заголовке **и** в `<meta>`, санитайз
   Markdown, никакого `dangerouslySetInnerHTML` с сырым выводом модели; Caddy не ослабляет CSP
   (проверка `curl -I`); XSS в UI не должен давать API-действия.
8. Audit — метаданные (событие, tool, решение, длительность, id), без промптов/секретов;
   ротация и права 0600; panic/kill switch документированы.
9. Caddy Origin-guard + app-level Origin/Host/CSRF; тело 1 МБ в приложении, 64 МБ на edge.
10. Откат Caddy и остановка сервиса не затрагивают DSH; проверено на приёмке.
11. Workspace — только `/srv/claude-web/workspaces/<id>` после `realpath`/prefix-проверки;
    `PreToolUse`-хук резолвит симлинки и покрывает Read/Edit/Write/Grep/Glob;
    `additionalDirectories: []`.
12. Приложение **fail-closed**: не стартует при `EDGE_SECRET` короче 64 hex или
    `ALLOWED_USER_HASH` не 12 hex; чужой `X-Auth-User` → `403`; пустой/короткий
    `X-Claude-Edge` → `403` до чтения тела.

### 7.2. Модель угроз (кратко)

| Угроза | Мера | Остаток |
|---|---|---|
| Анонимный доступ | forward_auth, loopback+`X-Claude-Edge`, 401/403 | — |
| Кража cookie шлюза приложением | `header_up -Cookie`, app не видит cookie | компрометация caddy/root |
| Локальный обход (xray/mtg) | loopback + `X-Claude-Edge`; `claudeapp` не в группе caddy | root |
| Prompt injection → опасная команда | ручное подтверждение, safe-режим без Bash, показ полного входа | человек может подтвердить зло |
| Кража OAuth-токена | safe-режим (Bash выключен), deny `/proc/**`, минимальный env, ротация | Read-инструмент в том же UID |
| Утечка секретов DSH | отдельный UID, ProtectHome, deny-правила | root |
| XSS в UI | CSP, sanitize, нет inline | сторонняя библиотека |
| DoS/память | 2 сессии, лимиты, таймауты | 2 vCPU/2 ГБ |
| Отзыв сессии при открытом SSE | heartbeat 60 с, max 15 мин | до 15 мин чтения |
| Сломанный Caddy | backup, validate, restart, rollback | до 15 с downtime DSH |

### 7.3. Остаточные риски (принять письменно)

1. **Токен в процессе.** Safe-режим не даёт Bash/WebFetch, но Claude-процесс всё равно несёт
   `CLAUDE_CODE_OAUTH_TOKEN` в env; Read-инструмент может прочитать `/proc/self/environ`, если
   не сработает deny. Меры: deny `/proc/**` и `/etc/claude-web/**`, минимальный child env без
   `EDGE_SECRET`, `0600 root:root` env-файл, канареечный тест, ротация. Power-режим (Bash) в MVP
   **выключен**; включать его в этой архитектуре нельзя — нужен отдельный control-plane.
2. **Человеческий фактор.** Prompt injection может выглядеть убедительно; UI обязан показывать
   полный путь/команду/дифф и предупреждать о сети/записи вне workspace.
3. **Вложенный PWA scope.** Установка Claude может требовать ручного меню; тест на Android —
   gate G1.
4. **Лимиты Pro-подписки.** Веб-UI расходует те же лимиты; жёсткого бюджета нет; смотреть
   `rate_limit_event` и не делать авто-ретраи.
5. **Root-окно.** Caddy нельзя reload (admin off, `CanReload=no`) — только restart, до 15 с
   разрыва WS/SSE DSH. Делать в окне обслуживания, с backup и вторым SSH.
6. **Caddy access log (pre-existing).** В логе могут оставаться request `Cookie` и
   `Set-Cookie` логина DSH; это не создаётся Claude, но должно быть закрыто фильтром
   `request>headers>Cookie delete`, `Authorization delete`, `resp_headers>Set-Cookie delete`
   до продакшена (проверка — `grep -c` в runbook §6).
7. **Общий bucket `/verify` 600/мин.** Claude добавляет запросы к нему; при тяжёлой загрузке
   возможен `429` и на DSH-вход. Проверить на стенде, не поднимать лимит без пересмотра
   антифлуда; бандлить SPA, не делать лишних перезагрузок.
8. **Single-owner.** `ALLOWED_USER_HASH` обязателен в MVP (12 hex из `/auth/status`); приложение
   отказывает любому другому `X-Auth-User`. Если allowlist шлюза когда-либо расширится, это
   не откроет Claude второму пользователю, но останется расход общего `/verify`-bucket.

---

## 8. Команда субагентов

| Роль | Кто | Зона | Что не делает |
|---|---|---|---|
| **Lead / архитектор** | этот агент | план, API-контракт, интеграция, финальное ревью, координация root | не выполняет root-шаги, не правит Caddy/systemd |
| **Runtime** | `claude-runtime` | SDK, auth, permissions, resume, память, `server/agent*` | не трогает Caddy/UI |
| **Access/Auth** | `gateway-route` | `/verify`, Caddy-фрагмент, systemd, root-runbook, `server/auth*`, `deploy/` | не меняет gateway/DSH, не выполняет root |
| **PWA/Frontend** | `pwa-assets` | SPA, manifest, SW, иконки, install-приёмка, `web/`, `pwa/` | не трогает auth/Caddy |
| **Security review** | новый субагент | независимая модель угроз, ревью auth/exec-путей, adversarial-тесты | **не** пишет код, который проверяет; право veto |
| **QA/Deploy** | новый субагент | приёмка, регрессия DSH, rollback-репетиция, `test/acceptance` | не выполняет root без владельца |

**Правила работы:**

- один писатель на каталог; пересечения — только через API-контракт lead'а;
- никаких секретов в промптах/файлах/логах; токен — плейсхолдер;
- никакого sudo и правок `/etc`, `/opt`, systemd, Caddy, Tailscale субагентами;
- каждое изменение auth/exec-пути проходит ревью security; без подписи — не деплоим;
- root-шаги выполняет только владелец, по runbook, с backup и откатом.

---

## 9. Фазы, артефакты, гейты

### Фаза 0. База и go/no-go (0.5 дня)

- зафиксировать: `git status`, версии Node/DSH/Claude, `sha256` Caddyfile (root), текущие
  `401`/`200`, состояние DSH PWA;
- подтвердить root-доступ/окно, выбрать workspace (рекомендуется отдельный
  `/srv/claude-web/workspaces`, не `/home/dsh/projects`);
- **Gate G0:** есть владелец root-шагов и окно; workspace выбран.

### Фаза 1. Каркас и контракт (1–2 дня)

- `claude-web/`: server (Node http, без Express), `server/agent.mjs` интерфейс + fake runtime,
  API, SSE, audit; `web/` Vite+Preact; тесты;
- API-контракт (см. §10) и mock-UI; локальный запуск `127.0.0.1:3091`, `AUTH_MODE=dev`
  (только loopback, явный env);
- **Gate G1:** unit/integration зелёные; UI ходит в fake runtime; нет секретов в логах.

### Фаза 2. Runtime Claude (2–3 дня)

- SDK-интеграция: streaming, `canUseTool`, interrupt, resume, лимиты, idle-close;
- auth: `setup-token` (владелец), env, 401-обработка; smoke-тест реального ответа модели
  после получения токена;
- permission-политика **safe only** (Bash/WebFetch/WebSearch выключены), deny-правила, `PreToolUse`-аудит;
- **Gate G2:** реальный короткий турн + streaming + approval + interrupt; память в норме;
  токен не в логах.

### Фаза 3. UI и PWA (2–3 дня)

- чат, tool-карточки, approval-шит, stop, список/возобновление сессий, heartbeat, ошибки;
- manifest/SW/иконки, install-метаданные, update-UI;
- **Gate G3:** локальная установка PWA (desktop) и SW-тесты; манифест валиден.

### Фаза 4. Доступ и Caddy (1 день + окно)

- локальный стенд Caddy 2.11.9: TCP 3090, mock auth 200/401, SSE, Origin, spoof
  `X-Auth-User`; проверить порядок `handle`/`route`;
- root: backup Caddyfile, патч в temp, `caddy validate`, restart в окне, проверки 401/200,
  DSH smoke; при ошибке — немедленный откат;
- **Gate G4:** `/claude/` 401 без сессии, 200 с сессией, manifest/icons 200 без cookie,
  `/claude/sw.js` 401, DSH не сломан; **Gate G1 (Android install)** — здесь же.

### Фаза 5. Hardening (1–2 дня)

- отдельный пользователь, systemd-юнит, loopback 3090 + `X-Claude-Edge`, `ProtectHome`, лимиты;
- bwrap/Power — **вне MVP**: safe-режим без Bash; если позже понадобится, отдельный дизайн control-plane;
- CSP/заголовки, audit, ротация токена, rate-limit, kill switch;
- независимое security-ревью; **Gate G5:** подпись security, нет High-находок без принятого
  residual.

### Фаза 6. Приёмка и откат (1 день)

- ручная установка PWA на Android Chrome (WebAPK) и desktop; standalone, имя/иконка;
- approval allow/deny/timeout, interrupt, resume, session expiry, offline pages;
- rollback-репетиция: restore Caddyfile, restart, stop service; DSH снова работает;
- **Gate G6:** приёмка §12, откат выполнен, DSH не затронут.

### Фаза 7. Эксплуатация

- runbook, мониторинг (journal/audit/RSS), обновление SDK (pin → тест → деплой), ротация
  токена, инцидент-план (revoke, stop, rotate), бэкапы конфигов (без токена).

---

## 10. API-контракт (эскиз)

Все пути под `/claude/api/`; auth — `X-Claude-Edge` + `X-Auth-User` (Caddy-сессия); ответы JSON,
ошибки `{error, code}`; SSE — `text/event-stream`. `cwd` принимается только из серверного списка
workspace, проверяется `realpath` + префикс + отсутствие симлинков.

```
GET    /claude/api/health                     -> {ok, version, active, max}
GET    /claude/api/workspaces                 -> [{id,name,path}]
GET    /claude/api/sessions                   -> [{id,title,cwd,mode,status,lastActive}]
POST   /claude/api/sessions {cwd?, mode}      -> {id}
GET    /claude/api/sessions/:id               -> meta
GET    /claude/api/sessions/:id/events        -> SSE
POST   /claude/api/sessions/:id/messages {text}
POST   /claude/api/sessions/:id/approvals/:reqId {decision, reason?}
POST   /claude/api/sessions/:id/interrupt
POST   /claude/api/sessions/:id/close
DELETE /claude/api/sessions/:id
POST   /claude/api/heartbeat
```

SSE-события: `snapshot`, `assistant_delta`, `assistant_message`, `tool_request`, `tool_result`,
`status`, `result`, `error`, `session_expired`, `ping`. `Last-Event-ID` + ring buffer; при
разрыве — новый `snapshot`.

Ограничения: тело 1 МБ; сообщение ≤ 32 КБ; максимум 2 активные сессии; 30 сообщений/мин;
approval timeout 5 мин; SSE max 15 мин **и** закрытие через 120 с без успешного heartbeat
(Caddy после revoke отдаёт 401).

---

## 11. Caddy-фрагмент (схема, точный — в runbook)

```caddyfile
# 1) CSP — ПОСЛЕ глобальных header-директив route. В route выигрывает последний setter;
#    блок ДО глобального header проверенно перетирается (Caddy 2.11.9).
header /claude/* {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
}

# 2) Origin-guard — ДО install-ветки и forward_auth: любой cross-origin запрос
#    (включая WS) получает 403. Сравниваем весь Origin, не полагаемся на регистр Upgrade.
@claude_bad_origin {
    path /claude/*
    expression `{http.request.header.Origin} != '' && {http.request.header.Origin} != 'https://vps-4692.tailfbc4b2.ts.net:10000'`
}
respond @claude_bad_origin "forbidden" 403

# 3) Публичные install-ассеты: только 5 точных путей, только GET/HEAD; отдаёт Caddy.
@claude_install path /claude/manifest.webmanifest /claude/icons/icon-192.png \
                  /claude/icons/icon-512.png /claude/icons/icon-maskable-512.png \
                  /claude/icons/apple-touch-icon-180.png
handle @claude_install {
    @not_get not method GET HEAD
    respond @not_get "method not allowed" 405
    root * /srv/claude-web/public
    file_server
}

handle /claude { redir * /claude/ 308 }

# 4) Всё остальное под /claude/ — за той же сессией.
handle /claude/* {
    forward_auth 127.0.0.1:9090 {
        uri /verify
        copy_headers X-Auth-User
    }
    reverse_proxy 127.0.0.1:3090 {
        flush_interval -1
        header_up X-Forwarded-Proto https
        header_up -Cookie
        header_up X-Claude-Edge <EDGE_SECRET>
        header_up -Authorization
        header_up -X-Forwarded-User
        header_up -X-Real-IP
    }
}
```

**Порядок вставки:** CSP-блок — в **самое начало** `route`, до существующего глобального
`header`; остальные блоки — после `/internal/*` и до финального `handle { ... }`. Всё внутри
`route { ... }`. `<EDGE_SECRET>` — случайные 32 байта (`openssl rand -hex 32`), тот же секрет
в `/etc/claude-web/env`; Caddyfile `0640 root:caddy`, env `0600 root:root`. Если `forward_auth`
копирует `X-Auth-User`, не удалять его в `reverse_proxy`.

Публичные файлы: `/srv/claude-web` — `root:root 0751` (caddy проходит, но не листает;
claudeapp не может подменить `public`), `public` — `root:root 0755`, файлы `0644`;
`claudeapp` в `public` не пишет. Каталог `workspaces` — `claudeapp:claudeapp 0750`.

---

## 12. Приёмка (кратко)

Без сессии:

```
/claude/                          -> 401
/claude/manifest.webmanifest      -> 200, application/manifest+json, без Set-Cookie
/claude/icons/icon-192.png        -> 200, image/png
/claude/sw.js                     -> 401
/                                 -> 401 (DSH не изменился)
/claude (без слеша)               -> 308 -> /claude/
POST на публичный manifest        -> 405
cross-origin POST/WS на /claude/* -> 403 (Origin-guard до /verify)
127.0.0.1:3090 без X-Claude-Edge  -> 403 (и только 127.0.0.1, не 0.0.0.0)
127.0.0.1:3090 с верным edge, но чужим X-Auth-User -> 403
заголовок CSP у /claude/          -> default-src 'self'
```

С сессией (браузер):

- `/claude/` 200; установка PWA (Android Chrome и desktop), standalone, имя/иконка Claude;
- короткий турн: streaming, tool-карточка, approve → результат, deny → отказ, timeout → deny;
- interrupt; resume после закрытия; 2 сессии — очередь; 3-я не стартует;
- истечение сессии → страница «Сессия завершилась», вход и возврат;
- offline/5xx → страница retry; API/SSE не в кэше;
- CSP/заголовки; в логах нет cookie/токена/промптов; Caddy access log без `Set-Cookie`;
- upstream не получает `Cookie`/`__Host-dsh_session` (проверить mock-echo или лог приложения);
- `navigator.serviceWorker.controller.scriptURL` = `/claude/sw.js`, а не root-SW DSH;
  после обновления DSH-SW контроллер не перехватывает Claude;
- DSH: `/` 401, вход, WS, PWA-манифест — без регрессии;
- rollback: restore Caddyfile + restart + stop claude-web → DSH работает.

---

## 13. Открытые вопросы

1. **Root-доступ и окно**: кто выполняет runbook и когда (Caddy restart рвёт WS DSH до 15 с).
2. **Bash/Power**: в MVP **выключен**; включать только после отдельного дизайна control-plane
   (token-proxy/отдельный UID), а не «просто bwrap».
3. **bubblewrap**: для MVP не нужен; ставить только если появится отдельный Power-дизайн.
4. **Workspace**: отдельный `/srv/claude-web/workspaces` (рекомендуется) или импорт
   `/home/dsh/projects` через git; прямой доступ к `/home/dsh` закрыт `ProtectHome`.
5. **Имя/иконка**: `Claude Workspace`/`Claude`, собственная метка (не официальный логотип).
6. **`next` после логина**: сейчас шлюз ведёт на `/`; в MVP — опрос `/auth/status`; правка
   шлюза — отдельно, security-reviewed.
7. **Android nested scope**: если Chrome не устанавливает Claude при установленном DSH —
   принять ручную установку/ограничение или обсуждать отдельный origin (вне MVP).
