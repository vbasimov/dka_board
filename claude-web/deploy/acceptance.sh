#!/usr/bin/env bash
# acceptance.sh — приёмка claude-web по runbook §6 / plan §12.
#
# Только чтение: GET/HEAD/POST к публичному origin и loopback, чтение логов и
# прав файлов. Ничего не меняет; exit 1 при любом FAIL.
#
# Использование:
#   deploy/acceptance.sh
#   deploy/acceptance.sh --public https://vps-4692.tailfbc4b2.ts.net:10000 \
#                        --app-port 3090 --env-file /etc/claude-web/env
#   deploy/acceptance.sh --deep            # + проверка с валидным X-Claude-Edge
#
# Параметры (env или флаги): PUBLIC, APP_PORT, ENV_FILE, BASE_PATH, CADDY_LOG.
set -euo pipefail

PUBLIC=${PUBLIC:-https://vps-4692.tailfbc4b2.ts.net:10000}
APP_HOST=${APP_HOST:-127.0.0.1}
APP_PORT=${APP_PORT:-3090}
ENV_FILE=${ENV_FILE:-/etc/claude-web/env}
BASE_PATH=${BASE_PATH:-/claude/}
CADDY_LOG=${CADDY_LOG:-/var/log/dsh-gateway/caddy-access.log}
TIMEOUT=${TIMEOUT:-10}
DEEP=0

usage() {
	cat <<'EOF'
acceptance.sh — проверки runbook §6 (read-only, exit 1 при провале).

  --public URL     публичный origin (default https://vps-4692.tailfbc4b2.ts.net:10000)
  --app-host HOST  loopback-хост приложения (default 127.0.0.1)
  --app-port PORT  порт приложения (default 3090)
  --env-file PATH  env-файл с EDGE_SECRET/ALLOWED_USER_HASH (для --deep)
  --base-path P    base path (default /claude/)
  --caddy-log PATH access-лог Caddy (default /var/log/dsh-gateway/caddy-access.log)
  --deep           дополнительно проверить приложение валидным X-Claude-Edge
                   (секрет читается только из env-файла и не попадает в argv)
  --timeout SEC    таймаут curl (default 10)
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--public) PUBLIC=$2; shift 2 ;;
	--app-host) APP_HOST=$2; shift 2 ;;
	--app-port) APP_PORT=$2; shift 2 ;;
	--env-file) ENV_FILE=$2; shift 2 ;;
	--base-path) BASE_PATH=$2; shift 2 ;;
	--caddy-log) CADDY_LOG=$2; shift 2 ;;
	--deep) DEEP=1; shift ;;
	--timeout) TIMEOUT=$2; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) printf 'FAIL: неизвестный аргумент %s (см. --help)\n' "$1" >&2; exit 1 ;;
	esac
done

[[ "$BASE_PATH" == */ ]] || BASE_PATH="$BASE_PATH/"
BASE="${PUBLIC%/}${BASE_PATH}"
APP_BASE="http://${APP_HOST}:${APP_PORT}${BASE_PATH}"

command -v curl >/dev/null 2>&1 || {
	printf 'FAIL: нет curl — приёмка невозможна\n' >&2
	exit 1
}

CHECKS=0
FAILS=0
FAILED_NAMES=()

pass() { CHECKS=$((CHECKS + 1)); printf 'PASS: %s\n' "$*"; }
fail() {
	CHECKS=$((CHECKS + 1))
	FAILS=$((FAILS + 1))
	FAILED_NAMES+=("$*")
	printf 'FAIL: %s\n' "$*" >&2
}
skip() { printf 'WARN/SKIP: %s\n' "$*" >&2; }

http_code() { # url [extra curl args...]
	local url=$1
	shift
	curl -sS -o /dev/null --max-time "$TIMEOUT" "$@" -w '%{http_code}' "$url" 2>/dev/null || printf '000'
}

http_meta() { # url [extra curl args...] -> "code|content_type|redirect_url"
	local url=$1
	shift
	curl -sS -o /dev/null --max-time "$TIMEOUT" "$@" \
		-w '%{http_code}|%{content_type}|%{redirect_url}' "$url" 2>/dev/null || printf '000||'
}

http_headers() { # url [extra curl args...]
	local url=$1
	shift
	curl -sSI --max-time "$TIMEOUT" "$@" "$url" 2>/dev/null || true
}

