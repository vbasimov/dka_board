#!/usr/bin/env bash
# rollback.sh — откат Caddy-маршрута claude-web и (по флагу) остановка приложения.
#
# Выполняется root на VPS, в окне обслуживания (runbook §8). Источник —
# бэкап /root/claude-pwa-backup-<TAG>/Caddyfile, созданный apply-caddy.py
# --install (или вручную по runbook §0). Проверяет sha256 (если бэкап его
# сохранил) и caddy validate ДО установки: битый бэкап не ставится.
#
#   deploy/rollback.sh --tag 20261122-120000
#   deploy/rollback.sh --tag 20261122-120000 --stop-app
#   deploy/rollback.sh                      # TAG из /root/claude-pwa-backup-TAG
#
# Ничего не удаляет: бэкапы, данные и audit сохраняются для разбора.
set -euo pipefail
umask 077

LIVE_CONFIG=/etc/dsh-gateway-caddy/Caddyfile
GATEWAY_UNIT=dsh-gateway-caddy
APP_UNIT=claude-web
BACKUP_ROOT=/root
TAG_POINTER=/root/claude-pwa-backup-TAG
PUBLIC=${PUBLIC:-https://vps-4692.tailfbc4b2.ts.net:10000}
TAG=''
STOP_APP=0
NO_RESTART=0

info() { printf 'INFO: %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
rollback.sh — restore Caddyfile из /root/claude-pwa-backup-<TAG> (root).

  --tag TAG     метка бэкапа (по умолчанию из /root/claude-pwa-backup-TAG)
  --stop-app    после отката Caddy выполнить systemctl disable --now claude-web
  --no-restart  не перезапускать dsh-gateway-caddy (только файл + validate;
                НЕ применять на живом сервере без причины)
  --public URL  публичный origin для проверок DSH
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--tag) [[ $# -ge 2 ]] || die "--tag требует значение"; TAG=$2; shift 2 ;;
	--stop-app) STOP_APP=1; shift ;;
	--no-restart) NO_RESTART=1; shift ;;
	--public) [[ $# -ge 2 ]] || die "--public требует значение"; PUBLIC=$2; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) die "неизвестный аргумент: $1 (см. --help)" ;;
	esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "нужен root (runbook §8)"
[[ -f "$LIVE_CONFIG" ]] || die "нет живого Caddyfile: $LIVE_CONFIG"
command -v caddy >/dev/null 2>&1 || die "caddy не найден: откат без validate запрещён"
command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"

# ── TAG и бэкап ─────────────────────────────────────────────────────────────
if [[ -z "$TAG" ]]; then
	[[ -f "$TAG_POINTER" ]] || die "нет --tag и нет $TAG_POINTER"
	TAG=$(tr -d '[:space:]' <"$TAG_POINTER")
fi
[[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "недопустимый TAG: $TAG"
BACKUP_DIR="$BACKUP_ROOT/claude-pwa-backup-$TAG"
BACKUP_FILE="$BACKUP_DIR/Caddyfile"
[[ -f "$BACKUP_FILE" ]] || die "нет бэкапа: $BACKUP_FILE"
info "TAG=$TAG, источник: $BACKUP_FILE"

sha_file="$BACKUP_DIR/Caddyfile.sha256"
if [[ -f "$sha_file" ]]; then
	expected=$(awk 'NR==1 {print $1}' "$sha_file")
	actual=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
	[[ "$expected" == "$actual" ]] || die "sha256 бэкапа не совпадает (expected ${expected:0:16}…, actual ${actual:0:16}…)"
	pass "sha256 бэкапа совпадает"
else
	warn "в бэкапе нет Caddyfile.sha256: sha256 не сверяется"
fi

# ── validate ДО установки ───────────────────────────────────────────────────
umask 077
caddy validate --config "$BACKUP_FILE" --adapter caddyfile \
	|| die "caddy validate бэкапа провалился — откат отменён, живой Caddyfile не изменён"
pass "caddy validate бэкапа: Valid configuration"

CURRENT_SHA=$(sha256sum "$LIVE_CONFIG" | awk '{print $1}')
info "текущий живой Caddyfile sha256: ${CURRENT_SHA:0:16}…"

# ── установка (атомарно) ────────────────────────────────────────────────────
tmp_live="$LIVE_CONFIG.rollback-$$"
trap 'rm -f -- "$tmp_live"' EXIT
install -m 0640 -o root -g caddy "$BACKUP_FILE" "$tmp_live"
mv -f "$tmp_live" "$LIVE_CONFIG"
trap - EXIT
chown root:caddy "$LIVE_CONFIG"
chmod 0640 "$LIVE_CONFIG"
pass "установлен бэкап: $LIVE_CONFIG (0640 root:caddy)"

# ── restart + проверки ──────────────────────────────────────────────────────
if [[ $NO_RESTART -eq 1 ]]; then
	warn "--no-restart: dsh-gateway-caddy НЕ перезапущен (изменения не применены в рантайме)"
else
	systemctl restart "$GATEWAY_UNIT"
	sleep 1
	[[ "$(systemctl is-active "$GATEWAY_UNIT" 2>/dev/null || true)" == "active" ]] \
		|| {
			journalctl -u "$GATEWAY_UNIT" -n 50 --no-pager || true
			die "$GATEWAY_UNIT не active после откатанного restart"
		}
	pass "$GATEWAY_UNIT active"
fi

if command -v curl >/dev/null 2>&1; then
	code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$PUBLIC/" 2>/dev/null || printf '000')
	[[ "$code" == "401" ]] && pass "DSH $PUBLIC/ -> 401" || die "DSH $PUBLIC/ вернул $code (ожидался 401)"
	code=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' "$PUBLIC/manifest.webmanifest" 2>/dev/null || printf '000')
	[[ "$code" == "200" ]] && pass "DSH $PUBLIC/manifest.webmanifest -> 200" || die "DSH-манифест вернул $code (ожидался 200)"
else
	warn "curl недоступен: проверки DSH пропущены"
fi

# ── опционально: остановить приложение ──────────────────────────────────────
if [[ $STOP_APP -eq 1 ]]; then
	systemctl disable --now "$APP_UNIT"
	pass "$APP_UNIT disabled+stopped (kill switch)"
else
	info "$APP_UNIT не останавливался (для остановки: --stop-app)"
fi

info "данные/audit/бэкапы не удалялись; при инциденте сохраните journal+audit"
echo "TAG=$TAG"
echo "BACKUP_FILE=$BACKUP_FILE"
echo "RESULT=ok"
