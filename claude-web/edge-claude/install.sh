#!/usr/bin/env bash
# install.sh — идемпотентная root-установка ВТОРОГО edge-инстанса Claude
# (origin https://vps-4692.tailfbc4b2.ts.net:8443 -> 127.0.0.1:8444).
#
# Что делает (повторный запуск безопасен):
#   1) проверяет root, caddy, systemctl, пользователя caddy и env-файл
#      /etc/claude-web/env (0600 root:root); EDGE_SECRET обязан быть 64 hex,
#      иначе — fail-closed (ничего не меняем);
#   2) создаёт /etc/claude-edge (0750 root:caddy) и /var/log/claude-edge
#      (0750 caddy:caddy); кладёт README;
#   3) подставляет EDGE_SECRET из env в Caddyfile -> временный файл рядом,
#      caddy validate + caddy adapt (на временном файле), и только после
#      успеха атомарно ставит /etc/claude-edge/Caddyfile (0640 root:caddy);
#   4) ставит юнит claude-edge.service, daemon-reload, enable + restart;
#   5) проверяет: active; слушает ТОЛЬКО 127.0.0.1:8444; права конфига/лога;
#      аноним /claude/ -> 401 + полный CSP; manifest -> 200
#      application/manifest+json + no-cache; icon -> 200 image/png +
#      public,max-age=86400; POST manifest -> 405; чужой Origin -> 403;
#      / -> 302 на :10000; /claude -> 308; в access-логе нет cookie/
#      Set-Cookie/X-Claude-Edge/query/секрета.
#
# Чего НЕ делает: не открывает публичный порт (это Tailscale Funnel, см.
# README), не трогает Caddy auth-гейтвея, приложение, env-файл, xray и
# существующие systemd-юниты. Секрет не печатается (только PASS/FAIL).
#
# Использование:
#   sudo ./install.sh
#   sudo ./install.sh --help
set -euo pipefail
umask 077

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ETC=/etc/claude-edge
CFG=$ETC/Caddyfile
README=$ETC/README.md
LOG_DIR=/var/log/claude-edge
UNIT=/etc/systemd/system/claude-edge.service
UNIT_SRC=$SRC_DIR/systemd/claude-edge.service
ENV_FILE=/etc/claude-web/env
CADDY=/usr/bin/caddy
PUBLIC_ORIGIN=https://vps-4692.tailfbc4b2.ts.net:10000
LOOPBACK=http://127.0.0.1:8444
FUNNEL_HOST=vps-4692.tailfbc4b2.ts.net:8443

info() { printf 'INFO: %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
install.sh — root-установка второго edge-инстанса Claude (:8443 -> :8444).

  -h, --help    эта справка.

Требования: root, /usr/bin/caddy, systemd, пользователь caddy,
/etc/claude-web/env (0600 root:root) с EDGE_SECRET ровно 64 hex.
Публичный вход открывает Tailscale Funnel отдельно (см. README.md).
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help) usage; exit 0 ;;
	*) die "неизвестный аргумент: $1 (см. --help)" ;;
	esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "нужен root"
[[ -x "$CADDY" ]] || die "не найден $CADDY (нужен пакет caddy; unit использует именно /usr/bin/caddy)"
command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"
command -v curl >/dev/null 2>&1 || die "curl не найден (нужен для post-checks)"
command -v ss >/dev/null 2>&1 || die "ss не найден (iproute2; нужен для проверки слушателя)"
[[ -f "$SRC_DIR/Caddyfile" ]] || die "нет $SRC_DIR/Caddyfile"
[[ -f "$UNIT_SRC" ]] || die "нет $UNIT_SRC"
getent passwd caddy >/dev/null 2>&1 || die "нет пользователя caddy (нужен для User=caddy)"
getent group caddy >/dev/null 2>&1 || die "нет группы caddy"

# ── 0. env-файл и EDGE_SECRET: fail-closed ДО любых изменений ──────────────
[[ -f "$ENV_FILE" ]] || die "нет $ENV_FILE (создаёт Lead; EDGE_SECRET 64 hex, 0600 root:root)"
env_stat=$(stat -c '%a %U:%G' "$ENV_FILE")
[[ "$env_stat" == "600 root:root" ]] \
	|| die "$ENV_FILE должен быть 0600 root:root, сейчас: $env_stat"
