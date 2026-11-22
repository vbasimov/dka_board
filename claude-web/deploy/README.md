# deploy/ — артефакты развёртывания claude-web

Подготовлены по [runbook §1-§8](../../docs/claude-pwa-runbook.md) и
[CONTRACT §8](../docs/CONTRACT.md). **Root-шаги на VPS выполняет Lead/ops**;
эти файлы только готовятся и валидируются в репозитории.

## Файлы

| Файл | Назначение |
|---|---|
| `claude-web.service` | systemd-юнит, дословно runbook §4 (User=claudeapp, hardening, ReadWritePaths, лимиты) |
| `Caddyfile.fragment` | секции A (CSP) и B (маршрут `/claude/*` + deferred кэш/Content-Type статики) по runbook §5; плейсхолдер `__EDGE_SECRET__` |
| `apply-caddy.py` / `apply-caddy.sh` | вставка фрагмента в копию живого Caddyfile: dry-run (по умолчанию) / install / rollback |
| `install.sh` | идемпотентная root-установка: пользователь, каталоги, `/opt/claude-web`, public-ассеты, юнит |
| `acceptance.sh` | приёмка runbook §6 (read-only, exit 1 при провале) |
| `rollback.sh` | restore Caddyfile из `/root/claude-pwa-backup-<TAG>` + restart + проверки DSH |

## Быстрый порядок (root, на VPS)

```sh
deploy/apply-caddy.sh --dry-run          # на живом: копия в /tmp, diff, validate/adapt
deploy/install.sh --artifact /root/claude-web-<TAG>.tgz
deploy/apply-caddy.sh --install          # бэкап + установка 0640 root:caddy + restart + проверки
deploy/acceptance.sh --deep              # runbook §6 (root нужен только для --deep)
# откат Caddy: deploy/rollback.sh --tag <TAG> [--stop-app]
```

`--install` читает `EDGE_SECRET` из `/etc/claude-web/env` (0600 root:root) или
`--secret-file`; в argv секрет не принимается. Env-файл создаёт Lead по runbook §2.

## Что apply-caddy.py делает, кроме вставки фрагмента

- вставляет A ПОСЛЕ всех глобальных header-директив route (`header { }` и
  `@nonAuthCsp` + `header @nonAuthCsp CSP`), но до `@pwa_no_store`/`request_header`/
  `handle`; обратный порядок на Caddy 2.11.9 перетирает CSP (эмпирически проверено
  Lead'ом). B — после `handle /internal/*` и до финального catch-all `handle {`;
- идемпотентен (маркеры, без дублей), отказывается при ненайденном/неоднозначном
  якоре; если фрагмент уже установлен, но отличается от текущего (обновление
  артефактов) — заменяет помеченные секции A/B целиком, без дублей;
- задаёт кэш/Content-Type для `/claude/` статики так, чтобы правила **не
  применялись к не-2xx** (иначе 401 от forward_auth кэшировался бы с immutable):
  `sw.js` → deferred `no-store`; публичные `manifest.webmanifest` → `no-cache` +
  `application/manifest+json` и `icons/*` → `public, max-age=86400` + `image/png`
  ставятся `header` внутри `handle @claude_install` после `respond 405`;
  `/claude/assets/*` — отдельная ветка `handle @claude_assets` внутри `route`
  после `forward_auth`, immutable ставится только на `handle_response status 2xx`
  (`copy_response`); HTML/API/SSE идут обычным proxy с no-store. Эмпирика Caddy
  2.11.9: глобальный deferred-header применялся и к 401 (баг), `header_down` и
  `-Cache-Control` не дают одного значения;
- дополняет `log > format filter > fields` строкой
  `request>headers>X-Claude-Edge delete` — иначе секрет Caddy↔app попадает в
  access-лог (runbook §6 это проверяет); отключается `--no-patch-log`;
- без успешного `caddy validate`/`caddy adapt` живой файл не меняется; при провале
  проверок после restart автоматически восстанавливает бэкап.

## Валидация (2026-11-22, Caddy v2.11.9)

Живой Caddyfile на момент проверки: `sha256 60ae87f3…` (11731 байт, 0640 root:caddy;
менялся шлюзом параллельно — apply-caddy.py перечитывает его в момент применения).

- `caddy validate` пропатченной копии = *Valid configuration*, `caddy adapt` exit 0;
- структурные проверки — PASS: A **после** всех глобальных header-директив
  (`header {}` и `@nonAuthCsp` + `header @nonAuthCsp CSP`) и **до**
  `@pwa_no_store`/`request_header`/`handle`; порядок Origin-guard → install → 308 →
  forward_auth → 3090 → catch-all; `-Cookie`; `X-Claude-Edge`; `flush_interval -1`;
  5 публичных ассетов; log-фильтр `X-Claude-Edge`;
- эмпирически (изолированный `caddy run` на `127.0.0.1:18483`, site-адрес заменён с
  `:8081`, живой сервис не тронут): `GET /claude/` без сессии = **401** и в ответе
  полный `Content-Security-Policy: default-src 'self'; script-src 'self'; …`;
  `GET /` = 401 с глобальной минимальной CSP; `/claude` → 308; `POST` install-ассета
  → 405; cross-origin `/claude/` → 403;
- репетиция на копии живого конфига (изолированный `caddy run`, реальный
  `EDGE_SECRET`, мок upstream :18485/mock public root), два прогона:
  * реальный `forward_auth` (аноним = 401): `/claude/manifest.webmanifest` и
    `/claude/icons/icon-192.png` → 200 с одним `Cache-Control` (`no-cache` /
    `public, max-age=86400`) и правильным `Content-Type`; `/claude/assets/*`,
    `/claude/sw.js`, `/claude/icons/favicon-96.png`, `/claude/` → **401 без
    `immutable` и без подмены `Content-Type`** (только no-store);
  * мок-авторизация `request_header X-Auth-User` (200-путь): `/claude/assets/app.abc123.js`
    → 200 ровно один `Cache-Control: public, max-age=86400, immutable`, нет no-store;
    `/claude/assets/err.js` → 500 **без immutable** (2xx-gating работает);
    `/claude/sw.js` → 200 один `no-store` без `Service-Worker-Allowed`;
    `/claude/`, `/claude/api/health`, SSE `/claude/api/sessions/:id/events` →
    no-store (SSE `Content-Type: text/event-stream` сохранён — обычный proxy);
    `POST` install-ассета → 405;
- живой Caddyfile не изменён (sha256 до/после), /tmp очищен.

Если фрагмент уже был установлен ранее (в т.ч. предыдущая ревизия), dry-run
покажет diff обновления, а `--install` заменит помеченные секции A/B на
актуальные (бэкап — текущий живой файл); при параллельном деплое шлюза
установка отменяется, если файл изменился после чтения.

Важно: размещение A **ДО** глобального header (как в runbook §5) проверенно
перетиралось глобальным header'ом — в ответе `/claude/` оставалась только
минимальная CSP без `default-src 'self'`. Поэтому apply-caddy.py ставит A после
header-директив; фрагмент (код CSP) при этом не меняется.

Известное косметическое предупреждение: `Caddyfile input is not formatted` из-за
`\`-продолжений matcher'а `@claude_install` как в runbook §5; на validate/adapt и
на ответы Caddy не влияет.
