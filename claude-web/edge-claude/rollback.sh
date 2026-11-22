#!/usr/bin/env bash
# rollback.sh — снять второй edge-инстанс Claude (:8443 -> :8444).
#
# Делает ТОЛЬКО сервис: stop/disable юнита и удаление unit-файла
# /etc/systemd/system/claude-edge.service. Конфиг (/etc/claude-edge) и логи
# (/var/log/claude-edge) НЕ удаляются: их можно посмотреть после отката или
# поставить заново через install.sh.
#
# Публичный порт при этом остаётся открытым в Tailscale Funnel (:8443 -> мёртвый
# 127.0.0.1:8444). Если второй origin больше не нужен, выключить Funnel
# отдельно (после отката):
#     tailscale funnel --https=8443 off
# Тогда :8443 перестаёт отвечать снаружи; Claude остаётся доступным на
# основном origin https://vps-4692.tailfbc4b2.ts.net:10000/claude/.
#
# Идемпотентно: если юнита нет — ничего не падает.
#
# Использование:
#   sudo ./rollback.sh
#   sudo ./rollback.sh --help
set -euo pipefail

UNIT=claude-edge
UNIT_FILE=/etc/systemd/system/claude-edge.service
ETC=/etc/claude-edge
LOG_DIR=/var/log/claude-edge

info() { printf 'INFO: %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
rollback.sh — откат второго edge-инстанса Claude (root).

  Останавливает/дизейблит claude-edge.service и удаляет unit-файл.
  Конфиг /etc/claude-edge и логи /var/log/claude-edge сохраняются.
  Публичный Funnel :8443 выключается отдельно:
      tailscale funnel --https=8443 off

  -h, --help    эта справка.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help) usage; exit 0 ;;
	*) die "неизвестный аргумент: $1 (см. --help)" ;;
	esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "нужен root"
command -v systemctl >/dev/null 2>&1 || die "systemctl не найден"

# Останавливаем и убираем автозапуск (даже если юнит уже не active).
if systemctl cat "$UNIT" >/dev/null 2>&1 || [[ -f "$UNIT_FILE" ]]; then
	systemctl disable --now "$UNIT" 2>/dev/null || systemctl disable --now "$UNIT.service" 2>/dev/null || true
	rm -f -- "$UNIT_FILE"
	systemctl daemon-reload
	pass "сервис $UNIT остановлен, unit-файл удалён"
else
	info "сервис $UNIT не установлен — нечего останавливать"
fi

# Проверяем, что loopback-порт закрыт (если кто-то ещё держит 8444 — скажем).
if command -v ss >/dev/null 2>&1; then
	remaining=$(ss -ltnH "sport = :8444" 2>/dev/null | awk '{print $4}' | sort -u || true)
	if [[ -n "$remaining" ]]; then
		printf 'WARN: порт 8444 всё ещё слушается: %s\n' "$remaining" >&2
	else
		pass "127.0.0.1:8444 закрыт"
	fi
fi

[[ -f "$ETC/Caddyfile" ]] && info "конфиг сохранён: $ETC/Caddyfile"
[[ -d "$LOG_DIR" ]] && info "логи сохранены: $LOG_DIR"
printf 'INFO: публичный Funnel не трогали; выключить при необходимости:\n'
printf 'INFO:   tailscale funnel --https=8443 off\n'
printf 'RESULT=ok\n'
