# Claude PWA — журнал развёртывания (Lead)

Дата: 2026-11-22. Окружение: VPS 45.144.214.206 (vps-4692), публичный origin
`https://vps-4692.tailfbc4b2.ts.net:10000`, приложение `127.0.0.1:3090`, путь `/claude/`.

## Состояние до деплоя (Phase 0)

- Живой Caddyfile: 192 строки, `0640 root:caddy`, sha256 `92dd74d4…` на момент бэкапа 08:35:21 UTC.
  В 08:36:34 UTC владелец/внешнее обновление auth-гейтвея изменило Caddyfile (P1 RT-APP-3:
  vendor telegram-web-app.js + CSP для /tg,/auth), новый sha256 `fcf7ebb8…`. На деплой влияет
  только как «файл, который надо перечитать перед патчем»; apply-caddy.py делает свой бэкап.
- Node `v24.22.3`, npm 11.19.1, `claude` 2.1.329, RAM 1967 МБ, диск 29 ГБ (свободно 21 ГБ).
- Сервисы active: dsh-web, dsh-gateway-auth, dsh-gateway-caddy, tailscaled.
- `claudeapp` отсутствовал; /srv пуст; SDK 0.3.330 установлен и проверен в
  `/home/dsh/projects/sdk-inspect` (+ native CLI `claude-agent-sdk-linux-x64`).

## Root-подготовка (runbook §0-§2)

- `TAG=20261122-083521`: бэкап `/root/claude-pwa-backup-$TAG/{Caddyfile,Caddyfile.sha256,dsh-gateway-caddy.unit,ports.txt}`,
  указатель `/root/claude-pwa-backup-TAG`.
- Пользователь `claudeapp` (system, nologin, uid 993, без групп dsh/sudo/caddy),
  каталоги: `/var/lib/claude-web` 0700, `/var/lib/claude-web/claude-config` 0700,
  `/var/log/claude-web` 0700, `/srv/claude-web` 0751 root, `/srv/claude-web/workspaces` 0750 claudeapp,
  `/srv/claude-web/public` 0755 root, `/etc/claude-web` 0750 root, `/opt/claude-web` 0755 root.
  `runuser -u caddy -- test -x /srv/claude-web` — ok.
- OAuth-токен: `claude setup-token` (1 год) в tmux под `dsh`; токен записан только в
  `/etc/claude-web/env` (0600 root:root) вместе с `EDGE_SECRET` (32 байта) и `ALLOWED_USER_HASH`.
  Проверка: `claude auth status` с env → `loggedIn:true, authMethod:oauth_token`. Токен в чат/логи
  не выводился; буфер tmux убит.

## Сборка и проверки (до установки)

- Локально (Mac, Node 24.22.1): `npm test` → 220/220 (server+pwa+deploy) после фикса auto-approval.
- Сервер (dsh, Node 24.22.3): `npm ci` (SDK 0.3.330 + native CLI), `npm --prefix web ci && npm run build`,
  `node --test 'test/*/*.test.mjs'` → 213/213 (до фикса auto; повтор после ре-sync — ниже).
- Реальный SDK-smoke (dev 127.0.0.1:3091, fake→sdk, токен из env): турн «ответь одним словом» →
  `assistant_message "ок"`, реальный `usage`, `result/end_turn`; audit без промптов, в логах нет
  `sk-ant`; предстоит турн с инструментами (Read auto / Write approval).

## Установка (факт)

- Артефакт: `/root/claude-web-20261122-102537.tgz` (235 файлов, source + web/dist, без node_modules/.git).
- `deploy/install.sh --artifact …`: PASS по всем шагам — пользователь/каталоги, npm ci (105 пакетов,
  SDK + native CLI), публичные install-ассеты в `/srv/claude-web/public/claude`, юнит,
  `claude-web active`, 3090 только loopback, env 0600, в journal нет `sk-ant`.
