# auditd: `svc_exec` — переводим с «запуска» на «изменение»

**Вариант A** · подготовлено 2026-11-21 · к применению — завтра, нужен root
Время: ~10 минут · Риск: низкий · Откат: 2 команды

> **TL;DR (скорее всего ветка 5B):** бэкап → закомментировать `execve`-правило с ключом `svc_exec` → добавить `/etc/audit/rules.d/60-svc-exec.rules` с `-p wa` → `augenrules --load` → проверить `auditctl -l` и `security-watch --dry-run`.
> **Не делать:** не выключать auditd, не трогать ключи `svc_priv`, `priv_esc`, `auth`, `identity`.

---

## 0. Контекст: почему это вообще нужно

Бот (v1.4.2) присылает в Telegram:

```
🛡️ Изменения в чувствительных файлах (356 событий):
svc_exec:/usr/bin/git
svc_exec:/lib64/ld-linux-x86-64.so.2
svc_exec:/usr/local/sbin/systemctl
...
```

Это **не изменения файлов**. Ключ `svc_exec` сейчас стоит на `execve` — то есть на *запуск* бинарника, а в событие попадает всё, что auditd увидел при запуске: неудачные PATH-пробы шелла и ELF-интерпретатор `ld-linux`.

Что уже проверено 21.11.2026:

| Проверка | Результат |
|---|---|
| Пути `/usr/local/sbin/systemctl`, `/usr/local/bin/systemctl`, `/usr/sbin/systemctl` из алерта | **не существуют** — записать в них нечего, а «попытаться запустить» можно |
| `/lib64/ld-linux-x86-64.so.2` | интерпретатор, auditd добавляет его к каждому запуску динамического бинарника |
| `dpkg -V systemd iputils-ping libc6` | **чисто**, ни одного расхождения |
| mtime: systemctl / ping / bash / git | 12.10.2026 / 24.07.2025 / 31.03.2024 / 16.10.2026 — не менялись |
| Время алертов 21:52:38, 21:53:38, 21:54:38 | совпадает с работой агента (`landlock-run` → `bash`) и `tunnel-healthcheck` (раз в 5 мин) |

**Цель правки:** оставить сигнал «кто-то перезаписал/подменил бинарник» (supply-chain) и убрать шум от «кто-то запустил `systemctl`».

---

## 1. Что меняем по сути

| | Было | Стало |
|---|---|---|
| Что ловим | `execve` — запуск | `w` + `a` — запись и смена атрибутов (chmod/chown) |
| Шум от агента/healthcheck | 150–350 «событий» в минуту | 0 |
| Подмена бинарника | видна, но тонет в шуме | видна и шумит ровно тогда, когда надо |

`-p wa` = `w` (запись содержимого) + `a` (изменение атрибутов). Только `-p w` брать не надо: `chmod u+s /usr/bin/bash` — это тоже атака, а `w` её не поймает.

Правила для каталогов (`/usr/bin`, `/usr/local/bin`, …) нужны отдельно: `-w` на файл следит за inode, а `dpkg` заменяет бинарник через rename — per-file правило после этого смотрит на старый inode. Каталог ловит саму подмену/подброс файла.

---

## 2. Предусловия

```bash
systemctl is-active auditd                 # active
sudo auditctl -s | grep -E 'enabled|immutable'
sudo systemctl --version | head -1         # для контекста
```

- Если в `enabled` стоит **2** — правила immutable, менять их можно только после перезагрузки. Тогда сначала `sudo reboot`, потом продолжаем.
- Если `enabled` = 1 — всё ок, идём дальше.

---

## 3. Бэкап (обязательно)

```bash
BK=/root/audit-backup-$(date +%F)
sudo install -d -m 700 "$BK"
sudo cp -a /etc/audit/rules.d/. "$BK"/
sudo auditctl -l | sudo tee "$BK/loaded.rules" >/dev/null
sudo auditctl -s | sudo tee "$BK/audit.status" >/dev/null
sudo ls -la "$BK"
```

---

## 4. Осмотр правил: какой у нас случай

```bash
sudo grep -rn -- '-k svc_exec' /etc/audit/rules.d/
```

> `/etc/audit/audit.rules` — сгенерированный файл, править его руками нельзя: `augenrules --load` перезапишет. Все правки — только в `/etc/audit/rules.d/*.rules`.

