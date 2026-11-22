# QA-приёмка claude-web + регрессия DSH

Роль: независимый QA/Deploy (`qa`). Дата: 2026-11-22.
Окружение: VPS `45.144.214.206` (vps-4692), публичный origin
`https://vps-4692.tailfbc4b2.ts.net:10000`, приложение `127.0.0.1:3090` за auth-шлюзом DSH.

Методика: доступ по SSH **только на чтение** (curl, journalctl, ss -lntp, systemctl
is-active/show, sha256sum, stat, чтение логов/конфигов). Изменения Caddy/systemd/каталогов
выполняет Lead; QA проверяет результат и приёмку по `docs/claude-pwa-runbook.md` §6/§8/§10,
`docs/claude-pwa-plan.md` §7.1/§12 и `claude-web/docs/CONTRACT.md` §1/§6.
Секреты (`EDGE_SECRET`, OAuth-токен, cookie) в отчёт не выведены; заголовки `Set-Cookie`
маскируются.

Статусы: PASS / FAIL / N/A (не применимо на этапе) / ОЖИДАНИЕ.

---

## 1. Baseline (до деплоя) — 2026-11-22 10:25 UTC

Снят до установки приложения и правки Caddy: служит доказательством отсутствия регрессии DSH
после деплоя и якорем для отката.

### 1.1. Публичный origin, анонимные запросы

`curl -sS -o /dev/null -w '%{http_code} %{content_type} %{time_total}s' "$PUBLIC<path>"`

| Путь | Код | Content-Type | Время | Тело | Примечание |
|---|---|---|---|---|---|
| `/` | 401 | application/json | 0.678 s | `{"error":"unauthorized"}` (24 B) | DSH под сессией |
| `/manifest.webmanifest` | 200 | application/manifest+json; charset=utf-8 | 0.378 s | 877 B | DSH PWA-манифест |
| `/tg` | 200 | text/html; charset=utf-8 | 0.514 s | 16343 B | страница входа Telegram |
| `/healthz` | 200 | application/json | 0.415 s | `{"status":"ok","version":"0.1.0"}` | |
| `/auth/status` | 200 | application/json | 0.439 s | `{"ok":true,"authenticated":false,"userHash":null,"totpEnrolled":true}` | |
| `/claude/` | **401** | application/json | 0.366 s | `{"error":"unauthorized"}` | ещё НЕ маршрутизирован: 401 от глобального auth-гейта, не 404 |
| `/claude` (без слеша) | **401** | application/json | 0.367 s | `{"error":"unauthorized"}` | 308 пока нет (ожидаемо до деплоя) |
| `/claude/sw.js` | **401** | application/json | 0.372 s | `{"error":"unauthorized"}` | 401 от гейта, не app |

Вывод: приложение ещё не установлено и не слушает 3090; `/claude/*` попадает в глобальный
`handle { forward_auth }` → 401. Это ожидаемое pre-deploy состояние (task-5: «404 или 401»).

### 1.2. Заголовки (аноним)

`/` (401):
```
content-security-policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'
cache-control: no-store, private
content-type: application/json; charset=utf-8
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
referrer-policy: no-referrer
strict-transport-security: max-age=31536000
www-authenticate: DSH-Session realm="dsh-gateway"
x-content-type-options: nosniff
x-frame-options: DENY
x-robots-tag: noindex, nofollow, noarchive
via: 1.1 Caddy
```

`/manifest.webmanifest` (200): те же security-заголовки + `content-type: application/manifest+json`,
`etag`, `vary: Accept-Encoding`, `cache-control: no-cache` (вместе с `no-store, private`).

`/tg` (200): CSP `default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; …`
(+vendor telegram-web-app.js), `content-type: text/html`.

`/claude/` (401): тот же ответ гейта, что и `/`; CSP пока
`frame-ancestors 'none'; base-uri 'none'; object-src 'none'` — **НЕ** `default-src 'self'`.
Это baseline для проверки, что после деплоя на `/claude/*` появится CSP приложения.

`Set-Cookie`: на всех анонимных ответах (`/`, `/manifest.webmanifest`, `/tg`, `/claude/`,
`/claude/sw.js`) **отсутствует**.

### 1.3. DSH WebSocket-проба (без сессии)

