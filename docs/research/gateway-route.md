# Второе приложение (Claude Web UI) за тем же входом, что и DSH

Дата: 2026-11-21. Режим: только чтение, uid `dsh`, без sudo, без входа в шлюз,
без создания сессий. Публичный адрес:
`https://vps-4692.tailfbc4b2.ts.net:10000/` → tailscaled Funnel `:10000` →
Caddy `127.0.0.1:8081` → auth-gateway `127.0.0.1:9090` → DSH `127.0.0.1:3080`.

Вопрос: как открыть второе приложение (Claude Web UI, предполагаемый upstream
`127.0.0.1:3090`) через **ту же** сессию `__Host-dsh_session`, не сломав DSH.

> **Важная оговорка про исходник Caddyfile.** `/etc/dsh-gateway-caddy/Caddyfile`
> не читается (`root:caddy 0640`, каталог `0750 root:caddy`), sudo у `dsh` нет.
> Ниже конфиг Caddy восстановлен по `DESIGN.md` §5, `README.md`, наблюдаемому
> поведению и ранее снятому read-only снимку этого файла (аудит 2026-11-21
> 06:34). Перед правкой root обязан сделать `diff` живого файла с ожидаемым
> скелетом: за время после снимка код шлюза менялся (15:47/16:46), Caddyfile
> тоже мог измениться. Все точные фрагменты ниже проверены на Caddy 2.11.9 в
> локальном стенде (mock upstream, порты 18081–18085/19090–19091), но **не**
> применялись к системе.

---

## 1. Карта маршрутов сейчас

| Путь | Caddy | Проверка сессии | Куда |
|---|---|---|---|
| `/tg`, `/auth/*` | `handle` → `reverse_proxy 9090` | нет (точки входа) | auth-gateway |
| `/healthz` | `handle` → `reverse_proxy 9090` | нет | auth-gateway (минимальный JSON) |
| `/connect`, `/connect/*` | `respond 404` | нет | — |
| `/verify` | `respond 404` | нет | — (наружу закрыт) |
| `/internal/*` | `respond 404` | нет | — |
| всё остальное, включая `/`, `/api/*`, `/assets/*`, `/sw.js`, WS | `handle` → `forward_auth 9090 /verify` → `reverse_proxy 9090` | да, дважды (Caddy + прокси) | auth-gateway → DSH 3080 |
| WS на любой не-auth путь | Caddy `forward_auth` на handshake → gateway `handleUpgrade` | да + Origin + лимит WS | auth-gateway-owned TCP → DSH |

Caddy слушает только `127.0.0.1:8081` (site `http://:8081` + `bind 127.0.0.1`),
`admin off`, поэтому reload = restart (см. §7). Порядок внутри одного
`route { ... }` сохраняется; `handle` взаимоисключающие: срабатывает первый
подходящий, иначе управление доходит до финального `handle { ... }` (catch-all).

### 1.1. Что предлагается добавить (вариант B)

| Путь | Caddy | Сессия | Куда |
|---|---|---|---|
| `/claude` | `redir * /claude/ 308` | нет | — |
| `/claude/manifest.webmanifest`, `/claude/icon-*.png` (точный список — из манифеста) | `handle @claude_install` → `reverse_proxy 3090` | **нет** (публично) | Claude |
| `/claude/*` (HTML, JS, API, SSE) | Origin-guard → `forward_auth 9090 /verify` → `reverse_proxy 3090` | да | Claude |
| WS `/claude/*` | тот же `handle`; Caddy сам туннелирует Upgrade | да (на handshake) | Claude |

DSH-маршруты не меняются: новый блок вставляется **до** финального
`handle { ... }`, но после `/internal/*`.

---

## 2. Семантика `GET /verify`

Код: `lib/authflow.mjs:688-714`, маршрут — `lib/gateway.mjs:170-172`,
WS-вариант — `lib/gateway.mjs:336-366`.

### 2.1. Контракт запроса

`/verify` — **внутренний** endpoint. Caddy не проксирует его наружу
(`handle /verify { respond 404 }`). Прямой запрос к `127.0.0.1:9090/verify`
без заголовков `X-Forwarded-Method` и `X-Forwarded-Uri` даёт `404 not_found`
(проверено live). Это не «секретный» барьер, а защита от случайного/публичного
использования: оба заголовка может поставить любой локальный клиент, но
снаружи путь закрыт Caddy.

| Требование | Поведение |
|---|---|
| `X-Forwarded-Method` + `X-Forwarded-Uri` | обязательны, иначе `404` |
| `Host` | публичный authority или loopback (`127.0.0.1`/`localhost`/`[::1]` с любым портом), иначе `421` (`checkHost`, `http.mjs:198-207`) |
| Cookie | `__Host-dsh_session` (имя из конфига, lower-case при разборе) |
| Метод | фактически не проверяется; Caddy `forward_auth` всегда шлёт **GET** на `/verify`, а исходный метод кладёт в `X-Forwarded-Method` |
| Origin / `Sec-Fetch-Site` | **не проверяются** |
| `X-Gateway-Client-IP` | доверяется только если TCP-peer — loopback и значение — валидный IP (`util.mjs:119-129`); иначе `socket.remoteAddress` |

### 2.2. Ответы

| Ситуация | Статус | Тело | Заголовки |
|---|---|---|---|
| Валидная сессия | `200` | `{"ok":true}` | `X-Auth-User: <12 hex>`, `X-Auth-Session: <12 hex>`, security headers, `Cache-Control: no-store`; **без** `Set-Cookie` |
| Нет/истекла сессия | `401` | `{"error":"unauthorized"}` | `WWW-Authenticate: DSH-Session realm="dsh-gateway"`, security headers, no-store; без `X-Auth-*` |
| Слишком много неудач с IP | `429` | `{"error":"rate_limited"}` | `Retry-After`; audit `ratelimit` |
| Общий bucket исчерпан | `429` | `{"error":"rate_limited"}` | `Retry-After`; audit `global_ratelimit` |
| Нет forward-заголовков | `404` | `{"error":"not_found"}` | — |
| Чужой Host | `421` | `{"error":"host_denied"}` | — |