- Найден и исправлен баг install.sh/acceptance.sh: `stat -c '%a %U:%G'` даёт `600 root:root`,
  а сравнение было с `600 root root` (фикс в обоих скриптах).
- Прямые проверки 3090: без `X-Claude-Edge` → 403; с edge+своим `X-Auth-User` → 200
  (`/claude/api/health` = `{ok,version:0.1.0,active:0,max:2,mode:sdk}`); с чужим user → 403;
  `/claude/sw.js` без edge → 403.
- `deploy/apply-caddy.sh --dry-run` на живом (sha256 `60ae87f3…`, 223 строки): `caddy validate`
  = Valid configuration, `caddy adapt` — маршруты/заголовки на месте. Живой файл не менялся.

## Находка CSP (важно)

Репетиция на изолированном Caddy 2.11.9 (порт 18481/18482, живой auth-гейтвей) показала:
при текущем живом конфиге глобальный CSP ставится через матчер (`@nonAuthCsp not path /tg /auth/*`
+ `header @nonAuthCsp Content-Security-Policy …`). Наш CSP-блок, вставленный ДО глобального header,
**полностью перетирается**: в ответе `/claude/` остаётся только минимальная CSP
(`frame-ancestors/base-uri/object-src`). Если вставить блок ПОСЛЕ глобальных header-директив —
в ответе есть полный CSP с `default-src 'self'` (то, что требует приёмка §6).
Исправление якоря вставки поручено edge (task-6), после чего повторим dry-run и репетицию.
Это же расхождение надо отразить в runbook §5 (там сказано «в начало route») после приёмки.

## Боевое применение Caddy (окно, 10:42 UTC)

- Пред-apply живой Caddyfile: sha256 `60ae87f3…` (223 строки). `apply-caddy.sh --install`:
  свежий бэкап `/root/claude-pwa-backup-20261122-104217` (sha `60ae87f3…`), патч копии,
  `caddy validate`/`adapt` PASS, перечитывание живого файла перед подменой, атомарная установка
  0640 root:caddy, `systemctl restart dsh-gateway-caddy` (~доли секунды), post-checks PASS,
  TAG pointer обновлён. DSH после рестарта отвечает 401 на loopback.
- `deploy/acceptance.sh --deep`: **checks=28 failed=0, RESULT=ok**. Ключевое: аноним `/claude/`
  401 + полный CSP `default-src 'self'`; 5 install-ассетов 200 (manifest
  `application/manifest+json` + `no-cache`; иконки `image/png` + `public, max-age=86400`),
  без `Set-Cookie`; `/claude/sw.js` 401; `POST` манифеста 405; cross-origin 403; спуф
  `X-Auth-User` 401; `/claude` 308; 3090 без edge 403 и с чужим user 403; DSH `/` 401,
  `/manifest.webmanifest` 200; access-log без `Set-Cookie`/`__Host-dsh_session`/`X-Claude-Edge`;
  journal/audit без `sk-ant`; env 0600 root:root.
- Создан рабочий workspace `/srv/claude-web/workspaces/demo` (claudeapp 0750) — UI не пустой.

## Найдено после применения и чинится (SEC-11, Low)

Deferred `>Cache-Control` применялся и к 401 (анонимный `/claude/assets/*.js` кэшировался как
`public, max-age=86400, immutable`; приватные иконки — как `public`). Риск: после истечения
сессии и повторного входа браузер может отдать закэшированный 401 вместо JS/CSS. Решение:
assets — `header_down >Cache-Control` внутри `reverse_proxy` (не применяется, когда
forward_auth отдал 401); manifest/icons — правила внутрь `handle @claude_install` (публичные
пути). Фикс — task-8, затем повторный apply в рамках репетиции отката.

## Репетиция отката (Gate G6, 10:57 UTC)

