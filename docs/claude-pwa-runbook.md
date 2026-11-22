# Claude PWA: root-runbook развёртывания и отката

Дата: 2026-11-21. Для владельца/ops. **Выполнять на VPS по SSH с root**, в окне
обслуживания: Caddy нельзя перезагрузить (`admin off`, `CanReload=no`) — только
`systemctl restart dsh-gateway-caddy`, это рвёт WS/SSE DSH на время до ~15 с.
Все команды — с проверками; при любом провале — откат (§8), не «чинить на живом».

План и архитектура: [claude-pwa-plan.md](claude-pwa-plan.md).
Исследования: [gateway-route.md](research/gateway-route.md),
[claude-runtime.md](research/claude-runtime.md),
[pwa-assets.md](research/pwa-assets.md).

Обозначения:

- `PUBLIC=https://vps-4692.tailfbc4b2.ts.net:10000`
- `APP=/opt/claude-web`, `DATA=/var/lib/claude-web`, `WS=/srv/claude-web/workspaces`
- `PORT=3090` (loopback)
- `TAG=$(date +%Y%m%d-%H%M%S)` — метка бэкапа.

---

## 0. Предусловия и бэкап

В root-shell задать переменные (не полагаться на прошлую сессию):

```bash
PUBLIC='https://vps-4692.tailfbc4b2.ts.net:10000'
WS='/srv/claude-web/workspaces'
export PUBLIC WS
```

Убедиться:

```bash
hostname; date -u
systemctl is-active dsh-web dsh-gateway-auth dsh-gateway-caddy
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/"          # 401
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/manifest.webmanifest"  # 200
node -v                                                      # v24.x
```

Бэкап **до** любых изменений:

```bash
TAG=$(date +%Y%m%d-%H%M%S)
install -d -m 0700 /root/claude-pwa-backup-$TAG
cp -a /etc/dsh-gateway-caddy/Caddyfile /root/claude-pwa-backup-$TAG/Caddyfile
sha256sum /etc/dsh-gateway-caddy/Caddyfile | tee /root/claude-pwa-backup-$TAG/Caddyfile.sha256
systemctl cat dsh-gateway-caddy > /root/claude-pwa-backup-$TAG/dsh-gateway-caddy.unit
ss -lntp > /root/claude-pwa-backup-$TAG/ports.txt
echo "$TAG" > /root/claude-pwa-backup-TAG
```

Проверить живой Caddyfile и **сравнить** с ожидаемым скелетом из
[gateway-route.md §5.1](research/gateway-route.md): за время после снимка конфиг мог
измениться. Правки — только в копии, не в живом файле.

> Внимание (аудит SEC-02): auth-гейтвей передеплоивается и перезаписывает Caddyfile.
> Бэкап и `claude-pwa-backup-TAG` из §0 могут устареть за время подготовки. Перед
> `--install` ориентируйтесь на свежий бэкап, который создаёт `apply-caddy.py --install`
> (он читает живой файл в момент применения и падает, если файл изменился между
> чтением и заменой), а репетицию отката делайте по НОВОМУ TAG, а не по §0.

---

## 1. Пользователь и каталоги

```bash
id claudeapp 2>/dev/null || useradd --system \
  --home-dir /var/lib/claude-web --create-home \
  --shell /usr/sbin/nologin claudeapp

install -d -o claudeapp -g claudeapp -m 0700 /var/lib/claude-web
install -d -o claudeapp -g claudeapp -m 0700 /var/lib/claude-web/claude-config
install -d -o claudeapp -g claudeapp -m 0700 /var/log/claude-web
# /srv/claude-web — root-owned 0751: caddy проходит к public, но не листает;
# claudeapp не может подменить public (владелец родителя — root). workspaces — claudeapp 0750.
install -d -o root -g root -m 0751 /srv/claude-web
install -d -o claudeapp -g claudeapp -m 0750 /srv/claude-web/workspaces
install -d -o root -g root -m 0755 /srv/claude-web/public
install -d -o root -g root -m 0750 /etc/claude-web
install -d -o root -g root -m 0755 /opt/claude-web
```

Проверка:

```bash
getent passwd claudeapp; getent group caddy
stat -c '%a %U:%G %n' /var/lib/claude-web /srv/claude-web /srv/claude-web/public /etc/claude-web
runuser -u caddy -- test -x /srv/claude-web && echo caddy-traverse-ok
```