`X-Auth-User` — это `sha256("tg:<id>").slice(0,12)` (`util.mjs:157-159`), не
сырой Telegram id. `X-Auth-Session` — первые 12 hex от `sha256(sid)`, не сам
sid. В WS-ветке `/verify` (`gateway.mjs:352-365`) отдаётся только
`X-Auth-User`; `X-Auth-Session` там нет. Оба значения псевдонимные и стабильные; секретами не являются, но и
идентификатором для авторизации второго приложения служить не должны.

### 2.3. Побочные эффекты

`handleVerify` вызывает `sessionFromRequest()` → `store.getSession(sid,{touch:true})`
(`authflow.mjs:110-114`, `sessions.mjs:289-314`):

- **touch**: если с `lastSeenAt` прошло ≥30 с, обновляется `lastSeenAt` и
  планируется запись `sessions.json`. Это **продлевает idle-таймаут** (1 ч для
  MiniApp, 2 ч для web; absolute 12 ч не продлевается). Второе приложение,
  которое опрашивает API, будет держать и DSH-сессию живой до absolute-предела.
- **ротации sid нет**, `Set-Cookie` нет, DSH-cookie/broker не трогаются.
- **audit на успех не пишется**. Пишутся только `verify_fail` (throttle 60 с
  на IP), `ratelimit` и `global_ratelimit`.
- **общий token-bucket** `GATEWAY_GLOBAL_RATE_PER_MIN` (по умолчанию 600/мин)
  расходуется на **каждый** вызов `/verify`, независимо от валидности сессии.
  Он общий с `/tg` и `/auth/*`. Это важно для второго приложения: каждая
  загрузка ассета = один вызов `/verify` = один токен.
- per-IP лимит неудач `GATEWAY_VERIFY_FAIL_PER_MIN` (120/мин) — только на
  `401`-ветку.

### 2.4. Можно ли использовать как `forward_auth` для второго upstream

**Да.** Проверено на Caddy 2.11.9 с mock-auth и mock-upstream:

- Caddy `forward_auth` сам ставит `X-Forwarded-Method`, `X-Forwarded-Uri`,
  `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`; auth видел
  `Host: vps-4692...:10000`, Cookie и `X-Gateway-Client-IP` (если Caddy его
  поставил).
- `200` → Caddy идёт в `reverse_proxy`; `401`/`429` → Caddy отдаёт ответ auth
  клиенту и upstream **не вызывает**.
- `forward_auth` **не копирует** заголовки ответа auth по умолчанию (в 2.11.9
  на обычном HTTP): `X-Auth-User`/`X-Auth-Session`/`Set-Cookie` до upstream не
  доходят. Если нужен `X-Auth-User`, его надо явно указать в
  `copy_headers X-Auth-User`; тогда значение auth **перекрывает** клиентскую
  подделку (проверено).
- Без `copy_headers` клиентский `X-Auth-User: EVIL` проходит до upstream, если
  его не вырезать. В живом Caddyfile уже есть глобальный
  `request_header -X-Auth-*`, поэтому клиентская подделка не доходит (проверено
  и в mock-стенде).
- **WS-нюанс:** на Upgrade Caddy присылает в `/verify` сам handshake
  (`Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-*`, `Origin`).
  Gateway это специально обрабатывает и отвечает `200` (не `101`), после чего
  Caddy туннелирует исходный WS в upstream. Проверено: с валидной сессией —
  `101`, без — `401`, с чужим Origin (при нашем guard) — `403`. Если auth
  попытается ответить `101`/начать проксировать сокет, схема ломается; поэтому
  `/verify` и остаётся «плоским» 200.
- **WS-квирк Caddy 2.11.9:** при handshake `X-Auth-User` из ответа `/verify`
  иногда попадает в upstream даже без `copy_headers`, и `header_up
  -X-Auth-User` его не убирает; при этом клиентская подделка `X-Auth-User`
  после глобального strip до upstream не доходила. Практический вывод: не
  используйте `X-Auth-User` как единственный auth-механизм второго приложения и
  не считайте `header_up` надёжным фильтром именно для WS. Если приложение не
  должно видеть никакие `X-Auth-*`, нужен broker (вариант C) или gateway-owned
  WS (вариант A).

### 2.5. Origin и CSRF

`/verify` **не вызывает** `checkOrigin` (`http.mjs:183-192`) — ни для HTTP, ни
для WS. Для DSH Origin проверяет `ProxyService.validateRequest`
(`proxy.mjs:180-205`), а не edge. Если Caddy проксирует в Claude напрямую
(вариант B), эту проверку надо продублировать в Caddy (см. §5), иначе
state-changing запросы и WS-handshake с валидной cookie не проверяются по
Origin. `SameSite=Lax` помогает против cross-site POST, но не является
достаточной заменой проверке Origin, особенно для WS.

---

## 3. WebSocket: как это устроено и что нужно второму приложению

### 3.1. В шлюзе

`server.on('upgrade')` (`gateway.mjs:405`) → `handleUpgrade` (`gateway.mjs:324-383`):

1. `checkHost`; только `Upgrade: websocket`; путь из `req.url`.
2. Если путь `/verify` — спецветка для Caddy `forward_auth`: общий bucket,
   `sessionFromRequest`, `200` с `X-Auth-User` + `Connection: close`, иначе
   `401`. **Origin здесь не проверяется**, audit успеха нет.
3. `/tg`, `/connect`, `/healthz`, `/auth/*`, `/internal/*` — `404`, не
   проксируются.
4. Иначе `ProxyService.handleUpgrade` (`proxy.mjs:490-540`):
   - `validateRequest({upgrade:true})`: только GET, валидация пути,
     `checkOrigin(requireOrigin:true)` — Origin обязан быть в
     `allowedOrigins` (публичный origin + `GATEWAY_EXTRA_ALLOWED_ORIGINS`);
   - сессия из cookie (`touch`);
   - лимит `wsMaxPerSession` (по умолчанию 4) на `sidHash`;
   - `broker.cookieHeader()` (DSH-cookie), затем `#openUpgrade`:
     raw TCP в DSH, рукописный handshake с `Host` = authority, `Origin`
     клиента, `Cookie` DSH; `101` → вырезаются `Set-Cookie/Server/Date`,
     сокет учитывается в `wsBySession`; `401` от DSH → один refresh+retry;
     иначе `502`.
   - `revoke`/`logout`/`revoke --all` вызывают `closeSessionSockets(sidHash)` и
     закрывают WS (`proxy.mjs:704-723`).

