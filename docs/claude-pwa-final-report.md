# Claude PWA — итоговый отчёт о развёртывании (2026-11-22)

Статус: **развёрнуто, приёмка пройдена, security-veto снят**. Публичный адрес:
`https://vps-4692.tailfbc4b2.ts.net:10000/claude/` (тот же вход, что у DSH).

## 1. Что сделано

| Блок | Результат |
|---|---|
| Свой веб-UI к Claude Code | SPA (Preact 10 + Vite 7 + TS), SSE-стриминг, tool-карточки с ручным подтверждением, стоп/прерывание, resume, список сессий |
| PWA | свой манифест/SW/иконки, scope `/claude/`, offline-страницы, update-флоу; иконки — zero-dep PNG-генератор |
| Бэкенд | Node 24 + `@anthropic-ai/claude-agent-sdk@0.3.330` (собственный CLI, глобальный `claude` не нужен), safe-режим без Bash/WebFetch/WebSearch, `permissionMode:'default'`, PreToolUse-хук-граница путей, audit JSONL |
| Доступ | тот же origin/сессия гейтвея: Caddy `forward_auth /verify` → `reverse_proxy 127.0.0.1:3090`; cookie гейтвея в приложение не попадает; `X-Claude-Edge` + `X-Auth-User` (allowlist) проверяются приложением |
| Изоляция | пользователь `claudeapp` (без dsh/sudo/caddy), `/opt/claude-web`, данные `/var/lib/claude-web`, workspace `/srv/claude-web/workspaces`, systemd-hardening, лимиты 1150M/150%/256 задач |
| Токен | `claude setup-token` (1 год), только в `/etc/claude-web/env` (0600 root:root), проверено `authMethod: oauth_token` |
| Код | `claude-web/` (репозиторий workspace) и зеркало `/home/dsh/projects/claude-web` (dsh); тесты **226/226** (server 188, pwa 68, deploy 36… итого 226) |

## 2. Что и где (runbook §1-§5)

- Приложение: `/opt/claude-web` (root:root, не writable для claudeapp), юнит `/etc/systemd/system/claude-web.service`,
  слушает **только** `127.0.0.1:3090`.
- Данные: `/var/lib/claude-web` (state, `claude-config`), audit `/var/log/claude-web/audit.jsonl` (0600).
- Workspace: `/srv/claude-web/workspaces/demo` (создан, claudeapp 0750). Добавлять рабочие каталоги — сюда.
- Публичная статика установки: `/srv/claude-web/public/claude/*` (root:root 0644/0755).
- Env: `/etc/claude-web/env` 0600 root:root (`EDGE_SECRET`, `ALLOWED_USER_HASH`, `CLAUDE_CODE_OAUTH_TOKEN`).
- Caddy: живой `/etc/dsh-gateway-caddy/Caddyfile` (0640 root:caddy), live sha256
  `add2e495423112201aa5bd4f29b656b12de34d80c0f6f5784a24b65a34dbd015`.
- Бэкапы/откат: `/root/claude-pwa-backup-20261122-105447` (pre-final-apply, sha `60ae87f3…`),
  `/root/claude-pwa-backup-20261122-104217` (pre-first-apply), указатель `/root/claude-pwa-backup-TAG`.

## 3. Проверки (независимые)

- `deploy/acceptance.sh --deep`: **checks=32 failed=0, RESULT=ok**.
- Аноним: `/claude/` 401 + полный CSP `default-src 'self'`; `/claude/sw.js` 401; `/` 401;
  `/claude` 308; `POST` манифеста 405; cross-origin (включая WS-upgrade) 403; спуф
  `X-Auth-User`/`X-Claude-Edge` → 401; traversal/`..%2f`/`._*` → 401.
- Публично ровно 5 install-ассетов: 200, manifest `application/manifest+json` + `no-cache`,
  иконки `image/png` + `public, max-age=86400`, без `Set-Cookie`.
- Приложение: 3090 без `X-Claude-Edge` → 403; с чужим `X-Auth-User` → 403; с валидными → 200;
  `/claude/assets/*` 200 = ровно один `public, max-age=86400, immutable`; анонимные 401 —
  `no-store` (SEC-11 закрыт), JS на 401 больше не кэшируется.
- DSH без регрессии: `/` 401, `/manifest.webmanifest` 200 (etag как до деплоя), `/tg` 200,
  `/healthz` 200, WS `/plugins/events` 401.
- Логи: access-log Caddy — 0 совпадений `Set-Cookie`/`__Host-dsh_session`/`X-Claude-Edge`;
  journal и audit — без токена/промптов.
- Реальный SDK smoke: короткий турн («ок»), read-only `Grep` (auto, без подтверждения),
  `Write` с подтверждением → файл создан; реальный `usage` от API; секретов в логах нет.
- Репетиция отката (Gate G6): restore pre-apply Caddyfile → sha `60ae87f3…`, DSH все якоря PASS,
  `/claude/` снова 401 без маршрута; затем финальный apply — всё вернулось. Механика отката рабочая.
- Security-ревью (независимый ревьюер, право veto): Critical 0, High 0, открытых Medium 0.
  SEC-01 (порядок CSP в docs) и SEC-02 (устаревший бэкап при параллельных деплоях шлюза) закрыты;
  SEC-11 (кэширование 401) исправлен и подтверждён на живом; veto снят, деплой одобрен.
- QA (независимо): baseline → приёмка → откат → финальный apply: PASS, блокеров нет.

