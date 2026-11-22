#!/usr/bin/env python3
"""apply-caddy.py — вставка claude-web фрагмента в КОПИЮ живого Caddyfile.

Источник требований: docs/claude-pwa-runbook.md §5 (фрагмент, вставка, validate,
установка, откат) и §8 (откат). Используется из deploy/apply-caddy.sh; вручную
запускает только Lead/root.

Режимы (взаимоисключающие):
  --dry-run   (по умолчанию) вставка в копию, diff с redaction секрета,
              caddy validate + caddy adapt (если caddy доступен). Живой файл и
              сервисы не трогаются; результат пишется в /tmp/<tag>/.
              Реальный секрет в dry-run НЕ подставляется: валидируется структура
              с плейсхолдером __EDGE_SECRET__ (синтаксически эквивалентно).
  --install   требует root: бэкап /root/claude-pwa-backup-<TAG>/, правка копии,
              validate+adapt (fail-closed), атомарная установка 0640 root:caddy,
              restart dsh-gateway-caddy, проверки; при провале — автоматический
              restore бэкапа и повторный restart. EDGE_SECRET читается из
              /etc/claude-web/env (или --secret-file), в argv не принимается.
  --rollback  требует root: restore /root/claude-pwa-backup-<TAG>/Caddyfile,
              проверка sha256 (если есть), validate, атомарная установка,
              restart, проверки DSH.

Фрагмент вставляется ТОЛЬКО внутрь существующего route { ... }:
  • A (CSP) — ПОСЛЕ всех глобальных header-директив route (иначе глобальный
    header перетирает CSP; проверено на Caddy 2.11.9), но ДО @pwa_no_store/
    request_header/handle-веток;
  • B (маршрут /claude/* + кэш/Content-Type статики) — после
    "handle /internal/*", ДО финального handle {.
Дополнительно (runbook §6, проверка лога): в log > format filter > fields
добавляется "request>headers>X-Claude-Edge delete", иначе секрет Caddy↔app
попадает в access-лог. Отключается --no-patch-log.

Гарантии:
  * отказ при ненайденном/неоднозначном якоре (не «правим наугад»);
  * повторный запуск идемпотентен (маркеры вставок не дублируются);
  * если фрагмент уже установлен, но отличается от текущего (обновление
    артефактов) — помеченные секции A/B заменяются на актуальные;
  * при --install без успешного validate/adapt живой файл не меняется;
  * секрет никогда не печатается в stdout/stderr (redaction 64-hex в diff).
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

LIVE_CONFIG = Path("/etc/dsh-gateway-caddy/Caddyfile")
GATEWAY_UNIT = "dsh-gateway-caddy"
APP_UNIT = "claude-web"
BACKUP_PREFIX = "claude-pwa-backup-"
BACKUP_ROOT = Path("/root")
TAG_POINTER = Path("/root/claude-pwa-backup-TAG")
PUBLIC_ORIGIN = "https://vps-4692.tailfbc4b2.ts.net:10000"
APP_UPSTREAM = "127.0.0.1:3090"
AUTH_UPSTREAM = "127.0.0.1:9090"
PUBLIC_ROOT = "/srv/claude-web/public"
DEFAULT_ENV_FILE = "/etc/claude-web/env"
SECRET_PLACEHOLDER = "__EDGE_SECRET__"
DEFAULT_FRAGMENT = Path(__file__).resolve().with_name("Caddyfile.fragment")
LOG_EDGE_DELETE = "request>headers>X-Claude-Edge delete"

HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")
HEX64_ANY = re.compile(r"\b[0-9a-fA-F]{64}\b")
MARK_BEGIN = "# >>> claude-web:fragment:{key}:begin >>>"
MARK_END = "# <<< claude-web:fragment:{key}:end <<<"
RE_BEGIN = re.compile(r"^# >>> claude-web:fragment:(A|B|C):begin >>>$")
RE_END = re.compile(r"^# <<< claude-web:fragment:(A|B|C):end <<<$")


class Fail(Exception):
    """Ожидаемая ошибка: печатается как FAIL и даёт exit 1."""


# ── вывод ────────────────────────────────────────────────────────────────────


def info(msg: str) -> None:
    print(f"INFO: {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"PASS: {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"WARN: {msg}", flush=True)


def redact(text: str, secret: str | None) -> str:
    """Убирает из текста реальный секрет, плейсхолдер и любые 64-hex значения."""
    if secret:
        text = text.replace(secret, "<redacted>")
    text = text.replace(SECRET_PLACEHOLDER, "<EDGE_SECRET>")
    return HEX64_ANY.sub("<redacted>", text)


# ── текстовые утилиты ───────────────────────────────────────────────────────


def indent_of(line: str) -> str:
    stripped = line.lstrip(" \t")
    return line[: len(line) - len(stripped)]


def code_only(line: str) -> str:
    """Убирает комментарии и содержимое строк/бэктиков: так считаются скобки.

    Caddyfile-строки в кавычках и бэктиках могут содержать { } (например,
    expression с плейсхолдерами) — их нельзя считать структурой блоков.
    """
    out: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch in ("`", '"'):
            quote = ch
            i += 1
            while i < n and line[i] != quote:
                if line[i] == "\\" and quote == '"':
                    i += 1
                i += 1
            i += 1
            out.append(" ")
            continue
        if ch == "#":
            break
        out.append(ch)
        i += 1
    return "".join(out)


def find_block_end(lines: list[str], start: int) -> int:
    """Индекс строки с закрывающей скобкой блока, открытого в lines[start]."""
    depth = 0
    for i in range(start, len(lines)):
        code = code_only(lines[i])
        depth += code.count("{") - code.count("}")
        if depth <= 0 and i > start:
            return i
    raise Fail(f"не найден конец блока, открытого на строке {start + 1}")


def read_lines(path: Path, what: str) -> list[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        raise Fail(f"{what} не найден: {path}") from None
    except OSError as exc:
        raise Fail(f"не читается {what} ({path}): {exc}") from None


def write_private(path: Path, text: str, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, mode)


def shred(path: Path) -> None:
    if not path.exists():
        return
    shred_bin = shutil.which("shred")
    if shred_bin:
        subprocess.run([shred_bin, "-u", "--", str(path)], capture_output=True, check=False)
    else:
        try:
            path.unlink()
        except OSError:
            pass


# ── фрагмент ────────────────────────────────────────────────────────────────


def parse_fragment(path: Path) -> dict[str, list[str]]:
    if not path.is_file():
        raise Fail(f"файл фрагмента не найден: {path}")
    lines = read_lines(path, "файл фрагмента")
    sections: dict[str, list[str]] = {"A": [], "B": [], "C": []}
    current: str | None = None
    for line in lines:
        begin = RE_BEGIN.match(line)
        if begin:
            if current is not None:
                raise Fail(f"вложенный маркер в фрагменте: {line}")
            current = begin.group(1)
            continue
        end = RE_END.match(line)
        if end:
            if current != end.group(1):
                raise Fail(f"несогласованный маркер в фрагменте: {line}")
            current = None
            continue
        if current is not None:
            sections[current].append(line)
    if current is not None:
        raise Fail("незакрытая секция фрагмента")
    for key in ("A", "B"):
        if not any(line.strip() for line in sections[key]):
            raise Fail(f"секция {key} фрагмента пуста или отсутствует")
    text = "\n".join(lines)
    if SECRET_PLACEHOLDER not in text:
        raise Fail("во фрагменте нет плейсхолдера __EDGE_SECRET__")
    if HEX64_ANY.search(text):
        raise Fail("во фрагменте найден 64-hex секрет — допускается только __EDGE_SECRET__")
    return sections


def render_section(lines: list[str], dst_indent: str, secret: str | None) -> list[str]:
    base = ""
    for line in lines:
        if line.strip():
            base = indent_of(line)
            break
    out: list[str] = []
    for line in lines:
        if not line.strip():
            out.append("")
            continue
        body = line[len(base):] if base and line.startswith(base) else line
        if secret:
            body = body.replace(SECRET_PLACEHOLDER, secret)
        out.append(dst_indent + body)
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    return out


def detect_applied(lines: list[str]) -> bool:
    text = "\n".join(lines)
    present = {key: (MARK_BEGIN.format(key=key) in text) for key in ("A", "B")}
    if any(present.values()):
        if not all(present.values()):
            raise Fail(
                "Caddyfile применён частично (есть не все маркеры фрагмента) — "
                "автоматическая правка опасна, нужен ручной разбор"
            )
        return True
    if "@claude_install" in text or "@claude_bad_origin" in text:
        raise Fail(
            "в Caddyfile уже есть блоки /claude, но без маркеров apply-caddy.py — "
            "ручной разбор, чтобы не вставить дубликат"
        )
    return False


# ── поиск якорей ────────────────────────────────────────────────────────────


def locate_route(lines: list[str]) -> tuple[int, int]:
    """Находит ВНЕШНИЙ route { ... } (фрагмент вставляет свой вложенный route)."""
    found = [i for i, line in enumerate(lines) if line.strip() == "route {"]
    if not found:
        raise Fail(
            "якорь 'route {' не найден: ожидается существующий route { ... } "
            "auth-шлюза DSH (runbook §5); handle вне route Caddy не примет"
        )
    # Вложенный route { } (фрагмент claude-web) имеет больший отступ: внешний —
    # на минимальном отступе среди всех route {.
    min_indent = min(len(indent_of(lines[i])) for i in found)
    top_level = [i for i in found if len(indent_of(lines[i])) == min_indent]
    if len(top_level) > 1:
        raise Fail(
            f"якорь 'route {{' неоднозначен: найдено {len(top_level)} route на "
            f"минимальном отступе (строки "
            f"{', '.join(str(i + 1) for i in top_level)}) — нужен ровно один внешний"
        )
    idx = top_level[0]
    return idx, find_block_end(lines, idx)


def child_indent(lines: list[str], route_idx: int) -> str:
    route_indent = indent_of(lines[route_idx])
    for line in lines[route_idx + 1:]:
        if line.strip():
            indent = indent_of(line)
            if len(indent) > len(route_indent):
                return indent
            break
    return route_indent + "\t"


def locate_catch_all(
    lines: list[str], route_idx: int, route_end: int, dst_indent: str
) -> int:
    candidates = [
        i
        for i in range(route_idx + 1, route_end)
        if lines[i].strip() == "handle {" and indent_of(lines[i]) == dst_indent
    ]
    if not candidates:
        raise Fail(
            "якорь 'handle {' (финальный catch-all) не найден внутри route — "
            "фрагмент B некуда вставлять (runbook §5)"
        )
    if len(candidates) > 1:
        raise Fail(
            "якорь 'handle {' неоднозначен: найдено "
            f"{len(candidates)} catch-all-кандидатов (строки "
            f"{', '.join(str(i + 1) for i in candidates)}); нужен ровно один"
        )
    idx = candidates[0]
    block = "\n".join(lines[idx: find_block_end(lines, idx) + 1])
    if "forward_auth" not in block and "reverse_proxy" not in block:
        raise Fail(
            "найденный 'handle {' не похож на финальный catch-all "
            "(внутри нет forward_auth/reverse_proxy) — проверьте Caddyfile"
        )
    return idx


def locate_log_fields(lines: list[str]) -> tuple[int, int, str]:
    log_idxs = [i for i, line in enumerate(lines) if line.strip() == "log {"]
    if len(log_idxs) != 1:
        raise Fail(
            "не найден однозначный блок 'log {' для патча фильтра "
            f"(найдено {len(log_idxs)}) — секрет попадёт в access-лог; "
            "используйте --no-patch-log только осознанно"
        )
    log_idx = log_idxs[0]
    log_end = find_block_end(lines, log_idx)
    fields_idxs = [
        i for i in range(log_idx + 1, log_end) if lines[i].strip() == "fields {"
    ]
    if len(fields_idxs) != 1:
        raise Fail(
            "не найден однозначный блок 'fields {' в log > format filter "
            f"(найдено {len(fields_idxs)}) — нельзя добавить удаление X-Claude-Edge"
        )
    fields_idx = fields_idxs[0]
    fields_end = find_block_end(lines, fields_idx)
    fields_child = indent_of(lines[fields_idx]) + "\t"
    for line in lines[fields_idx + 1: fields_end]:
        if line.strip():
            fields_child = indent_of(line)
            break
    return fields_idx, fields_end, fields_child


# ── сборка пропатченного Caddyfile ──────────────────────────────────────────

def find_global_header_anchor(
    lines: list[str], route_idx: int, route_end: int, dst_indent: str
) -> tuple[int, list[str]]:
    """Индекс строки, ПОСЛЕ которой вставляется секция A (CSP для /claude/*).

    Эмпирически на Caddy 2.11.9: header, исполняемый ПОЗЖЕ, перетирает CSP
    (последний setter выигрывает). Поэтому CSP-блок claude-web обязан идти
    после глобальных header-директив route, но до остальных директив
    (@pwa_no_store/request_header/handle).

    Глобальная header-группа = блок `header { ... }` на уровне route плюс все
    последующие CSP-header-директивы, в том числе с матчерами вида
    `@nonAuthCsp not path /tg /auth/*` + `header @nonAuthCsp
    Content-Security-Policy "..."`. Директивы header БЕЗ CSP (например
    `header @pwa_no_store Cache-Control ...`) остаются позже вставки.

    Возвращает (anchor_idx, report). Fail-closed, если якоря нет/неоднозначны.
    """
    report: list[str] = []
    header_blocks = [
        i
        for i in range(route_idx + 1, route_end)
        if lines[i].strip() == "header {" and indent_of(lines[i]) == dst_indent
    ]
    if not header_blocks:
        raise Fail(
            "якорь 'header {' (глобальные заголовки route) не найден — CSP-блок "
            "claude-web ставить некуда: без него глобальный header перетрёт CSP"
        )
    if len(header_blocks) > 1:
        raise Fail(
            "якорь 'header {' неоднозначен: найдено "
            f"{len(header_blocks)} блока на уровне route "
            f"(строки {', '.join(str(i + 1) for i in header_blocks)}) — нужен ровно один"
        )
    block_idx = header_blocks[0]
    block_end = find_block_end(lines, block_idx)
    anchor = block_end
    has_csp = "Content-Security-Policy" in "\n".join(lines[block_idx:block_end + 1])
    report.append(
        f"глобальный 'header {{' найден: строки {block_idx + 1}-{block_end + 1}"
    )

    def next_meaningful(start: int) -> int | None:
        for j in range(start, route_end):
            stripped = lines[j].strip()
            if not stripped or stripped.startswith("#"):
                continue
            return j
        return None

    i = block_end + 1
    while True:
        idx = next_meaningful(i)
        if idx is None or indent_of(lines[idx]) != dst_indent:
            break
        stripped = lines[idx].strip()
        if stripped.startswith("@"):
            matcher_end = find_block_end(lines, idx) if stripped.endswith("{") else idx
            hdr = next_meaningful(matcher_end + 1)
            if hdr is None or indent_of(lines[hdr]) != dst_indent:
                break
            hdr_line = lines[hdr].strip()
            if not (
                hdr_line.startswith("header ")  # header <matcher> ...
                and "Content-Security-Policy" in hdr_line
            ):
                break
            hdr_end = find_block_end(lines, hdr) if hdr_line.endswith("{") else hdr
            anchor = hdr_end
            has_csp = True
            report.append(
                f"CSP-header с матчером '{stripped.split()[0]}' найден: строка {hdr_end + 1}"
            )
            i = hdr_end + 1
            continue
        if (
            (stripped == "header" or stripped.startswith("header "))
            and "Content-Security-Policy" in stripped
        ):
            hdr_end = find_block_end(lines, idx) if stripped.endswith("{") else idx
            anchor = hdr_end
            has_csp = True
            report.append(f"глобальный CSP-header найден: строка {hdr_end + 1}")
            i = hdr_end + 1
            continue
        break

    if not has_csp:
        raise Fail(
            "в route нет глобального Content-Security-Policy (ни внутри 'header { }', "
            "ни отдельной header-директивой) — CSP-блок claude-web перетрётся или "
            "якорь не найден (fail-closed)"
        )
    return anchor, report




def build_patch(
    lines: list[str],
    sections: dict[str, list[str]],
    secret: str | None,
    patch_log: bool,
) -> tuple[list[str], list[str], bool]:
    """Возвращает (новые строки, отчёт PASS, были ли изменения)."""
    report: list[str] = []
    route_idx, route_end = locate_route(lines)
    report.append(f"'route {{' найден: строка {route_idx + 1}")
    dst_indent = child_indent(lines, route_idx)
    catch_idx = locate_catch_all(lines, route_idx, route_end, dst_indent)
    report.append(f"финальный 'handle {{' (catch-all) найден: строка {catch_idx + 1}")
    header_anchor_idx, _header_report = find_global_header_anchor(
        lines, route_idx, route_end, dst_indent
    )

    applied = detect_applied(lines)
    inserts: list[tuple[int, list[str]]] = []
    replacements: dict[int, tuple[int, list[str]]] = {}

    if applied:
        # Фрагмент уже установлен. Если он отличается от текущего (обновление
        # артефактов) — заменяем помеченные секции целиком, не дублируя маркеры.
        changed_sections: list[str] = []
        for key, section in (("A", sections["A"]), ("B", sections["B"])):
            begin_line = dst_indent + MARK_BEGIN.format(key=key)
            end_line = dst_indent + MARK_END.format(key=key)
            begin_idxs = [i for i, line in enumerate(lines) if line.strip() == begin_line.strip()]
            end_idxs = [i for i, line in enumerate(lines) if line.strip() == end_line.strip()]
            if len(begin_idxs) != 1 or len(end_idxs) != 1 or begin_idxs[0] > end_idxs[0]:
                raise Fail(
                    f"некорректные маркеры секции {key} в Caddyfile — нужен ручной разбор"
                )
            begin_idx, end_idx = begin_idxs[0], end_idxs[0]
            new_block = (
                [begin_line] + render_section(section, dst_indent, secret) + [end_line]
            )
            if lines[begin_idx:end_idx + 1] != new_block:
                replacements[begin_idx] = (end_idx, new_block)
                changed_sections.append(key)
        if changed_sections:
            report.append(
                "фрагмент уже установлен, но отличается от текущего — обновляю секции "
                + ", ".join(changed_sections)
            )
        else:
            report.append(
                "фрагмент A/B уже применён и совпадает с текущим — правка не нужна"
            )
    else:
        section_a = render_section(sections["A"], dst_indent, secret)
        section_b = render_section(sections["B"], dst_indent, secret)
        inserts.append(
            (
                header_anchor_idx + 1,
                [dst_indent + MARK_BEGIN.format(key="A")]
                + section_a
                + [dst_indent + MARK_END.format(key="A")],
            )
        )
        inserts.append(
            (
                catch_idx,
                [dst_indent + MARK_BEGIN.format(key="B")]
                + section_b
                + [dst_indent + MARK_END.format(key="B")],
            )
        )
        report.append(
            "секция A (CSP) будет вставлена после глобальных header-директив "
            f"(после строки {header_anchor_idx + 1})"
        )
        report.append(f"секция B будет вставлена перед строкой {catch_idx + 1}")

    log_patched = False
    if patch_log:
        if LOG_EDGE_DELETE in "\n".join(lines):
            report.append("log-фильтр уже удаляет X-Claude-Edge — патч лога не нужен")
        else:
            fields_idx, fields_end, fields_child = locate_log_fields(lines)
            block = [
                fields_child + MARK_BEGIN.format(key="C"),
                fields_child
                + "# удаление секрета Caddy↔app из access-лога (runbook §6)",
                fields_child + LOG_EDGE_DELETE,
                fields_child + MARK_END.format(key="C"),
            ]
            inserts.append((fields_end, block))
            log_patched = True
            report.append(
                f"log-фильтр: добавлено '{LOG_EDGE_DELETE}' "
                f"(перед строкой {fields_end + 1})"
            )

    patched: list[str] = []
    inserts.sort(key=lambda item: item[0])
    pending = list(inserts)
    replaced_until = -1
    for i, line in enumerate(lines):
        if i <= replaced_until:
            continue
        if i in replacements:
            end_idx, new_block = replacements[i]
            patched.extend(new_block)
            replaced_until = end_idx
            continue
        while pending and pending[0][0] == i:
            patched.extend(pending.pop(0)[1])
        patched.append(line)
    while pending:
        patched.extend(pending.pop(0)[1])

    verify_patch(patched, dst_indent, secret, report)
    changed = patched != lines
    return patched, report, changed


def verify_patch(
    lines: list[str],
    dst_indent: str,
    secret: str | None,
    report: list[str],
) -> None:
    """Структурные инварианты результата (не заменяет caddy validate)."""

    def check(cond: bool, msg: str) -> None:
        if not cond:
            raise Fail(f"структурная проверка не прошла: {msg}")
        report.append(msg)

    text = "\n".join(lines)
    route_idxs = [i for i, line in enumerate(lines) if line.strip() == "route {"]
    min_route_indent = min(len(indent_of(lines[i])) for i in route_idxs) if route_idxs else 0
    top_routes = [i for i in route_idxs if len(indent_of(lines[i])) == min_route_indent]
    check(len(top_routes) == 1, "в Caddyfile ровно один внешний 'route {'")
    route_idx = top_routes[0]
    route_end = find_block_end(lines, route_idx)

    for key in ("A", "B"):
        check(
            text.count(MARK_BEGIN.format(key=key)) == 1,
            f"маркер начала секции {key} встречается ровно один раз",
        )
        check(
            text.count(MARK_END.format(key=key)) == 1,
            f"маркер конца секции {key} встречается ровно один раз",
        )

    def idx_of(predicate, what: str, start: int = 0, end: int | None = None) -> int:
        end = len(lines) if end is None else end
        found = [i for i in range(start, end) if predicate(lines[i])]
        if len(found) != 1:
            raise Fail(f"в результате ожидался ровно один {what}, найдено {len(found)}")
        return found[0]

    csp_idx = idx_of(
        lambda line: line.strip().startswith("header /claude/*")
        and indent_of(line) == dst_indent,
        "'header /claude/*'",
        route_idx + 1,
        route_end,
    )
    check(
        "default-src 'self'; script-src 'self'" in lines[csp_idx + 1],
        "CSP из runbook §5 присутствует (default-src/script-src 'self')",
    )
    # CSP обязан идти ПОСЛЕ всех глобальных header-директив (Caddy 2.11.9:
    # последний setter выигрывает; проверено эмпирически Lead'ом).
    header_anchor_idx, _header_report = find_global_header_anchor(
        lines, route_idx, route_end, dst_indent
    )
    check(
        csp_idx > header_anchor_idx,
        "CSP-блок стоит ПОСЛЕ глобальных header-директив (иначе перетирается)",
    )
    between = [
        lines[i].strip() for i in range(header_anchor_idx + 1, csp_idx)
    ]
    check(
        all(not item or item.startswith("#") for item in between),
        "CSP-блок идёт непосредственно после глобальных header-директив",
    )
    csp_block_end = find_block_end(lines, csp_idx)
    later_global_csp = [
        i
        for i in range(csp_block_end + 1, route_end)
        if indent_of(lines[i]) == dst_indent
        and (lines[i].strip() == "header" or lines[i].strip().startswith("header "))
        and "Content-Security-Policy" in lines[i]
    ]
    check(
        not later_global_csp,
        "после CSP-блока нет глобальных CSP-header (никто его не перетирает)",
    )
    later_meaningful = [
        i
        for i in range(csp_block_end + 1, route_end)
        if lines[i].strip()
        and not lines[i].strip().startswith("#")
        and indent_of(lines[i]) == dst_indent
    ]
    if later_meaningful:
        check(
            later_meaningful[0] > csp_block_end,
            "CSP-блок стоит ДО остальных директив route (@pwa_no_store/request_header/handle)",
        )
        report.append(
            f"CSP-блок стоит перед директивой: {lines[later_meaningful[0]].strip()[:80]}"
        )

    origin_idx = idx_of(
        lambda line: line.strip().startswith("@claude_bad_origin"),
        "матичер '@claude_bad_origin'",
        route_idx + 1,
        route_end,
    )
    check(
        "respond @claude_bad_origin \"forbidden\" 403" in [line.strip() for line in lines]
        or any(line.strip().startswith("respond @claude_bad_origin") for line in lines),
        "Origin-guard отвечает 403",
    )
    origin_window = "\n".join(lines[origin_idx: origin_idx + 4])
    check(
        PUBLIC_ORIGIN in origin_window
        and "{http.request.header.Origin}" in origin_window,
        f"Origin-guard сравнивает {{{{http.request.header.Origin}}}} с {PUBLIC_ORIGIN}",
    )
    install_idx = idx_of(
        lambda line: line.strip().startswith("@claude_install path"),
        "матичер '@claude_install'",
        route_idx + 1,
        route_end,
    )
    check(origin_idx < install_idx, "Origin-guard стоит ДО install-ветки")
    check(
        lines[install_idx].count("/claude/") >= 1 and "sw.js" not in lines[install_idx],
        "install-матичер не содержит sw.js",
    )
    check(
        "/claude/manifest.webmanifest" in lines[install_idx],
        "install-матичер содержит manifest.webmanifest",
    )
    for asset in (
        "/claude/icons/icon-192.png",
        "/claude/icons/icon-512.png",
        "/claude/icons/icon-maskable-512.png",
        "/claude/icons/apple-touch-icon-180.png",
    ):
        check(asset in "\n".join(lines[install_idx: install_idx + 6]), f"install-путь {asset}")

    # В живом Caddyfile уже есть другие file_server (/vendor/...), поэтому
    # проверяем именно блок install, а не глобальную уникальность директивы.
    install_handle_idx = idx_of(
        lambda line: line.strip() == "handle @claude_install {"
        and indent_of(line) == dst_indent,
        "'handle @claude_install {'",
        route_idx + 1,
        route_end,
    )
    install_block = "\n".join(
        lines[install_handle_idx: find_block_end(lines, install_handle_idx) + 1]
    )
    check("file_server" in install_block, "install-ветка отдаёт file_server")
    check(f"root * {PUBLIC_ROOT}" in install_block, f"file_server отдаёт из {PUBLIC_ROOT}")
    check(
        'respond @not_get "method not allowed" 405' in install_block,
        "install-ветка отдаёт 405 на не-GET/HEAD",
    )
    check("@not_get not method GET HEAD" in install_block, "install-ветка только GET/HEAD")

    # ── кэш/Content-Type статики /claude/* ────────────────────────────────
    # (a) /claude/sw.js — deferred no-store на уровне route (безопасно для
    # любого статуса: no-store и так глобальный для /claude/*).
    sw_matcher_idx = idx_of(
        lambda line: line.strip() == "@claude_sw path /claude/sw.js"
        and indent_of(line) == dst_indent,
        "матичер '@claude_sw'",
        route_idx + 1,
        route_end,
    )
    sw_header_idx = idx_of(
        lambda line: line.strip() == 'header @claude_sw >Cache-Control "no-store"'
        and indent_of(line) == dst_indent,
        "header @claude_sw no-store",
        route_idx + 1,
        route_end,
    )
    check(sw_matcher_idx < sw_header_idx, "sw.js: матичер до deferred no-store")
    check(
        "Service-Worker-Allowed" not in text,
        "нет Service-Worker-Allowed (scope SW только /claude/)",
    )

    # (b) публичные manifest/icons: header ВНУТРИ handle @claude_install, после
    # respond 405 и до root/file_server (405/401 не получают cache/type).
    install_handle_end = find_block_end(lines, install_handle_idx)
    resp405_idx = idx_of(
        lambda line: line.strip() == 'respond @not_get "method not allowed" 405',
        "respond 405 в install-ветке",
        install_handle_idx,
        install_handle_end,
    )
    public_rules = {
        "@claude_manifest": (
            "path /claude/manifest.webmanifest",
            ['header @claude_manifest Cache-Control "no-cache"',
             'header @claude_manifest Content-Type "application/manifest+json"'],
        ),
        "@claude_icons": (
            "path /claude/icons/*",
            ['header @claude_icons Cache-Control "public, max-age=86400"',
             'header @claude_icons Content-Type "image/png"'],
        ),
    }
    for matcher, (matcher_def, header_ops) in public_rules.items():
        matcher_idx = idx_of(
            lambda line, m=matcher, d=matcher_def: line.strip() == f"{m} {d}"
            and indent_of(line) != dst_indent,
            f"матичер '{matcher}' внутри install-ветки",
            install_handle_idx,
            install_handle_end,
        )
        check(matcher_idx > resp405_idx, f"{matcher}: матичер после respond 405")
        for op in header_ops:
            op_idx = idx_of(
                lambda line, o=op: line.strip() == o,
                f"правило '{op}'",
                install_handle_idx,
                install_handle_end,
            )
            check(op_idx > matcher_idx, f"{op}: после матичера")
            check(op_idx < install_handle_end, f"{op}: внутри install-ветки")
    root_idx = idx_of(
        lambda line: line.strip() == f"root * {PUBLIC_ROOT}",
        f"'root * {PUBLIC_ROOT}'",
        install_handle_idx,
        install_handle_end,
    )
    fs_install_idx = idx_of(
        lambda line: line.strip() == "file_server",
        "'file_server' в install-ветке",
        install_handle_idx,
        install_handle_end,
    )
    check(root_idx < fs_install_idx, "install: root до file_server")
    for op in (
        'header @claude_manifest Cache-Control "no-cache"',
        'header @claude_icons Cache-Control "public, max-age=86400"',
    ):
        op_idx = idx_of(
            lambda line, o=op: line.strip() == o, f"правило '{op}'",
            install_handle_idx, install_handle_end,
        )
        check(op_idx < root_idx, f"{op}: до file_server")

    # (d) регрессия: cache-правила assets/manifest/icons НЕ на уровне route —
    # иначе они применяются к 401 от forward_auth (401 с immutable = баг).
    top_level_cache = [
        i
        for i in range(route_idx + 1, route_end)
        if indent_of(lines[i]) == dst_indent
        and lines[i].strip().startswith(
            ("header @claude_assets", "header @claude_icons", "header @claude_manifest")
        )
    ]
    check(
        not top_level_cache,
        "cache/type assets/manifest/icons не на уровне route (иначе 401 кэшируется)",
    )
    redirect_idx = idx_of(
        lambda line: line.strip() == "handle /claude {"
        and indent_of(line) == dst_indent,
        "'handle /claude {'",
        route_idx + 1,
        route_end,
    )
    check(
        any(line.strip() == "redir * /claude/ 308" for line in lines),
        "redirect /claude -> /claude/ 308",
    )
    private_idx = idx_of(
        lambda line: line.strip() == "handle /claude/* {"
        and indent_of(line) == dst_indent,
        "'handle /claude/* {'",
        route_idx + 1,
        route_end,
    )
    check(install_idx < redirect_idx < private_idx, "install-ветка и redirect идут ДО forward_auth")
    check(
        any(
            line.strip() == f"forward_auth {AUTH_UPSTREAM} {{"
            for line in lines[private_idx: route_end]
        ),
        f"forward_auth {AUTH_UPSTREAM} внутри handle /claude/*",
    )
    block = "\n".join(lines[private_idx: find_block_end(lines, private_idx) + 1])
    check("uri /verify" in block, "forward_auth использует uri /verify")
    check("copy_headers X-Auth-User" in block, "forward_auth копирует X-Auth-User")
    check(
        any(line.strip() == f"reverse_proxy {APP_UPSTREAM} {{" for line in lines),
        f"reverse_proxy {APP_UPSTREAM}",
    )
    check("flush_interval -1" in block, "flush_interval -1 (SSE не буферизуется)")
    check("header_up X-Forwarded-Proto https" in block, "header_up X-Forwarded-Proto https")
    check("header_up -Cookie" in block, "header_up -Cookie (cookie шлюза не уходит в app)")
    expected_edge = (
        f"header_up X-Claude-Edge {secret}"
        if secret
        else f"header_up X-Claude-Edge {SECRET_PLACEHOLDER}"
    )
    check(expected_edge in block, "header_up X-Claude-Edge присутствует")
    for header in ("header_up -Authorization", "header_up -X-Forwarded-User", "header_up -X-Real-IP"):
        check(header in block, header)
    check("Service-Worker-Allowed" not in text, "нет Service-Worker-Allowed")

    # (c) /claude/assets/*: immutable ТОЛЬКО на 2xx app (handle_response status
    # 2xx), 401 от forward_auth не доходит до ветки; вложенный handle отделяет
    # assets от HTML/API/SSE (стрим обычного proxy не меняется).
    private_block = "\n".join(lines[private_idx: find_block_end(lines, private_idx) + 1])
    check("route {" in private_block, "приватная часть обёрнута в route { } (порядок директив)")
    assets_handle_idx = idx_of(
        lambda line: line.strip() == "handle @claude_assets {",
        "'handle @claude_assets {'",
        private_idx,
        find_block_end(lines, private_idx),
    )
    forward_auth_idx = idx_of(
        lambda line: line.strip() == f"forward_auth {AUTH_UPSTREAM} {{",
        f"forward_auth {AUTH_UPSTREAM}",
        private_idx,
        find_block_end(lines, private_idx),
    )
    check(forward_auth_idx < assets_handle_idx, "forward_auth стоит ДО ветки assets")
    assets_block = "\n".join(
        lines[assets_handle_idx: find_block_end(lines, assets_handle_idx) + 1]
    )
    check("@claude_asset_ok status 2xx" in assets_block, "assets: handle_response по status 2xx")
    check("handle_response @claude_asset_ok {" in assets_block, "assets: handle_response блок")
    check(
        '>Cache-Control "public, max-age=86400, immutable"' in assets_block,
        "assets: deferred immutable Cache-Control в handle_response",
    )
    check("copy_response" in assets_block, "assets: copy_response (тело/статус сохраняются)")
    check(
        text.count('>Cache-Control "public, max-age=86400, immutable"') == 1,
        "immutable-правило ровно одно (не дублируется)",
    )
    check(
        "handle @claude_assets" in private_block
        and private_block.count("handle @claude_assets") == 1,
        "ветка assets ровно одна",
    )


# ── caddy ───────────────────────────────────────────────────────────────────


def find_caddy(explicit: str | None) -> str | None:
    if explicit:
        if not Path(explicit).is_file():
            raise Fail(f"указанный caddy не найден: {explicit}")
        return explicit
    for candidate in (shutil.which("caddy"), "/usr/bin/caddy", "/usr/local/bin/caddy"):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def caddy_validate(caddy: str, config: Path) -> None:
    result = subprocess.run(
        [caddy, "validate", "--config", str(config), "--adapter", "caddyfile"],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise Fail(
            f"caddy validate провалился (exit {result.returncode}):\n{output[-4000:]}"
        )
    ok("caddy validate: Valid configuration")


def caddy_adapt(caddy: str, config: Path, out_json: Path) -> str:
    result = subprocess.run(
        [caddy, "adapt", "--config", str(config), "--adapter", "caddyfile", "--pretty"],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        raise Fail(
            f"caddy adapt провалился (exit {result.returncode}):\n"
            f"{(result.stdout + result.stderr).strip()[-4000:]}"
        )
    adapted = result.stdout
    write_private(out_json, adapted)
    return adapted


def check_adapted(adapted: str, secret: str | None) -> None:
    required = (
        AUTH_UPSTREAM,
        APP_UPSTREAM,
        PUBLIC_ROOT,
        "flush_interval",
        "X-Claude-Edge",
        PUBLIC_ORIGIN,
        "reverse_proxy",
    )
    missing = [item for item in required if item not in adapted]
    if missing:
        raise Fail(f"caddy adapt: в JSON нет ожидаемых элементов: {missing}")
    ok("caddy adapt: /claude/* -> forward_auth -> reverse_proxy, flush_interval, edge-header на месте")


# ── системные операции ──────────────────────────────────────────────────────


def require_root() -> None:
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise Fail("для --install/--rollback нужен root (реальный сервер)")


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError:
        raise Fail(f"команда не найдена: {cmd[0]}") from None
    except subprocess.TimeoutExpired:
        raise Fail(f"таймаут команды: {' '.join(cmd)}") from None


def systemctl(*args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run(["systemctl", *args], timeout=timeout)


def is_active(unit: str) -> bool:
    result = systemctl("is-active", unit)
    return result.returncode == 0 and result.stdout.strip() == "active"


def curl_code(url: str, extra: list[str] | None = None) -> str | None:
    curl = shutil.which("curl")
    if not curl:
        return None
    result = run([curl, "-sS", "-o", "/dev/null", "--max-time", "10", *([] if extra is None else extra), "-w", "%{http_code}", url])
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def group_gid(name: str) -> int:
    import grp

    try:
        return grp.getgrnam(name).gr_gid
    except KeyError:
        raise Fail(f"группа {name} не существует (ожидается caddy от auth-шлюза)") from None


def atomic_install_text(text: str, dst: Path, mode: int, group: str) -> None:
    """Атомарная установка: tmp-файл в том же каталоге, chown/chmod, os.replace."""
    if not dst.parent.is_dir():
        raise Fail(f"каталог {dst.parent} не существует")
    tmp = dst.parent / f".{dst.name}.new-{os.getpid()}-{int(time.time())}"
    try:
        write_private(tmp, text, 0o600)
        os.chown(tmp, 0, group_gid(group))
        os.chmod(tmp, mode)
        os.replace(tmp, dst)
        dir_fd = os.open(dst.parent, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def validate_installed(config: Path) -> None:
    caddy = find_caddy(None)
    if not caddy:
        raise Fail("caddy не найден: без validate установка запрещена (fail-closed)")
    caddy_validate(caddy, config)


def restart_gateway_and_check(restored_from: Path | None = None) -> None:
    result = systemctl("restart", GATEWAY_UNIT)
    if result.returncode != 0:
        raise Fail(f"systemctl restart {GATEWAY_UNIT} провалился: {result.stderr.strip()}")
    time.sleep(2)
    if not is_active(GATEWAY_UNIT):
        journal = systemctl("status", GATEWAY_UNIT, "--no-pager", "-n", "40")
        raise Fail(
            f"{GATEWAY_UNIT} не active после restart; статус:\n"
            f"{(journal.stdout + journal.stderr).strip()[-4000:]}"
        )
    ok(f"{GATEWAY_UNIT} active после restart")

    code_root = curl_code("http://127.0.0.1:8081/")
    if code_root is None:
        warn("curl/localhost check пропущен (curl недоступен или соединение не удалось)")
        return
    if code_root != "401":
        raise Fail(f"DSH сломан: http://127.0.0.1:8081/ вернул {code_root}, ожидался 401")
    ok("DSH-корень на loopback отвечает 401")

    code_claude = curl_code("http://127.0.0.1:8081/claude/")
    if code_claude is None:
        warn("проверка /claude/ на loopback пропущена")
        return
    if code_claude != "401":
        raise Fail(
            f"http://127.0.0.1:8081/claude/ вернул {code_claude}, ожидался 401 (аноним)"
        )
    ok("/claude/ на loopback отвечает 401 (аноним)")


def resolve_secret(args: argparse.Namespace) -> str:
    if args.secret_file:
        lines = read_lines(Path(args.secret_file), "файл секрета")
        secret = next((line.strip() for line in lines if line.strip()), "")
        source = args.secret_file
    else:
        env_path = Path(args.env_file)
        if not env_path.is_file():
            raise Fail(
                f"нет env-файла {env_path}: EDGE_SECRET создаёт Lead по runbook §2 "
                "(или укажите --secret-file)"
            )
        secret = ""
        for line in read_lines(env_path, "env-файл"):
            if line.startswith("EDGE_SECRET="):
                secret = line[len("EDGE_SECRET="):].strip().strip("'\"")
        source = args.env_file
    if not secret:
        raise Fail(f"EDGE_SECRET не найден в {source}")
    if secret == SECRET_PLACEHOLDER or not HEX64.match(secret):
        raise Fail("EDGE_SECRET должен быть 64 hex (fail-closed), значение не выводится")
    ok("EDGE_SECRET прочитан (64 hex; значение не выводится)")
    return secret


# ── режимы ──────────────────────────────────────────────────────────────────


def print_diff(original: list[str], patched: list[str], secret: str | None) -> None:
    diff = difflib.unified_diff(
        [line + "\n" for line in original],
        [line + "\n" for line in patched],
        fromfile="Caddyfile (live/копия)",
        tofile="Caddyfile (patched)",
        n=3,
    )
    rendered = "".join(redact(line, secret) for line in diff)
    if not rendered.strip():
        info("diff пуст: файл не изменится")
        return
    print("─" * 72)
    print(rendered, end="")
    print("─" * 72)


def make_tag(raw: str | None, prefix: str) -> str:
    tag = raw or time.strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[^A-Za-z0-9._-]", "", tag)
    if not safe:
        raise Fail(f"недопустимый TAG: {raw!r}")
    if not safe.startswith(prefix):
        safe = f"{prefix}{safe}"
    return safe[:120]


def do_dry_run(args: argparse.Namespace, sections: dict[str, list[str]]) -> int:
    config = Path(args.config)
    lines = read_lines(config, "Caddyfile")
    if args.secret_file:
        warn("dry-run не подставляет реальный секрет: валидируется структура с плейсхолдером")
    patched, report, changed = build_patch(lines, sections, None, not args.no_patch_log)
    for item in report:
        ok(item)
    print_diff(lines, patched, None)

    tag = make_tag(args.tag, "dry-")
    if args.output_dir:
        out_dir = Path(args.output_dir)
    else:
        out_dir = Path(tempfile.mkdtemp(prefix=f"claude-caddy-{tag}-", dir="/tmp"))
    out_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(out_dir, 0o700)
    out_config = out_dir / "Caddyfile"
    write_private(out_config, "\n".join(patched) + "\n", 0o600)
    print(f"MODE=dry-run")
    print(f"TAG={tag}")
    print(f"CHANGED={int(changed)}")
    print(f"DRY_RUN_CONFIG={out_config}")
    info(f"пропатченная копия: {out_config} (0600, реальный секрет не подставлен)")

    caddy = find_caddy(args.caddy)
    if args.no_validate:
        warn("--no-validate: validate/adapt пропущены по явному флагу")
        print("VALIDATED=0")
        print("RESULT=ok")
        return 0
    if not caddy:
        warn("caddy не найден: validate/adapt пропущены (на VPS ожидается /usr/bin/caddy)")
        print("VALIDATED=0")
        print("RESULT=ok")
        return 0
    caddy_validate(caddy, out_config)
    out_json = out_dir / "Caddyfile.json"
    adapted = caddy_adapt(caddy, out_config, out_json)
    check_adapted(adapted, None)
    print(f"DRY_RUN_JSON={out_json}")
    print("VALIDATED=1")
    print("RESULT=ok")
    info("живой Caddyfile и сервисы НЕ изменялись")
    return 0


def do_install(args: argparse.Namespace, sections: dict[str, list[str]]) -> int:
    require_root()
    if args.no_validate:
        raise Fail("--install несовместим с --no-validate: установка только после validate")
    config = Path(args.config)
    if config.resolve() != LIVE_CONFIG.resolve():
        raise Fail(
            f"--install ставит только живой {LIVE_CONFIG}; для другой копии используйте --dry-run"
        )
    secret = resolve_secret(args)
    caddy = find_caddy(args.caddy)
    if not caddy:
        raise Fail("caddy не найден: --install требует validate/adapt (fail-closed)")
    lines = read_lines(config, "Caddyfile")
    # Бэкап делаем ровно из тех байт, что прочитали и патчили: живой Caddyfile
    # может меняться параллельными деплоями шлюза, поэтому backup/patched должны
    # описывать один и тот же снимок.
    original_text = "\n".join(lines) + "\n"
    patched, report, changed = build_patch(lines, sections, secret, not args.no_patch_log)
    for item in report:
        ok(item)
    print_diff(lines, patched, secret)
    if not changed:
        info("Caddyfile уже актуален: изменений нет, установка не требуется")
        print("RESULT=no-op")
        return 0

    tag = make_tag(args.tag, "")
    if not tag or tag.startswith("dry-"):
        raise Fail("--tag не должен начинаться с dry-")
    backup_dir = BACKUP_ROOT / f"{BACKUP_PREFIX}{tag}"
    if backup_dir.exists():
        raise Fail(f"бэкап-каталог уже существует: {backup_dir}; выберите другой --tag")
    backup_dir.mkdir(mode=0o700, parents=True)
    os.chmod(backup_dir, 0o700)  # mkdir mode маскируется umask — фиксируем явно
    backup_file = backup_dir / "Caddyfile"
    write_private(backup_file, original_text, 0o600)
    digest = hashlib.sha256(original_text.encode("utf-8")).hexdigest()
    write_private(backup_dir / "Caddyfile.sha256", f"{digest}  {config}\n")
    write_private(
        backup_dir / "systemctl-cat.txt",
        systemctl("cat", GATEWAY_UNIT).stdout + systemctl("cat", GATEWAY_UNIT).stderr,
    )
    ports = run(["ss", "-lntp"])
    write_private(backup_dir / "ports.txt", ports.stdout + ports.stderr)
    ok(f"бэкап: {backup_dir} (sha256 {digest[:16]}…)")

    staged = BACKUP_ROOT / f"Caddyfile.{tag}"
    staged_json = BACKUP_ROOT / f"Caddyfile.{tag}.json"
    try:
        write_private(staged, "\n".join(patched) + "\n", 0o600)
        try:
            caddy_validate(caddy, staged)
            adapted = caddy_adapt(caddy, staged, staged_json)
            check_adapted(adapted, secret)
        except Fail:
            warn("живой Caddyfile НЕ изменён (validate/adapt провалились)")
            raise
        try:
            current_text = config.read_text(encoding="utf-8")
        except OSError as exc:
            raise Fail(f"не удалось перечитать живой Caddyfile перед установкой: {exc}") from None
        if current_text != original_text:
            raise Fail(
                "живой Caddyfile изменился во время подготовки (параллельный деплой?) — "
                "живой файл НЕ изменён, повторите --install, чтобы пропатчить свежий снимок"
            )
        atomic_install_text("\n".join(patched) + "\n", config, 0o640, "caddy")
        ok(f"установлено: {config} (0640 root:caddy)")
        try:
            restart_gateway_and_check()
        except Fail:
            warn("проверки после restart провалились — автоматический откат из бэкапа")
            atomic_install_text(backup_file.read_text(encoding="utf-8"), config, 0o640, "caddy")
            warn("бэкап восстановлен, повторный restart")
            restart_gateway_and_check()
            raise Fail("установка отменена, Caddyfile восстановлен из бэкапа")
        write_private(TAG_POINTER, tag + "\n", 0o600)
        ok(f"TAG={tag} записан в {TAG_POINTER}")
        print(f"BACKUP_DIR={backup_dir}")
        print("RESULT=ok")
        return 0
    finally:
        shred(staged)
        shred(staged_json)


def do_rollback(args: argparse.Namespace) -> int:
    require_root()
    tag = args.tag
    if not tag:
        if not TAG_POINTER.is_file():
            raise Fail(f"нет --tag и нет {TAG_POINTER}")
        tag = TAG_POINTER.read_text(encoding="utf-8").strip()
    if not tag:
        raise Fail("TAG пуст")
    tag = re.sub(r"[^A-Za-z0-9._-]", "", tag)
    backup_dir = BACKUP_ROOT / f"{BACKUP_PREFIX}{tag}"
    backup_file = backup_dir / "Caddyfile"
    if not backup_file.is_file():
        raise Fail(f"нет бэкапа: {backup_file}")
    text = backup_file.read_text(encoding="utf-8")
    sha_file = backup_dir / "Caddyfile.sha256"
    if sha_file.is_file():
        expected = sha_file.read_text(encoding="utf-8").split()[0]
        actual = sha256_file(backup_file)
        if expected != actual:
            raise Fail(
                f"sha256 бэкапа не совпадает (ожидался {expected[:16]}…, "
                f"получен {actual[:16]}…) — откат остановлен"
            )
        ok("sha256 бэкапа совпадает")
    caddy = find_caddy(args.caddy)
    if not caddy:
        raise Fail("caddy не найден: откат без validate запрещён (fail-closed)")
    staged = BACKUP_ROOT / f"Caddyfile.rollback-{tag}"
    try:
        write_private(staged, text, 0o600)
        caddy_validate(caddy, staged)
        atomic_install_text(text, LIVE_CONFIG, 0o640, "caddy")
        ok(f"восстановлено: {LIVE_CONFIG} из {backup_file}")
        restart_gateway_and_check()
    finally:
        shred(staged)
    info(f"TAG={tag}; живой Caddyfile и dsh-gateway-caddy восстановлены")
    print(f"RESTORED_FROM={backup_file}")
    print("RESULT=ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="apply-caddy.py",
        description="claude-web: вставка Caddy-фрагмента в копию живого Caddyfile",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Примеры:\n"
            "  deploy/apply-caddy.sh --dry-run\n"
            "  deploy/apply-caddy.sh --install --tag 20261122-120000\n"
            "  deploy/apply-caddy.sh --rollback --tag 20261122-120000\n"
            "Секрет в argv не принимается: --env-file (по умолчанию /etc/claude-web/env)\n"
            "или --secret-file."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_const", const="dry-run", dest="mode",
                      help="копия в /tmp + diff + validate/adapt (по умолчанию)")
    mode.add_argument("--install", action="store_const", const="install", dest="mode",
                      help="бэкап, установка, restart dsh-gateway-caddy (root)")
    mode.add_argument("--rollback", action="store_const", const="rollback", dest="mode",
                      help="restore Caddyfile из /root/claude-pwa-backup-<TAG> (root)")
    parser.set_defaults(mode="dry-run")
    parser.add_argument("--config", default=str(LIVE_CONFIG), help="исходный Caddyfile")
    parser.add_argument("--fragment", default=str(DEFAULT_FRAGMENT), help="файл фрагмента")
    parser.add_argument("--tag", default=None, help="TAG бэкапа (install/rollback)")
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE,
                        help="env-файл с EDGE_SECRET (install)")
    parser.add_argument("--secret-file", default=None,
                        help="файл с EDGE_SECRET (только install; не argv)")
    parser.add_argument("--caddy", default=None, help="путь к бинарю caddy")
    parser.add_argument("--output-dir", default=None, help="каталог dry-run (по умолчанию /tmp/...)")
    parser.add_argument("--no-patch-log", action="store_true",
                        help="не удалять X-Claude-Edge из access-лога (не рекомендуется)")
    parser.add_argument("--no-validate", action="store_true",
                        help="пропустить caddy validate/adapt (в install запрещено)")
    args = parser.parse_args(argv)

    try:
        if args.mode == "rollback":
            return do_rollback(args)
        sections = parse_fragment(Path(args.fragment))
        if args.mode == "install":
            return do_install(args, sections)
        return do_dry_run(args, sections)
    except Fail as exc:
        print(f"FAIL: {exc}", file=sys.stderr, flush=True)
        print("RESULT=fail", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