### 3.2. Что нужно второму приложению

Два рабочих способа:

- **B (Caddy-only):** Caddy `forward_auth` на WS-handshake → `/verify` 200 →
  Caddy сам туннелирует WS в `3090`. Gateway владеет только проверкой, не
  сокетом. Работает (проверено), но теряются `wsMaxPerSession`, Origin-проверка
  шлюза, `ws_open/ws_deny/ws_close` audit и закрытие по revoke. Сессия на
  открытом WS дальше не проверяется — как и у DSH (известный остаточный риск
  M-4), но для Claude это означает, что `revoke --all` не закроет уже открытый
  сокет.
- **A/C (broker/gateway-owned):** сокетом владеет шлюз или broker; тогда можно
  считать лимиты, писать audit, закрывать по revoke. Для A нужно
  параметризовать `ProxyService` вторым upstream; для C — реализовать
  аналогичный proxy в broker.

Caddy-путь B проверен с реальным Caddy 2.11.9: без cookie — `401` (не `101`),
с cookie — `101`, с чужим Origin (при guard) — `403`.

---

## 4. Варианты маршрутизации: сравнение

| Критерий | A. Расширить auth-gateway | B. Caddy + forward_auth → 3090 | C. Отдельный claude-broker | D. Второй инстанс шлюза |
|---|---|---|---|---|
| Что меняется | `config.mjs`, `proxy.mjs`, `gateway.mjs`, тесты; рестарт auth | только Caddyfile; рестарт Caddy | новый сервис + unit + Caddyfile; рестарт Caddy | второй unit/порт + общий store |
| Вход | та же сессия/store | та же сессия через `/verify` | та же сессия через `/verify` | та же cookie, но **другой store** |
| HTTP | да | да | да | да, если store общий |
| WS | gateway-owned, 101/401, Origin, лимит, revoke | Caddy-owned; 101/401 работает, revoke нет | broker-owned; можно revoke/лимит | как A, но второй процесс |
| Audit | полный (можно добавить target/userHash) | только Caddy access log + `verify_fail` | свой JSONL; можно userHash | два audit-файла/гонки |
| Rate-limit | `maxBodyBytes`, `verifyFail`, `wsMaxPerSession`, общий bucket | только общий `/verify` + Caddy body/method | свой + общий `/verify` | как A |
| Гигиена заголовков/cookie | лучшая: `buildUpstreamHeaders` режет Cookie/trust | ручная; обязательно `-Cookie`, иначе sid утечёт | полная: можно фильтровать cookie по имени | как A |
| Риск для DSH | высокий: общий код прокси | низкий: DSH-маршруты не меняются | средний: новый сервис, но DSH не трогаем | высокий: второй store/revoke-рассинхрон |
| Объём | ~250–400 LOC + тесты | ~30 строк Caddyfile | ~300–500 LOC + unit | ~100 LOC + новая модель store |
| Откат | git revert + restart auth | restore Caddyfile + restart Caddy | stop/disable unit + Caddyfile | stop unit |
| Вердикт | цель на будущее, если Claude останется | **рекомендуется для фазы 1** | если B не хватает | **не реально** без нового store |

### A. Расширить auth-gateway

Плюсы: единый store/audit/rate-limit; WS остаётся gateway-owned (revoke
закрывает и Claude); можно идеально вычистить Cookie/trust-заголовки; один
механизм входа.

Минусы: `ProxyService` жёстко завязан на DSH: `config.dsh.host/port/authority`,
`broker.cookieHeader()` (инъекция DSH-cookie), 401-retry, `buildUpstreamHeaders`
всегда ставит `Cookie: dsh-auth-...`. Чтобы отдать Claude, нужно:
- ввести descriptor upstream `{host,port,authority,prefix,cookieMode}`;
- не инжектить DSH-cookie (иначе DSH-cookie утечёт в Claude) и не пересылать
  браузерную Cookie;
- не делать DSH-401-retry (или сделать общий);
- поддержать strip prefix `/claude`;
- параметризовать WS-handshake и `wsBySession` (target);
- добавить audit-события с target.
Это правки в общем коде, который обслуживает DSH; ошибка ломает **весь** вход
(fail-closed 503). Плюс рестарт `dsh-gateway-auth` рвёт DSH WS/SSE (клиенты
переподключатся, сессии переживают рестарт). Тестов на сервере нет (аудит
фиксировал, что `tests/` не задеплоены), поэтому проверять пришлось бы в
staging. Для «минимально-рискового» шага — слишком большой blast radius.

### B. Caddy: `/claude/*` + forward_auth + reverse_proxy 3090

Плюсы: не трогаем Node-код и auth-сервис; Caddy уже умеет TLS-заголовки,
лимит тела, методы, логи; `forward_auth` переиспользует ту же сессию; WS
работает; откат — один файл; DSH-маршруты не меняются.

Минусы/что теряется:
- **Нет gateway-audit** успешных запросов Claude и WS; только Caddy access log
  (IP, URI без query, статус) и `verify_fail` в audit шлюза.
- **Нет `wsMaxPerSession`**, нет `ws_open/ws_close`, нет закрытия WS по
  revoke/logout/revoke-all. Открытый Claude-WS переживёт истечение сессии и
  отзыв (пока приложение/клиент сам не закроет).
- **Нет per-IP/per-user rate-limit** на API Claude; есть только общий
  `/verify`-bucket (600/мин) и Caddy body/method.
- **Cookie/заголовки** надо чистить вручную. Если не поставить
  `header_up -Cookie`, браузерная `__Host-dsh_session` уйдёт в Claude (утечка
  полноценной сессии в второе приложение). Если у Claude есть свои cookie —
  либо named-cookie forwarding, либо broker.