grep -Eq '^EDGE_SECRET=[0-9a-fA-F]{64}$' "$ENV_FILE" \
	|| die "в $ENV_FILE нет валидного EDGE_SECRET (ровно 64 hex) — установка остановлена"
EDGE_SECRET=$(awk -F= '/^EDGE_SECRET=/{print $2; exit}' "$ENV_FILE")
[[ "$EDGE_SECRET" =~ ^[0-9a-fA-F]{64}$ ]] || die "EDGE_SECRET не 64 hex — установка остановлена"
pass "env-файл: 0600 root:root, EDGE_SECRET 64 hex (значение не печатается)"

TMP_CONFIG=''
cleanup() {
	set +e
	[[ -n "$TMP_CONFIG" && -f "$TMP_CONFIG" ]] && rm -f -- "$TMP_CONFIG"
	unset EDGE_SECRET
}
trap cleanup EXIT

# ── 1. каталоги и права ────────────────────────────────────────────────────
install -d -o root -g caddy -m 0750 "$ETC"
install -d -o caddy -g caddy -m 0750 "$LOG_DIR"
# access.log создаём заранее и отдаём caddy: `caddy validate` при провижининге
# может открыть/создать файл лога от root — тогда сервис под caddy не смог бы
# писать. Существующий лог не обрезаем.
LOG_FILE=$LOG_DIR/access.log
[[ -e "$LOG_FILE" ]] || install -o caddy -g caddy -m 0640 /dev/null "$LOG_FILE"
chown caddy:caddy "$LOG_FILE"
chmod 0640 "$LOG_FILE"
pass "каталоги: $ETC 0750 root:caddy, $LOG_DIR 0750 caddy:caddy (+ access.log caddy:caddy)"

# ── 2. Caddyfile: подстановка секрета, validate/adapt на временном файле ──
# Считаем только рабочие вхождения: комментарии с плейсхолдером (документация) не в счёт.
placeholder_lines=$(grep '__EDGE_SECRET__' "$SRC_DIR/Caddyfile" | grep -vc '^[[:space:]]*#' || true)
[[ "$placeholder_lines" -eq 2 ]] \
	|| die "в шаблоне Caddyfile ожидалось 2 строки с __EDGE_SECRET__, найдено: $placeholder_lines"

TMP_CONFIG="$ETC/Caddyfile.new.$$"
sed "s/__EDGE_SECRET__/${EDGE_SECRET}/g" "$SRC_DIR/Caddyfile" >"$TMP_CONFIG"
chown root:caddy "$TMP_CONFIG"
chmod 0640 "$TMP_CONFIG"

grep -q '__EDGE_SECRET__' "$TMP_CONFIG" && die "в staged-конфиге остался плейсхолдер"
[[ $(grep -c "header_up X-Claude-Edge ${EDGE_SECRET}" "$TMP_CONFIG") -eq 2 ]] \
	|| die "X-Claude-Edge подставлен не в обе proxy-ветки"
[[ $(grep -cF "$EDGE_SECRET" "$TMP_CONFIG") -eq 2 ]] \
	|| die "секрет встречается в конфиге не ровно 2 раза"
pass "секрет подставлен в обе proxy-ветки (значение не печатается)"

"$CADDY" validate --config "$TMP_CONFIG" --adapter caddyfile \
	|| die "caddy validate staged-конфига провалился — живой конфиг НЕ изменён"
pass "caddy validate: Valid configuration"
"$CADDY" adapt --config "$TMP_CONFIG" --adapter caddyfile >/dev/null \
	|| die "caddy adapt staged-конфига провалился — живой конфиг НЕ изменён"
pass "caddy adapt: exit 0"

# Атомарная подмена (оба файла в одном каталоге, mv атомарен).
mv -f -- "$TMP_CONFIG" "$CFG"
TMP_CONFIG=''
chown root:caddy "$CFG"
chmod 0640 "$CFG"
install -m 0644 -o root -g root "$SRC_DIR/README.md" "$README" 2>/dev/null \
	|| warn "README.md не найден рядом — пропускаю установку документации"