```
curl -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Origin: https://vps-4692.tailfbc4b2.ts.net:10000' "$PUBLIC/plugins/events"
→ 401   (не 502 — gateway/auth жив)
```

### 1.4. Инфраструктура

| Проверка | Значение baseline |
|---|---|
| `sha256sum /etc/dsh-gateway-caddy/Caddyfile` | `60ae87f3a0dcae8e374409c5837343237b391d7540333c9261fc2c7bebc37d45` |
| Caddyfile: строк / байт / права | 223 / 11731 / `0640 root:caddy` |
| Caddy | v2.11.9; `ActiveState=active`, `CanReload=no` (только `restart`) |
| `systemctl is-active dsh-web dsh-gateway-auth dsh-gateway-caddy tailscaled` | active, active, active, active |
| `node -v` | v24.22.3 |
| `claude --version` | 2.1.329 (Claude Code) |
| RAM | 1967 MB total, 707 used, 1259 available |
| uptime / load | up 16:40, load 0.34 0.47 0.29 |
| Диск `/` | 29G, 8.9G занято, 20G свободно (32%) |

Слушающие сокеты (`ss -lntp`):

| Порт | Адрес | Процесс |
|---|---|---|
| 22 | 0.0.0.0 / [::] | sshd |
| 443 | * | xray |
| 8443 | * | xray |
| 2053 | * | xray |
| 2083 | * | mtg |
| 10000 | 100.119.213.114%tailscale0 + [fd7a:…]%tailscale0 | tailscaled (Funnel) |
| 8081 | 127.0.0.1 | caddy |
| 9090 | 127.0.0.1 | auth-service (MainThread, pid 607900) |
| 3080 | 127.0.0.1 | DSH web (MainThread, pid 607895) |
| **3090** | — | **НЕ слушается** (приложение не установлено) |

### 1.5. Pre-deploy состояние приложения

| Проверка | Значение |
|---|---|
| `systemctl is-active claude-web` | `inactive` |
| `systemctl is-enabled claude-web` | `not-found` (юнита нет) |
| `/etc/systemd/system/claude-web.service` | отсутствует |
| `/opt/claude-web` | существует, `700 root:root` (каталог подготовлен, артефакт не разложен) |
| `/srv/claude-web/public` | существует, `755 root:root`, **пуст** (install-ассетов нет) |
| `/etc/claude-web/env` | `600 root:root`, 492 B (создан на root-подготовке) |
| `claudeapp` | uid 993, gid 983, группы `983(claudeapp)` — без dsh/sudo/caddy ✅ |
| `/srv/claude-web` / `workspaces` | `751 root:root` / `750 claudeapp:claudeapp` ✅ |
| `/var/lib/claude-web`, `claude-config`, `/var/log/claude-web` | `700 claudeapp:claudeapp` ✅ |
| `/etc/claude-web` | `750 root:root` ✅ |

### 1.6. Якоря для сравнения после деплоя/отката

1. DSH: `/` = 401, `/manifest.webmanifest` = 200 (тот же etag), `/tg` = 200 (16343 B),
   `/healthz` = 200, WS-проба `/plugins/events` = 401.
2. Caddyfile **до** правки: sha256 `60ae87f3…c37d45`, 223 строки. Это цель отката
   (runbook §8) — после restore хеш обязан совпасть.
   Внимание: журнал деплоя фиксировал `fcf7ebb8…` в 08:36 UTC; живой файл уже другой
   (`60ae87f3…`) из-за продолжавшегося обновления auth-гейтвея — apply-caddy обязан
   перечитать живой файл, откат сверять именно с `60ae87f3…`.
3. Порт 3090 до деплоя отсутствует; после деплоя — только `127.0.0.1:3090`.
4. `/claude/` до деплоя = 401 с CSP `frame-ancestors 'none'…` без Set-Cookie.

---

## 2. Приёмка после деплоя (10:42–10:48 UTC, ревизия Caddyfile `35d1e71d…`)

Сигнал Lead: «claude-web задеплоен и публичный маршрут применён» (окно 10:42 UTC,
restart `dsh-gateway-caddy`, бэкап `/root/claude-pwa-backup-20261122-104217`).
Проверял независимо; результат Lead `acceptance.sh --deep` подтверждён.

