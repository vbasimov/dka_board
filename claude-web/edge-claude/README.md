# claude-edge — второй публичный origin Claude (PWA на отдельном порту)

Самостоятельный Caddy-инстанс для **второго публичного origin** Claude-Web:

```
браузер/Tailscale ── https://vps-4692.tailfbc4b2.ts.net:8443
                        │  (TLS и публичный порт — Tailscale Funnel)
                        ▼
                 tailscaled:127.0.0.1:8443 (Funnel)
                        │  plain HTTP
                        ▼
                 Caddy claude-edge  127.0.0.1:8444   (этот каталог)
                        ├─ /claude/manifest.webmanifest, /claude/icons/*  → file_server /srv/claude-web/public
                        ├─ /claude/*  → forward_auth 127.0.0.1:9090/verify → 127.0.0.1:3090
                        ├─ /tg, /auth/*, /healthz → 127.0.0.1:9090 (вход/истечение сессии)
                        └─ всё остальное → 302 https://vps-4692.tailfbc4b2.ts.net:10000/
```

## Зачем

DSH-PWA имеет `scope: "/"` и перехватывает ссылки на
`https://vps-4692.tailfbc4b2.ts.net:10000/claude/`: Chrome открывает Claude внутри
установленного DSH, а не ставит отдельным PWA. Второй порт Funnel даёт **другой origin**
(`…:8443` против `…:10000`), поэтому у Claude появляется собственный PWA-origin.
Хост тот же, порт другой, а cookie гейтвея `__Host-dsh_session` host-bound (без порта) —
она **общая** для обоих портов, поэтому вход остаётся один.

Инстанс **независим** от Caddy auth-гейтвея (`dsh-gateway-caddy`, `127.0.0.1:8081`):
у него свой конфиг, свой systemd-юнит и свой admin off. Деплой/рестарт гейтвея не
трогает второй origin и наоборот.

## Состав

| Файл | Назначение |
|---|---|
| `Caddyfile` | конфиг инстанса; плейсхолдер `__EDGE_SECRET__` подставляет `install.sh` |
| `systemd/claude-edge.service` | юнит (User=caddy, hardening, Restart=on-failure) |
| `install.sh` | root-установка: секрет из `/etc/claude-web/env`, validate/adapt, атомарная установка, post-checks |
| `rollback.sh` | stop/disable + удаление юнита; конфиг и логи сохраняются |
| `../test/edge-claude/*.test.mjs` | статические проверки артефактов (`npm test`) |

## Требования на сервере

- Caddy 2.11.x в `/usr/bin/caddy`, systemd, пользователь/группа `caddy` (пакет caddy).
- `/etc/claude-web/env` — `0600 root:root`, с `EDGE_SECRET` ровно 64 hex (тот же секрет,
  что у приложения `claude-web.service`).
- Приложение на `127.0.0.1:3090` (`claude-web.service`) и auth-гейтвей на
  `127.0.0.1:9090` (`dsh-gateway-auth.service`) уже работают.
- Публичные install-ассеты в `/srv/claude-web/public/claude/` (ставит `deploy/install.sh`).
- Tailscale Funnel (см. ниже); порт `8443` свободен. **Funnel разрешает только 443,
  8443, 10000.** `8443` освобождён переносом xray-inbound (на 2096) — это делает Lead,
  а не этот каталог.

## Установка (root)

```bash
# скопировать каталог на сервер (например, /root/edge-claude) и:
cd /root/edge-claude
sudo ./install.sh
```

`install.sh` (идемпотентно) проверяет root/caddy/env (без валидного `EDGE_SECRET` —
fail-closed, ничего не меняет), создаёт каталоги, подставляет секрет во **временный**
Caddyfile, гоняет `caddy validate` + `caddy adapt` и только после успеха атомарно
ставит `/etc/claude-edge/Caddyfile` (`0640 root:caddy`). Затем unit, `daemon-reload`,
`enable --now` и проверки: слушает только loopback, `/claude/` аноним → `401` + CSP,
manifest/icons → `200` с правильными `Content-Type`/`Cache-Control`, `POST` манифеста
→ `405`, чужой `Origin` → `403`, `/` → `302`, `/claude` → `308`, в access-логе нет
cookie/query/секрета. В конце печатает `RESULT=ok` и напоминание про Funnel.

Секрет не печатается и в git не попадает.

## Включить публично (Tailscale Funnel)

Funnel уже настроен Lead'ом; команды для повторного включения/выключения:

```bash
# включить (фоново; проксирует публичный :8443 на локальный 127.0.0.1:8444)
tailscale funnel --bg --yes --https=8443 http://127.0.0.1:8444

# статус (должно быть: https://vps-4692.tailfbc4b2.ts.net:8443 → 127.0.0.1:8444)
tailscale funnel status

# выключить публичный :8443
tailscale funnel --https=8443 off
```

Проверить точный синтаксис на сервере: `tailscale funnel --help`.
Флаг `--bg` обязателен для неинтерактивного запуска; `--yes` — согласие с условиями
Funnel. Funnel **терминирует TLS на tailscaled**: до Caddy доходит уже plain HTTP, поэтому
в Caddy нет HTTPS-сайта и `auto_https` не используется.

## Проверка

С сервера (loopback, без Funnel):