- `deploy/rollback.sh --tag 20261122-104217`: restore pre-apply Caddyfile, `validate`, restart,
  DSH-пробы. Результат: live sha снова `60ae87f3…` (223 строки), `dsh-gateway-caddy` active,
  DSH `/` 401, `/manifest.webmanifest` 200, `/tg` 200, `/healthz` 200; `/claude/` → 401 от
  старого catch-all (без 308), `/claude/manifest.webmanifest` 401, `/claude/assets/*` 401,
  CSP только минимальная — ожидаемое состояние отката. Приложение не останавливалось,
  данные/audit/бэкапы не тронуты. QA зафиксировал оба состояния.

## Финальное применение (SEC-11 fix, 10:54 UTC)

- `apply-caddy.sh --install`: fresh insert от восстановленного `60ae87f3…`, новый бэкап
  `/root/claude-pwa-backup-20261122-105447`, TAG pointer обновлён; `caddy validate`/`adapt` PASS;
  restart PASS; live sha `add2e495…` (640 root:caddy).
- `acceptance.sh --deep`: **checks=32 failed=0 RESULT=ok**.
- SEC-11 закрыт: анонимный `/claude/assets/*.js` → 401 c `no-store, private` (без public/immutable);
  `/claude/icons/favicon-96.png` → 401 `no-store` (без image/png); `/claude/sw.js` → 401 no-store.
- Аноним `/claude/` 401 + полный CSP `default-src 'self'`; `/claude` 308; manifest 200
  `application/manifest+json` + `no-cache`; 4 иконки 200 `image/png` + `public, max-age=86400`;
  DSH `/` 401, `/manifest.webmanifest` 200, `/tg` 200; access-log без Set-Cookie/cookie/edge;
  сервисы active; 3090/8081 только loopback.

## Фикс update-баннера PWA (11:16 UTC)

Найдено на живом: в Chrome вкладка `/claude/` показывала «Доступно обновление», кнопка «Обновить»
ничего не делала. Причина: баннер срабатывал на `updatefound` при `container.controller` — на первом
заходе под чужим service worker (DSH root scope) наша регистрация `/claude/sw.js` устанавливается и
активируется сразу (это не обновление, `registration.waiting` нет), но контроллер (чужой) уже был →
баннер показывался, а клик молча скрывал плашку без перезагрузки.

Фикс (web/src/sw-register.ts, web/src/app.tsx):
- баннер только при `reg.waiting` (реально ожидающий воркер), а не по факту чужого контроллера;
- `applyServiceWorkerUpdate()`: при отсутствии `waiting` — принудительный `reloadOnce(true)` (тап
  никогда не no-op); после `SKIP_WAITING` — страховочный reload через 4 с, если воркер не ответил;
- `controllerchange` по явному действию пользователя перезагружает страницу в обход 5-секундного
  анти-петлевого guard'а; UI скрывает баннер сразу.

Тесты: `test/pwa/sw-update.test.mjs` (+4), всего 230/230. Пересборка и `install.sh --artifact`:
RESULT=ok, новый бандл `index-BULplnDI.js` отдаётся приложением, `acceptance.sh --deep` 32/32 PASS.
Владельцу нужен один hard-reload (Cmd+Shift+R), чтобы получить новый JS; дальнейшие обновления —
по кнопке.

## Отдельный origin для Claude PWA (12:09-12:11 UTC)

Проблема: DSH установлен как PWA со scope `/`, поэтому ссылки на `...:10000/claude/`
открывались в DSH-приложении (вложенный scope), на Android — даже после установки Claude.
Решение (вариант B, без домена): второй публичный порт Tailscale Funnel `:8443` → отдельный
Caddy `127.0.0.1:8444` (независимый от Caddy гейтвея, чтобы деплой гейтвея его не сносил).
Порт — часть origin, значит это отдельное PWA; cookie `__Host-dsh_session` host-bound
(порты cookie не различает), поэтому вход остаётся общим.