Возможны две формы — дальше идём по нужной ветке:

- **A:** `-w /usr/bin/systemctl -p x -k svc_exec` → раздел 5A
- **B:** `-a always,exit ... -S execve ... -k svc_exec` → раздел 5B (скорее всего именно она: только syscall-правило объясняет, почему в алертах есть несуществующие `/usr/local/...`)

Заодно сохраните список строк для отчёта:

```bash
sudo grep -rn -- '-k svc_exec' /etc/audit/rules.d/ | sudo tee "$BK/svc_exec.old"
```

---

## 5A. Если форма `-w ... -p x -k svc_exec`

Меняем только `x` → `wa` в строках с ключом `svc_exec`:

```bash
sudo sed -ri '/-k[[:space:]]+svc_exec\b/ s/-p[[:space:]]+x([[:space:]]|$)/-p wa\1/' /etc/audit/rules.d/*.rules

# показать разницу с бэкапом
sudo diff -ru "$BK" /etc/audit/rules.d/ | grep -E '^[-+][^-+]'
```

Ожидаемо: строки поменялись с `-p x` на `-p wa`, других изменений нет. Переходите к разделу 6.

---

## 5B. Если форма `-a always,exit ... -S execve ... -k svc_exec`

### 5B.1 Закомментировать exec-правило

```bash
sudo sed -ri '/-k[[:space:]]+svc_exec\b/ { /^[[:space:]]*#/! s/^/# / }' /etc/audit/rules.d/*.rules
sudo grep -rn -- 'svc_exec' /etc/audit/rules.d/ | grep execve
```

Ожидаемо: строка(и) с `execve` начинаются с `# `.

### 5B.2 Добавить правила на изменение

```bash
sudo tee /etc/audit/rules.d/60-svc-exec.rules >/dev/null <<'EOF'
## svc_exec: изменения бинарников (supply-chain), а не запуски.
## Каталоги — подмена/подброс/удаление файла (в т.ч. rename со стороны dpkg).
-w /usr/local/bin  -p wa -k svc_exec
-w /usr/local/sbin -p wa -k svc_exec
-w /usr/bin        -p wa -k svc_exec
-w /usr/sbin       -p wa -k svc_exec

## Ключевые файлы — правка/смена атрибутов на месте.
-w /usr/bin/bash      -p wa -k svc_exec
-w /usr/bin/systemctl -p wa -k svc_exec
-w /usr/bin/ping      -p wa -k svc_exec
-w /usr/bin/git       -p wa -k svc_exec
-w /usr/bin/sudo      -p wa -k svc_exec
-w /usr/bin/ssh       -p wa -k svc_exec
-w /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 -p wa -k svc_exec
EOF
```

Замечания:

- `/bin` и `/sbin` — симлинки на `/usr/bin` и `/usr/sbin` (usrmerge), отдельные правила не нужны.
- Если в старом правиле был свой список бинарников — перенесите его в этот файл, только с `-p wa`.
- Ключи `svc_priv`, `priv_esc`, `auth`, `identity`, `persist`, `gateway`, `fail2ban` **не трогаем**.

---

## 6. Загрузить правила

```bash
sudo augenrules --load
sudo auditctl -l | grep svc_exec
```

Ожидаемо: строки с `-p wa`; ни одной с `-p x` и ни одной `-S execve` по ключу `svc_exec`.

```bash
sudo auditctl -l | grep -c svc_exec     # для протокола
```

Если `augenrules --load` ругается — смотрите `sudo journalctl -u auditd -n 30` и возвращайтесь к разделу 9 (откат).

---

## 7. Проверки

### 7.1 Запуск больше не ловится

```bash
MARK=$(date -u +%H:%M:%S); echo "маркер: $MARK (UTC)"
/usr/bin/systemctl --version >/dev/null
/bin/bash -c 'true'
sudo ausearch -k svc_exec -ts "$MARK" -i | tail -5
```

Ожидаемо: **пусто** — за время после маркера записей нет. Старые записи (до правки) останутся в логе, это нормально.

### 7.2 Запись ловится (тест на `/tmp`, бинарники не трогаем)

