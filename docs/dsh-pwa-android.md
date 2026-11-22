# DSH Web как PWA на Android: почему не ставится и как починить

Дата: 2026-11-21. Сервер: `vps-4692`, публичный адрес
`https://vps-4692.tailfbc4b2.ts.net:10000/` (Tailscale Funnel → Caddy :8081 →
auth-шлюз :9090 → `dsh web` :3080).

## Коротко

Серверная часть PWA готова и проверена: `/sw.js` отдаётся, service worker
регистрируется и переходит в `activated`, `/manifest.webmanifest` валиден и
отдаётся с `crossorigin="use-credentials"` (браузер получает его с cookie).
Устанавливаться мешает только входная авторизация:

- **Яндекс.Браузер** на Android сторонние PWA не устанавливает — его «Добавить
  на главный экран» создаёт обычный ярлык-ссылку.
- **Chrome** на Android ставит PWA через **WebAPK**: сборку APK заказывает
  сервис Google, и он сам скачивает **манифест и иконки по публичному URL** —
  без cookie пользователя. Auth-шлюз отвечает на эти запросы `401`, поэтому
  Chrome пишет «app cannot be installed».

Проверка (без куки, как ходит сервис установки):

```bash
for p in manifest.webmanifest icon-192.png icon-512.png icon-maskable-512.png; do
  printf "%-24s " "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "https://vps-4692.tailfbc4b2.ts.net:10000/$p"
done
# сейчас: 401 401 401 401 — нужно 200
```

## Что сделать (нужен root)

Разрешить **без сессии** только статические файлы установки. В них нет
секретов; интерфейс, API и WebSocket остаются за входом.

Путь к конфигу Caddy можно уточнить:

```bash
ps aux | grep '[c]addy run'          # --config /etc/dsh-gateway-caddy/Caddyfile
```

### 1. Бэкап

```bash
sudo cp /etc/dsh-gateway-caddy/Caddyfile /etc/dsh-gateway-caddy/Caddyfile.bak
```

### 2. Вставить блок

В **начало** блока сайта (внутри `{ ... }` для `:10000` /
`vps-4692.tailfbc4b2.ts.net`), **выше** `forward_auth` / `reverse_proxy`:

```caddyfile
# Публичные метаданные установки: Chrome WebAPK minter запрашивает их без cookie.
@pwa_install path /manifest.webmanifest /icon-192.png /icon-512.png /icon-maskable-512.png /apple-touch-icon.png
handle @pwa_install {
    reverse_proxy 127.0.0.1:3080
}
```

Почему так: совпавшие пути уходят из Caddy прямо в `dsh web` (там статика
публична), минуя `forward_auth` и инъекцию ping. `/sw.js` намеренно **не**
в списке — скрипт worker'а браузер забирает сам, со своей сессией.

Если конфиг обёрнут в `route { ... }`, блок нужно положить **первым внутри
`route`** — `handle` вне `route` Caddy не примет.

### 3. Проверить и перезагрузить

```bash
sudo caddy validate --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile
sudo systemctl reload dsh-gateway-caddy
```

### 4. Проверить снаружи

```bash
for p in manifest.webmanifest icon-192.png icon-512.png icon-maskable-512.png; do
  printf "%-24s " "$p"
  curl -s -o /dev/null -w '%{http_code}\n' "https://vps-4692.tailfbc4b2.ts.net:10000/$p"
done
# ожидается: 200 200 200 200
```

## Установка на телефоне

1. Удалить старый ярлык, созданный Яндекс.Браузером.
2. Открыть `https://vps-4692.tailfbc4b2.ts.net:10000/` в **Chrome** (не в
   Яндекс.Браузере и не во встроенном браузере Telegram).
3. Войти: `https://vps-4692.tailfbc4b2.ts.net:10000/auth/tg` — пароль + TOTP
   (или вход через Telegram).
4. Меню **⋮ → «Установить приложение»** (именно «установить», а не «добавить
   на главный экран»). Дождаться завершения — Chrome соберёт WebAPK.
5. Иконка должна открыть окно **без адресной строки** (`display: standalone`).

## Если что-то пошло не так

- **Caddy не принимает конфиг** — вернуть бэкап и перезагрузить:

  ```bash
  sudo cp /etc/dsh-gateway-caddy/Caddyfile.bak /etc/dsh-gateway-caddy/Caddyfile
  sudo systemctl reload dsh-gateway-caddy
  ```

- **Chrome всё равно пишет «app cannot be installed»** — проверить, что
  публичные файлы действительно `200` (шаг 4), и что в манифесте иконки —
  PNG (не SVG): Chrome не собирает WebAPK по SVG-иконкам. Текущий манифест:
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`.
- **Иконка ставится, но открывается с адресной строкой** — Chrome сделал
  ярлык вместо WebAPK (например, сборка не дошла до конца); удалить и
  повторить установку после шага 4.
- **Логин не спрашивается, сразу `{"error":"unauthorized"}`** — это ответ
  шлюза: в этом браузере нет сессии; открыть `/auth/tg`, войти, затем
  вернуться на `/`.

## Важно про сессии

Сессия веб-входа живёт idle 2 ч (продлевается пингом, пока вкладка видима) и
абсолютный максимум 12 ч. После установки PWA при истечении сессии вместо
сырого JSON показывается страница «Сессия завершилась» с кнопкой «Войти»
(ведёт на `/auth/tg`) и «Повторить» — это поведение service worker'а.

## Альтернатива без правки шлюза

Установить PWA на **десктопном Chrome**: там установка локальная, WebAPK-сервис
Google не участвует, и auth-шлюз ей не мешает. На Android без публичного
доступа к иконкам и манифесту настоящую установку сделать нельзя — только
ярлык.

## Откат

Вернуть `Caddyfile.bak` и перезагрузить Caddy. Уже установленный на телефоне
WebAPK продолжит работать, но обновления иконок/имен из манифеста перестанут
подтягиваться, пока публичный доступ не вернут.