- **Origin** не проверяется `/verify`; нужен Caddy-guard (см. §5).
- **Общий bucket**: каждый ассет = `/verify`; второе приложение может
  расходовать 600/мин и мешать `/tg`/входу. Для одного пользователя обычно
  терпимо, но надо смотреть 429.
- **Base path**: приложение должно уметь жить под `/claude/` (asset URLs,
  manifest, start_url, redirects). Если оно генерирует абсолютные `/assets/...`
  или `Location: /`, путь ломается: `/assets/*` уйдёт в DSH. Это главный
  go/no-go.

### C. Отдельный `claude-broker` на loopback

Плюсы: не трогаем gateway; broker сам вызывает `/verify`, получает 200/401,
сам проксирует в Claude; можно:
- вырезать `__Host-dsh_session`/`__Host-dsh_dev`, оставив только cookie Claude
  (фильтрация по имени);
- вырезать все trust-заголовки, выставить `X-Forwarded-*`;
- владеть WS (лимит, закрытие, audit);
- писать свой audit JSONL с `userHash`/`sidPrefix` из `/verify`;
- сделать strip prefix и, при необходимости, минимальный rewrite Location.

Минусы: новый сервис (unit, UID, loopback-порт, hardening, обновления), дубль
security-логики (Origin! `/verify` его не проверяет; body limit; path
validation), нет интеграции с `revoke --all` (если broker не опрашивает шлюз
по admin-token, а это ещё один секрет у сервиса), риск «своего» auth-бага.
Больше кода и эксплуатации, чем B, но меньше риска для DSH, чем A. Разумный
выбор, если B не устраивает из-за cookie/WS-revoke/audit.

### D. Второй инстанс шлюза с общим session-store

Cookie `__Host-dsh_session` действительно **не привязана к порту**: `__Host-`
требует Secure/Path=/ и отсутствие Domain, поэтому браузер отправит её и на
`/claude/*` (тот же host:port), и на второй loopback-порт, если бы Caddy
маршрутизировал туда. Но это единственное, что работает.

`SessionStore` (`sessions.mjs`) — это **in-memory** состояние, загружаемое из
JSON при старте, с атомарной полной перезаписью файла (`writeFileSync` +
`fsync` + `rename`) и **без file lock / reload / watch** (`sessions.mjs:145-241`).
Два процесса на одном файле:
- загрузят копии и будут перетирать записи друг друга (last writer wins);
- login на инстансе A не виден B до рестарта B (а рестарт может затереть
  свежие данные A);
- `revoke`/`logout` на A не отзовёт сессию на B; `revoke --all` на A не
  закроет WS B;
- `verify` на B будет делать `touch` и писать свою копию, создавая гонки.
Разные файлы — ещё хуже: сессия, выданная A, для B не существует; вход в B
потребует отдельного `/tg`, что противоречит цели «тот же вход». Общий
store нужен новый (SQLite/Redis или файл с lock+reload), это отдельный проект.
Плюс два audit-файла/ротации, два юнита, двойная память. **Не рекомендуется.**

---

## 5. Рекомендуемая схема (B) и точный Caddyfile-фрагмент

Рекомендация: **B для фазы 1** — минимальная правка (только Caddyfile), не
трогает Node/DSH, легко откатывается, переиспользует ту же сессию и работает
для HTTP/SSE/WS. Обязательные условия:

1. Claude слушает **только** `127.0.0.1:3090`, под отдельным UID, с
   systemd-hardening; `ss -ltnp` подтверждает loopback.
2. Claude умеет base path `/claude/` (все URL относительные или
   конфигурируемые; manifest/start_url/scope под `/claude/`; нет
   `Location: /`).
3. У Claude **нет своей формы входа** (или она отключается). Если есть свои
   cookie — B требует named-cookie forwarding; если есть своя auth-сессия,
   «тот же вход» не получится без A/C.
4. `header_up -Cookie` обязателен (или named-cookie), иначе sid утечёт.
5. Origin-guard в Caddy обязателен (`/verify` его не делает). Если в
   `GATEWAY_EXTRA_ALLOWED_ORIGINS` есть другие origin'ы, их надо добавить в
   условие guard'а; для публичного Funnel достаточно
   `https://vps-4692.tailfbc4b2.ts.net:10000`.
6. Публично — только manifest/icons; `/claude/sw.js` и всё остальное — за
   сессией.

### 5.1. Куда вставлять

В существующий `route { ... }` внутри `site`-блока, **после** `handle
/internal/*` и **до** финального `handle { ... }` (catch-all). Если в живом
файле `route` нет — сохранить текущую структуру и вложенность; `handle` вне
`route` Caddy не примет. Новый блок не должен попасть в отдельный `route`
после catch-all: catch-all поглотит `/claude/*`.

Ожидаемый скелет (восстановлен; живой файл проверить `diff`-ом):

```caddyfile
http://:8081 {
    bind 127.0.0.1
    route {
        header { ... }                 # security headers
        request_header -X-Auth-*       # уже есть
        request_header -X-Forwarded-*  # уже есть
        request_header -X-Gateway-Client-IP
        request_header X-Gateway-Client-IP {client_ip}
        request_body { max_size 64MB }
        @badMethods not method GET HEAD POST OPTIONS
        respond @badMethods "method not allowed" 405

        handle /tg { reverse_proxy 127.0.0.1:9090 }
        handle /auth/* { reverse_proxy 127.0.0.1:9090 }
        handle /healthz { reverse_proxy 127.0.0.1:9090 }
        handle /connect { respond "not found" 404 }
        handle /connect/* { respond "not found" 404 }
        handle /verify { respond "not found" 404 }
        handle /internal/* { respond "not found" 404 }

        # >>> CLAUDE BLOCK HERE <<<

        handle {
            forward_auth 127.0.0.1:9090 { uri /verify }
            reverse_proxy 127.0.0.1:9090 { flush_interval -1 ... }
        }
    }
    handle_errors { ... }
    log { ... }
}
```

### 5.2. Фрагмент

Порты: auth `9090`, Claude `3090`. Список публичных путей заменить на реальные
пути манифеста/иконок Claude.