`claudeapp` **не** должен быть в группе `dsh`, иметь доступ к `/home/dsh` или docker/sudo.

---

## 2. Токен Claude (однократно, владелец)

`claude setup-token` требует браузер и существующий вход Claude Code. Выполнять **от `dsh`**
(не от root), в обычном SSH (не внутри DSH-песочницы):

```bash
# root; TTY нужен для интерактивного flow. Вывод пишем в root-файл 0600,
# строки с токеном не показываем в терминале (URL/инструкции — видны).
umask 077
script -qec 'runuser -u dsh -- env HOME=/home/dsh /usr/bin/claude setup-token' \
  /root/claude-setup-token | grep --line-buffered -v 'sk-ant-'
chmod 0600 /root/claude-setup-token
```

Если `script`/`runuser` недоступны — выполнить `claude setup-token` в SSH-сессии `dsh`,
но **не** сохранять вывод в домашнем каталоге `dsh`: сразу перенести файл root'ом и удалить.
Не печатать токен в чат и не оставлять его в `/tmp` или истории shell.

Токен — секрет: не печатать в чат, не коммитить, не оставлять в `/tmp`. Передать root
безопасно (например, root сам читает файл с правами 0600 и сразу удаляет):

```bash
# root:
umask 077
TOKEN=$(grep -o 'sk-ant-[A-Za-z0-9._-]*' /root/claude-setup-token | tail -1)
test -n "$TOKEN" || { echo "token not found"; exit 1; }
EDGE_SECRET=$(openssl rand -hex 32)
[[ "$EDGE_SECRET" =~ ^[0-9a-f]{64}$ ]] || { echo "bad EDGE_SECRET"; exit 1; }
# владелец: открыть $PUBLIC/auth/status после входа, скопировать userHash (12 hex)
: "${ALLOWED_USER_HASH:?export ALLOWED_USER_HASH=<12hex from /auth/status>}"
[[ "$ALLOWED_USER_HASH" =~ ^[0-9a-f]{12}$ ]] || { echo "bad ALLOWED_USER_HASH"; exit 1; }
{
  echo "HOST=127.0.0.1"
  echo "PORT=3090"
  echo "PUBLIC_ORIGIN=$PUBLIC"
  echo "BASE_PATH=/claude/"
  echo "WORKSPACES=$WS"
  echo "AUDIT_LOG=/var/log/claude-web/audit.jsonl"
  echo "MAX_SESSIONS=2"
  echo "APPROVAL_TIMEOUT_MS=300000"
  echo "EDGE_SECRET=$EDGE_SECRET"
  echo "ALLOWED_USER_HASH=$ALLOWED_USER_HASH"
  echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN"
} > /etc/claude-web/env
chown root:root /etc/claude-web/env
chmod 0600 /etc/claude-web/env
shred -u /root/claude-setup-token 2>/dev/null || rm -f /root/claude-setup-token
unset TOKEN EDGE_SECRET ALLOWED_USER_HASH
```

Файл `0600 root:root`: systemd читает его как root **до** drop privileges; `claudeapp` не может
прочитать его ни через Read-инструмент, ни из shell. Power-режим (Bash) в MVP выключен; если
его когда-нибудь включат, токен будет наследоваться Bash-процессом (см. plan §7.3).

Проверка без вывода секрета (root читает env, но не передаёт токен в argv):

```bash
stat -c '%a %U:%G %n' /etc/claude-web/env    # 600 root:root
umask 077
tmp=$(mktemp -d)
set -a; . /etc/claude-web/env; set +a
HOME=$tmp CLAUDE_CONFIG_DIR=$tmp/.claude claude auth status | \
  grep -E 'loggedIn|authMethod|subscriptionType'
# ожидается authMethod: oauth_token
rm -rf "$tmp"; unset CLAUDE_CODE_OAUTH_TOKEN EDGE_SECRET
```

> Если `setup-token` недоступен: fallback — отдельный вход `claude auth login` от
> `claudeapp` (нужен браузер) и файловый OAuth в `CLAUDE_CONFIG_DIR`; это хуже
> (refresh-файл, 8-часовой access token). Решение принимает владелец.

---

## 3. Деплой приложения

Сборка выполняется под `dsh` (не root), артефакт — tar без `node_modules` и секретов:

```bash
# как dsh:
cd /home/dsh/projects/claude-web
npm ci
npm test
npm run build
tar --exclude=node_modules --exclude=.git -czf /tmp/claude-web-$TAG.tgz .
```

