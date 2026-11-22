# Installable web app (PWA) for the DSH Web GUI

Replaces the shipped manifest with a stricter one and adds the service worker
and install metadata that the built Web shell does not have, so `dsh web`
installs and behaves like an app.

- **`/manifest.webmanifest`** — a stable `id`, `display: standalone`, explicit
  `scope`/`start_url`, dark splash colors, and the icons from the frontend dist.
- **`/sw.js`** — a root-scope service worker that keeps immutable build assets
  (`/assets/*`) fast, refreshes the small static files (icons, manifest) in the
  background, and replaces a failed navigation with one small page: the Host is
  unreachable, or the auth gateway ended the session.
- **Head rows** — a manifest link with `crossorigin="use-credentials"` (the
  browser fetches a manifest without credentials, which a cookie-authenticating
  proxy refuses), the Apple standalone tag, `theme-color` for both color
  schemes, the application name, and the registration script.

The plugin has no page, button, or settings entry. Its surface is the browser's
install affordance and the installed window.

## Use it

1. Open the GUI in the browser and sign in to whatever fronts it; the plugin
   changes nothing about the login.
2. Reload once so the new rows and the worker are served.
3. Install from the browser:
   - Chrome / Edge: the install icon in the address bar, or **⋮** →
     **Install DeepSeek Harness**.
   - Android Chrome: the install prompt or **⋮** → **Add to Home screen**.
   - iOS Safari: **Share** → **Add to Home Screen**.
4. The installed window opens the same URL without browser chrome.

Chrome registers a service worker only in a secure context, so open the GUI over
HTTPS (the Tailscale URL is) or on `localhost`.

## What is cached, and what is not

| Request | Strategy |
| --- | --- |
| Navigation (`/`) | Network only, 10 s timeout; a failure shows an app page |
| 401 / 403 navigation | A "session has ended" page with a sign-in link |
| 5xx navigation | The "server unreachable" page |
| `/assets/*` (hashed JS, CSS, fonts) | Cache first, bounded to 120 entries |
| Manifest, icons, favicons | Stale-while-revalidate |
| Everything else (API, `/plugins/*`, streams, WebSocket) | Not intercepted |

A response enters the cache only when it is the file it claims to be: the URL
did not redirect, the content type matches the extension, and it is not HTML.
A proxy's login page therefore never replaces an asset or the manifest.

The shell is a live client: every session needs the Host over WebSocket, so the
worker does not fake offline capability. The "server unreachable" page reloads
as soon as any HTTP answer proves the path is reachable again; the "session has
ended" page links to the auth gateway's sign-in page at **`/tg`** (constant
`SIGN_IN_PATH` in `sw.js`; a deployment without that gateway still gets the
retry button).

The index page is deliberately never cached: it carries the boot graph of the
current composition, and a stale copy would break after a plugin change.

## Turn it off

Disabling the plugin in **Plugins** stops serving `/sw.js` and stops the
manifest override, so the shipped dist manifest is served again. The browser
keeps an already installed app and its worker until the worker is replaced or
unregistered: remove the app from the OS (Android/iOS), or use the browser's
developer tools on a desktop (**Application** → **Service workers** →
**Unregister**).

## Files

- `index.js` — the Host plugin: two routes and the index rows.
- `sw.js` — the service worker, read per request, so editing it needs no plugin
  reload. Bump its `VERSION` when the caching rules change.
- `cordis.patch.yml` — inserts the `web-pwa` row.
- `locale/*.json` — Plugin Manager title and description.
- `icon.svg` — the plugin's icon.
- `test/pwa.test.mjs` — `node --test` from this directory.

---

# Устанавливаемое веб-приложение (PWA) для веб-интерфейса DSH

Заменяет штатный манифест более строгим и добавляет service worker и метаданные
установки, которых нет в собранной оболочке `dsh web`:

