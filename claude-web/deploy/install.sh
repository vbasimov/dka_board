#!/usr/bin/env bash
# install.sh — идемпотентная root-установка claude-web (runbook §1, §3, §4).
#
# Что делает (повторный запуск безопасен):
#   1) проверяет root, node и env-файл /etc/claude-web/env (0600 root:root);
#   2) создаёт системного пользователя claudeapp (nologin, без групп dsh/sudo/
#      admin/wheel/docker/caddy) и каталоги/права runbook §1;
#   3) разворачивает артефакт (tar.gz или каталог) в /opt/claude-web, проверяя
#      наличие server/index.mjs и web/dist и безопасность путей tar;
#   4) npm ci --omit=dev --ignore-scripts, проверка @anthropic-ai/claude-agent-sdk
#      и native CLI node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude;
#      chown root:root + chmod a+rX,go-w (код читается, но не пишется claudeapp);
#   5) копирует web/dist/claude/* -> /srv/claude-web/public/claude/* (root:root,
#      файлы 0644, каталоги 0755) и проверяет 5 публичных install-ассетов;
#   6) ставит systemd-юнит, daemon-reload, enable + restart, проверяет:
#      active, 127.0.0.1:3090 (только loopback), права env, отсутствие токена
#      в journal.
#
# Чего НЕ делает: не создаёт /etc/claude-web/env (это Lead, runbook §2; здесь
# только проверка наличия/прав), не трогает Caddy (deploy/apply-caddy.sh), не
# удаляет данные. Destructive-очистка /opt — только с явными --fresh --yes и
# только для APP=/opt/claude-web.
#
# Использование:
#   sudo deploy/install.sh --artifact /root/claude-web-<TAG>.tgz
#   sudo deploy/install.sh --artifact /tmp/claude-web-build   # каталог
#   sudo deploy/install.sh                                    # повтор без артефакта
#   sudo deploy/install.sh --artifact ... --fresh --yes       # полная замена /opt
set -euo pipefail
umask 077

APP=/opt/claude-web
DATA=/var/lib/claude-web
WS=/srv/claude-web/workspaces
PUB=/srv/claude-web/public
ETC=/etc/claude-web
ENV_FILE=$ETC/env
APP_USER=claudeapp
NODE_BIN=/usr/bin/node
UNIT_DST=/etc/systemd/system/claude-web.service
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-web.service"

ARTIFACT=''
FRESH=0
YES=0
SKIP_NPM=0