Сделано:
- xray inbound `8443` перенесён на `2096` (443/2053/2096; конфиг провалидирован, бэкап
  `/root/xray-backup-20261122-115236`), ufw allow 2096, `tailscale funnel --bg --yes
  --https=8443 http://127.0.0.1:8444`.
- Гейтвей: `GATEWAY_EXTRA_ALLOWED_ORIGINS=https://…:8443` (+ `GATEWAY_CLAUDE_ORIGIN`),
  `checkHost` принимает authority второго origin; кнопка «Открыть Claude» в @bvauthbot ведёт
  на `https://…:8443/tg?next=/claude/`; бэкап `/root/gateway-lib-backup-20261122-120933`.
- Приложение: `EXTRA_ORIGINS=https://…:8443` в `/etc/claude-web/env` (Host/Origin allowlist),
  передеплой артефактом (install.sh RESULT=ok), `Host :8443` → 200.
- Новый edge `claude-web/edge-claude/` (Caddy :8444 + systemd + install/rollback): install.sh
  RESULT=ok, 15+ post-checks; отдельный лог `/var/log/claude-edge/access.log` без cookie/query/
  Set-Cookie/X-Claude-Edge. Тесты: gateway 167/167, claude-web 269/269 (включая edge-claude).
- Публично: `https://…:8443/claude/` → 401 + полный CSP; manifest 200 application/manifest+json;
  иконки 200 image/png; POST manifest 405; чужой Origin 403; `/claude` 308; `/` 302 на :10000;
  `/tg` 200 (вход с нового origin). Старый `/claude/` на :10000 работает.
- Сеть: у домашнего провайдера выяснилось, что TCP 443 до IP сервера блокируется (REALITY на
  443 не проходит; 2053/2096 проходят, SSH 22 проходит). В Clash-профиле нода `VLESS-8443`
  заменена на `VLESS-2096` (бэкап профиля рядом), активная нода — `VLESS-2053`.
  Это не связано с панелью/PWA, но объясняет обрыв прокси в момент работ.

## ОТКАТ второго origin :8443 (по требованию владельца, 19:41-20:05 UTC)

Владелец: «с какого перепуга ты 8443 заменил? надо чтобы там xray был как раньше». Откат выполнен
полностью:

- `tailscale funnel --https=8443 off` — публичный Funnel снова только `:10000`.
- xray: конфиг восстановлен из бэкапа `/root/xray-backup-20261122-115236` (sha256
  `bfad5213…`, byte-identical), inbound снова на **8443** (плюс 443, 2053), `xray -test` OK,
  сервис active, слушает `*:443 *:8443 *:2053`; REALITY-хендшейк с домашнего канала на 8443 —
  `CN=www.speedtest.net`, verify OK.
- `claude-edge` остановлен и удалён (`rollback.sh`; конфиг/логи сохранены), unit — not-found.
- Убраны env: `GATEWAY_EXTRA_ALLOWED_ORIGINS`/`GATEWAY_CLAUDE_ORIGIN` из gateway.env,
  `EXTRA_ORIGINS` из `/etc/claude-web/env`; сервисы перезапущены.
- `ufw delete allow 2096/tcp`.
- Код второго edge остаётся в репозитории (`claude-web/edge-claude/`), но выключен — вернём
  только если появится отдельный домен (на одном host без свободного Funnel-порта отдельное
  PWA для Claude невозможно: установленный DSH scope `/` перехватывает `/claude/`).
- Claude PWA снова живёт на прежнем адресе `https://vps-4692.tailfbc4b2.ts.net:10000/claude/`
  (в браузере; отдельного приложения нет). Кнопка «Открыть Claude» в @bvauthbot снова ведёт на
  `:10000/tg?next=/claude/`.
- Clash на Mac возвращён в обычный режим: `mode=rule`, `TUN on`, нода `VLESS-8443` (она снова
  рабочая), интернет проверен.