pass "установлен $CFG (0640 root:caddy)"

# ── 3. юнит, запуск ────────────────────────────────────────────────────────
install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT"
pass "установлен $UNIT"
systemctl daemon-reload
systemctl enable claude-edge >/dev/null
if ! systemctl restart claude-edge; then
	set +e
	journalctl -u claude-edge -n 30 --no-pager >&2
	die "claude-edge не запустился (journal выше)"
fi
sleep 1
systemctl is-active --quiet claude-edge || {
	set +e
	journalctl -u claude-edge -n 30 --no-pager >&2
	die "claude-edge не active"
}
pass "claude-edge: active + enabled"

# ── 4. post-checks ─────────────────────────────────────────────────────────
# 4a. Слушатель: только 127.0.0.1:8444 (никаких 0.0.0.0/[::]/*).
addrs=$(ss -ltnH "sport = :8444" 2>/dev/null | awk '{print $4}' | sort -u)
[[ -n "$addrs" ]] || die "127.0.0.1:8444 никто не слушает"
while IFS= read -r addr; do
	[[ "$addr" == "127.0.0.1:8444" ]] || die "слушатель не только loopback: $addr"
done <<<"$addrs"
pass "слушает только 127.0.0.1:8444"

# 4b. Права.
cfg_stat=$(stat -c '%a %U:%G' "$CFG")
[[ "$cfg_stat" == "640 root:caddy" ]] || die "$CFG должен быть 0640 root:caddy, сейчас: $cfg_stat"
log_stat=$(stat -c '%a %U:%G' "$LOG_DIR")
[[ "$log_stat" == "750 caddy:caddy" ]] || die "$LOG_DIR должен быть 0750 caddy:caddy, сейчас: $log_stat"
grep -q '__EDGE_SECRET__' "$CFG" && die "в живом конфиге остался плейсхолдер"
pass "права: конфиг 0640 root:caddy, лог-каталог 0750 caddy:caddy"

# Вспомогательные функции не должны ронять скрипт молча под set -e/pipefail:
# отсутствие curl-соединения/заголовка — это FAIL ниже с понятным сообщением.
http_code() { curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }
http_type() { curl -sS --max-time 5 -o /dev/null -w '%{content_type}' "$@" 2>/dev/null || true; }
header_of() {
	curl -sS --max-time 5 -D - -o /dev/null "$@" 2>/dev/null \
		| tr -d '\r' \
		| awk -v h="$1" 'index(tolower($0), tolower(h) ":") == 1 { print; exit }' || true
}

# 4c. Аноним /claude/ -> 401 + полный CSP.
code=$(http_code "$LOOPBACK/claude/")
[[ "$code" == "401" ]] || die "аноним /claude/ должен быть 401, получено: $code"
csp=$(header_of 'content-security-policy' "$LOOPBACK/claude/")
printf '%s' "$csp" | grep -q "default-src 'self'" \
	|| die "в 401 на /claude/ нет полного CSP (default-src 'self')"
pass "аноним /claude/ -> 401 + CSP default-src 'self'"

# 4d. manifest -> 200 application/manifest+json + no-cache.
code=$(http_code "$LOOPBACK/claude/manifest.webmanifest")
ctype=$(http_type "$LOOPBACK/claude/manifest.webmanifest")
[[ "$code" == "200" ]] || die "manifest должен быть 200, получено: $code"
[[ "$ctype" == application/manifest+json* ]] || die "manifest Content-Type: $ctype"
cache=$(header_of 'cache-control' "$LOOPBACK/claude/manifest.webmanifest")
printf '%s' "$cache" | grep -q 'no-cache' || die "manifest Cache-Control: ${cache:-нет}"
pass "manifest: 200 application/manifest+json, Cache-Control no-cache"

# 4e. icon -> 200 image/png + public,max-age=86400.
code=$(http_code "$LOOPBACK/claude/icons/icon-192.png")
ctype=$(http_type "$LOOPBACK/claude/icons/icon-192.png")
[[ "$code" == "200" ]] || die "icon должен быть 200, получено: $code"
[[ "$ctype" == image/png* ]] || die "icon Content-Type: $ctype"
cache=$(header_of 'cache-control' "$LOOPBACK/claude/icons/icon-192.png")
printf '%s' "$cache" | grep -q 'max-age=86400' || die "icon Cache-Control: ${cache:-нет}"
pass "icon: 200 image/png, Cache-Control public,max-age=86400"