```bash
curl -sI http://127.0.0.1:8444/claude/                 # 401 + Content-Security-Policy: default-src 'self'…
curl -sI http://127.0.0.1:8444/claude/manifest.webmanifest  # 200 application/manifest+json; Cache-Control: no-cache
curl -sI http://127.0.0.1:8444/claude/icons/icon-192.png    # 200 image/png; Cache-Control: public, max-age=86400
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8444/claude/manifest.webmanifest  # 405
curl -sI http://127.0.0.1:8444/claude                   # 308 → /claude/
curl -sI http://127.0.0.1:8444/                         # 302 → https://vps-4692.tailfbc4b2.ts.net:10000/
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: vps-4692.tailfbc4b2.ts.net:8443' -H 'Origin: https://evil.example' \
  http://127.0.0.1:8444/claude/                         # 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: vps-4692.tailfbc4b2.ts.net:8443' \
  -H 'Origin: https://vps-4692.tailfbc4b2.ts.net:8443' http://127.0.0.1:8444/claude/  # 401 (прошёл guard → forward_auth)
```

Снаружи (Funnel):

```bash
curl -sI https://vps-4692.tailfbc4b2.ts.net:8443/claude/                       # 401 + CSP
curl -sI https://vps-4692.tailfbc4b2.ts.net:8443/claude/manifest.webmanifest  # 200
curl -sI https://vps-4692.tailfbc4b2.ts.net:8443/claude                       # 308 → /claude/
```

В браузере: `https://vps-4692.tailfbc4b2.ts.net:8443/tg` → вход → `/claude/` →
Chrome предложит установить **отдельное** приложение Claude (свой `id`/`scope`/`start_url`).

Лог: `/var/log/claude-edge/access.log` — JSON, ротация 10 MiB × 5 файлов.
Из записей вычищены `Cookie`, `Authorization`, `X-Claude-Edge`, `Set-Cookie` и query
(там бывают Telegram initData/`next`-параметры). Секрет в лог/journal не попадает.

Эксплуатация:

```bash
systemctl status claude-edge
journalctl -u claude-edge -n 50 --no-pager
/usr/bin/caddy validate --config /etc/claude-edge/Caddyfile --adapter caddyfile
systemctl restart claude-edge          # admin off: config reload только рестартом
```

## Откат

```bash
cd /root/edge-claude
sudo ./rollback.sh          # stop/disable юнита + удаление unit-файла
tailscale funnel --https=8443 off   # закрыть публичный :8443
```

`rollback.sh` **не** удаляет `/etc/claude-edge` и `/var/log/claude-edge` (конфиг и логи
остаются для разбора/повторной установки) и не трогает Caddy auth-гейтвея,
`claude-web` и DSH: основной origin `…:10000` продолжает работать как раньше.
Повторная установка — снова `sudo ./install.sh`.

## Ограничения и риски

- **Приложение и гейтвей должны принять новый origin.** Claude-Web проверяет `Host`
  (публичный authority) и `Origin` для unsafe-методов; auth-гейтвей — свои allowlist'ы.
  Если после включения вход с `:8443` даёт `403`/`400`, нужна правка allowlist'ов в
  приложении/гейтвее (`:8443` рядом с `:10000`). Делает Lead отдельной задачей — edge
  только приводит Origin в известный вид и отдаёт `X-Forwarded-Proto: https`.
- **Один вход на два origin.** Cookie `__Host-dsh_session` host-bound (без порта) и
  `Secure`; вход/выход действуют сразу на `:8443` и `:10000`. Это осознанное решение
  («вход один»), но означает, что revoke сессии на одном origin завершает её и на другом.
- **Cookie гейтвея не уходит в приложение.** В `/claude/*` Caddy делает
  `header_up -Cookie`; сессию приложение узнаёт только по `X-Auth-User` от `forward_auth`.
- **Прямой запрос к `127.0.0.1:3090` без `X-Claude-Edge` → 403** (проверяет приложение;
  Caddy лишь ставит `X-Claude-Edge` с секретом и не даёт клиенту его подделать).
- **`/tg` и `/auth/*` идут прямо в приложение гейтвея (`127.0.0.1:9090`), минуя Caddy
  гейтвея.** Клиентские `X-Forwarded-*` edge вырезает; без `trusted_proxies` Caddy
  всё равно подставляет в `X-Forwarded-For` только `127.0.0.1` (соединение от
  tailscaled/Funnel). Для входа это не важно, но IP-based rate-limit/lockout и
  audit-IP гейтвея с `:8443` будут видеть loopback. Если это критично — либо
  `trusted_proxies` + `X-Gateway-Client-IP` на edge (отдельная задача, согласовать
  с моделью угроз), либо проксировать `/tg`,`/auth/*` через Caddy гейтвея (`:8081`).
- **Service worker Claude живёт в scope `/claude/`** (свой origin `:8443`). Тот же SW,
  зарегистрированный на `:10000`, остаётся отдельным origin — обновление приложения на
  одном origin не ломает другой.
- Funnel поддерживает только `443/8443/10000`; `:8443` — единственный свободный из них.
  Если `:8443` понадобится под другое, second origin придётся переводить на доменное имя
  (Funnel с `--https=443`), а не на порт.
- Лог содержит только метаданные запросов (без тел/ответов); секреты и сессии из него
  вырезаны, но `remote_ip` остаётся (диагностика). Ротация ограничена 10 MiB × 5.