```caddyfile
# ── Claude Web UI (/claude/) ─────────────────────────────────────────────
# 1) Установочные метаданные: Chrome WebAPK minter тянет manifest и иконки
#    БЕЗ cookie пользователя. Публикуем только инертные файлы, только GET/HEAD.
@claude_install path /claude/manifest.webmanifest /claude/icon-192.png /claude/icon-512.png /claude/icon-maskable-512.png
handle @claude_install {
    @not_get not method GET HEAD
    respond @not_get "method not allowed" 405
    reverse_proxy 127.0.0.1:3090
}

# 2) Канонический trailing slash: относительные URL приложения должны
#    резолвиться под /claude/, а не в корень DSH.
handle /claude {
    redir * /claude/ 308
}

# 3) Origin/CSRF guard ДО forward_auth: /verify Origin не проверяет.
#    Для POST/PUT/PATCH/DELETE и WS-handshake Origin обязан быть публичным.
#    (path-матчер + expression = AND; respond срабатывает раньше forward_auth)
@claude_bad_origin {
    path /claude/*
    expression `({http.request.method} in ['POST','PUT','PATCH','DELETE'] || {http.request.header.Upgrade} == 'websocket') && {http.request.header.Origin} != 'https://vps-4692.tailfbc4b2.ts.net:10000'`
}
respond @claude_bad_origin "forbidden" 403

# 4) Всё остальное под /claude/ — за той же сессией.
handle /claude/* {
    forward_auth 127.0.0.1:9090 {
        uri /verify
        # Опционально: если приложению нужен псевдоним пользователя.
        # copy_headers X-Auth-User
    }

    reverse_proxy 127.0.0.1:3090 {
        # SSE/стриминг агента: не буферизовать.
        flush_interval -1

        # Публичный вход — https (TLS терминирует tailscaled).
        # Caddy за TLS-терминатором иначе отдаст приложению http.
        header_up X-Forwarded-Proto https

        # НИКОГДА не отдавать второму приложению сессионную cookie шлюза.
        # Если у Claude есть свои cookie — заменить на named-forwarding:
        #   header_up Cookie "claude_session={http.request.cookie.claude_session}"
        header_up -Cookie

        # Клиентские trust-заголовки уже вырезаны глобально; здесь — defense
        # in depth. Для WS Caddy 2.11.9 эти delete могут не примениться к
        # X-Auth-* (см. §2.4), поэтому не полагайтесь на них как на auth.
        header_up -X-Auth-User
        header_up -X-Auth-Session
        header_up -X-Forwarded-User
        header_up -X-Real-IP
        header_up -Authorization
        header_up -X-Gateway-Client-IP
    }
}
```

Пояснения к порядку:

- `@claude_install` **до** `handle /claude/*`, иначе публичные файлы попадут
  под forward_auth и вернут 401 (именно это сейчас ломает установку DSH-PWA).
- `@claude_bad_origin` — на уровне `route`, **до** `handle /claude/*`. Если
  положить `respond` внутрь handle перед `forward_auth`, Caddy сортирует
  директивы subroute и всё равно сначала вызовет `/verify` (проверено:
  bad-origin POST доходил до `/verify`, потом получал 403). На уровне route
  порядок сохраняется: bad-origin блокируется без вызова `/verify`.
- `redir * /claude/ 308`: без `*` Caddy парсит `/claude/` как matcher, а `308`
  как Location (проверено: получался `302 Location: 308`). `*` обязателен.
- `handle /claude` и `handle /claude/*` не конфликтуют: точный путь уходит в
  редирект, подпути — в прокси.
- `header_up -Cookie` — ключевая строка. Без неё Claude получает
  `__Host-dsh_session` и `__Host-dsh_dev` в каждом запросе.
- `copy_headers X-Auth-User` — только если приложению действительно нужен
  псевдоним; тогда уберите `header_up -X-Auth-User`/`-X-Auth-Session` (иначе
  удалите скопированное).
  Помните про WS-квирк: на handshake заголовок может появиться/не появиться
  непоследовательно.

### 5.3. Публичные пути для установки PWA

Chrome на Android ставит PWA через **WebAPK**: сервис Google скачивает
`manifest` и иконки по публичному URL **без cookie пользователя**. Если они за
`forward_auth`, установка падает с «app cannot be installed» — это уже
зафиксировано для DSH в `docs/dsh-pwa-android.md:16-28`. Для Claude нужно то
же:

- публично: `manifest.webmanifest`, `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png`, при необходимости `apple-touch-icon.png`,
  `favicon.ico`;
- только `GET`/`HEAD`, точные пути, без листингов и без API;
- корректный `Content-Type: application/manifest+json` (если приложение отдаёт
  `text/plain`, поправить заголовком в handle);
- манифест: `id`, `start_url`, `scope` — под `/claude/`; `display:
  standalone`; иконки PNG (Chrome WebAPK не собирает SVG); `theme_color`;
- ссылка в HTML приложения должна вести на `/claude/manifest.webmanifest` (или
  на публичный путь). Если приложение жёстко ссылается на корневой
  `/manifest.webmanifest`, оно возьмёт манифест DSH — установится «DSH»,
  а не Claude. Это нужно проверить до правки Caddy.

**Почему `/claude/sw.js` НЕ публичный:**

1. Это исполняемый код с правами origin и scope `/claude/`; он может
   перехватывать и кэшировать все ответы приложения, включая закрытые
   страницы/API. Публичный доступ к нему не нужен и расширяет поверхность.
2. Браузер регистрирует/обновляет SW **со своей сессией** (same-origin,
   credentials), поэтому 401 для анонима не мешает работе вошедшего
   пользователя. Для WebAPK-минтера SW вообще не нужен — он тянет только
   manifest/icons.
3. Корневой `/sw.js` уже занят PWA-плагином DSH. Второе приложение не должно
   претендовать на `/sw.js`: иначе его worker получит scope `/` и сможет
   влиять на DSH. Claude-SW должен жить по `/claude/sw.js` со scope
   `/claude/`; `Service-Worker-Allowed: /` ему выдавать нельзя.