Установка (root):

```bash
install -m 0600 /tmp/claude-web-$TAG.tgz /root/claude-web-$TAG.tgz
tar -xzf /root/claude-web-$TAG.tgz -C /opt/claude-web --strip-components=1
cd /opt/claude-web
npm ci --omit=dev --ignore-scripts
# проверить, что SDK и его native CLI на месте:
node -e 'import("@anthropic-ai/claude-agent-sdk").then(m=>console.log(typeof m.query))'
test -x node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude && echo sdk-cli-ok
chown -R root:root /opt/claude-web
chmod -R go-w /opt/claude-web

# публичные install-ассеты отдаёт Caddy из /srv/claude-web/public
install -d -o root -g root -m 0755 /srv/claude-web/public
cp -a /opt/claude-web/pwa/public/. /srv/claude-web/public/
chown -R root:root /srv/claude-web/public
chmod -R a+rX,go-w /srv/claude-web/public
find /srv/claude-web/public -type f -exec chmod 0644 {} +
```

Если `--ignore-scripts` не поставил native-пакет — установить его осознанно
(`npm rebuild`/`npm ci` без `--ignore-scripts`), зафиксировав версию и проверив
контрольную сумму/lockfile. Не тянуть `latest`.

`/opt/claude-web` не должен быть writable для `claudeapp`: код читается, данные — в
`/var/lib/claude-web`, workspace — в `/srv/claude-web/workspaces`.

---

## 4. systemd-юнит

Создать `/etc/systemd/system/claude-web.service`:

```ini
[Unit]
Description=Claude Web UI (PWA) behind DSH auth gateway
Documentation=file:/opt/claude-web/README.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=claudeapp
Group=claudeapp
WorkingDirectory=/opt/claude-web
EnvironmentFile=/etc/claude-web/env
Environment=NODE_ENV=production
Environment=HOME=/var/lib/claude-web
Environment=CLAUDE_CONFIG_DIR=/var/lib/claude-web/claude-config
Environment=DISABLE_AUTOUPDATER=1
ExecStart=/usr/bin/node /opt/claude-web/server/index.mjs
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
KillSignal=SIGTERM
UMask=0077

# ── hardening ───────────────────────────────────────────────────────────────
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/claude-web /var/log/claude-web /srv/claude-web/workspaces
MemoryMax=1150M
MemoryHigh=950M
CPUQuota=150%
TasksMax=256

[Install]
WantedBy=multi-user.target
```

Примечания:

- `RestrictNamespaces=yes` **не** ставить, если планируется bwrap-песочница Bash.
- `IPAddressDeny` **не** ставить: приложению нужен egress к API Anthropic.
- `ProtectHome=yes` закрывает `/home` (включая `/home/dsh`); workspace — только `/srv`.
- `claudeapp` **не** входит в группу `caddy` и не читает `/etc/dsh-gateway-caddy`/логи Caddy.
- Приложение слушает только `127.0.0.1:3090`; сокета и `SupplementaryGroups=caddy` нет.

```bash
systemctl daemon-reload
systemctl enable --now claude-web
sleep 1
systemctl is-active claude-web
journalctl -u claude-web -n 50 --no-pager
ss -ltnp | grep -E ':3090\b'       # только 127.0.0.1:3090, не 0.0.0.0
stat -c '%a %U:%G %n' /etc/claude-web/env   # 600 root:root
```

---

## 5. Caddy: установка маршрута `/claude/*`

Caddyfile живой — `0640 root:caddy`; править только копию.

```bash
umask 077
TAG=$(cat /root/claude-pwa-backup-TAG)
cp -a /etc/dsh-gateway-caddy/Caddyfile /root/Caddyfile.$TAG
chmod 0600 /root/Caddyfile.$TAG
$EDITOR /root/Caddyfile.$TAG
```

Обе части — **внутрь существующего `route { ... }`**. Часть A — **ПОСЛЕ глобальных
header-директив `route`** (последний setter заголовка выигрывает; блок до глобального
`header` проверенно теряет `default-src 'self'` — см. §5.1). Часть B — после
`handle /internal/*` и **до** финального `handle { ... }` (catch-all). Если `route` нет —
сохранить структуру; `handle` вне `route` Caddy не примет. Точные фрагменты —

