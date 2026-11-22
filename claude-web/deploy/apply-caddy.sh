#!/usr/bin/env bash
# apply-caddy.sh — обёртка над apply-caddy.py (stdlib-only python3).
#
# По умолчанию --dry-run: пропатченная КОПИЯ живого Caddyfile в /tmp, diff с
# redaction секрета, caddy validate + caddy adapt. Живой файл/сервисы не трогаются.
#
#   deploy/apply-caddy.sh                      # dry-run
#   deploy/apply-caddy.sh --install --tag ...  # root: бэкап+установка+restart
#   deploy/apply-caddy.sh --rollback --tag ... # root: restore из бэкапа
#
# Реальный секрет в argv не передаётся: --install читает EDGE_SECRET из
# /etc/claude-web/env (0600 root:root) или из --secret-file.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
py="${PYTHON:-python3}"

if ! command -v "$py" >/dev/null 2>&1; then
	echo "FAIL: python3 не найден (нужен для apply-caddy.py)" >&2
	exit 1
fi
if [[ ! -f "$here/apply-caddy.py" ]]; then
	echo "FAIL: нет $here/apply-caddy.py" >&2
	exit 1
fi
if [[ ! -f "$here/Caddyfile.fragment" ]]; then
	echo "FAIL: нет $here/Caddyfile.fragment" >&2
	exit 1
fi

exec "$py" "$here/apply-caddy.py" "$@"