```bash
sudo install -m 600 /dev/null /tmp/svc_probe
sudo auditctl -w /tmp/svc_probe -p wa -k svc_probe
sudo sh -c 'echo x >> /tmp/svc_probe'
sudo chmod 640 /tmp/svc_probe
sudo ausearch -k svc_probe -i | tail -20
sudo auditctl -W /tmp/svc_probe -p wa -k svc_probe
sudo rm -f /tmp/svc_probe
```

Ожидаемо: два события — `write` и `chmod`. Если событий нет — правила не применились, откатывайтесь.

### 7.3 Бот молчит (dry-run, без Telegram)

```bash
sudo /usr/bin/node /usr/local/sbin/security-watch.mjs --dry-run
```

Ожидаемо: нет `would alert` по `svc_exec`. Затем 30–60 минут обычной работы (агент, `tunnel-health`, обычные команды) — в Telegram не должно прийти ни одного «Изменения в чувствительных файлах».

---

## 8. Чего ожидать дальше

| Событие | Реакция бота |
|---|---|
| `apt upgrade` / `dpkg -i` | burst `svc_exec` — **правильно**: пакеты перезаписывают бинарники. Один алерт (дедуп 1 ч), список путей = что обновилось |
| Правка/подброс файла в `/usr/local/bin`, `/usr/local/sbin` | алерт — главный сценарий, ради которого всё делается |
| Запуск `systemctl`/`ping`/`bash` кем угодно | **тишина** (осознанная потеря покрытия; запуск ≠ компрометация) |

---

## 9. Откат

```bash
BK=/root/audit-backup-<дата>
sudo cp -a "$BK"/. /etc/audit/rules.d/
sudo rm -f /etc/audit/rules.d/60-svc-exec.rules
sudo augenrules --load
sudo auditctl -l | grep svc_exec
```

Проверить, что вернулось исходное: `sudo diff -ru "$BK" /etc/audit/rules.d/` (файла `loaded.rules` в diff не будет — он лежит только в бэкапе).

---

## 10. Подводные камни

1. `-w` несовместим с `-F`; путь должен существовать на момент загрузки правил. Поэтому `/usr/local/*` — каталогами (они есть), а не файлами, которых может не быть.
2. `-w` на файл привязан к inode: `dpkg` кладёт новый файл через rename, per-file правило после этого смотрит на старый inode. Именно поэтому в наборе есть правила на каталоги.
3. `-p wa` без `a` — дырка: `chmod`, `chown`, `setcap` на бинарнике не будут видны.
4. `enabled 2` (immutable) — правки только после reboot, иначе `augenrules --load` молча ничего не применит.
5. `security-watch` читает `/var/log/audit/audit.log` по offset из `state.json` — после смены правил ничего сбрасывать не нужно, новые события подхватятся сами.
6. Если правила управляются playbook'ом (`/usr/local/sbin/pb-rollback`, снимки в `/var/backups/playbook/`), сначала проверьте, не перезапишет ли он `/etc/audit/rules.d` при следующем деплое; при необходимости внесите правку в исходник playbook'а, а не только в `/etc`.

---

## 11. Чек-лист

- [ ] `auditctl -s` → `enabled 1` (не 2)
- [ ] бэкап в `/root/audit-backup-YYYY-MM-DD` (+ `loaded.rules`)
- [ ] `grep -rn -- '-k svc_exec'` — определили форму A или B
- [ ] правка выполнена, `diff` показывает только ожидаемое
- [ ] `augenrules --load` прошёл без ошибок
- [ ] `auditctl -l | grep svc_exec` → только `-p wa`
- [ ] тест 7.1: exec не даёт новых записей
- [ ] тест 7.2: `/tmp`-проба пишет `write` + `chmod`
- [ ] `security-watch.mjs --dry-run` — без `would alert`
- [ ] 1 час наблюдения: в Telegram тихо

---

## 12. Справка

| perm | Значение |
|---|---|
| `r` | чтение |
| `w` | запись содержимого |
| `a` | изменение атрибутов (chmod, chown, setcap, touch) |
| `x` | исполнение (именно это сейчас шумит) |

Полезное:

```bash
sudo auditctl -l                                   # активные правила
sudo ausearch -k svc_exec -ts today -i | tail -40  # что реально прилетало
sudo aureport -f --summary | head                  # сводка по файлам
sudo journalctl -u auditd -n 30                    # ошибки загрузки правил
```