# 4f. POST manifest -> 405; у 405 нет image/manifest Content-Type.
code=$(http_code -X POST "$LOOPBACK/claude/manifest.webmanifest")
[[ "$code" == "405" ]] || die "POST manifest должен быть 405, получено: $code"
pass "POST manifest -> 405"

# 4g. Origin-guard: чужой -> 403, свой (:8443) -> дальше (401), пустой -> 401.
bad=$(http_code -H "Host: $FUNNEL_HOST" -H 'Origin: https://evil.example' "$LOOPBACK/claude/")
[[ "$bad" == "403" ]] || die "чужой Origin должен быть 403, получено: $bad"
good=$(http_code -H "Host: $FUNNEL_HOST" -H 'Origin: https://vps-4692.tailfbc4b2.ts.net:8443' "$LOOPBACK/claude/")
[[ "$good" == "401" ]] || die "Origin :8443 должен пропускаться до forward_auth (401), получено: $good"
old=$(http_code -H "Host: $FUNNEL_HOST" -H 'Origin: https://vps-4692.tailfbc4b2.ts.net:10000' "$LOOPBACK/claude/")
[[ "$old" == "401" ]] || die "Origin :10000 должен пропускаться до forward_auth (401), получено: $old"
pass "Origin-guard: чужой 403, :8443/:10000 -> 401 (до forward_auth)"

# 4h. /claude -> 308; / -> 302 на :10000.
code=$(http_code "$LOOPBACK/claude")
location=$(header_of 'location' "$LOOPBACK/claude")
[[ "$code" == "308" ]] || die "/claude должен быть 308, получено: $code"
printf '%s' "$location" | grep -q '/claude/' || die "/claude Location: ${location:-нет}"
code=$(http_code "$LOOPBACK/")
location=$(header_of 'location' "$LOOPBACK/")
[[ "$code" == "302" ]] || die "/ должен быть 302, получено: $code"
printf '%s' "$location" | grep -qx "Location: $PUBLIC_ORIGIN/" \
	|| die "/ Location должен быть $PUBLIC_ORIGIN/, получено: ${location:-нет}"
pass "/claude -> 308, / -> 302 на $PUBLIC_ORIGIN/"

# 4i. Лог: JSON, без query/cookie/Set-Cookie/X-Claude-Edge/секрета.
#     Сначала провоцируем запись с query и cookie.
http_code -H 'Cookie: __Host-dsh_session=INSTALL_LOGTEST_COOKIE' \
	"$LOOPBACK/healthz?probe=INSTALL_LOGTEST_QUERY" >/dev/null || true
sleep 1
[[ -s "$LOG_FILE" ]] || die "access-лог пуст/отсутствует: $LOG_FILE"
head -n1 "$LOG_FILE" | grep -q '^{' || die "access-лог не JSON"
for needle in INSTALL_LOGTEST_QUERY INSTALL_LOGTEST_COOKIE '__Host-dsh_session' 'Set-Cookie' 'X-Claude-Edge'; do
	if grep -qF -- "$needle" "$LOG_FILE"; then
		die "в access-логе найдено «$needle» — фильтры лога не работают"
	fi
done
if grep -qF -- "$EDGE_SECRET" "$LOG_FILE"; then
	die "в access-логе найден EDGE_SECRET — фильтры лога не работают"
fi
if journalctl -u claude-edge --since '-2 min' -o cat 2>/dev/null | grep -qF -- "$EDGE_SECRET"; then
	die "в journal найдена подстрока секрета"
fi
pass "access-лог: JSON, без query/cookie/Set-Cookie/X-Claude-Edge/секрета"

printf 'RESULT=ok\n'
printf 'INFO: публичный вход открывает и закрывает Tailscale Funnel (см. README.md):\n'
printf 'INFO:   tailscale funnel --bg --yes --https=8443 http://127.0.0.1:8444\n'
printf 'INFO:   tailscale funnel --https=8443 off\n'