info() { printf 'INFO: %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
install.sh — root-установка claude-web (идемпотентно).

  --artifact PATH   tar.gz или каталог сборки (server/index.mjs, web/dist).
                    Без флага — использовать уже установленный /opt/claude-web.
  --fresh           перед копированием очистить /opt/claude-web (требует --yes).
  --yes             подтверждение destructive-шага --fresh.
  --skip-npm        не запускать npm ci (артефакт уже с node_modules; не рекомендуется).
  --node PATH       путь к node (по умолчанию /usr/bin/node).
  -h, --help        эта справка.

env-файл /etc/claude-web/env (0600 root:root) создаёт Lead по runbook §2;
без него установка останавливается.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--artifact) [[ $# -ge 2 ]] || die "--artifact требует путь"; ARTIFACT=$2; shift 2 ;;
	--fresh) FRESH=1; shift ;;
	--yes) YES=1; shift ;;
	--skip-npm) SKIP_NPM=1; shift ;;
	--node) [[ $# -ge 2 ]] || die "--node требует путь"; NODE_BIN=$2; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) die "неизвестный аргумент: $1 (см. --help)" ;;
	esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "нужен root (запускать по runbook §1-§4)"
[[ "$APP" == /opt/claude-web ]] || die "внутренняя ошибка: APP=$APP"
[[ -x "$NODE_BIN" ]] || die "node не найден/не исполняемый: $NODE_BIN (укажите --node)"
command -v npm >/dev/null 2>&1 || die "npm не найден в PATH (нужен для npm ci)"
command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"
[[ -f "$UNIT_SRC" ]] || die "нет файла юнита: $UNIT_SRC"

# ── 0. env-файл: только проверка (создаёт Lead, runbook §2) ─────────────────
if [[ ! -f "$ENV_FILE" ]]; then
	die "нет $ENV_FILE — его создаёт Lead по runbook §2 (EDGE_SECRET 64 hex, ALLOWED_USER_HASH 12 hex, CLAUDE_CODE_OAUTH_TOKEN) с правами 0600 root:root"
fi
env_stat=$(stat -c '%a %U:%G' "$ENV_FILE")
[[ "$env_stat" == "600 root:root" ]] || die "$ENV_FILE должен быть 0600 root:root, сейчас: $env_stat"
grep -Eq '^EDGE_SECRET=[0-9a-fA-F]{64}$' "$ENV_FILE" || die "в $ENV_FILE нет валидного EDGE_SECRET (64 hex)"
grep -Eq '^ALLOWED_USER_HASH=[0-9a-f]{12}$' "$ENV_FILE" || die "в $ENV_FILE нет валидного ALLOWED_USER_HASH (12 hex)"
grep -Eq '^CLAUDE_CODE_OAUTH_TOKEN=.+' "$ENV_FILE" || die "в $ENV_FILE нет CLAUDE_CODE_OAUTH_TOKEN"
grep -Eq '^HOST=127\.0\.0\.1$' "$ENV_FILE" || warn "в $ENV_FILE HOST не 127.0.0.1 (приложение fail-closed)"
grep -Eq '^PORT=3090$' "$ENV_FILE" || warn "в $ENV_FILE PORT не 3090"
pass "env-файл $ENV_FILE: 0600 root:root, обязательные переменные на месте"

# ── 1. пользователь и каталоги (runbook §1) ─────────────────────────────────
if ! getent passwd "$APP_USER" >/dev/null 2>&1; then
	useradd --system --home-dir "$DATA" --create-home \
		--shell /usr/sbin/nologin "$APP_USER"
	pass "создан системный пользователь $APP_USER"
else
	pass "пользователь $APP_USER уже существует"
fi
groups=$(id -nG "$APP_USER")
for bad in dsh sudo admin wheel docker caddy; do
	if printf ' %s ' "$groups" | grep -qw "$bad"; then
		die "$APP_USER входит в запрещённую группу '$bad' ($groups)"
	fi
done
pass "$APP_USER не входит в dsh/sudo/admin/wheel/docker/caddy"

install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA/claude-config"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 /var/log/claude-web
install -d -o root -g root -m 0751 /srv/claude-web
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$WS"
install -d -o root -g root -m 0755 "$PUB"
install -d -o root -g root -m 0750 "$ETC"
install -d -o root -g root -m 0755 "$APP"
pass "каталоги и права runbook §1 выставлены"

# ── 2. артефакт -> /opt/claude-web ──────────────────────────────────────────
STAGE=''
LIST=''
cleanup() {
	if [[ -n "$LIST" && -f "$LIST" ]]; then rm -f -- "$LIST"; fi
	if [[ -n "$STAGE" && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
}
trap cleanup EXIT

SRC=''
if [[ -n "$ARTIFACT" ]]; then
	[[ -e "$ARTIFACT" ]] || die "артефакт не найден: $ARTIFACT"
	if [[ -d "$ARTIFACT" ]]; then
		SRC=$ARTIFACT
	elif [[ -f "$ARTIFACT" ]]; then
		STAGE=$(mktemp -d /root/claude-web-stage.XXXXXX)
		LIST=$(mktemp /root/claude-web-tar-list.XXXXXX)
		tar -tzf "$ARTIFACT" >"$LIST"
		if grep -Eq '(^/|(^|/)\.\.(/|$))' "$LIST"; then
			die "в tar небезопасные пути (абсолютные или '..'): $ARTIFACT"
		fi
		tar -xzf "$ARTIFACT" -C "$STAGE" --no-same-owner --no-same-permissions
		SRC=$STAGE
		pass "артефакт распакован во временный каталог (пути проверены)"
	else
		die "артефакт не является файлом/каталогом: $ARTIFACT"
	fi
	[[ -f "$SRC/server/index.mjs" ]] || die "в артефакте нет server/index.mjs"
	[[ -d "$SRC/web/dist" ]] || die "в артефакте нет web/dist"
	[[ -f "$SRC/package.json" ]] || die "в артефакте нет package.json"

	if [[ $FRESH -eq 1 ]]; then
		[[ $YES -eq 1 ]] || die "--fresh удаляет содержимое $APP; подтвердите --yes"
		find "$APP" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
		warn "содержимое $APP очищено (--fresh --yes)"
	fi
	cp -a "$SRC/." "$APP/"
	pass "код развёрнут в $APP"
else
	[[ -f "$APP/server/index.mjs" ]] || die "нет --artifact и в $APP нет server/index.mjs"
	info "артефакт не указан: использую уже установленный $APP"
fi

# ── 3. зависимости и native CLI SDK (runbook §3) ────────────────────────────
cd "$APP"
[[ -f package-lock.json ]] || die "в $APP нет package-lock.json (нужен для npm ci)"
if [[ $SKIP_NPM -eq 1 ]]; then
	warn "npm ci пропущен (--skip-npm): проверяю только уже установленное"
else
	(umask 022 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
	pass "npm ci --omit=dev --ignore-scripts выполнен"
fi
"$NODE_BIN" -e 'import("@anthropic-ai/claude-agent-sdk").then((m)=>{if(typeof m.query!=="function")process.exit(1)}).catch(()=>process.exit(1))' \
	|| die "SDK @anthropic-ai/claude-agent-sdk не импортируется"
pass "SDK импортируется, query() доступен"
NATIVE_CLI="$APP/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
[[ -x "$NATIVE_CLI" ]] || die "нет native CLI $NATIVE_CLI (--ignore-scripts мог его не поставить: npm rebuild, зафиксировать версию по lockfile)"
pass "native CLI SDK на месте и исполняемый"

chown -R root:root "$APP"
chmod -R a+rX,go-w "$APP"
pass "$APP: root:root, код доступен чтением, не writable для claudeapp"

# ── 4. публичные install-ассеты для Caddy file_server ───────────────────────
[[ -d "$APP/web/dist/claude" ]] || die "нет $APP/web/dist/claude (соберите web через npm run build)"
cp -a "$APP/web/dist/claude/." "$PUB/claude/"
chown -R root:root "$PUB"
chmod -R a+rX,go-w "$PUB"
find "$PUB" -type f -exec chmod 0644 {} +
find "$PUB" -type d -exec chmod 0755 {} +
for asset in \
	claude/manifest.webmanifest \
	claude/icons/icon-192.png \
	claude/icons/icon-512.png \
	claude/icons/icon-maskable-512.png \
	claude/icons/apple-touch-icon-180.png; do
	[[ -f "$PUB/$asset" ]] || die "нет публичного install-ассета $PUB/$asset"
done
pass "публичные install-ассеты скопированы в $PUB/claude (root:root 0644/0755)"

# ── 5. systemd-юнит и запуск (runbook §4) ───────────────────────────────────
install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable claude-web >/dev/null
systemctl restart claude-web
sleep 1
systemctl is-active --quiet claude-web || {
	journalctl -u claude-web -n 50 --no-pager || true
	die "claude-web не active после запуска (см. journal выше)"
}
pass "claude-web active (unit установлен из $UNIT_SRC)"

# ── 6. проверки ─────────────────────────────────────────────────────────────
listen=$(ss -ltn | awk 'NR>1 {print $4}')
if printf '%s\n' "$listen" | grep -qE '^(0\.0\.0\.0|\*|\[::\]):3090$'; then
	die "3090 слушается не только loopback: $(printf '%s\n' "$listen" | grep ':3090' || true)"
fi
printf '%s\n' "$listen" | grep -q '^127\.0\.0\.1:3090$' \
	|| die "приложение не слушает 127.0.0.1:3090"
pass "3090 слушается только на 127.0.0.1"

env_stat=$(stat -c '%a %U:%G' "$ENV_FILE")
[[ "$env_stat" == "600 root:root" ]] || die "env-файл изменил права: $env_stat"
pass "env-файл по-прежнему 0600 root:root"

if journalctl -u claude-web -n 200 --no-pager 2>/dev/null | grep -qE 'sk-ant-[A-Za-z0-9._-]+'; then
	die "в journal claude-web найден OAuth-токен (sk-ant-...) — остановитесь и разберитесь"
fi
pass "в journal claude-web нет sk-ant-токена"

if command -v runuser >/dev/null 2>&1 && runuser -u "$APP_USER" -- test -r /home/dsh 2>/dev/null; then
	warn "$APP_USER может читать /home/dsh — проверьте ProtectHome/права"
else
	pass "/home/dsh недоступен для $APP_USER (или runuser отсутствует)"
fi

stat -c '%a %U:%G %n' "$DATA" "$DATA/claude-config" /var/log/claude-web \
	/srv/claude-web "$WS" "$PUB" "$ENV_FILE" 2>/dev/null || true

echo "RESULT=ok"
info "дальше: deploy/apply-caddy.sh --dry-run, затем приёмка deploy/acceptance.sh"
