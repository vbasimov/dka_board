# claude-web

Свой веб-UI (PWA) к Claude Code на VPS: тот же вход, что у DSH, путь `/claude/`,
приложение слушает только `127.0.0.1:3090` за Caddy + forward_auth.

Документы-источники (внешние, в `../docs/`):

- `claude-pwa-plan.md` — архитектура, инварианты безопасности, фазы, приёмка;
- `claude-pwa-runbook.md` — root-развёртывание и откат;
- `docs/CONTRACT.md` (этот репозиторий) — интерфейсы модулей, API, события, env.

## Раскладка

```
server/     Node 24 HTTP/SSE приложение, Agent SDK 0.3.330, audit, permissions
web/        SPA: Vite + Preact + TS (base /claude/)
pwa/        manifest, service worker, zero-dep генератор иконок
deploy/     systemd unit, Caddy-фрагмент, install/acceptance/rollback
test/       node:test (server, pwa, deploy)
```

## Локально

```sh
npm run build            # web/dist + отдельная статика PWA
AUTH_MODE=dev CLAUDE_RUNTIME=fake PORT=3091 node server/index.mjs
# открыть http://127.0.0.1:3091/claude/
```

`AUTH_MODE=dev` разрешён только на `127.0.0.1:3091`; в prod приложение fail-closed без
`EDGE_SECRET` (64 hex), `ALLOWED_USER_HASH` (12 hex) и `CLAUDE_CODE_OAUTH_TOKEN`.

## Тесты

```sh
node --test test/server test/pwa test/deploy
```

## Развёртывание

Root-шаги — по `claude-pwa-runbook.md`; артефакты в `deploy/`. Приложение не меняет
auth-шлюз, DSH, `dsh-web-pwa`, Funnel и firewall.