**A. ПОСЛЕ глобальных header-директив `route`** (`header { ... }` + возможные
`@matcher … header @matcher Content-Security-Policy …`, как `@nonAuthCsp` в текущем
конфиге гейтвея). Проверено на Caddy 2.11.9: в `route` для одного заголовка выигрывает
последний setter; блок, вставленный ДО глобального `header`, перетирается и `/claude/`
отдаёт CSP без `default-src 'self'` (приёмка §6 падает). `apply-caddy.py` ставит A
именно после глобальных header-директив и отказывается работать, если якорь не найден.

```caddyfile
header /claude/* {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
}
```

**B. После `handle /internal/*`, до финального `handle { ... }` (catch-all).**

```caddyfile
# ── Claude Web UI (/claude/) ─────────────────────────────────────────────
# 1) Origin-guard — ДО install-ветки и forward_auth; любой cross-origin, включая WS, → 403.
@claude_bad_origin {
    path /claude/*
    expression `{http.request.header.Origin} != '' && {http.request.header.Origin} != 'https://vps-4692.tailfbc4b2.ts.net:10000'`
}
respond @claude_bad_origin "forbidden" 403

# 2) Публичные install-ассеты: ровно 5 путей, только GET/HEAD, отдаёт Caddy.
@claude_install path /claude/manifest.webmanifest \
                  /claude/icons/icon-192.png \
                  /claude/icons/icon-512.png \
                  /claude/icons/icon-maskable-512.png \
                  /claude/icons/apple-touch-icon-180.png
handle @claude_install {
    @not_get not method GET HEAD
    respond @not_get "method not allowed" 405
    root * /srv/claude-web/public
    file_server
}

handle /claude {
    redir * /claude/ 308
}

# 3) Приватная часть: та же сессия, без cookie шлюза в app.
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

`<EDGE_SECRET>` — значение `EDGE_SECRET` из `/etc/claude-web/env` (32 байта hex). Не
печатать его в чат/лог; подставить в Caddyfile можно, например:

```bash
EDGE_SECRET=$(grep '^EDGE_SECRET=' /etc/claude-web/env | cut -d= -f2-)
test -n "$EDGE_SECRET"
# $EDITOR /tmp/Caddyfile.$TAG  → заменить <EDGE_SECRET> на значение
unset EDGE_SECRET
```

Проверить, что глобально уже есть вырезание клиентских trust-заголовков
(`request_header -X-Auth-*`, `-X-Forwarded-*`, `-X-Gateway-Client-IP`) и установка
`X-Gateway-Client-IP {client_ip}`. `header_up X-Claude-Edge` обязан **перезаписывать**
клиентское значение; приложение отклоняет запрос без правильного секрета.

Публичные файлы отдаёт Caddy (`file_server`) из `/srv/claude-web/public`; приложение
анонимных путей не имеет. Проверить права: каталоги `0755`, файлы `0644`, владелец
`root:root`; `claudeapp` не должен писать в `/srv/claude-web/public`.

### 5.1. Кэш и Content-Type для `/claude/*` (без этого PWA холодно стартует)

Глобальный `@pwa_no_store` Caddy ставит `Cache-Control: no-store, private` на всё, кроме
`/assets/` и `/plugins/??` DSH. Для `/claude/*` его нужно переопределить **после** него
(последний setter выигрывает), иначе бандлы не кэшируются, а у манифеста нет
`Content-Type`:

```caddyfile
	# в секции B, после глобального header/no-store, до handle-веток
	@claude_assets path /claude/assets/*
	header @claude_assets {
		>Cache-Control "public, max-age=86400, immutable"
	}
	@claude_manifest path /claude/manifest.webmanifest
	header @claude_manifest {
		>Cache-Control "no-cache"
		>Content-Type "application/manifest+json"
	}
	@claude_icons path /claude/icons/*
	header @claude_icons {
		>Cache-Control "public, max-age=86400"
		>Content-Type "image/png"
	}
	@claude_sw path /claude/sw.js
	header @claude_sw {
		>Cache-Control "no-store"
	}
```

`>` (force set) обязателен: без него заголовок от приложения и глобальный `no-store`
складываются, и эффективным остаётся `no-store`. HTML и API `/claude/*` остаются
`no-store`. Проверка в §6 — фактические заголовки `/claude/assets/*`,
`/claude/manifest.webmanifest`, `/claude/icons/*`, `/claude/sw.js`.

Валидация **до** установки:

```bash
umask 077
caddy validate --config /root/Caddyfile.$TAG --adapter caddyfile
# ожидается: Valid configuration
caddy adapt --config /root/Caddyfile.$TAG --adapter caddyfile --pretty > /root/Caddyfile.$TAG.json
chmod 0600 /root/Caddyfile.$TAG.json
# глазами проверить: /claude/* → forward_auth → 127.0.0.1:3090; install-handle выше catch-all
diff -u /etc/dsh-gateway-caddy/Caddyfile /root/Caddyfile.$TAG \
  | sed -E 's/(X-Claude-Edge[[:space:]]+).*/\1<redacted>/' || true