## 4. Принятые остаточные риски (письменно)

1. **Токен в env дочернего процесса** Claude: deny `/proc/**` и `/etc/claude-web/**` подтверждены,
   но Read в том же UID теоретически остаётся; Power/Bash выключен, минимальный env без `EDGE_SECRET`.
2. **Человеческий фактор**: prompt injection может выглядеть убедительно — UI показывает полный
   путь/инструмент/вход и предупреждения, подтверждение всегда ручное, таймаут = deny.
3. **Single-owner / общий bucket `/verify` 600/мин**: влияние на вход DSH при тяжёлой загрузке.
4. **Вложенный PWA scope**: установка Claude при уже установленном DSH может требовать ручного
   меню Chrome («Установить приложение»); проверка на Android — за владельцем.
5. **Окно рестарта Caddy** до ~15 с (WS/SSE DSH) — выполнялось в окне; reload недоступен (admin off).
6. **SSE после revoke** живёт до закрытия по heartbeat (≤2 мин) и максимум 15 мин на соединение.
7. **DoS authenticated**: нет жёсткого cap SSE-соединений (SEC-03, Low) и числа сессий сверх 2 child.
8. **Low SEC-04/05** (defense-in-depth): `PreToolUse` без `onFailure:'block'`; инструменты вне
   path-набора разрешаются (фактическая граница — tools-whitelist). **SEC-06** (AppleDouble `._*`)
   вычищен из `/opt` и `/srv`; артефакт собирать с `--exclude='._*'`.
9. **Info SEC-07/08/09/10**: audit-редакция секретов до усечения; `cwd`/`sdkSessionId` из state
   не пере-валидируются; title = начало промпта в state (0600); клиентские `X-Auth-*` остаются
   в access-log как шум (секретов нет).
10. **Лимиты Pro-подписки**: веб-UI расходует те же лимиты; авто-ретраев нет; следить за `rate_limit_event`.

## 5. Эксплуатация (коротко)

```sh
systemctl status claude-web              # состояние
journalctl -u claude-web -n 100          # журнал (без секретов)
tail -f /var/log/claude-web/audit.jsonl  # аудит: метаданные без промптов
systemctl restart claude-web             # после обновления кода
systemctl stop claude-web                # kill switch (DSH не затронут, /claude/ -> 502/503)
```

- **Ротация токена** (раз в год/при инциденте): `claude setup-token` → заменить
  `CLAUDE_CODE_OAUTH_TOKEN` в `/etc/claude-web/env` → `systemctl restart claude-web`.
- **Ротация `EDGE_SECRET`**: заменить в `/etc/claude-web/env` **и** в Caddyfile
  (`apply-caddy.sh --install` подставит из env) → restart обоих сервисов.
- **Обновление SDK**: pin версии → `npm ci` → тесты → артефакт → `deploy/install.sh --artifact …`.
- **Любые правки Caddy**: `apply-caddy.sh --dry-run` → `--install` (бэкап + validate + restart).
- **Откат**: `deploy/rollback.sh --tag 20261122-105447` (Caddy) и/или
  `systemctl disable --now claude-web`; данные/audit не удалять.

## 6. ВАЖНО: durability маршрута `/claude/`

Маршрут живёт в живом Caddyfile. **Следующий деплой auth-гейтвея** (он перезаписывает
`/etc/dsh-gateway-caddy/Caddyfile` из шаблона `playbook/dsh-gateway/etc/Caddyfile`) **уберёт
`/claude/`** — Claude PWA станет недоступен (DSH не пострадает). После любого деплоя шлюза:

```sh
cd /home/dsh/projects/claude-web && bash deploy/apply-caddy.sh --install
```

Рекомендация на будущее: добавить фрагмент в шаблон гейтвея (`playbook/dsh-gateway/etc/Caddyfile`
с подстановкой `EDGE_SECRET` в install.sh), чтобы деплой шлюза сохранял маршрут. Это изменение
кода гейтвея — вне рамок текущей задачи, требует отдельного ревью.

## 7. Осталось владельцу (в браузере)

1. Войти: `https://vps-4692.tailfbc4b2.ts.net:10000/auth/tg` → открыть `/claude/` (та же сессия).
2. Проверить турн: streaming, tool-карточка (Read = «авто», Edit/Write = подтверждение),
   deny, timeout (5 мин), interrupt, resume после закрытия, 2 сессии и лимит, истечение сессии.
3. Проверить SW: `navigator.serviceWorker.controller.scriptURL` = `.../claude/sw.js`.
4. Установить PWA (Android Chrome и desktop): имя `Claude`, standalone; при вложенном scope —
   через меню Chrome «Установить приложение» (план §13.7, gate G1).
5. Решить по workspace'ам: сейчас `/srv/claude-web/workspaces/demo`; рабочие репозитории
   импортировать туда (git clone под claudeapp или копирование с правами).

## 8. Документы

- План: `docs/claude-pwa-plan.md` · Runbook: `docs/claude-pwa-runbook.md` (обновлён: CSP-размещение,
  cache/Content-Type, предупреждение об устаревшем бэкапе).
- Журнал деплоя: `docs/claude-pwa-deploy-log.md`.
- Security-ревью: `docs/reviews/security-review.md` (подпись «одобряю деплой», §9 post-apply).
- QA-приёмка: `docs/reviews/qa-acceptance.md` (baseline / приёмка / откат / итог).
- Код и контракт: `claude-web/README.md`, `claude-web/docs/CONTRACT.md`.