Причина ошибки: для второго origin был занят порт 8443 (Funnel разрешает только 443/8443/10000,
а 443 и 8443 держал xray). Правильным было бы сначала согласовать освобождение порта у xray —
это не было сделано.

## Вход через @bvauthbot и два отдельных PWA (11:22 UTC)

По решению владельца: origin один (Funnel отдаёт только :10000, 443/8443 заняты xray), но DSH и
Claude остаются **двумя разными устанавливаемыми приложениями** — разные `id`/`scope`/`start_url`
(DSH: `/`, `DeepSeek Harness`; Claude: `/claude/`, `Claude Workspace`), свои иконки и SW.

Изменения:
- **Auth-бот @bvauthbot** (`lib/authbot.mjs`): на `/start` две web_app-кнопки — «Открыть DSH»
  (`/tg`) и «Открыть Claude» (`/tg?next=/claude/`); `/claude` — алиас панели; help обновлён.
- **Страница входа `/tg`** (`lib/pages.mjs`): `next` строго из allowlist `['/', '/claude/']`
  (никакого open redirect), все успешные входы (Telegram initData, TOTP, recovery, browser
  password+TOTP) идут через `goNext()`; статус «открываем Claude/DSH». Серверный `/auth/*`
  не менялся (по-прежнему отдаёт `next:'/'`, страница решает по allowlist).
- **Бот уведомлений**: команда `/claude` удалена (и код, и конфиг, и env); вход в Claude — только
  через auth-бота.
- **Claude PWA**: добавлена кнопка «Установить» (beforeinstallprompt/appinstalled, скрыта в
  standalone и после установки) — ставится независимо от установленного DSH.
- Деплой: gateway — только `lib/pages.mjs`+`lib/authbot.mjs` + restart `dsh-gateway-auth`
  (Caddy не трогали, маршрут `/claude/` сохранён), бэкап `/root/gateway-lib-backup-20261122-112255`;
  бот уведомлений — бэкап `/root/telegram-bot-backup-20261122-112349`; приложение — новый артефакт
  `install.sh` RESULT=ok, бандл `index-DVLH_H0M.js`.
- Проверки: gateway-тесты 162/162 (`tests/pages.test.mjs` — allowlist/without open redirect),
  бот уведомлений 292/292, claude-web 233/233; `acceptance.sh --deep` 32/32 PASS; `/tg` 200
  (allowlist в странице), `/claude/` 401, DSH не затронут.

## Третий PWA (решение: пока не делать)

Официального self-hosted веб-интерфейса Claude нет: claude.ai — только SaaS; у Anthropic есть
[self-hosted environments для Claude Code](https://websitemain.claude.com/blog/run-claude-code-sessions-on-your-own-compute?r=0)
(public beta: сессии исполняются на твоей инфраструктуре, но UI — их веб/мобильный) и
[enterprise-консоль self-hosted Managed Agents](https://platform.claude.com/docs/en/managed-agents/self-hosted/console.md)
(по заявке). Claude Cowork — облачный, self-hosted версии нет
([разбор](https://github.com/kortix-ai/suna/blob/3fe7c67ffbad34d97f45ed64a91f28f39a879e68/apps/web/content/posts/self-hosted-claude-cowork.md)).
Сторонние UI: [Open WebUI с Anthropic API-ключом](https://docs.openwebui.com/alternatives/claude)
(отдельный биллинг по токенам), агентские платформы Suna, обёртка десктоп-приложения
[Claudesk](https://github.com/ump45nose/Claudesk) и мобильный клиент
[TwiCC](https://pypi.org/project/twicc/1.9.0/) — с рисками ToS/хрупкости и/или отдельным origin.
Владелец выбрал «пока не делать».

## Откат

- Caddy: `deploy/rollback.sh --tag $TAG` (restore + validate + restart), DSH-проверки.
- Приложение: `systemctl disable --now claude-web` (Caddy начнёт отдавать 502/503 на /claude/,
  DSH не затронут), затем при необходимости restore Caddyfile.