4. Публичный SW — лишний канал доставки кода и потенциальный cache-poisoning
   вектор; принцип — отдавать анониму только инертные метаданные.

### 5.4. Заголовки, таймауты, тело

| Что | Значение / действие |
|---|---|
| `Host` | Caddy по умолчанию сохраняет публичный `vps-4692...:10000` (проверено). Не переписывать: приложению нужен публичный authority для Host/Origin-fence. |
| `X-Forwarded-Proto` | явно `https` для HTTP (tailscaled терминирует TLS; иначе Caddy отдаст `http`). На WS-handshake Caddy 2.11.9 может всё равно отдать `http` (наблюдали), поэтому приложение должно строить `wss://` явно, не выводя схему из этого заголовка. |
| `X-Forwarded-Host` | Caddy сохраняет публичный host. |
| `X-Forwarded-For` | Caddy ставит реальный IP клиента (trusted_proxies loopback); клиентский XFF вырезан глобально. |
| `X-Gateway-Client-IP` | уже ставится edge для auth; в Claude не обязателен (можно отдать, можно вырезать). |
| `Cookie` | вырезать; named-forwarding только для cookie самого Claude. |
| `X-Auth-*`, `Authorization`, `X-Forwarded-User`, `X-Real-IP` | вырезать (клиентские — глобально, в upstream — defense in depth). |
| `Origin` | сохранять; Caddy-guard проверяет для unsafe/WS. |
| security headers | глобальные (HSTS, CSP frame-ancestors/base-uri/object-src, XFO, nosniff, Referrer-Policy, Permissions-Policy, no-store, X-Robots-Tag, `-Server`) применяются и к Claude. |
| `Cache-Control` | глобальный `no-store, private`; PWA-ассеты кэширует SW, не HTTP-кэш. Если нужен HTTP-кэш для `/claude/assets/*`, это отдельный handle с `header -Cache-Control` (не в phase 1). |
| таймауты | глобальные `read_header 20s`, `read_body 300s`, `write 0s`, `idle 5m`; `flush_interval -1` для SSE/потоков; WS туннелируется без write-таймаута. |
| тело | глобальный `request_body max_size 64MB` (совпадает с `maxBodyBytes` шлюза); для Claude можно уменьшить, если нет загрузок. |
| header size | `max_header_size 32KB`. |
| методы | глобальный `@badMethods` → 405 для всего, кроме GET/HEAD/POST/OPTIONS; публичные manifest/icons дополнительно только GET/HEAD. |
| логи | в `log.format.filter.fields` добавить `resp_headers>Set-Cookie delete` — иначе cookie Claude (и, как известно из аудита, `Set-Cookie` шлюза) попадут в `/var/log/dsh-gateway/caddy-access.log`. Проверено: после этой строки `Set-Cookie` в JSON-логе отсутствует. |

---

## 6. Root-шаги (выполняет владелец/root; `dsh` их сделать не может)

> Все команды — только для root. Ниже предполагается, что Claude уже слушает
> `127.0.0.1:3090` и что его base path/manifest проверены (§8).

### 6.1. Бэкап и подготовка

```bash
install -d -m 0700 /root/dsh-gateway-caddy-backup
cp -a /etc/dsh-gateway-caddy/Caddyfile \
      /root/dsh-gateway-caddy-backup/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ)
sha256sum /etc/dsh-gateway-caddy/Caddyfile /root/dsh-gateway-caddy-backup/Caddyfile.*
stat -c '%U:%G %a %n' /etc/dsh-gateway-caddy/Caddyfile
# ожидается root:caddy 640

# рабочая копия, которую правим и валидируем ДО установки
cp -a /etc/dsh-gateway-caddy/Caddyfile /root/Caddyfile.new
```

### 6.2. Правка

В `/root/Caddyfile.new` вставить фрагмент §5.2 в существующий `route { ... }`
до финального `handle { ... }`. Проверить, что:

```bash
grep -n 'handle /internal/\*\|# >>> CLAUDE\|handle /claude\|handle {' /root/Caddyfile.new
```

Порядок должен быть: `/internal/*` → Claude install → `/claude` redirect →
bad-origin guard → `/claude/*` → финальный `handle {`.

### 6.3. Валидация (до установки)

```bash
caddy validate --config /root/Caddyfile.new --adapter caddyfile
# ожидается: Valid configuration
caddy fmt --diff /root/Caddyfile.new    # необязательно; покажет форматирование
```

Если `validate` ругается — не устанавливать.

### 6.4. Установка и restart

```bash
install -m 0640 -o root -g caddy /root/Caddyfile.new \
        /etc/dsh-gateway-caddy/Caddyfile
stat -c '%U:%G %a %n' /etc/dsh-gateway-caddy/Caddyfile   # root:caddy 640

# ВАЖНО: reload невозможен — admin off и в юните нет ExecReload
# (systemctl show ... -p CanReload => no). Только restart.
systemctl restart dsh-gateway-caddy
systemctl is-active dsh-gateway-caddy
```

`restart` — разрыв: Caddy перестаёт принимать соединения и перезапускается;
открытые DSH SSE/WS-соединения рвутся, клиенты переподключаются. В худшем
случае остановка занимает до `TimeoutStopSec=15s` (Caddy делает graceful
shutdown, а долгие SSE/WS сами не закрываются), поэтому это не «доли
секунды». Делать в спокойное окно.

### 6.5. Проверки после restart

Без сессии (не логинимся, не создаём сессий):

```bash
H='Host: vps-4692.tailfbc4b2.ts.net:10000'
for p in /healthz / /auth/tg /verify /connect /internal/status \
         /claude /claude/ /claude/sw.js /claude/api \
         /claude/manifest.webmanifest /claude/icon-192.png; do
  printf '%-32s ' "$p"
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 -H "$H" "http://127.0.0.1:8081$p"
done
```

Ожидаемо:

- `/healthz` — 200 (auth жив);
- `/` — 401 (DSH не открылся);
- `/auth/tg` — 200 (страница входа);
- `/verify`, `/connect`, `/internal/status` — 404;
- `/claude` — 308 → `/claude/`;
- `/claude/`, `/claude/sw.js`, `/claude/api` — 401 (не 101/200);
- `/claude/manifest.webmanifest`, `/claude/icon-192.png` — 200 **только если
  Claude запущен и отдаёт их**; иначе 502/503 — это не ошибка Caddy.