- **`/manifest.webmanifest`** — стабильный `id`, `display: standalone`, явные
  `scope` и `start_url`, тёмные цвета заставки и иконки из дистрибутива;
- **`/sw.js`** — service worker со scope на корень: кэширует неизменяемые
  ресурсы сборки (`/assets/*`), в фоне обновляет мелкие статические файлы и
  заменяет неудачную навигацию одной небольшой страницей: хост недоступен или
  шлюз авторизации завершил сессию;
- **строки в `<head>`** — ссылка на манифест с `crossorigin="use-credentials"`
  (браузер запрашивает манифест без куки, и прокси с авторизацией такой запрос
  отклоняет), Apple-тег standalone, `theme-color` для обеих схем, имя
  приложения и скрипт регистрации worker'а.

Своей страницы, кнопки или настроек у плагина нет: он проявляется в значке
установки браузера и в установленном окне.

## Как установить

1. Откройте интерфейс в браузере и войдите во что бы он ни был обёрнут — вход
   плагин не меняет.
2. Один раз перезагрузите страницу, чтобы новые строки и worker начали
   отдаваться.
3. Установите из браузера:
   - Chrome / Edge — значок установки в адресной строке или **⋮** →
     **Установить DeepSeek Harness**;
   - Android Chrome — предложение установки или **⋮** → **Добавить на главный
     экран**;
   - iOS Safari — **Поделиться** → **На экран «Домой»**.
4. Установленное окно открывает тот же адрес без интерфейса браузера.

Service worker регистрируется только в защищённом контексте: нужен HTTPS (адрес
Tailscale подходит) или `localhost`.

## Что кэшируется

| Запрос | Стратегия |
| --- | --- |
| Навигация (`/`) | Только сеть, таймаут 10 с; при сбое — страница приложения |
| Навигация с 401 / 403 | Страница «сессия завершилась» со ссылкой на вход |
| Навигация с 5xx | Страница «сервер недоступен» |
| `/assets/*` (JS, CSS, шрифты с хешем) | Сначала кэш, не более 120 записей |
| Манифест, иконки, favicon | Stale-while-revalidate |
| Всё остальное (API, `/plugins/*`, потоки, WebSocket) | Не перехватывается |

Ответ попадает в кэш, только если это действительно тот файл: URL не
редиректил, тип содержимого соответствует расширению, а HTML не кэшируется
вообще. Поэтому страница входа прокси не подменит ресурс или манифест.

Оболочка — живой клиент: любой сессии нужен хост по WebSocket, поэтому имитации
офлайна нет. Страница «сервер недоступен» перезагружается, как только любой
HTTP-ответ докажет доступность пути; страница «сессия завершилась» ведёт на
страницу входа шлюза по пути **`/auth/tg`** (константа `SIGN_IN_PATH` в `sw.js`;
без такой страницы остаётся кнопка повтора).

Страница `index.html` намеренно не кэшируется: она содержит граф загрузки
текущей композиции, и устаревшая копия сломалась бы после изменения плагинов.

## Как отключить

Отключение плагина в **Plugins** прекращает отдачу `/sw.js` и подмену
манифеста, поэтому снова отдаётся штатный манифест из дистрибутива. Браузер
сохраняет уже установленное приложение и его worker, пока worker не будет
заменён или разрегистрирован: удалите приложение средствами ОС (Android/iOS)
или разрегистрируйте worker в инструментах разработчика на десктопе
(**Application** → **Service workers** → **Unregister**).

## Файлы

- `index.js` — хост-плагин: два маршрута и строки индекса.
- `sw.js` — service worker; читается на каждый запрос, поэтому его правка не
  требует перезагрузки плагина. При смене правил кэширования поднимите `VERSION`.
- `cordis.patch.yml` — вставляет строку `web-pwa`.
- `locale/*.json` — заголовок и описание для Plugin Manager.
- `icon.svg` — иконка плагина.
- `test/pwa.test.mjs` — `node --test` из этого каталога.