| Параметр | Baseline (до) | После деплоя |
|---|---|---|
| `/etc/dsh-gateway-caddy/Caddyfile` sha256 | `60ae87f3…c37d45` (223 стр.) | `35d1e71d…b72873c` (310 стр.), `0640 root:caddy` |
| Бэкап отката | — | `/root/claude-pwa-backup-20261122-104217/Caddyfile`, sha256 **=** `60ae87f3…c37d45` ✅ |

### 2.1. `deploy/acceptance.sh --deep` (запуск QA от root)

```
bash /home/dsh/projects/claude-web/deploy/acceptance.sh --deep
SUMMARY: checks=28 failed=0
RESULT=ok
EXIT=0
```

Полный вывод (все PASS):
аноним /claude/ 401; аноним /claude/sw.js 401; manifest.webmanifest 200
application/manifest+json (без Set-Cookie, `no-cache`); icon-192/512/maskable-512/
apple-touch-180 200 image/png (без Set-Cookie, `public, max-age=86400`); CSP /claude/
`default-src 'self'`; /claude/ Cache-Control `no-store`; GET /claude → 308; POST
manifest → 405; спуф X-Auth-User → 401; cross-origin → 403; валидный Origin без
сессии → 401; 3090 без edge → 403; 3090 чужой user → 403; 3090 только loopback;
DSH / → 401; DSH /manifest.webmanifest → 200; claude-web active; journal без sk-ant;
audit без sk-ant; Caddy access log без Set-Cookie/сессии/X-Claude-Edge; env 600
root:root; public 755 root:root; manifest 644 root:root; `--deep` health с валидным
edge → 200; `--deep` чужой X-Auth-User → 403.

### 2.2. Независимые проверки (не из acceptance.sh)

