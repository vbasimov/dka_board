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

## Откат

- Caddy: `deploy/rollback.sh --tag $TAG` (restore + validate + restart), DSH-проверки.
- Приложение: `systemctl disable --now claude-web` (Caddy начнёт отдавать 502/503 на /claude/,
  DSH не затронут), затем при необходимости restore Caddyfile.