```

Установка и рестарт (окно обслуживания):

```bash
install -m 0640 -o root -g caddy /root/Caddyfile.$TAG /etc/dsh-gateway-caddy/Caddyfile
shred -u /root/Caddyfile.$TAG /root/Caddyfile.$TAG.json 2>/dev/null || rm -f /root/Caddyfile.$TAG /root/Caddyfile.$TAG.json
systemctl restart dsh-gateway-caddy
sleep 1
systemctl is-active dsh-gateway-caddy
journalctl -u dsh-gateway-caddy -n 50 --no-pager
```

`validate` **не** доказывает порядок маршрутов: перед окном прогнать тот же фрагмент на
локальном Caddy (высокий порт) с mock auth/upstream и проверить, что `/claude/` без cookie —
`401`, install-путь — `200`, а `/claude/` с валидной сессией не получает `502`.

**Если Caddy не стартовал** — немедленно §8 (restore + restart), не оставлять DSH без edge.

---

## 6. Проверки после установки

Без сессии (аноним):

```bash
for u in /claude/ /claude/sw.js /; do
  printf '%-18s ' "$u"
  curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC$u"
done
# 401 401 401

for u in /claude/manifest.webmanifest /claude/icons/icon-192.png /claude/icons/icon-512.png \
         /claude/icons/icon-maskable-512.png /claude/icons/apple-touch-icon-180.png; do
  printf '%-42s ' "$u"
  curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$PUBLIC$u"