Проверка WS без сессии (должен быть 401, не 101):

```bash
curl --http1.1 -si --max-time 5 -H "$H" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8081/claude/ws | head -3
```

Проверка с сессией — **только в браузере владельца** (curl с настоящей cookie
не использовать, чтобы не светить sid):

1. Открыть `https://vps-4692.tailfbc4b2.ts.net:10000/claude/` в том же
   браузере, где уже есть вход. Ожидается 200, приложение, WS 101 в DevTools →
   Network → WS.
2. Открыть DSH `/`, проверить, что чат/агент работает, WS 101.
3. Установить PWA: Chrome → «Установить приложение»; проверить, что
   `start_url` = `/claude/`, scope = `/claude/`, иконки — PNG, окно без
   адресной строки.
4. DevTools → Application → Service Workers: scope **`/claude/`**, не `/`.

Логи:

```bash
journalctl -u dsh-gateway-caddy -n 100 --no-pager | grep -Ei 'error|panic|dial|503' || true
tail -n 3 /var/log/dsh-gateway/caddy-access.log
# проверить, что в логе нет Set-Cookie / __Host-dsh_session
grep -c 'Set-Cookie\|__Host-dsh_session' /var/log/dsh-gateway/caddy-access.log || true
```

`dsh-web` и `dsh-gateway-auth` не перезапускались; проверить:

```bash
systemctl is-active dsh-web dsh-gateway-auth dsh-gateway-caddy
```

### 6.6. Откат

Если Caddy не стартует, DSH сломался или Claude ведёт себя непредсказуемо:

```bash
cp -a /root/dsh-gateway-caddy-backup/Caddyfile.<TS> \
      /etc/dsh-gateway-caddy/Caddyfile
stat -c '%U:%G %a %n' /etc/dsh-gateway-caddy/Caddyfile   # root:caddy 640
caddy validate --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile
systemctl restart dsh-gateway-caddy
systemctl is-active dsh-gateway-caddy
H='Host: vps-4692.tailfbc4b2.ts.net:10000'
curl -sS -o /dev/null -w '%{http_code}\n' -H "$H" http://127.0.0.1:8081/healthz  # 200
```

Если Caddy в цикле рестартов (`systemctl status`), сначала вернуть файл, затем
`systemctl reset-failed dsh-gateway-caddy` (при необходимости) и
`systemctl restart`. Если сломан только Claude — можно удалить только блок
`/claude` и оставить остальное; DSH-маршруты не затрагивались.

---

## 7. Почему `reload` не работает

`dsh-gateway-caddy.service`:

- `ExecStart=/usr/bin/caddy run --config /etc/dsh-gateway-caddy/Caddyfile`;
- **нет** `ExecReload`;
- Caddyfile: `admin off` (и `persist_config off`);
- `systemctl show dsh-gateway-caddy -p CanReload` → `no`.

Поэтому `systemctl reload dsh-gateway-caddy` не перечитывает конфиг (и, скорее
всего, вернёт ошибку «Job type reload is not applicable»). В
`docs/dsh-pwa-android.md` указан `systemctl reload` — для этого юнита это
неверно; нужен `restart`. `caddy reload` тоже не сработает: admin API выключен.

---

## 8. Go/no-go для Claude (проверить до правки Caddy)

| # | Проверка | Почему |
|---|---|---|
| 1 | `ss -ltnp \| grep 3090` → `127.0.0.1:3090`, не `0.0.0.0` | иначе второй обход шлюза |
| 2 | Приложение открывается по `http://127.0.0.1:3090/claude/` (HTML, JS, CSS, API) | base path |
| 3 | В HTML нет абсолютных `/assets/...`, `/api/...`, `Location: /`; либо есть настройка `BASE_URL`/`PUBLIC_URL=/claude/` | иначе уйдёт в DSH |
| 4 | Манифест и иконки отдаются по `/claude/...` без auth и без редиректа на `/claude/` | иначе WebAPK не установится |
| 5 | В HTML ссылка на manifest ведёт на `/claude/manifest.webmanifest` | иначе установится DSH-манифест |
| 6 | У приложения нет своей формы входа; свои cookie — известных имён или отсутствуют | «тот же вход»; фильтрация cookie |
| 7 | WS приложения идёт на `wss://vps-.../claude/...` (относительный путь), Origin = публичный | forward_auth + guard |
| 8 | Приложение принимает `Host: vps-...:10000` и `X-Forwarded-Proto: https` | Host/Origin fence |
| 9 | Приложение не регистрирует SW на scope `/` и не отдаёт `/sw.js` | не перехватывать DSH |
| 10 | Приложение не делает абсолютных редиректов на `/` после логина/API | иначе выход из `/claude/` |

Если 2–5 не выполняются — вариант B не подходит. Тогда: A (полный контроль,
но правки общего прокси) или C (broker с rewrite/фильтрацией), либо
переупаковка Claude под `/claude/` (правка приложения).

---

## 9. Остаточные риски и ограничения B

1. **Утечка сессионной cookie**, если забыть `header_up -Cookie`. Это
   критично: `__Host-dsh_session` = полный доступ к DSH. С named-cookie
   forwarding убедиться, что приложение не логирует Cookie.
2. **Нет revoke/WS-close**: `revoke --all` не закроет уже открытый Claude-WS;
   сессия на WS не перепроверяется. Смягчение: idle/absolute таймаут в самом
   Claude, рестарт Claude при отзыве, или вариант A/C.
3. **Нет gateway-audit** успешных запросов и WS Claude; только Caddy access log
   и `verify_fail`. Для per-user аудита нужен A/C.
4. **Нет per-user/per-IP rate-limit** API Claude; общий `/verify` bucket может
   насыщаться. Смотреть 429; при проблеме — уменьшить число ассетов за auth
   (публичные hashed assets) или поднять bucket (ослабляет защиту входа).
