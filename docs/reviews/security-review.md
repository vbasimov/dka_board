# Security-ревью claude-web перед публикацией `/claude/`

Роль: независимый security-ревьюер (`security`, task-4), право veto.
Дата: 2026-11-22 (Europe/Moscow). Workspace: `/Users/vbasimov/sandbox/remote-cld`.
Версия документа: **финальная для FROZEN-ревизии deploy** (13:37–13:39 MSK).

Методика: чтение кода + тесты + динамические проверки на локально поднятом приложении
(fake runtime, **без prod-секретов**) + read-only наблюдение VPS (`45.144.214.206`) +
изолированный прогон Caddy 2.11.9 на `127.0.0.1` (живой сервис и Caddyfile не трогались).
Секреты (`EDGE_SECRET`, OAuth-токен, cookie) не читались и в отчёте отсутствуют.

---

## 1. Объект ревью и ревизия (FROZEN)

Проверялись: `claude-web/server/**`, `claude-web/web/src/**`, `claude-web/pwa/sw.js`,
`claude-web/deploy/**`; требования — `docs/claude-pwa-plan.md` §4/§6/§7/§12,
`docs/claude-pwa-runbook.md` §5/§6/§10, `claude-web/docs/CONTRACT.md`.

FROZEN-хэши (sha256, сверил с сообщениями edge и Lead — совпадают):

| Артефакт | sha256 |
|---|---|
| `deploy/apply-caddy.py` | `b61f508ed8a41c4c7a19f56cdff6813fdceb68a97a933678e49e14c20d27332b` |
| `deploy/Caddyfile.fragment` | `f9e4f0cead81af8c9e8621d28f1b2bf5dab75e5e27c085ce6e4fe11f65fd03ca` |
| `deploy/acceptance.sh` | `74f267b302947ec640c3e07786980dc22e473bbfa4bddf2e0c252d47447551ed` |
| `deploy/install.sh` | `cac7142ef627df799a2cd4483c327869132ac7831451fa775042762245a3bc10` |
| `deploy/rollback.sh` | `c79fb2a90108c1d19eb116dfb8d7b973a59e8a13232d2ba420341cfa1eb0d1f7` |
| `deploy/claude-web.service` | `40130927748eb6a4595c5ac59541bc4adb1f2e423a309fdc3ba1085cbf1d0c30` |
| `deploy/README.md` | `a1aaa9568eaf5748e99a70bfa81dd190174d6a40e87087c19a8c9d98c5480b3a` |
| `docs/claude-pwa-runbook.md` | `c08f7101166e02f834b877f3fc249d5dbf04238df958f15c0bfa9f381d4cd694` |
| `docs/claude-pwa-plan.md` | `a3860bfe037e5107097d3145b5ada78e5c493078c8db13cfbf090a626783313f` |

Код приложения (стабилен с 11:39–13:21; хэши в отчёте — по этой ревизии):
`server/auth.mjs 421427fe…`, `server/config.mjs 339bb37d…`, `server/app.mjs e71080d8…`,
`server/sessions.mjs bbd137c1…`, `server/sse.mjs 5f61044d…`, `server/static.mjs 21b8c4a8…`,
`server/runtime/hook.mjs 60f5846f…`, `server/runtime/sdk.mjs 69b91884…`,
`web/src/markdown.ts fe487f32…`, `web/src/sse.ts 965613fd…`,
`pwa/sw.js = web/dist/sw.js 6d6dea4b…`.

Сверка с задеплоенным артефактом (read-only, VPS): `/opt/claude-web/server/*.mjs`,
`server/runtime/*.mjs`, `web/dist/sw.js`, `web/dist/index.html`, `package.json` — **sha256
совпадают** с ревизией workspace (17/17). Приложение: `claude-web.service` active,
`127.0.0.1:3090`, `runtime=sdk`, `auth=prod`; юнит побайтово соответствует
`deploy/claude-web.service`. Живой Caddyfile на момент ревью — `60ae87f3…`, маршрута
`/claude/*` ещё нет.

Тесты FROZEN-ревизии: `npm test` — **225/225 pass**; `node --test 'test/deploy/*.test.mjs'`
— **35/35 pass** (порядок маршрутов/CSP, cache-правила, отсутствие секретов, fail-closed
apply-caddy).

---

## 2. Вердикт