| # | Проверка | Команда/метод | Факт | Итог |
|---|---|---|---|---|
| 1 | Аноним `/claude/` | `curl -w %{http_code}` | 401, `{"error":"unauthorized"}`, 24 B | PASS |
| 2 | Аноним `/claude/sw.js` | то же | 401 | PASS |
| 3 | Аноним `/` (DSH) | то же | 401 | PASS |
| 4 | `/claude` без слеша | `curl -D -` | 308 → `https://…/claude/` | PASS |
| 5 | Методы install-манифеста | `-X GET/HEAD/POST/PUT/DELETE/OPTIONS` | 200/200/405/405/405/405 | PASS |
| 6 | `/claude/manifest.webmanifest` | `curl -D -` | 200 `application/manifest+json`, 986 B, `cache-control: no-cache`, etag, `vary: Accept-Encoding` | PASS |
| 7 | 4 иконки install | `curl -D -` | 200 `image/png`, `public, max-age=86400` | PASS |
| 8 | `Set-Cookie` на анонимных `/claude/*` | grep по заголовкам | отсутствует на всех (401 и 200) | PASS |
| 9 | CSP `/claude/` даже на 401 | `curl -D -` | `content-security-policy: default-src 'self'; …frame-ancestors 'none'; object-src 'none'` | PASS |
| 10 | Cross-origin GET `/claude/` | `-H 'Origin: https://evil.example'` | 403 (Caddy Origin-guard до `/verify`) | PASS |
| 11 | Cross-origin POST `/claude/api/health` | то же | 403 | PASS |
| 12 | Cross-origin WS `/claude/` (Upgrade) | то же | 403 | PASS |
| 13 | Спуф `X-Auth-User: deadbeef` (публично) | `-H` | 401 (гейт) | PASS |
| 14 | 3090 без `X-Claude-Edge` | `curl http://127.0.0.1:3090/claude/` | 403 | PASS |
| 15 | 3090 чужой edge+user | `-H 'X-Claude-Edge: wrong' -H 'X-Auth-User: deadbeef'` | 403 | PASS |
| 16 | 3090 верный edge + чужой user | edge из env через `--config -` (не в argv) | 403 | PASS |
| 17 | 3090 верный edge + верный user → `/api/health` | то же | 200 `{"ok":true,"version":"0.1.0","active":0,"max":2,"mode":"sdk"}` | PASS |
| 18 | 3090 слушает только loopback | `ss -ltnp \| grep :3090` | `127.0.0.1:3090`, pid 623790 (node) | PASS |
| 19 | App `/claude/` с edge (loopback) | `curl --config -` | 200, 1502 B HTML, CSP в **header и meta**, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`, `Permissions-Policy`, `X-Robots-Tag`, `Cache-Control no-store` | PASS |
| 20 | App `/claude/sw.js` | то же | 200, `text/javascript`, `Cache-Control: no-store`, заголовка `Service-Worker-Allowed` **нет** (слово только в комментарии тела) | PASS |
| 21 | App `/api/workspaces` | то же | `[{"id":"demo","name":"demo","path":"/srv/claude-web/workspaces/demo"}]` | PASS |
| 22 | App Host-mismatch | `Host: evil.example` + edge | 403 | PASS |
| 23 | App POST без Origin | POST `{}` + edge, без Origin | 403 | PASS |
| 24 | App GET с чужим Origin | `Origin: https://evil.example` | 403 | PASS |
| 25 | Traversal в app (loopback, `--path-as-is`) | `/claude/../../etc/passwd`, `%2e%2e`, `..%2f..%2f` | 404 всё, содержимого `/etc/passwd` нет | PASS |
| 26 | Публично ровно 5 ассетов | `/claude/icons/favicon-96.png`, `/claude/index.html`, `/claude/assets/index.js`, `/claude/icons/` | все 401 (favicon-96 в манифесте не указан — не нужен) | PASS |
| 27 | Нормализация `..%2f` в Caddy | `/claude/..%2fmanifest.webmanifest` | 200, но это **DSH-манифест** (`"name":"DeepSeek Harness"`) после очистки пути, не claude-ассет | PASS (Info) |
| 28 | Install-ассеты без `Cache-Control: no-store, private` | заголовки | manifest `no-cache`, icons `public, max-age=86400` — как задумано | PASS |
| 29 | DSH `/` | `curl` | 401, 24 B | PASS |
| 30 | DSH `/manifest.webmanifest` | `curl -D -` | 200, 877 B, etag `W/"LpaxHAAvxInro4IR4yUhpH7o8nM"` — **совпал с baseline** | PASS |
| 31 | DSH `/tg` | `curl` | 200, text/html, 16343 B (в странице Telegram/TOTP/login) | PASS |
| 32 | DSH `/healthz` | `curl` | 200 `{"status":"ok","version":"0.1.0"}` | PASS |
| 33 | DSH WS-проба `/plugins/events` | Upgrade+Origin, без сессии | 401 (не 502) | PASS |
| 34 | WS-проба `/claude/api/sessions` | то же | 401 | PASS |
| 35 | Права env / audit / public / manifest / caddy-log | `stat -c` | 600 root:root; 600 claudeapp:claudeapp; 755 root:root; 644 root:root; 600 caddy:caddy | PASS |
| 36 | `claudeapp` без лишних групп | `id claudeapp` | uid 993, groups = `983(claudeapp)` — без dsh/caddy/sudo | PASS |
| 37 | Изоляция `claudeapp` | `runuser -u claudeapp` | не читает `/etc/claude-web/env`, Caddyfile, caddy-access.log; `/home/dsh` — Permission denied | PASS |
| 38 | hardening юнита | `systemctl show` | `ProtectHome=yes`, `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `CapabilityBoundingSet=` (пусто), `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `UMask=0077`; RSS 65.8 MB | PASS |
| 39 | Секреты в journal claude-web | `journalctl -u claude-web` (500 строк) | нет `sk-ant`, нет `__Host-dsh_session`/edge | PASS |
| 40 | audit.jsonl | чтение | 600 claudeapp, 24 записи, только `auth_fail`, ключей `prompt/text/content/token/secret` нет | PASS |
| 41 | Caddy access log | `grep -c` | 0 совпадений Set-Cookie / `__Host-dsh_session` / `X-Claude-Edge`; URI без query | PASS |
| 42 | Бэкап отката | `sha256sum` | sha = pre-apply `60ae87f3…`, 223 строки, есть `ports.txt`/`systemctl-cat.txt`/`Caddyfile.sha256` | PASS |

### 2.3. Наблюдения (не блокеры)

- **SEC-11 (Low, открыт на ревизии `35d1e71d…`; закрыт финальным apply — §3.2).** На
  промежуточной ревизии deferred-заголовки кэша протекали на ответы без тела успеха:
  `/claude/assets/app.js` **401** получал `cache-control: public, max-age=86400, immutable`;
  `POST /claude/manifest.webmanifest` **405** получал `cache-control: no-cache`.
  Секретов не раскрывало; риск — кэширование 401. В финальной ревизии `add2e495…`
  анонимные 401 получают только `no-store, private` (проверено, §3.2).