check_code() { # name expected actual
	local name=$1 expected=$2 actual=$3
	if [[ "$actual" == "$expected" ]]; then pass "$name -> $actual"; else fail "$name: ожидался $expected, получен $actual"; fi
}

echo "== claude-web acceptance =="
echo "PUBLIC=$PUBLIC"
echo "BASE=$BASE"
echo "APP_BASE=$APP_BASE"
echo

# ── 1. анонимный доступ ─────────────────────────────────────────────────────
check_code "аноним $BASE_PATH" 401 "$(http_code "$BASE")"
check_code "аноним ${BASE_PATH}sw.js" 401 "$(http_code "${BASE}sw.js")"

# ── 2. публичные install-ассеты ─────────────────────────────────────────────
check_asset() { # path expected_ctype expected_cache
	local path=$1 expected=$2 expected_cache=${3:-} meta code ctype hdrs cache_count
	meta=$(http_meta "$BASE$path")
	code=${meta%%|*}
	ctype=${meta#*|}
	ctype=${ctype%%|*}
	if [[ "$code" != "200" ]]; then
		fail "install-ассет /claude/$path: ожидался 200, получен $code"
		return
	fi
	if [[ "$ctype" != *"$expected"* ]]; then
		fail "install-ассет /claude/$path: content-type '$ctype' не содержит '$expected'"
		return
	fi
	hdrs=$(http_headers "$BASE$path" | tr -d '\r')
	if printf '%s\n' "$hdrs" | grep -qi '^set-cookie:'; then
		fail "install-ассет /claude/$path отдаёт Set-Cookie (должен быть без cookie)"
		return
	fi
	if [[ -n "$expected_cache" ]]; then
		cache_count=$(printf '%s\n' "$hdrs" | grep -ci '^cache-control:' || true)
		if [[ "${cache_count:-0}" != "1" ]]; then
			fail "install-ассет /claude/$path: Cache-Control должен быть один, найдено ${cache_count:-0}"
			return
		fi
		if ! printf '%s\n' "$hdrs" | grep -qi "^cache-control:.*${expected_cache}"; then
			fail "install-ассет /claude/$path: Cache-Control не содержит '$expected_cache'"
			return
		fi
	fi
	pass "install-ассет /claude/$path -> 200 $ctype (без Set-Cookie, Cache-Control='${expected_cache:-—}')"
}

check_asset "manifest.webmanifest" "application/manifest+json" "no-cache"
check_asset "icons/icon-192.png" "image/png" "public, max-age=86400"
check_asset "icons/icon-512.png" "image/png" "public, max-age=86400"
check_asset "icons/icon-maskable-512.png" "image/png" "public, max-age=86400"
check_asset "icons/apple-touch-icon-180.png" "image/png" "public, max-age=86400"

# ── 2b. 401 не должен получать кэшируемые заголовки (регрессия: immutable на 401) ──
check_401_no_cache() { # path
	local path=$1 code hdrs
	code=$(http_code "$PUBLIC$path")
	if [[ "$code" != "401" ]]; then
		fail "$path: ожидался 401 без сессии, получен $code"
		return
	fi
	hdrs=$(http_headers "$PUBLIC$path" | tr -d '\r')
	if printf '%s\n' "$hdrs" | grep -qi '^cache-control:.*immutable'; then
		fail "$path: 401 содержит immutable Cache-Control (401 нельзя кэшировать)"
		return
	fi
	if printf '%s\n' "$hdrs" | grep -qi '^content-type: *image/png'; then
		fail "$path: 401 содержит Content-Type image/png (приватный путь не должен типизироваться)"
		return
	fi
	pass "$path -> 401 без immutable/Content-Type-подмены"
}
check_401_no_cache "/claude/assets/app.js"
check_401_no_cache "/claude/sw.js"
check_401_no_cache "/claude/icons/favicon-96.png"
check_401_no_cache "/claude/"

# ── 3. CSP не ослаблен ──────────────────────────────────────────────────────
CLAUDE_HDRS=$(http_headers "$BASE" | tr -d '\r')
if printf '%s\n' "$CLAUDE_HDRS" | grep -qi "^content-security-policy:.*default-src 'self'"; then
	pass "CSP /claude/ содержит default-src 'self'"
else
	fail "CSP на /claude/ отсутствует или ослаблен (default-src 'self' не найден)"
fi
if printf '%s\n' "$CLAUDE_HDRS" | grep -qi '^cache-control:.*no-store'; then
	pass "/claude/ (HTML/API) отдаёт Cache-Control no-store"
else
	fail "/claude/ не отдаёт Cache-Control no-store"
fi

# ── 4. redirect без слеша ───────────────────────────────────────────────────
meta=$(http_meta "${PUBLIC%/}${BASE_PATH%/}")
code=${meta%%|*}
rest=${meta#*|}
ctype=${rest%%|*}
redirect=${rest#*|}
if [[ "$code" == "308" && "$redirect" == *"${BASE_PATH}" ]]; then
	pass "GET ${BASE_PATH%/} -> 308 на ${BASE_PATH} (redirect='$redirect')"
else
	fail "GET ${BASE_PATH%/}: ожидался 308 на ${BASE_PATH}, получен code=$code redirect='$redirect'"
fi

# ── 5. метод и спуфинг ──────────────────────────────────────────────────────
check_code "POST install-манифеста" 405 "$(http_code "$BASE"manifest.webmanifest -X POST)"
check_code "спуф X-Auth-User" 401 "$(http_code "$BASE" -H 'X-Auth-User: deadbeef')"
check_code "cross-origin Origin-guard" 403 "$(http_code "$BASE" -H 'Origin: https://evil.example')"
check_code "валидный Origin без сессии" 401 "$(http_code "$BASE" -H "Origin: ${PUBLIC%/}")"

# ── 6. loopback-приложение требует X-Claude-Edge/X-Auth-User ────────────────
check_code "127.0.0.1:$APP_PORT без X-Claude-Edge" 403 "$(http_code "$APP_BASE")"
check_code "127.0.0.1:$APP_PORT с чужим X-Auth-User" 403 \
	"$(http_code "$APP_BASE" -H 'X-Claude-Edge: wrong' -H 'X-Auth-User: deadbeef')"

# ── 7. 3090 только loopback ─────────────────────────────────────────────────
if command -v ss >/dev/null 2>&1; then
	listen=$(ss -ltn | awk 'NR>1 {print $4}')
	if printf '%s\n' "$listen" | grep -qE '^(0\.0\.0\.0|\*|\[::\]):'"$APP_PORT"'$'; then
		fail "порт $APP_PORT слушается не только loopback"
	elif printf '%s\n' "$listen" | grep -q "^127\.0\.0\.1:${APP_PORT}$"; then
		pass "порт $APP_PORT слушается только 127.0.0.1"
	else
		fail "порт $APP_PORT не слушается на 127.0.0.1"
	fi
else
	skip "ss недоступен: проверка loopback-порта пропущена"
fi

# ── 8. DSH не сломан ────────────────────────────────────────────────────────
check_code "DSH / (401)" 401 "$(http_code "$PUBLIC/")"
check_code "DSH /manifest.webmanifest" 200 "$(http_code "$PUBLIC/manifest.webmanifest")"

# ── 9. сервис active ────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
	if [[ "$(systemctl is-active claude-web 2>/dev/null || true)" == "active" ]]; then
		pass "systemd: claude-web active"
	else
		fail "systemd: claude-web не active"
	fi
else
	skip "systemctl недоступен: проверка юнита пропущена"
fi

# ── 10. логи без секретов/cookie ────────────────────────────────────────────
if command -v journalctl >/dev/null 2>&1; then
	if journalctl -u claude-web -n 200 --no-pager 2>/dev/null | grep -qE 'sk-ant-[A-Za-z0-9._-]+'; then
		fail "journal claude-web содержит OAuth-токен (sk-ant-...)"
	else
		pass "journal claude-web без sk-ant-токена"
	fi
else
	skip "journalctl недоступен: проверка journal пропущена"
fi

if [[ -r /var/log/claude-web/audit.jsonl ]]; then
	if grep -qE 'sk-ant-[A-Za-z0-9._-]+' /var/log/claude-web/audit.jsonl; then
		fail "audit.jsonl содержит OAuth-токен"
	else
		pass "audit.jsonl без sk-ant-токена"
	fi
else
	skip "audit.jsonl недоступен для чтения: проверка пропущена"
fi

if [[ -r "$CADDY_LOG" ]]; then
	count=$(grep -cE 'Set-Cookie|__Host-dsh_session|X-Claude-Edge' "$CADDY_LOG" 2>/dev/null || true)
	if [[ "${count:-0}" -gt 0 ]]; then
		fail "Caddy access log содержит Set-Cookie/сессию/X-Claude-Edge (${count} строк): нужен log-фильтр"
	else
		pass "Caddy access log без Set-Cookie/__Host-dsh_session/X-Claude-Edge"
	fi
else
	skip "Caddy access log недоступен ($CADDY_LOG): проверка пропущена"
fi

# ── 11. права ───────────────────────────────────────────────────────────────
stat_mode() { stat -c '%a %U:%G' "$1" 2>/dev/null || printf 'missing'; }
if [[ -f "$ENV_FILE" ]]; then
	[[ "$(stat_mode "$ENV_FILE")" == "600 root:root" ]] \
		&& pass "права $ENV_FILE: 600 root:root" \
		|| fail "права $ENV_FILE: $(stat_mode "$ENV_FILE"), ожидалось 600 root:root"
else
	fail "нет env-файла $ENV_FILE"
fi
for target in /srv/claude-web/public /srv/claude-web/public/claude/manifest.webmanifest; do
	if [[ -e "$target" ]]; then
		mode=$(stat -c '%a' "$target")
		owner=$(stat -c '%U:%G' "$target")
		if [[ "$target" == */public ]]; then
			[[ "$mode" == "755" && "$owner" == "root:root" ]] \
				&& pass "права $target: 755 root:root" \
				|| fail "права $target: $mode $owner, ожидалось 755 root:root"
		else
			[[ "$mode" == "644" && "$owner" == "root:root" ]] \
				&& pass "права $target: 644 root:root" \
				|| fail "права $target: $mode $owner, ожидалось 644 root:root"
		fi
	else
		fail "нет файла/каталога $target"
	fi
done

# ── 12. --deep: валидный edge-секрет (секрет не попадает в argv) ────────────
if [[ $DEEP -eq 1 ]]; then
	if [[ ! -r "$ENV_FILE" ]]; then
		skip "--deep: env-файл $ENV_FILE недоступен (нужен root)"
	else
		edge=''
		user=''
		while IFS= read -r line; do
			case "$line" in
			EDGE_SECRET=*) edge=${line#EDGE_SECRET=} ;;
			ALLOWED_USER_HASH=*) user=${line#ALLOWED_USER_HASH=} ;;
			esac
		done <"$ENV_FILE"
		if [[ ! "$edge" =~ ^[0-9a-fA-F]{64}$ || ! "$user" =~ ^[0-9a-f]{12}$ ]]; then
			fail "--deep: EDGE_SECRET/ALLOWED_USER_HASH в $ENV_FILE невалидны"
		else
			host_hdr=${PUBLIC#https://}
			host_hdr=${host_hdr%/}
			code=$(
				{
					printf 'header = "X-Claude-Edge: %s"\n' "$edge"
					printf 'header = "X-Auth-User: %s"\n' "$user"
					printf 'header = "Host: %s"\n' "$host_hdr"
				} | curl -sS --max-time "$TIMEOUT" --config - -o /dev/null \
					-w '%{http_code}' "${APP_BASE}api/health" 2>/dev/null || printf '000'
			)
			check_code "--deep /claude/api/health с валидным edge" 200 "$code"
			code=$(
				{
					printf 'header = "X-Claude-Edge: %s"\n' "$edge"
					printf 'header = "X-Auth-User: deadbeef"\n'
					printf 'header = "Host: %s"\n' "$host_hdr"
				} | curl -sS --max-time "$TIMEOUT" --config - -o /dev/null \
					-w '%{http_code}' "${APP_BASE}api/health" 2>/dev/null || printf '000'
			)
			check_code "--deep чужой X-Auth-User" 403 "$code"
			unset edge user
		fi
	fi
fi

# ── итог ────────────────────────────────────────────────────────────────────
echo
echo "SUMMARY: checks=$CHECKS failed=$FAILS"
if [[ $FAILS -gt 0 ]]; then
	printf 'FAILED: %s\n' "${FAILED_NAMES[*]:-}" >&2
	echo "RESULT=fail"
	exit 1
fi
echo "RESULT=ok"