done
# 200 + правильный content-type; без Set-Cookie
```

CSP не ослаблен (даже на 401 Caddy должен отдать свой `header /claude/*`):

```bash
curl -sI "$PUBLIC/claude/" | grep -i '^content-security-policy' | grep -q "default-src 'self'" \
  && echo csp-ok || echo CSP-MISSING
```

Подделка заголовка и прямой доступ к upstream не должны пускать:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Auth-User: deadbeef' "$PUBLIC/claude/"
# 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC/claude/manifest.webmanifest"
# 405
ss -ltnp | grep -E ':3090\b'        # только 127.0.0.1:3090
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3090/claude/
# 403 (нет X-Claude-Edge)
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Claude-Edge: wrong' -H 'X-Auth-User: deadbeef' \
  -H 'Host: vps-4692.tailfbc4b2.ts.net:10000' http://127.0.0.1:3090/claude/
# 403
```

С сессией (браузер): войти в `/auth/tg`, открыть `/claude/`, проверить:
сессии/чат/approve/deny/interrupt; установить PWA; истечение сессии.

DSH не сломан:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/"                    # 401
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/manifest.webmanifest" # 200 (DSH)
```

Логи без секретов:

```bash
journalctl -u claude-web -n 100 --no-pager | grep -iE 'token|sk-ant|__Host-dsh_session' && echo CHECK || echo clean
grep -iE 'token|sk-ant|__Host-dsh_session' /var/log/claude-web/audit.jsonl 2>/dev/null && echo CHECK || echo clean
# Caddy access log не должен содержать Set-Cookie (известная проблема аудита):
grep -cE 'Set-Cookie|__Host-dsh_session|X-Claude-Edge' /var/log/dsh-gateway/caddy-access.log 2>/dev/null || true
# если >0 — добавить в log.format.filter fields удаление request Cookie/Authorization/
# X-Claude-Edge и resp_headers>Set-Cookie, validate/restart, проверить новые записи.
```

Права:

```bash
stat -c '%a %U:%G %n' /etc/claude-web/env /var/log/claude-web/audit.jsonl \
  /srv/claude-web/public /srv/claude-web/public/claude/manifest.webmanifest
# 600 root:root; 600 claudeapp; 755 root:root; 644 root:root
```

---

## 7. bwrap / Power-режим — **не в MVP**

MVP работает только в safe-режиме без Bash; этот раздел — заметка на будущее.
Если Power когда-нибудь понадобится:

- ставить `bubblewrap` и проверять его **внутри** юнита с теми же свойствами
  (`systemd-run ... bwrap ...`), а не только из shell (AppArmor/userns могут отличаться);
- `bwrap --unshare-net` не закрывает AF_UNIX; общий UID и env-секрет делают Power
  небезопасным без отдельного control-plane/token-proxy;
- при отказе bwrap **не** включать `sandbox.enabled` (SDK `failIfUnavailable` уронит сессию)
  и не отключать AppArmor/userns-ограничения ради него.

---

## 8. Откат

Немедленный (Caddy):

```bash
TAG=$(cat /root/claude-pwa-backup-TAG)
install -m 0640 -o root -g caddy /root/claude-pwa-backup-$TAG/Caddyfile /etc/dsh-gateway-caddy/Caddyfile
caddy validate --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile
systemctl restart dsh-gateway-caddy
sleep 1
systemctl is-active dsh-gateway-caddy
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/"   # 401
```

Остановить приложение (если нужно):

```bash
systemctl disable --now claude-web
```

Проверить DSH:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/"
curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/manifest.webmanifest"
```

Данные/пользователя не удалять сразу: журналы и audit нужны для разбора. Удаление —
отдельным решением после инцидента.

---

## 9. Ротация и эксплуатация

- **Токен**: раз в год или при инциденте — новый `claude setup-token`, заменить
  `CLAUDE_CODE_OAUTH_TOKEN` в `/etc/claude-web/env`, `systemctl restart claude-web`.
  Старый токен отозвать в аккаунте Anthropic (если доступно).
- **Edge-секрет** (`X-Claude-Edge`): при подозрении на утечку заменить **в двух местах** —
  `/etc/claude-web/env` и Caddyfile — и перезапустить `claude-web` и `dsh-gateway-caddy`.
- **SDK**: обновление только с pin, `npm ci`, тесты, staging, затем деплой; SDK тянет
  CLI, поэтому это обновление рантайма.
- **Caddy**: любые правки — backup, validate, окно, restart, проверки; reload недоступен.
- **Мониторинг**: `systemctl status claude-web`, RSS (`systemctl status`/`ps`),
  `journalctl -u claude-web`, audit-файл, диск (`/var/lib/claude-web`), OOM в `dmesg`.
- **Kill switch**: `systemctl stop claude-web` (Caddy начнёт отдавать 502/503 на `/claude/`,
  DSH не затронут); при необходимости — restore Caddyfile.
- **Инцидент**: остановить сервис, сохранить audit/journal, отозвать токен, проверить
  сессии/устройства Claude, сменить пароль/TOTP шлюза при подозрении на компрометацию.

---

## 10. Чек-лист «не забыть»

- [ ] Бэкап Caddyfile + hash + unit + ports.
- [ ] `claudeapp` без группы `dsh`, без sudo; `/home/dsh` недоступен.
- [ ] Токен только в `/etc/claude-web/env` `0600 root:root`; не в git/логах/терминале.
- [ ] `/opt/claude-web` root-owned, не writable для `claudeapp`.
- [ ] Приложение слушает только `127.0.0.1:3090`; `X-Claude-Edge` проверяется; `claudeapp` не в группе caddy.
- [ ] Caddy: публичны только 5 install-ассетов (file_server); `/claude/sw.js` 401.
- [ ] Origin-guard стоит до install-ветки; CSP `default-src 'self'` в ответе /claude/.
- [ ] `header_up -Cookie`; app не видит `__Host-dsh_session`.
- [ ] `X-Auth-User` только после `/verify`; `X-Claude-Edge` проверяется constant-time.
- [ ] Safe-режим: Bash/WebFetch/WebSearch выключены; deny `/proc/**`, `/etc/claude-web/**`,
      `/var/lib/claude-web/**`, `/var/log/claude-web/**`.
- [ ] Workspace только `/srv/claude-web/workspaces`; realpath/prefix/симлинки проверены.
- [ ] PreToolUse-хук резолвит realpath и покрывает Read/Edit/Write/Grep/Glob; симлинк
      на `/proc/self/environ` и в `/var/lib/claude-web` → deny (тест).
- [ ] `/claude/` контролируется `/claude/sw.js`, а не root-SW DSH (проверить controller).
- [ ] DSH `/` 401, вход и WS работают; PWA-манифест DSH 200.
- [ ] Android: установка Claude (WebAPK) и standalone; если нет — зафиксировать.
- [ ] Откат отрепетирован.