- **Info: AppleDouble-мусор `._*`** в артефакте (`/opt/claude-web/._package-lock.json`,
  `/srv/claude-web/public/claude/._icons`, `._manifest.webmanifest`, `._icon-*.png`).
  Публично не отдаётся (Caddy — ровно 5 точных путей), на приёмку не влияет;
  косметическая чистка при следующей сборке (tar с macOS).
- **Info: log-фильтр Caddy** удаляет `Cookie`, `Authorization`, `Referer`,
  `resp_headers>Set-Cookie`, но не удаляет клиентские `X-Claude-Edge`/`X-Auth-User`.
  Сейчас 0 совпадений; клиентское значение секретом не является (реальный edge
  ставит Caddy на upstream). При желании — добавить `request>headers>X-Claude-Edge delete`.
- App CSP включает дополнительные `font-src 'self'` и `form-action 'self'`; в ответе
  присутствуют и app-CSP, и Caddy-CSP (пересечение — безопасно, `frame-ancestors 'none'`).

### 2.4. Итог Этапа 2

**Приёмка пройдена**: 42/42 независимых чека PASS, `acceptance.sh --deep` 28/28 PASS,
DSH-регрессии нет (все baseline-якоря совпали, включая etag DSH-манифеста).
Открытый на этой ревизии SEC-11 (Low) закрыт финальным apply — см. §3.2.

## 3. Репетиция отката и финальный apply (окно 10:54 UTC)

Регламент окна: Lead выполняет restore/restart (`deploy/rollback.sh --tag 20261122-104217`)
и повторный apply исправленного фрагмента; QA одновременно опрашивает origin каждые 10 с и
снимает оба состояния независимо. Рестарты Caddy: PID 619656 → 639598 (откат) → 640249
(финальный apply). Фактически простой не поймал: опросы 401→401 без 5xx/000 (между
10:54:40 и 10:54:51), т.е. окно рестарта < 1 с по наблюдению.

### 3.1. Состояние ПОСЛЕ ОТКАТА (restore из `/root/claude-pwa-backup-20261122-104217`)

Снято 10:54:24–10:54:27 UTC, сразу после рестарта отката.

| Проверка | Факт | Ожидание отката | Итог |
|---|---|---|---|
| live Caddyfile sha256 | `60ae87f3a0dcae8e374409c5837343237b391d7540333c9261fc2c7bebc37d45` | = pre-apply/baseline | PASS |
| строк / права | 223, `0640 root:caddy` | как baseline | PASS |
| бэкап 104217 | sha = `60ae87f3…` (совпадает) | совпадает | PASS |
| `/claude/` | 401, `{"error":"unauthorized"}` | 401 от старого catch-all | PASS |
| CSP `/claude/` | **только** `frame-ancestors 'none'; base-uri 'none'; object-src 'none'` | `default-src 'self'` отсутствует | PASS |
| `/claude` без слеша | 401 (redirect нет) | 401, не 308 | PASS |
| `/claude/manifest.webmanifest` | 401 | 401 | PASS |
| `/claude/sw.js`, `/claude/assets/index-CNf-L_Pk.js` | 401 / 401 | 401 | PASS |
| DSH `/` | 401, 24 B | 401 | PASS |
| DSH `/manifest.webmanifest` | 200, 877 B, etag `W/"LpaxHAAvxInro4IR4yUhpH7o8nM"` | 200, etag как baseline | PASS |
| DSH `/tg` | 200, text/html, 16343 B | без регрессии | PASS |
| DSH `/healthz` | 200 | без регрессии | PASS |
| DSH WS `/plugins/events` | 401 (не 502) | 401 | PASS |
| Claude WS `/claude/api/sessions` | 401 | 401 | PASS |
| Сервисы | dsh-web, dsh-gateway-auth, dsh-gateway-caddy, tailscaled, claude-web — active | DSH не затронут | PASS |
| Порты | 3090/8081/9090 loopback, 10000 tailscale — как до окна | без изменений | PASS |

Вывод: **механика отката рабочая**; restore даёт ровно baseline-состояние (`60ae87f3…`,
223 строки, маршрута `/claude/` нет), DSH полностью сохранён (все якоря совпали,
включая etag манифеста), приложение `claude-web` при откате не останавливалось
(данные/audit/бэкапы целы, `--stop-app` не применялся).