5. **Общий bucket и touch**: трафик Claude продлевает idle DSH-сессии и
   расходует 600/мин, общие с `/tg`. Один пользователь — обычно ок.
6. **Caddy WS-квирк** с `X-Auth-*`; не строить auth приложения на этих
   заголовках.
7. **Restart Caddy** рвёт DSH WS/SSE на секунды; делать в окне.
8. **Публичные manifest/icons** — небольшая новая DoS-поверхность; только
   точные пути, GET/HEAD, желательно `Cache-Control`/static; не публиковать
   HTML/JS/API.
9. **Caddy access log**: после `resp_headers>Set-Cookie delete` cookie не
   пишется; URI логируется без query; IP — PII, retention 30 дней.
10. **Caddyfile не прочитан**: живой файл может отличаться от скелета; без
    `diff` есть риск сломать DSH. Валидация и бэкап обязательны.

---

## 10. Приложение: доказательства и код

### 10.1. Живые read-only проверки (без сессии)

```
GET /healthz (127.0.0.1:9090)                → 200 {"status":"ok","version":"0.1.0"}
GET /verify без X-Forwarded-*                → 404 {"error":"not_found"}
GET /verify с X-Forwarded-*, без cookie      → 401 {"error":"unauthorized"}
                                                WWW-Authenticate: DSH-Session realm="dsh-gateway"
GET /healthz через Caddy 8081                → 200
GET /verify через Caddy 8081                 → 404 (text/plain)
GET / через Caddy 8081, без cookie           → 401
```

### 10.2. Стенд Caddy 2.11.9 (mock auth + mock upstream)

Проверено локально, без production-сервисов:

| Сценарий | Результат |
|---|---|
| `/claude/` без cookie | 401, upstream не вызван |
| `/claude/` c cookie | 200 |
| `/claude/manifest.webmanifest` без cookie | 200 (публичный handle) |
| POST на публичный manifest | 405 |
| `/claude/sw.js` без cookie | 401 |
| `/claude` | 308 → `/claude/` (с `redir *`) |
| WS без cookie | 401, не 101 |
| WS c cookie | 101 |
| WS/POST с чужим Origin | 403 **до** `/verify` (guard на уровне route) |
| WS/POST с публичным Origin | 200/101 |
| клиентский `X-Auth-User: EVIL` | до upstream не доходит (глобальный strip) |
| `header_up -Cookie` | Cookie (включая `__Host-dsh_session`) в upstream отсутствует |
| `{http.request.cookie.claude}` | named-cookie forwarding работает: upstream видит только `claude=...` |
| `resp_headers>Set-Cookie delete` | `Set-Cookie` отсутствует в access log |
| `copy_headers X-Auth-User` | HTTP: auth-значение перекрывает клиентское; без copy — клиентское проходит |
| WS + `X-Auth-User` | квирк: значение из `/verify` может попасть в upstream даже без copy_headers и не убирается `header_up`; клиентская подделка при этом не проходит |
| WS + `header_up X-Forwarded-Proto https` | на handshake upstream всё равно получил `http`; на обычном HTTP — `https` |

### 10.3. Ссылки на код

| Факт | Где |
|---|---|
| `/verify` контракт | `lib/authflow.mjs:688-714` |
| `sessionFromRequest` | `lib/authflow.mjs:110-114` |
| `getSession`/touch/TTL | `lib/sessions.mjs:289-314` |
| persist (atomic, без lock) | `lib/sessions.mjs:205-241` |
| `/verify` маршрут | `lib/gateway.mjs:170-172` |
| WS `/verify` спецветка | `lib/gateway.mjs:336-366` |
| WS proxy | `lib/proxy.mjs:490-540`, `542-692` |
| Origin/методы/путь WS | `lib/proxy.mjs:180-205` |
| cookie/trust strip | `lib/proxy.mjs:114-133` |
| WS revoke | `lib/proxy.mjs:704-723` |
| clientIp / X-Gateway-Client-IP | `lib/util.mjs:119-129` |
| `hashTgUser` | `lib/util.mjs:157-159` |
| checkOrigin | `lib/http.mjs:183-192` |
| verify/global лимиты | `lib/config.mjs:285-299` |
| trustProxyHeaders | `lib/config.mjs:352-355` |
| Caddy edge (DESIGN) | `DESIGN.md` §5, §5.1 |
| PWA: manifest без cookie, `/sw.js` не публичный | `docs/dsh-pwa-android.md:16-28, 60-63` |

### 10.4. Мелочь, замеченная в коде (не про маршрутизацию)

В `lib/proxy.mjs:518-520` в WS-ветке при `Content-Length > maxBodyBytes`
вызывается `sendJson(res, 413, ...)`, но в `handleUpgrade(req, socket, head)`
переменной `res` нет. При срабатывании это даст `ReferenceError` и `502`
через внешний catch, а не 413. Триггерится только аномальным Upgrade с
большим Content-Length; при рефакторинге под вариант A это стоит поправить
(например, `respondUpgradeError(socket, 413, 'body_too_large')`).

---

## 11. Итог

- `/verify` — валидный `forward_auth`-контракт: 200/401, псевдонимные
  `X-Auth-User`/`X-Auth-Session`, touch сессии, общий rate-bucket, **без**
  Origin-проверки и без audit успеха. Для второго upstream его можно
  использовать, но Origin/CSRF и гигиену cookie надо добавить на edge.
- WS через Caddy `forward_auth` работает (проверено на 2.11.9), потому что
  gateway отвечает на Upgrade плоским 200. Но тогда сокетом владеет Caddy, а не
  шлюз: revoke/лимиты/audit WS теряются.
- Минимально-рисковый вариант — **B**: только Caddyfile, без правок Node,
  с обязательными `header_up -Cookie`, Origin-guard, публичными только
  manifest/icons и приватным `/claude/sw.js`.
- Главные условия: Claude обязан поддерживать base path `/claude/`, не иметь
  своей формы входа и не отдавать абсолютные ссылки в корень. Иначе — A
  (gateway-owned upstream) или C (broker).
- D (второй инстанс) нереален: `SessionStore` — in-memory JSON без lock/reload;
  две копии будут перетирать сессии и revoke.