- **server/** и **web/** (auth, сессии/SSE, exec-хук, static, SPA/PWA): High/Critical нет,
  **блокеров нет — ОДОБРЯЮ** публикацию за auth-шлюзом DSH при принятии residual §4.
- **Применение Caddy-фрагмента (FROZEN `b61f508e`/`f9e4f0ce`/`74f267b3`): ОДОБРЯЮ** —
  фрагмент безопасен (порядок CSP/Origin/install/forward_auth/header_up проверен
  изолированным Caddy 2.11.9), при обязательных post-apply проверках §6.3 и принятии
  SEC-11 (Low, публичное кэширование 401 для приватной статики) как residual или его
  исправлении после apply. Условий, требующих veto, на FROZEN-ревизии нет.

---

## 3. Находки

| ID | Sev | Область | Evidence | Сценарий | Рекомендация | Блокер |
|---|---|---|---|---|---|---|
| SEC-01 | ~~Medium~~ **закрыто** | deploy/docs (CSP ordering) | Было: `docs/claude-pwa-runbook.md:302-309`/`docs/claude-pwa-plan.md:528-532` велели ставить CSP до глобального header; на Caddy 2.11.9 старый порядок даёт 401 `/claude/` без `default-src 'self'` (проверено). **Сейчас:** docs обновлены (`runbook §5` — «ПОСЛЕ глобальных header-директив», plan §11 аналогично), `deploy/apply-caddy.py:348-445` (`find_global_header_anchor`, fail-closed) вставляет A после глобальных header, `Caddyfile.fragment:27-37`; проверено на финальном фрагменте: 401 `/claude/` → полный CSP | Ручной путь по старой инструкции терял CSP и валил приёмку | Закрыто фиксом docs+кода; повторная проверка финальной ревизии — PASS | нет |
| SEC-02 | ~~Medium~~ **закрыто (mitigated)** | deploy/rollback, параллельные деплои гейтвея | Живой Caddyfile менялся после бэкапа `20261122-083521` (sha бэкапа `92dd74d4…` ≠ живого `60ae87f3…`). В FROZEN `apply-caddy.py` (`do_install`): бэкап пишется из прочитанных байт, перед подменой живой файл **перечитывается** и сравнивается с исходным; изменился → FAIL без записи; `TAG_POINTER` пишется только после успешного restart+проверок, откат — по свежему TAG | Старый `rollback.sh`-по-pointer восстановил бы устаревший конфиг шлюза | Применять только `apply-caddy.py --install` (создаст свежий бэкап/TAG); репетицию отката — по новому TAG; не использовать текущий pointer (083521) до apply | нет |
| SEC-11 | Low | deploy/cache (задача task-7) | Финальный фрагмент: `@claude_assets path /claude/assets/*` + `header @claude_assets { >Cache-Control "public, max-age=86400, immutable" }` (и `@claude_icons` аналогично). На изолированном Caddy 2.11.9: `GET /claude/assets/x.js` **без сессии → 401** с `Cache-Control: public, max-age=86400, immutable`; `GET /claude/icons/favicon-96.png` (не публичный) → 401 с `public, max-age=86400` и `Content-Type: image/png`. Deferred `>`-правила не гейтятся по статусу; `acceptance.sh:130-150` проверяет только 200-путь | HTTP-кэш/браузер может закэшировать 401 на hashed asset URL на сутки (после истечения сессии возможна поломка загрузки JS/CSS до hard-reload). Утечки данных нет (401-тело — generic), shared-кэша в схеме нет | Гейтить на 2xx: для приватных путей — `reverse_proxy { header_down Cache-Control/Content-Type }` (401 от forward_auth туда не доходит); для 5 публичных install-ассетов — `header` внутри `handle @claude_install` после `respond @not_get 405`. Либо принять residual и добавить проверку в acceptance/мониторинг | нет (Low; принять residual или исправить после apply) |
| SEC-03 | Low | server/SSE (DoS) | `server/sse.mjs:82-119` — `open()` добавляет соединение без проверки лимита; `server/app.mjs:93-107`; динамически: 12 одновременных SSE к одной сессии приняты | Аутентифицированный (единственный владелец) может открыть много SSE и держать до 15 мин/соединение | residual (single-owner) или per-session/global cap (3–5) с 429 | нет |
| SEC-04 | Low | server/runtime (exec boundary, defense-in-depth) | `server/runtime/sdk.mjs:367-371` — hooks без `onFailure`; `docs/sdk.d.ts:1052-1060`: default `'continue'` — при исключении/таймауте хука действие продолжается; для Read/Glob/Grep хук — единственная path-проверка | При сбое `PreToolUse` read-only инструмент может выполниться без path-проверки (триггер не найден: хук синхронный, ошибки fs перехвачены) | Явно `onFailure: 'block'`; при желании — продублировать path-check в canUseTool | нет |
| SEC-05 | Low | server/runtime (defense-in-depth) | `server/runtime/hook.mjs:137-140` — инструменты вне `PATH_TOOLS` получают `allowed:true`; фактическая граница — `tools` whitelist + `disallowedTools` (`sdk.mjs:21-31, 96-107`) | При будущем расширении tools/MCP hook не отклонит не-path инструмент; сейчас Bash/WebFetch/WebSearch/Task/Agent недоступны | deny-by-default для инструментов вне `SAFE_TOOLS`; перепроверять whitelist при апгрейде SDK | нет |
| SEC-06 | Low | deploy/artifact (гигиена) | VPS `/srv/claude-web/public/claude/._*` (6 файлов AppleDouble), в артефакте `._sdk-README.md`/`._web`; в локальном репозитории их нет (создаются при переносе macOS→Linux). Проверено: `GET /claude/._manifest.webmanifest` → 401 (не публичны) | Засорение public-дерева/артефакта; публичной отдачи нет | Исключать `._*`/`.DS_Store` при сборке tar или чистить в `install.sh` | нет |
| SEC-07 | Info | server/audit (latent) | `server/audit.mjs:16-24`: `cleanString` усекает до `max` (для `code` — 40), затем `SECRET_RE=/^[0-9a-f]{64}$/` проверяет уже усечённое. Динамически: `sanitizeAuditFields({event:'x',code:'a'*64})` → `code`=40×`a` (не `[redacted]`) | Сейчас секрет в `code`/`tool` не передаётся; при появлении — 40 hex утекут в audit | Проверять секрет до усечения | нет |
| SEC-08 | Info | server/sessions (defense-in-depth) | `server/sessions.mjs:92-131` — `loadPersisted()` принимает `item.cwd` (только `/`-префикс) и `sdkSessionId` из `STATE_DIR/sessions.json` без `resolveCwd()`/realpath | Файл 0600 в `/var/lib/claude-web` (claudeapp/root); компрометация/ошибка оператора → resume с cwd вне workspace (формально нарушает invariant §7.1 п.11) | Прогонять `cwd` через `resolveCwd` при загрузке, невалидные записи отбрасывать | нет |
| SEC-09 | Info | privacy: prompt в state | `server/sessions.mjs:412-415` — title = первые 80 символов сообщения, пишется в `STATE_DIR/sessions.json` (0600); динамически title содержит промпт, **audit — 0 совпадений** | Промпт хранится в состоянии (транскрипты SDK и так содержат промпты); требование «audit без промптов» выполнено | Принять residual | нет |
| SEC-10 | Info | deploy/log (pre-existing) | Изолированный Caddy 2.11.9: access-log после запросов с `Cookie`/`Authorization`/`X-Claude-Edge`/`X-Auth-User` — 0 вхождений Cookie/Authorization/X-Claude-Edge; клиентский `X-Auth-User` остаётся текстом, серверный (из `/verify`) — нет | Клиентские trust-заголовки — шум/размер лога (JSON-экранирование, инъекции нет); секреты удалены | Принять residual; опционально удалять `X-Auth-*` в log-filter | нет |

Итого: Critical 0, High 0; Medium 0 открытых (SEC-01/SEC-02 закрыты в FROZEN); Low 5
(SEC-03/04/05/06/11), Info 4.

---

## 4. Принятые residual (требуют письменного принятия владельцем)

1. **OAuth-токен в env дочернего Claude-процесса.** `sdk.mjs:78-89` — только env; argv/логи/
   audit/SSE чисты (journal grep = 0). Deny `/proc/**`, `/etc/claude-web/**`,
   `/var/lib|log/claude-web/**`, `~/.claude|.dsh` (`sdk.mjs:35-70`) + `PreToolUse`-хук;
   динамически: Read `/proc`, `/proc/self/environ`, `/etc/passwd`, `/etc/claude-web/env`,
   audit-файла, симлинков на них → DENY. Остаток: Read в том же UID при сбое deny/хука.
2. **Человеческий фактор approval** (prompt injection): UI показывает input/путь/warnings;
   решение — за человеком.
3. **Single-owner**: второй пользователь → 403; общий bucket `/verify` 600/мин шлюза.
4. **Вложенный PWA scope** (ручная установка возможна/требуется) — ограничение платформы.
5. **Окно рестарта Caddy**: reload недоступен (admin off), restart рвёт WS/SSE DSH до ~15 с.
6. **До 15 мин SSE после отзыва сессии**; закрытие через 120 с без heartbeat; динамически:
   без heartbeat ~1,6 с при `SSE_HEARTBEAT_TIMEOUT_MS=1500`, с heartbeat — ровно
   `SSE_MAX_MS=6000`.
7. **DoS authenticated/single-owner:** нет cap SSE-соединений (SEC-03), нет cap числа сессий;
   лимиты 30 сообщений/мин/сессия, очередь 20, тело 1 МБ, `maxSessions=2` — проверены.
8. **SEC-11:** публичное кэширование 401 для `/claude/assets/*`/приватных иконок (ниже —
   §6.3); принять residual или исправить после apply. Не утечка; availability.
9. **Caddy/Funnel вне репозитория:** TLS терминирует tailscaled; Host доходит публичный
   (используется DSH Host/Origin-fence); Caddyfile 0640 root:caddy, env 0600 root:root,
   `claudeapp` без группы caddy (VPS: `env_not_readable_by_app`, `home_dsh_not_readable`).
10. **Реальный SDK-турн мной не выполнялся** (нет доступа к prod-токену/квоте); по сообщению
    Lead реальные турны (Read auto / Write approval) проверены на VPS. Security-ревью
    проверял код/конфиг/permission-инварианты. Остаток — поведение SDK 0.3.330 при обновлении
    (pin обязателен).

---

## 5. Что проверено (evidence)

### 5.1. Auth/fail-closed (динамика, prod-режим, тестовый edge-секрет, `127.0.0.1:3092`)

| Проверка | Результат |
|---|---|
| без заголовков / только edge / чужой user / чужой edge / edge неверной длины | 403 (все) |
| верные edge+user, чужой `Host` | 403 |
| верные edge+user+Host | 200 |
| `Origin: https://evil.example` (GET), `Sec-Fetch-Site: cross-site` | 403 |
| POST без `Origin` / `Content-Type: text/plain` / верный POST | 403 / 415 / 200 |
| тело 2 МБ (`Content-Length`) | 413 **до** буферизации (`http-util.mjs:113-128`) |
| 2 МБ без заголовков | 403 (auth до чтения тела) |
| dev-режим | только `127.0.0.1:3091` + `DEV_USER_HASH`; `AUTH_MODE=dev`+`PORT=3090` → fail-closed (`config.mjs:60-121`); в prod-конфиге не активен |

### 5.2. Сессии/approvals/SSE (fake runtime)

- `cwd` только из `WORKSPACES`: `/etc` → 403, симлинк-эскейп → 403, относительный/чужой →
  400/403 (`workspaces.mjs:38-106`, `sessions.mjs:350-378`).
- Approvals: чужой/неизвестный `reqId` → 404; `reqId` другой сессии → 404; неверный
  `decision` → 400; повторное решение → 404; после таймаута → 404; таймаут 1200 мс →
  `tool_result {ok:false, summary:"отклонено: timeout"}`; interrupt → deny/interrupted;
  одноразовость `rec.finish` (`sessions.mjs:191-215`).
- `maxSessions=2`: 3-я → `waiting`, очередь 20; health `active:2,max:2`.
- 30 сообщений/мин/сессия → 429 после лимита (динамически).
- SSE: snapshot + ring replay; закрытие по heartbeat timeout и `SSE_MAX_MS` — см. residual 6.
- Утечки: audit после турна — только метаданные; grep промпта = 0; journal без токена/cookie.

### 5.3. Exec-пути (`hook.mjs`, динамика на fake-workspace)

DENY: `../outside`, `../../etc/passwd`, `/etc/passwd`, `/proc`, `/proc/self/environ`,
`/var/lib/claude-web/*`, `/var/log/claude-web/audit.jsonl`, `/etc/claude-web/env`,
`~/.claude/*`, symlink→`/etc/passwd`, symlink→`/proc/self/environ`, dir-symlink→наружу,
вложенный symlink, `Grep/Glob` по symlink-каталогу, `Write` через symlink-родителя,
`Write .claude/settings.json`, NUL/relative-escapes, `cwd` вне workspace.
ALLOW: обычные файлы и относительные пути внутри workspace, `Grep/Glob` без path, создание
файла в workspace.
Исходники: `permissionMode:'default'`, `settingSources: []`, `additionalDirectories: []`,
`strictMcpConfig: true`, `tools` whitelist (Read/Glob/Grep/Edit/Write/AskUserQuestion),
`disallowedTools` = Bash/BashOutput/KillShell/WebFetch/WebSearch/Task/Agent, без
`allowedTools`/allow-правил; deny-правила для `/proc`, `/etc`, `/var/lib|log/claude-web`,
`~/.claude|.dsh|.ssh|.gnupg`, `.env`; child env — allowlist (`sdk.mjs:78-89`), без
`EDGE_SECRET`/DSH; токен только в env.

### 5.4. Static/SPA/PWA

- Traversal/encoded/dotfiles/backslash/NUL (`../../../server/index.mjs`, `%2e%2e`,
  `%252e%252e`, `..%2f`, `....//`, `//etc/passwd`) → 404; отдача только из `dist`
  (`static.mjs:132-220`).
- `sw.js`: `no-store`, **нет** `Service-Worker-Allowed`, scope `/claude/`; assets —
  `public, max-age=86400, immutable`; HTML/API — `no-store`.
- CSP приложения полный + `nosniff`/`DENY`/`no-referrer`/`Permissions-Policy`/`noindex`
  (`http-util.mjs:59-73`).
- XSS: markdown → AST, листья — текстовые Preact-ноды (`markdown.ts`, `Markdown.tsx`);
  ссылки только `http(s)/mailto/root-relative/#`, `javascript:/data:/vbscript:////` —
  literal; в `web/src/**` нет `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`document.write`
  (grep; единственное вхождение `innerHTML` в dist — внутренность Preact, не наш код);
  tool input/cwd/warnings/user text — текст (`ToolCard.tsx`, `ChatScreen.tsx`);
  SSE-данные валидируются по типам (`sse.ts:176-263`).
- SW: API/SSE не перехватываются (`sw.js:290`), навигация только сеть, HTML не кэшируется,
  кэш только `/claude/assets/*` ≤100, проверка `basic`/redirect/HTML; `skipWaiting` только
  по сообщению; `clients.claim()` в scope; login-страница — константа `/auth/tg`, open
  redirect нет; регистрация scope `/claude/` (`sw-register.ts:19-20, 97-99`).
- `manifest`: `id/start_url/scope=/claude/`, standalone; index.html — полный CSP в `<meta>`,
  без inline script.

### 5.5. Caddy — FROZEN-фрагмент на изолированном Caddy 2.11.9

Собран `apply-caddy.py` (FROZEN) из копии живого Caddyfile `60ae87f3…` → localization
путей/портов → `caddy validate` = **Valid configuration**; `apply-caddy.py --dry-run` —
все структурные проверки PASS (CSP после глобальных header, Origin→install→308→forward_auth,
`-Cookie`, `X-Claude-Edge`, `flush_interval -1`, 5 ассетов, cache-правила до handle,
log-filter `X-Claude-Edge`), patched diff 87 строк.

Матрица (изолированный `127.0.0.1:18084`, мок-auth/мок-app/мок-DSH):

| Проверка | Результат |
|---|---|
| 401 `/claude/` | полный CSP `default-src 'self'; script-src 'self'; …`; `no-store` |
| 401 `/claude/sw.js` | `no-store`, CSP полный |
| аноним manifest + 4 иконки | 200; manifest `application/manifest+json` + `no-cache` (ровно 1 Cache-Control); иконки `image/png` + `public, max-age=86400` (ровно 1); без `Set-Cookie` |
| POST manifest | 405 |
| `/claude` | 308 (CSP minimal — редирект без тела, ок) |
| cross-origin `/claude/` и install-ассета | 403 **до** forward_auth; мульти-`Origin` и payload'ы с кавычками/`||` — fail-closed |
| `/claude/assets/*` 200 | `public, max-age=86400, immutable` ровно одним значением |
| `/claude/` (HTML) 200 | `no-store`; CSP: Caddy-полный + app-полный (пересечение); app не отдаёт cookie |
| upstream-заголовки | `X-Auth-User` = от mock-`/verify`; `X-Claude-Edge` = значение Caddy (клиентский spoof перезаписан); `Cookie`/`Authorization`/`X-Real-IP`/`X-Forwarded-User` отсутствуют |
| access-log после spoof-запросов | 0 вхождений `Cookie`, `Authorization`, `X-Claude-Edge` |
| traversal/`..`/`%2e%2e`/dotfiles/`%00` | 401/403; наружу отдаются только 5 публичных файлов (path-cleaning на `/claude/icons/../manifest` → публичный manifest, безопасно) |
| **401 на `/claude/assets/*` и приватную иконку** | `public, max-age=86400[, immutable]` — SEC-11 (см. §3; Low, не блокер) |

### 5.6. Live VPS (read-only, перед apply)

- `claude-web` active, только `127.0.0.1:3090`; `claudeapp` (groups только `claudeapp`),
  не читает `/etc/claude-web/env` и `/home/dsh`; `/opt/claude-web`/public не writable app;
  env 0600 root:root, audit 0600 claudeapp, `/var/log/claude-web` 0700 claudeapp; journal без
  `sk-ant-`/cookie (grep 0); анонимный `/claude/*` на 3090 → 403 с полным CSP; `/claude` →
  308; DSH `8081/` → 401 (не сломан); живой Caddyfile `60ae87f3…` без маршрута `/claude/*`.

---

## 6. Условия/проверки после apply (обязательны)

1. `apply-caddy.py --install` (не ручная правка), свежий бэкап/TAG; после restart — проверить,
   что `claude-pwa-backup-TAG` указывает на новый каталог (SEC-02).
2. Прогнать `deploy/acceptance.sh --deep` (root, секрет не в argv) — exit 0; плюс вручную:
   - аноним `/claude/` → 401 **и полный CSP с `default-src 'self'`** (ключевая проверка SEC-01);
   - 5 ассетов → 200 с правильным content-type/Cache-Control, без `Set-Cookie`;
   - `/claude/sw.js` → 401; `POST` manifest → 405; `/claude` → 308;
   - cross-origin (включая WS/Upgrade) `/claude/*` → 403 **до** `/verify`;
   - `127.0.0.1:3090` без `X-Claude-Edge` → 403; с верным edge и чужим `X-Auth-User` → 403;
   - DSH `/` → 401, `/manifest.webmanifest` → 200; Caddy access log без
     `Set-Cookie`/`__Host-dsh_session`/`X-Claude-Edge`;
   - приложение получает `X-Auth-User` и не получает `Cookie`.
3. **SEC-11**: либо Lead/edge принимает residual письменно (добавить в отчёт/риски §7.3),
   либо после apply добавить гейтинг deferred cache-правил на 2xx (см. §3). До решения
   публично-кэшируемый 401 не является утечкой, но может ухудшить UX после истечения сессии.
4. Откат — только по свежему TAG, созданному `--install`; после отката DSH 401/200 и сверка
   Caddyfile с пред-apply снимком (не с устаревшим `20261122-083521`).

Нарушение п.1–4 = veto на публикацию `/claude/` (server/** и web/** уже одобрены).

---

## 7. Подпись

- **server/** и **web/**: **ОДОБРЯЮ** (High/Critical нет; residual §4 принять).
- **Применение Caddy-фрагмента FROZEN** (`apply-caddy.py b61f508e…`, `Caddyfile.fragment
  f9e4f0ce…`, `acceptance.sh 74f267b3…`): **ОДОБРЯЮ** при выполнении §6.1–6.4; SEC-11 —
  Low, принять residual или исправить после apply (не блокер).
- Вето: только при отступлении от §6 (ручная правка Caddyfile, отсутствие CSP
  `default-src 'self'` на 401 `/claude/` после apply, отсутствие post-apply проверок,
  откат по устаревшему бэкапу).

Подпись: `security` (независимый ревьюер), 2026-11-22.

---

## 8. Addendum: post-apply независимая проверка (public origin)

Применено Lead в окне 10:42 UTC; я независимо проверил **анонимные** запросы к публичному
origin `https://vps-4692.tailfbc4b2.ts.net:10000` (без сессии, без секретов; 3090 остаётся
loopback-only).

PASS (все проверки совпали с чек-листом §6):

- `/claude/` анонимно → `401`, тело `{"error":"unauthorized"}`, есть
  `content-security-policy: … default-src 'self'; script-src 'self'; …` (плюс глобальная
  минимальная — браузер применяет пересечение, полный CSP сохраняется); без `Set-Cookie`.
- 5 install-ассетов → `200`: manifest `application/manifest+json` + `no-cache`, иконки
  `image/png` + `public, max-age=86400`; **ровно один** `Cache-Control`; без `Set-Cookie`.
- `/claude/sw.js` → `401`; `POST` manifest → `405`; `/claude` → `308` на `/claude/`.
- cross-origin `GET /claude/`, manifest и WS-upgrade → `403`; валидный Origin без сессии →
  `401`; спуф `X-Auth-User`/`X-Claude-Edge` → `401`.
- `/claude/api/{health,workspaces,sessions}` анонимно → `401`; `POST heartbeat` → `401`.
- DSH не сломан: `/` → `401`, `/manifest.webmanifest` → `200`, `/tg` → `200`, `/healthz` → `200`.
- traversal/private (`._*`, `.DS_Store`, `%2e%2e`, `../../etc/passwd`,
  `../../server/index.mjs`, `/claude/claude/icons/...`) → `401` (наружу ничего не отдано).
- `Set-Cookie`/`Service-Worker-Allowed` отсутствуют на всех проверенных `/claude/*` ответах.

Замечания (не security, к сведению): на 401 `/claude/` два `Content-Security-Policy`
(Caddy полный + глобальный минимальный) — пересечение строже, ок; два одинаковых
`cache-control: no-store, private` — безвредно.

**SEC-11 подтверждён live (до фикса):** анонимный `GET /claude/assets/index-CNf-L_Pk.js` →
`401` + `Cache-Control: public, max-age=86400, immutable`; `GET /claude/icons/favicon-96.png`
(не публичная) → `401` + `public, max-age=86400` + `image/png`; `/claude/sw.js` → `401` +
`no-store`. Lead решил исправлять (task-8: `header_down` для assets, правила внутрь
`handle @claude_install` для manifest/icons). **Финальное подтверждение/veto — после
повторного apply новой FROZEN-ревизии: ожидаю 401 `/claude/assets/*` без `public` и повторный
PASS §6/§8.**

Итог addendum: текущий применённый маршрут **безопасен** (post-apply PASS), SEC-11 известен и
чинится; veto не снимается до подтверждения исправления на живом.

---

## 9. Финальная FROZEN-ревизия с исправлением SEC-11 (task-8) — подтверждение

FROZEN sha256 (сверены с edge и Lead, совпадают с workspace):

| Артефакт | sha256 |
|---|---|
| `deploy/apply-caddy.py` | `df92b4f98c0c41aa195a38f92f73f9505e05a10a046fcce4f5fb21bcd1f7366c` |
| `deploy/Caddyfile.fragment` | `6a74e80ba44b6b6d66b97d3f804f92606b637d9c90d8ecb276959621478c0a29` |
| `deploy/acceptance.sh` | `efc962df7e97ff3fc25f235c42fd52d12ee29eb07663c46e5990e7b027ad7d99` |

Проверены **оба** пути применения на реальном (изолированном) Caddy 2.11.9 c копиями живого
конфига:
1. **Upgrade-in-place** из текущей установленной ревизии (`35d1e71d…`): `apply-caddy.py
   --dry-run` заменил секции A/B целиком («обновляю секции B»), старые top-level
   `@claude_assets/@claude_icons/@claude_manifest` и deferred `>Cache-Control` удалены,
   маркеры по одному, diff 94 строки, `verify_patch` PASS.
2. **Fresh insert** (после репетиции отката живой Caddyfile снова `60ae87f3…`, маркеров
   фрагмента нет — именно это состояние перед повторным apply): `A` после глобальных
   header-директив, `B` перед catch-all, `log-filter X-Claude-Edge` — все структурные проверки
   PASS, `caddy validate` = **Valid configuration**.

Изолированный прогон финального (fresh-insert) конфига:

- **SEC-11 закрыт.** Анонимно: `/claude/assets/index-…js` → `401` + `Cache-Control:
  no-store, private` (**нет** `public`/`immutable`), `Content-Type: text/plain`;
  `/claude/icons/favicon-96.png` → `401` + `no-store`, **без** `image/png`;
  `/claude/sw.js` → `401` + `no-store`; `/claude/` → `401` + полный CSP.
- 200-путь не регрессировал: `/claude/assets/index-…js` → `200`, **ровно один**
  `public, max-age=86400, immutable`, `text/javascript`; app `500` → `no-store` **без**
  immutable (2xx-гейтинг `@claude_asset_ok` + `handle_response` работает, включая 5xx);
  HTML/API/SSE → `no-store`; `sw.js` 200 → `no-store` без `Service-Worker-Allowed`.
- 5 публичных install-ассетов → `200` с правильными content-type и **ровно одним**
  `Cache-Control` (manifest `no-cache` + `application/manifest+json`; иконки
  `public, max-age=86400` + `image/png`), без `Set-Cookie`.
- Без изменений и PASS: evil Origin → `403` до `/verify`; `/claude` → `308`; `POST` manifest →
  `405`; upstream получает `X-Auth-User` от `/verify` и `X-Claude-Edge` от Caddy (клиентский
  spoof перезаписан), **не** получает `Cookie`/`Authorization`; traversal → `401`;
  access-log без `Cookie`/`Authorization`/`X-Claude-Edge`.
- Тесты: `npm test` **226/226**, deploy **36/36**; `acceptance.sh` дополнен регрессией 2b
  («401 не получает immutable / image/png»), проверки `check_401_no_cache` для
  `/claude/assets/app.js`, `/claude/sw.js`, `/claude/icons/favicon-96.png`, `/claude/`.

Заключение по финальной ревизии: **ОДОБРЯЮ повторный apply** FROZEN-ревизии
(`df92b4f9…`/`6a74e80b…`/`efc962df…`). Обязательные post-apply: `acceptance.sh --deep`
exit 0 + анонимные проверки из §8 и SEC-11-регрессия (401 assets без `public`/`immutable`,
favicon 401 без `image/png`) + DSH 401/200. Итоговое post-apply подтверждение — после
применения (сверю фактические заголовки 401/200 и access-log через public origin).

Подпись (addendum): `security`, 2026-11-22.

---

## 10. Post-apply финальной ревизии — независимое подтверждение (вето снято)

Применено Lead (окно ~10:54 UTC). Живой Caddyfile:
`sha256 add2e495423112201aa5bd4f29b656b12de34d80c0f6f5784a24b65a34dbd015`, `0640 root:caddy`
(= FROZEN-ревизия из §9, применена fresh-insert после репетиции отката). Бэкап пред-apply:
`/root/claude-pwa-backup-20261122-105447` (Caddyfile `60ae87f3…`, 0600 root), TAG pointer
обновлён на `20261122-105447`.

**Независимая анонимная проверка с public origin** (без сессии и секретов; 3090 остаётся
loopback-only), сразу после apply:

- **SEC-11 закрыт на живом:** `/claude/assets/index-CNf-L_Pk.js` → `401` +
  `cache-control: no-store, private` (**нет** `public`/`immutable`), `application/json`;
  `/claude/icons/favicon-96.png` → `401` + `no-store` (**нет** `image/png`);
  `/claude/sw.js` → `401` + `no-store` (ровно одно значение).
- `/claude/` → `401`, полный `Content-Security-Policy: default-src 'self'; script-src 'self'; …`
  (+ глобальная минимальная — пересечение строже), `no-store`, без `Set-Cookie`.
- 5 install-ассетов → `200`: manifest `no-cache` + `application/manifest+json`; иконки
  `public, max-age=86400` + `image/png`; **ровно один** `Cache-Control`; без `Set-Cookie`.
- `/claude` → `308` на `/claude/`; `POST` manifest → `405`; evil Origin (GET/WS-upgrade) →
  `403`; валидный Origin без сессии → `401`; спуф `X-Auth-User`/`X-Claude-Edge` → `401`.
- `/claude/api/{health,workspaces,sessions}` анонимно → `401`; `POST heartbeat` → `401`.
- DSH не сломан: `/` → `401`, `/manifest.webmanifest` → `200`, `/tg` → `200`, `/healthz` → `200`.
- traversal/private (`._*`, `.DS_Store`, `%2e%2e`, `../../etc/passwd`, `../../server/index.mjs`)
  → `401`; `Set-Cookie`/`Service-Worker-Allowed` отсутствуют на всех проверенных ответах.

**Read-only VPS:** в живом Caddyfile маркеры A/B по одному; A — после `@nonAuthCsp` CSP-блока,
B — перед catch-all; `forward_auth` → ветка `handle @claude_assets` c
`@claude_asset_ok status 2xx` + `handle_response … copy_response` → общий `handle` (HTML/API/SSE);
старых top-level `@claude_assets/@claude_icons/@claude_manifest` deferred-правил **нет** (проверка
с отступами = 0); `header` manifest/icons — внутри `handle @claude_install`; `@claude_sw
>Cache-Control "no-store"` top-level; log-filter `request>headers>X-Claude-Edge delete`.
Бэкап `105447` sha `60ae87f3…`; оба сервиса active; `3090`/`8081` только loopback;
access-log — 0 совпадений `Set-Cookie`/`__Host-dsh_session`/`X-Claude-Edge`; journal
`claude-web` — 0 совпадений токена/сессии; loopback `8081/` и `/claude/` → 401.
(Факты Lead: `acceptance.sh --deep` checks=32 failed=0; тот же Caddy sha и бэкап.)

**Итог:** SEC-11 закрыт, регрессий 200-пути нет, DSH не затронут, секретов в логах нет.
Открытых High/Critical/Medium — **0**. Low SEC-03/04/05/06 — приняты как residual/defense-in-depth
(письменно фиксирует Lead в финальном отчёте), Info SEC-07/08/09/10 и residual §4 — без изменений.
**Veto снят. Деплой `/claude/` подтверждён (post-apply PASS).**

Подпись (финальная): `security` (независимый ревьюер), 2026-11-22 — **одобряю деплой**.