### 3.2. Состояние ПОСЛЕ ФИНАЛЬНОГО APPLY (10:54:48–10:54:51)

| Проверка | Факт | Итог |
|---|---|---|
| live Caddyfile sha256 | `add2e495423112201aa5bd4f29b656b12de34d80c0f6f5784a24b65a34dbd015`, 330 строк, `0640 root:caddy` | PASS |
| `caddy validate` живого конфига | `Valid configuration` (read-only) | PASS |
| новый бэкап | `/root/claude-pwa-backup-20261122-105447`, sha = **pre-apply** `60ae87f3…`, 223 строки; TAG pointer = `20261122-105447` | PASS |
| FROZEN-хэши deploy-артефактов | `apply-caddy.py` `df92b4f9…`, `Caddyfile.fragment` `6a74e80b…`, `acceptance.sh` `efc962df…` — совпали с заявленными | PASS |
| `acceptance.sh --deep` | **`SUMMARY: checks=32 failed=0`, `RESULT=ok`, EXIT=0** | PASS |
| `/claude/` | 401 + CSP `default-src 'self'; …frame-ancestors 'none'…` (вернулся) | PASS |
| `/claude` | 308 → `/claude/` | PASS |
| 5 install-ассетов | 200: manifest `application/manifest+json` + `no-cache`; 4 иконки `image/png` + `public, max-age=86400` | PASS |
| **SEC-11: анонимный `/claude/assets/index-CNf-L_Pk.js`** | **401, `cache-control: no-store, private` (×2), `content-type: application/json`; БЕЗ `public`/`immutable`** | PASS (закрыт) |
| **SEC-11: анонимный `/claude/icons/favicon-96.png`** | **401, `no-store, private`, `content-type: application/json`; БЕЗ `image/png`/`public`** | PASS (закрыт) |
| **SEC-11: `/claude/sw.js` аноним** | 401, `no-store` | PASS (закрыт) |
| 200-путь (edge+user, loopback): asset | 200 `text/javascript`, `cache-control: public, max-age=86400, immutable` | PASS |
| 200-путь: manifest | 200 `application/manifest+json`, `cache-control: no-cache` | PASS |
| 200-путь: icon-192 | `image/png`, `public, max-age=86400` | PASS |
| 200-путь: `/claude/` | 200 HTML, CSP в header+meta, `no-store`, `nosniff/DENY/no-referrer/Permissions-Policy/noindex`; Set-Cookie нет | PASS |
| `/claude/api/health` (edge+user) | 200 `{"ok":true,"version":"0.1.0","active":0,"max":2,"mode":"sdk"}` | PASS |
| App traversal (loopback, raw) | 404, без утечки `/etc/passwd` | PASS |
| DSH `/` | 401, 24 B | PASS |
| DSH `/manifest.webmanifest` | 200, 877 B, etag = baseline | PASS |
| DSH `/tg` | 200, 16343 B | PASS |
| DSH `/healthz` | 200 | PASS |
| DSH WS `/plugins/events` | 401 (не 502) | PASS |
| `/claude/` spoof X-Auth-User | 401 | PASS |
| Cross-origin GET `/claude/` | 403 | PASS |
| POST manifest | 405 | PASS |
| `127.0.0.1:3090` без edge | 403 | PASS |
| 3090 слушает только loopback | `127.0.0.1:3090` | PASS |
| Сервисы | 5/5 active | PASS |
| Порты | новых публичных нет: 22,443(xray),8443,2053,2083(mtg),10000(Funnel); loopback 8081(caddy),9090(auth),3080(DSH),3090(app) | PASS |
| journal claude-web | `sk-ant`: 0 | PASS |
| audit.jsonl | 34 записи: 32 `auth_fail`, 1 `http_api`, 1 `http_error`; промптов/токенов/сессий нет | PASS |
| caddy-access.log | 0 совпадений Set-Cookie/`__Host-dsh_session`/`X-Claude-Edge` | PASS |
| AppleDouble `._*` | в `/opt/claude-web` и `/srv/claude-web/public` — 0 (Lead удалил) | PASS |

Вывод: **финальная конфигурация корректна, SEC-11 закрыт**; 200-путь кэшируется как
задумано, а анонимные 401 больше не получают публичный/иммутабельный Cache-Control.

### 3.3. Сравнение с baseline

| Якорь baseline | Baseline | Откат | Финал |
|---|---|---|---|
| Caddyfile sha256 | `60ae87f3…` | `60ae87f3…` | `add2e495…` |
| DSH `/` | 401 / 24 B | 401 / 24 B | 401 / 24 B |
| DSH `/manifest` etag | `W/"LpaxHAAvxInro4IR4yUhpH7o8nM"` | тот же | тот же |
| DSH `/tg` | 200 / 16343 B | 200 / 16343 B | 200 / 16343 B |
| DSH `/healthz` | 200 | 200 | 200 |
| DSH WS `/plugins/events` | 401 | 401 | 401 |
| `/claude/` | 401 (гейт) | 401 (гейт) | 401 (гейт) + маршрут/CSP |
| 3090 | не слушался | loopback | loopback |

Регрессии DSH нет ни на одном этапе (включая окно с рестартом Caddy).

## 4. Итог

**Приёмка claude-web — ПРОЙДЕНА. Откат — проверен и рабочий. Регрессии DSH — нет.**
SEC-11 (Low) закрыт финальным apply. Данные, audit и бэкапы при откате сохранены.

Итоговые цифры: `acceptance.sh --deep` — **32/32 PASS** (финал), 28/28 (промежуточная
ревизия); независимые QA-проверки — 42/42 (Этап 2) + 25/25 (финал/SEC-11/откат);
3 состояния (deploy-ревизия, откат, финал) зафиксированы в §2 и §3.

### 4.1. Что остаётся владельцу (вне автоматизированной приёмки)

1. **Сессионный вход в браузере**: войти через `/auth/tg`, открыть `/claude/` → 200;
   короткий турн: streaming, tool-карточка, allow → результат, deny → отказ,
   timeout → deny; interrupt; resume после закрытия; 2 сессии/очередь/3-я не стартует;
   истечение сессии → экран «Сессия завершилась» и возврат; offline/5xx → retry.
   Проверить, что API/SSE не кэшируются и `navigator.serviceWorker.controller.scriptURL`
   = `/claude/sw.js` (не root-SW DSH).
2. **Установка PWA**: Android Chrome (risk: вложенный scope `/claude/` при установленном
   DSH — разрешается ручной установкой, план §13.7) и desktop Chrome; standalone,
   имя/иконка Claude; после обновления DSH-SW контроллер Claude не перехватывается.
3. **Эксплуатация**: ротация OAuth-токена раз в год/при инциденте (`/etc/claude-web/env`
   + `systemctl restart claude-web`) и edge-секрета при подозрении (env + Caddyfile,
   рестарт обоих сервисов); Caddy нельзя reload — только restart в окне (проверено: <1 c);
   kill switch — `systemctl stop claude-web` (DSH не затронут); мониторинг RSS/audit/OOM.

### 4.2. Остаточные риски (приняты письменно, см. plan §7.3)

- Токен в env процесса Claude; safe-режим без Bash; deny `/proc/**` и `/etc/claude-web/**`;
  Trust — root/UID. Power-режим в MVP выключен.
- Prompt injection → подтверждение человеком; UI обязан показывать полный вход.
- Вложенный PWA-scope на Android — ручная установка/ограничение (gate G1).
- Лимиты Pro-подписки общие с Claude Code; авто-ретраев нет.
- Caddy access log: клиентские `X-Auth-User`/`X-Claude-Edge` в лог не фильтруются
  (0 совпадений фактически; реальный edge видит только upstream — рекомендация на будущее:
  `request>headers>X-Claude-Edge delete`). Cookie/Authorization/Referer/Set-Cookie — вырезаны.
- `/verify` — общий bucket 600/мин у auth-гейтвея; при тяжёлой загрузке возможен 429
  и на DSH-вход (проверено на стенде только косвенно).
- Single-owner: `ALLOWED_USER_HASH` — ровно один пользователь; расширение allowlist
  шлюза не открывает Claude второму пользователю.

### 4.3. Подпись

QA (`qa`): приёмка и откат-репетиция выполнены по runbook §6/§8/§10 и plan §7.1/§12.
Блокеров нет. Автоматизированная часть — PASS; сессионная и PWA-установочная часть —
за владельцем (п.4.1).
