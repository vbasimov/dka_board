# PWA для Claude на `/claude/`: спецификация пересборки

Дата: 2026-11-21. Автор: субагент `pwa-assets` (исследование, система не менялась).
Связанные материалы: [dsh-pwa-android.md](../dsh-pwa-android.md), [claude-runtime.md](./claude-runtime.md),
существующий плагин [`dsh-web-pwa`](../../dsh-web-pwa/README.md).

**Что проверено практикой в этой работе**

- окружение и инструменты генерации PNG (см. §4), включая `sharp` внутри DSH;
- синтаксис и порядок Caddy-маршрутов на временном Caddy v2.11.9: публичный манифест без cookie → `200`,
  `/claude/` и `/claude/sw.js` без cookie → `401`, с cookie → `200`; upstream не получает gateway-cookie,
  подделанный `X-Auth-User` заменяется проверенным (см. §7.4);
- генератор PNG без зависимостей: 5 иконок, корректный PNG, непрозрачность и safe zone (см. §4.5).

**Что НЕ проверялось**: реальная установка WebAPK на Android, Chrome DevTools/Lighthouse на этом origin,
применение Caddyfile (файл `/etc/dsh-gateway-caddy/Caddyfile` недоступен на чтение, sudo запрещён).
Для них ниже — чек-лист приёмки, а не заявленный результат.

---

## 0. TL;DR

1. Claude — **отдельное PWA-приложение** на том же origin по пути `/claude/`. Плагин `dsh-web-pwa` не
   переиспользуется как код и не меняется: у него root-scope и root-манифест, которые для Claude опасны.
2. Манифест: `id`, `start_url`, `scope` — все `/claude/` (со слешем в конце). `scope` — префикс строки,
   поэтому `/claude/` не захватывает `/claude-evil`; `scope: "/claude"` захватывал бы.
3. Service worker: файл `/claude/sw.js`, scope `/claude/` (по умолчанию, без `Service-Worker-Allowed`).
   **Не** регистрировать его на `/sw.js` и **не** выдавать `Service-Worker-Allowed: /`: это столкнётся с
   root-SW DSH.
4. Публично (без cookie) — ровно 5 install-ассетов: манифест, 192/512 any, 512 maskable, 180 apple-touch.
   Всё остальное, включая `/claude/sw.js`, `/claude/`, `/claude/assets/*`, API/SSE/WS — за авторизацией.
5. Caddy: точные `path`-матчеры, `forward_auth` только для приватной части, запрос уходит напрямую в
   Claude upstream (`127.0.0.1:3081`), а не в DSH-прокси шлюза. Префикс `/claude` **не срезать**.
6. SW: навигация только сеть (10 с таймаут), HTML не кэшируется никогда; 401/403 → страница «сессия
   истекла» со ссылкой на вход; 5xx/сеть → «сервер недоступен»; кэшируются только хешированные
   `/claude/assets/*`, с проверкой типа/редиректа/HTML и лимитом записей.
7. Обновление SW — безопасное: **без `skipWaiting()` в `install`**, новый worker ждёт, приложение
   показывает «доступно обновление», по кнопке `SKIP_WAITING` + один `location.reload()`.
8. Иконки: ImageMagick/rsvg/inkscape/PIL/canvas/resvg/Chromium в системе нет; `sharp@0.35.5` есть только
   внутри `node_modules` DSH. В `claude-code` иконок нет. Официальный знак Claude есть в
   `@anthropic-ai/sdk/.github/logo.svg`, но это trademark (Apache-2.0 не даёт прав на логотип).
   Рабочий путь: `sharp` как devDependency приложения **или** zero-dependency генератор из приложения.
9. Вложенный scope: DSH занимает `/`, Claude — `/claude/`. Это «nested paths», которые web.dev прямо не
   рекомендует: если DSH-PWA уже установлен, Chrome может не показывать установку Claude, а ссылки/уведомления
   могут уходить внешнему приложению. Ставить Claude лучше до DSH или вручную из меню Chrome; идеально —
   отдельный origin (поддомен), если это когда-нибудь станет возможно. По [dsh-pwa-android.md](../dsh-pwa-android.md)
   DSH на Android сейчас всё равно не устанавливается из-за 401 на манифесте — окно для установки Claude
   первым есть, но после починки DSH это ограничение вернётся.
10. Вход после истечения сессии: шлюз сейчас жёстко редиректит на `/` (`authflow.mjs`/`pages.mjs`), параметр
    `next` не поддерживается. SW будет вести на `/auth/tg?next=%2Fclaude%2F`, но пока это лишь заготовка:
    после входа пользователь окажется в DSH. Это зависимость от gateway, а не от PWA.

---

## 1. Контекст и допущения

Публичный вход: `https://vps-4692.tailfbc4b2.ts.net:10000/` → Tailscale Funnel → Caddy `127.0.0.1:8081`
→ auth-gateway `127.0.0.1:9090` → приложение. Cookie сессии — `__Host-dsh_session`, `Path=/`,
`HttpOnly; Secure; SameSite=Lax` (проверено по исходникам `/opt/dsh-gateway/lib/util.mjs` и `config.mjs`).

По [claude-runtime.md](./claude-runtime.md) backend Claude — Node 24 на `127.0.0.1:3081`, каталог
`/home/dsh/projects/claude-pwa`. Стек HTTP/UI в отчёте runtime не зафиксирован, поэтому ниже
спецификация дана framework-agnostic; примеры для Node/Express и для Caddy `file_server`.

Допущения, которые нужно подтвердить у `gateway-route`/`claude-runtime`:

- Claude обслуживает и HTML, и API, и WS на одном порту `:3081`; все публичные URL — под `/claude/`;
- Caddy либо проксирует `/claude/*` напрямую в `:3081` с `forward_auth` на `/verify` (рекомендуется),
  либо шлюз получает новый маршрут `/claude/*`. Второй вариант требует правок gateway: сейчас
  `gateway.mjs` всё, что не `/auth/*`, проксирует в DSH и подставляет DSH-cookie — для Claude это неверно.
- Порт `:3081` — из runtime-отчёта; в Caddy-фрагменте его надо заменить, если runtime выберет другой.

Ограничения: отчёт только читает систему; Caddyfile не изменялся, плагин `dsh-web-pwa` не изменялся.

---

## 2. Карта URL, авторизации и кэша

| URL | Авторизация | Что отдаётся | HTTP-кэш | Service worker |
|---|---|---|---|---|
| `/claude/` | да | HTML приложения (`start_url`) | `no-store` (ставит приложение) | навигация: только сеть, HTML не кэшируется |
| `/claude/manifest.webmanifest` | **нет** | статический JSON | `no-cache` + ETag | не перехватывается |
| `/claude/icons/icon-192.png` | **нет** | PNG 192×192 | `public, max-age=86400` | не перехватывается |
| `/claude/icons/icon-512.png` | **нет** | PNG 512×512 | то же | не перехватывается |
| `/claude/icons/icon-maskable-512.png` | **нет** | PNG 512×512, maskable | то же | не перехватывается |
| `/claude/icons/apple-touch-icon-180.png` | **нет** | PNG 180×180, opaque | то же | не перехватывается |
| `/claude/sw.js` | да | JS service worker | `no-cache` + ETag, без `Service-Worker-Allowed` | сам worker |
| `/claude/assets/*` | да | хешированные JS/CSS/шрифты | `immutable, max-age=31536000` | cache-first, лимит 100 |
| `/claude/api/*`, `/claude/events`, `/claude/ws` | да | JSON / SSE / WebSocket | `no-store` | **не перехватывается** |
| `/auth/tg`, `/auth/*` | нет (вход) | страницы/JSON шлюза | `no-store` | вне scope Claude SW |
| `/claude` (без слеша) | желательно публичный redirect | `308 → /claude/` | — | вне scope Claude SW |

Публичные install-ассеты — это **метаданные установки**, не интерфейс и не данные. Они не должны
зависеть от пользователя, содержать токены, имя пользователя, внутренние адреса или разный ответ по
cookie. Это важно и для WebAPK, и для обновлений манифеста.

---

## 3. Манифест

### 3.1 Ключевые решения

| Поле | Значение | Почему |
|---|---|---|
| `id` | `/claude/` | Стабильная идентичность приложения. Резолвится относительно origin `start_url` (MDN), т.е. `https://host/claude/`. Менять нельзя без потери связи с уже установленным приложением. |
| `start_url` | `/claude/` | Абсолютный публичный путь. Обязан быть внутри `scope`. Если reverse proxy режет префикс, манифест всё равно должен рекламировать `/claude/`, иначе Chrome запустит корень DSH. |
| `scope` | `/claude/` | Префикс строки; слеш в конце отсекает `/claude-evil`. `scope: "/"` захватил бы DSH и сломал бы обе PWA. |
| `display` | `standalone` | Окно без адресной строки; обязательное условие installability вместе с `display_override`. |
| `display_override` | `["standalone", "minimal-ui"]` | Явный fallback; `window-controls-overlay` не добавлять, пока UI не умеет titlebar-area. |
| `orientation` | `any` | Чат/код адаптивны; блокировка портрета раздражает на планшете. |
| `background_color` | `#D97757` | Цвет заставки; совпадает с фоном иконки, поэтому splash без шва. |
| `theme_color` | `#1F1E1D` | Тёмный статус-бар/панель; при светлой теме браузера всё равно читаемо. Можно заменить на брендовый `#D97757`, если нужен терракотовый chrome. |
| `name` | `Claude` | Полное имя в splash/установке. Если рядом стоит официальное приложение Claude, лучше `Claude (self-hosted)` — но тогда `short_name` всё равно `Claude`. |
| `short_name` | `Claude` | ≤ 12 символов, не обрезается на Android. |
| `description` | короткое, без хвоста | Публичный файл; не писать внутренние адреса/имена. |
| `lang`/`dir` | `en`/`ltr` (или `ru`, если UI русский) | Один язык на манифест; не делать манифест зависимым от пользователя. |
| `categories` | `["productivity", "developer"]` | Категории Chrome; безвредны. |
| `prefer_related_applications` | `false` | Нативного приложения нет. |
| `icons` | 192 any, 512 any, 512 maskable | PNG, точные размеры; для WebAPK SVG не использовать. |
| `shortcuts` | только реальные маршруты | Каждый URL должен открываться; лучше 1–3, а не 5 мёртвых. |
| `screenshots` | пока **не добавлять** | Их тоже может забирать установщик без cookie; публичный список придётся расширять. |

`scope` и `start_url` — **обязательно с завершающим слешем**. Это не косметика: при `scope: "/claude"`
Chrome считает in-scope и `/claude-evil` (префиксное совпадение), а `start_url: "/claude"` без слеша
формально не попадает в `scope: "/claude/"` — придётся либо редиректить, либо менять scope; лишняя
точка отказа при установке.

### 3.2 JSON-пример

```json
{
  "id": "/claude/",
  "name": "Claude",
  "short_name": "Claude",
  "description": "Self-hosted Claude workspace: chats and coding sessions in the browser.",
  "lang": "en",
  "dir": "ltr",
  "start_url": "/claude/",
  "scope": "/claude/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#D97757",
  "theme_color": "#1F1E1D",
  "categories": ["productivity", "developer"],
  "prefer_related_applications": false,
  "icons": [
    {
      "src": "/claude/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/claude/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/claude/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "shortcuts": [
    {
      "name": "New chat",
      "short_name": "New",
      "description": "Start a new Claude session",
      "url": "/claude/?new=1"
    }
  ]
}
```

`shortcuts[0]` — **placeholder**: оставить только если `?new=1` действительно создаёт новый чат. Если
добавляются иконки шорткатов (`96x96`), их пути тоже придётся внести в публичный список Caddy.
`?new=1` не меняет `id` и находится в scope.

### 3.3 Префикс и reverse proxy: что важно

- **Рекомендуется не срезать `/claude`**: приложение монтируется на `/claude/` (`app.use('/claude', …)`,
  Next.js `basePath: '/claude'`, Vite `base: '/claude/'`). Тогда все ссылки, API, WS и статика естественно
  остаются под префиксом.
- Если Caddy делает `handle_path /claude/*` (срезает префикс), приложение видит `/`, и обязано:
  1. генерировать HTML/asset-URL с публичным префиксом `/claude/` (через `X-Forwarded-Prefix: /claude`
     или собственный `BASE_PATH`);
  2. не отдавать редиректы вида `Location: /login` — они выбросят браузер из `/claude/`;
  3. возвращать манифест с абсолютными `/claude/...`, а не с `/...`;
  4. регистрировать SW по публичному `/claude/sw.js` (браузер видит именно его).
- Если приложение не prefix-aware, срез префикса — главный источник «манифест есть, но `start_url`
  открывает DSH» и «ассеты 404». Лучше не срезать.
- `/claude` без слеша: желателен `308 → /claude/` **до** авторизации (публичный редирект, данных не
  отдаёт). Иначе пользователь, набравший путь без слеша, получит 401 от шлюза.
- Все API/WS приложения — под `/claude/` (`/claude/api`, `/claude/ws`). Root-relative `/api` уйдёт в DSH,
  потому что Caddy-маршрут для Claude — только `/claude/*`.

### 3.4 Обновления манифеста и идентичность

- URL манифеста (`/claude/manifest.webmanifest`) и `id` должны быть стабильными. Смена URL манифеста
  может остановить обновления установленного приложения; смена `id` создаёт **второе** приложение.
- Android Chrome проверяет манифест примерно раз в сутки при запуске; изменения `name`, `short_name`,
  `icons`, `background_color`, `display`, `orientation`, `scope`, `shortcuts`, `start_url`, `theme_color`
  приводят к пересборке WebAPK. Поэтому манифест — статический, без пользовательских данных.
- Публичный манифест позволяет Chrome обновлять метаданные даже когда сессия истекла. Если манифест
  закрыть авторизацией, установка WebAPK ломается (minter ходит без cookie), а обновления могут
  откладываться до 30 дней.
- Desktop Chrome не обновляет иконки установленного PWA (только Android) — это ограничение браузера,
  не повод менять URL иконок.

---

## 4. Иконки: чем генерировать и какие

### 4.1 Что есть в системе (проверено)

| Инструмент | Результат |
|---|---|
| ImageMagick (`convert`, `magick`, `identify`) | нет |
| `rsvg-convert`, `inkscape` | нет |
| `ffmpeg`, `wkhtmltoimage`, `weasyprint` | нет |
| Python PIL/Pillow, cairosvg, numpy | нет |
| Python `gi` + Rsvg/GdkPixbuf | `gi` есть, Rsvg/GdkPixbuf namespace — нет |
| Node `sharp`, `canvas`, `@resvg/resvg-js`, `pngjs`, `jimp` в проекте Claude | не установлены (в DSH есть только `sharp`, см. ниже) |
| Chromium/Chrome/Firefox | нет |
| `sharp` внутри DSH | **есть**: `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp` v0.35.5, рабочий |
| Иконки в `@anthropic-ai/claude-code@2.1.329` | **нет**: в пакете только `bin/claude.exe` (ELF), `cli-wrapper.cjs`, `install.cjs`, `sdk-tools.d.ts`; в 377 МБ бинарнике PNG-ресурсов, пригодных для иконки, не найдено (встроенные SVG-фрагменты — не готовые иконки приложения; извлекать их из бинарника не следует) |
| Официальный знак Claude | `@anthropic-ai/sdk/.github/logo.svg` (248×248, path, `#D97757`), но это **trademark**; Apache-2.0 §6 не даёт прав на логотип |

Вывод: «из коробки» генератора нет; `sharp` в DSH — случайная зависимость, импортировать её из
`/usr/lib/node_modules/@deepseek-ai/dsh/...` в продакшн нельзя (сломается при обновлении DSH).
`claude-code` готовых иконок не содержит — скрапить бинарник не нужно и небезопасно.

### 4.2 Матрица иконок

| Файл | Размер | `purpose` | Требования |
|---|---|---|---|
| `icon-192.png` | 192×192 | `any` | PNG 8-bit; непрозрачный фон предпочтителен (иначе Android покажет белый круг) |
| `icon-512.png` | 512×512 | `any` | то же; используется для splash/установки |
| `icon-maskable-512.png` | 512×512 | `maskable` | full-bleed непрозрачный фон; значимая часть — в круге радиусом 40% (80% диаметра); без прозрачных краёв |
| `apple-touch-icon-180.png` | 180×180 | — (link apple-touch-icon) | PNG, opaque, без прозрачности; iOS сам скругляет |
| `icon-96.png` | 96×96 | — (shortcut icon) | опционально; если используется в `shortcuts[].icons` — публичный путь |
| `favicon-32.png` / `favicon.svg` | 32×32 / vector | — | опционально; favicon не нужен WebAPK-установщику |

Не использовать SVG в `manifest.icons` для WebAPK: Chrome может принять SVG для installability, но
maskable/WebAPK надёжно работают с PNG (это же подтверждает [dsh-pwa-android.md](../dsh-pwa-android.md)).
Не полагаться на `"any maskable"` для одной иконки: у any и maskable разные требования к полям.

### 4.3 Вариант A (рекомендуемый): `sharp` как devDependency приложения

`sharp` уже доказал работоспособность на этом VPS (DSH его использует). В репозитории Claude:

```bash
cd /home/dsh/projects/claude-pwa
npm i -D sharp            # локально, не глобально; в package-lock
```

`scripts/gen-icons.mjs`:

```js
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'

const svg = await readFile('assets/claude-mark.svg') // официальный SVG или собственный
const jobs = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon-180.png', 180],
  ['icon-96.png', 96],
]
for (const [name, size] of jobs) {
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain', background: '#D97757' })
    .flatten({ background: '#D97757' }) // непрозрачный фон
    .png({ compressionLevel: 9 })
    .toFile(`public/claude/icons/${name}`)
}

// maskable: тот же знак, но с полями; фон full-bleed, знак ~70–78% кадра
await sharp(svg, { density: 384 })
  .resize(360, 360, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: 76, bottom: 76, left: 76, right: 76, background: '#D97757' })
  .flatten({ background: '#D97757' })
  .png({ compressionLevel: 9 })
  .toFile('public/claude/icons/icon-maskable-512.png')
```

Если используется официальный знак, его нужно либо положить в `assets/` с уведомлением о правах, либо
не коммитить в публичный репозиторий. **Важно:** `assets/claude-mark.svg` должен быть подготовлен под
фон — например, светлый знак на прозрачном фоне для терракотовой подложки. Если скормить `sharp`
исходный терракотовый знак с прозрачным фоном и залить фон `#D97757`, знак станет невидимым. Для
maskable официальный знак надо перекрасить (светлый на терракотовом) и уместить в safe zone, а не просто
отмасштабировать.

### 4.4 Вариант B: ноль зависимостей

Если ставить `sharp` нельзя, подходит чистый Node-скрипт: рисует геометрический знак (чат-облако с
хвостом и тремя точками) в RGBA-буфер, кодирует PNG через `node:zlib` (CRC32 + IHDR/IDAT/IEND),
делает 4× supersampling для сглаживания. Полный скрипт — в Приложении D. Проверено на Node v24.22.3:

```
icon-192.png            192x192  1347 B
icon-512.png            512x512  4151 B
icon-maskable-512.png   512x512  4002 B
apple-touch-icon-180.png 180x180 1244 B
icon-96.png              96x96    692 B
```

Проверка: `file` — PNG 8-bit/color RGBA, non-interlaced; `sharp` читает; alpha min = 255 (все
непрозрачные); максимальный радиус значимых пикселей: maskable 139.1 px при лимите 204.8 px (40% от
512), any 178.2 px, apple 56.4 px при лимите 72 px. Время генерации — ~4.2 с на все 5 иконок.

Ограничение варианта B: он не растеризует произвольный SVG. Если нужен именно официальный знак,
либо используйте `sharp`/`rsvg-convert` на машине сборки, либо берите нейтральный знак. Для приватного
PWA нейтральный знак даже безопаснее с точки зрения бренда.

### 4.5 Бренд и лицензия

- `@anthropic-ai/claude-code` не содержит иконок; официальный знак лежит в dev-каталоге SDK, а не в
  публичном API пакета. Apache-2.0 §6 прямо исключает trademark-права, поэтому «взял из SDK» — не
  лицензионное основание для распространения.
- Для **личного** self-hosted приложения номинативное использование знака Claude обычно допустимо, но
  если репозиторий/сборка публикуются — нужен нейтральный знак или разрешение Anthropic. В отчёте
  используется нейтральный знак как fallback; официальный — только по решению владельца.
- Имя приложения `Claude` без пометки «self-hosted» может выглядеть как официальное приложение.
  `name: "Claude (self-hosted)"`, `short_name: "Claude"` — компромисс; решает владелец.
- Не добавлять в PNG метаданные (EXIF/текст): публичные файлы не должны содержать ничего лишнего.

### 4.6 Валидация иконок

```bash
file public/claude/icons/*.png
node -e "const s=require('sharp'); for (const f of process.argv.slice(1)) s(f).metadata().then(m=>console.log(f,m.width,m.height,m.channels))" public/claude/icons/*.png
```

В DevTools → Application → Manifest → Icons включить «Show only the minimum safe area for maskable
icons» и убедиться, что знак не обрезан. Дополнительно — [maskable.app](https://maskable.app/).
`apple-touch-icon` проверить на iOS: прозрачности быть не должно.

---

## 5. Service worker

### 5.1 Файл, scope, заголовки

- URL: `/claude/sw.js`; scope по умолчанию — `/claude/` (каталог скрипта). **Не** отправлять
  `Service-Worker-Allowed: /`; если очень нужно явно — только `Service-Worker-Allowed: /claude/`.
- `Content-Type: text/javascript; charset=utf-8`; `Cache-Control: no-cache` + ETag; без редиректов;
  без `Content-Disposition`; `X-Content-Type-Options: nosniff`.
- Скрипт приватный: без cookie `401`, не `302` на login (иначе регистрация падает на редиректе).
- Регистрация: `{ scope: '/claude/', updateViaCache: 'none' }`. `updateViaCache: 'none'` заставляет
  браузер проверять сам скрипт по сети, но сервер всё равно должен отдавать `no-cache`/ETag.
- Почему не `/sw.js`: этот путь занят DSH worker'ом со scope `/`. Второй worker на тот же URL/scope
  заменит DSH; более специфичный `/claude/sw.js` живёт рядом и перехватывает только `/claude/`.

### 5.2 Что кэшируется

| Запрос | Стратегия | Кэш |
|---|---|---|
| Навигация (`request.mode === 'navigate'`) | network-only, таймаут 10 с; 401/403 → страница «сессия истекла»; 5xx/сеть → «сервер недоступен» | **никогда** |
| `/claude/assets/*` (хешированные JS/CSS/шрифты) | cache-first + bounded runtime cache | `claude-pwa-assets-vN` |
| `/claude/manifest.webmanifest` | не перехватывать (network) | — |
| `/claude/icons/*`, favicon | не перехватывать (пусть работает HTTP-кэш) | — |
| `/claude/api/*`, `/claude/events`, `/claude/ws` | не перехватывать | — |
| `/claude/sw.js` | не перехватывать | — |
| Всё остальное | не перехватывать | — |

Только статика. Никаких API-ответов, SSE, WS, HTML, пользовательских файлов, транскриптов и
изображений из чата в Cache Storage попадать не должно. Кэш ассетов ограничен (например, 100 записей)
и чистится от старых при активации.

### 5.3 Навигация и страницы ошибок

Алгоритм:

1. `fetch(event.request)` с `AbortController` на 10 с.
2. `401`/`403` → синтезированная страница «Сессия завершилась», кнопки «Войти» (`/auth/tg?next=%2Fclaude%2F`)
   и «Повторить». Без формы пароля, без ввода данных, без отражения URL.
3. `5xx`, сеть, таймаут → страница «Сервер Claude недоступен» с «Повторить» и авто-повтором по `online`
   и раз в 15 с (проба `HEAD /claude/manifest.webmanifest` без кэша).
4. Редирект, конечный URL которого вне `/claude/` (например, `/auth/tg`), — это подмена login-страницей:
   показывать страницу «сессия истекла», **не** возвращать login HTML и **не** кэшировать.
5. `200`, но `Content-Type` не `text/html` (JSON прокси) — не отдавать как страницу; показать
   «сервер недоступен»/«сессия истекла» в зависимости от статуса/URL.
6. `404` и прочие 4xx (кроме 401/403) — вернуть ответ приложения; это могут быть его собственные
   страницы/ошибки.
7. Успешный HTML — вернуть как есть, никогда не сохранять.

Страницы ошибок — статические строки, локализация по `navigator.language` (en/ru), инлайн-CSS.
Заголовки ответа: `Cache-Control: no-store`, `Content-Type: text/html; charset=utf-8`,
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Никаких `Set-Cookie`.

### 5.4 Защита кэша от подмены

Ответ попадает в кэш только если:

- `response.ok`, `response.type === 'basic'`, `!response.redirected`, `response.url === request.url`;
- нет `Content-Range`/`206`;
- `Cache-Control` не содержит `no-store`;
- `Content-Type` не `text/html` и соответствует расширению (`.js` → `text/javascript`, `.css` →
  `text/css`, шрифты → `font/`, изображения → `image/*`);
- запрос не имеет `Authorization`, не `Range`, не SSE (`Accept: text/event-stream`), не cross-origin.

Это те же идеи, что в [`sw.js`](../../dsh-web-pwa/sw.js) DSH, но с путями `/claude/` и отдельным
префиксом кэша. Прокси, отдавший login-страницу с `200 text/html`, не должен заменить ни ассет, ни
манифест.

### 5.5 Обновление worker'а (безопасное)

- В `install` **не** вызывать `skipWaiting()`. Новый worker остаётся в `waiting`, пока все вкладки
  приложения не закроются или пользователь не подтвердит обновление.
- Приложение слушает событие `updatefound` и проверяет `registration.waiting`/`worker.state === 'installed'`,
  затем показывает «Доступно обновление — Перезагрузить». По кнопке:
  `worker.postMessage({ type: 'SKIP_WAITING' })`.
- SW по сообщению вызывает `self.skipWaiting()`; страница ловит `controllerchange` и делает **один**
  `location.reload()`.
- `activate`: удалить только кэши с префиксом `claude-pwa-`, которых нет в текущем наборе; **не**
  трогать `dsh-web-pwa-*` и чужие кэши. `clients.claim()` допустим: при обычном обновлении активация
  происходит после закрытия старых клиентов или после явного `SKIP_WAITING`.
- Проверка обновлений: `registration.update()` при возврате на вкладку, не чаще раза в час; не на
  каждый route change.
- Почему не авто-`skipWaiting`: приложение живое (SSE/WS, несохранённый ввод). Мгновенная подмена
  worker'а может смешать старую страницу с новыми правилами кэша; лучше дать пользователю сохранить
  состояние и перезагрузиться осознанно.

### 5.6 Сосуществование с DSH worker'ом

- DSH SW (`/sw.js`, scope `/`) остаётся. Пока Claude SW не активировался, первый заход на `/claude/`
  может контролироваться DSH worker'ом: его `navigate()` покажет DSH-страницу при 401 и он может
  положить `/claude/assets/*` в свой кэш. Это временно и не ломает данные, но UX стоит проверить.
- Claude SW с scope `/claude/` после активации перехватывает только свой префикс. Root-scope ему давать
  нельзя.
- Опциональный follow-up (не в этой задаче): научить DSH SW не трогать `/claude/*` (сейчас плагин
  менять запрещено).

### 5.7 Тесты SW

Перенести подход из [`test/pwa.test.mjs`](../../dsh-web-pwa/test/pwa.test.mjs): VM + double для
`caches`/`fetch`. Проверить:

- `install` не вызывает `skipWaiting`;
- `activate` удаляет только `claude-pwa-*` и сохраняет `dsh-web-pwa-*`;
- навигация никогда не попадает в кэш; 401 → страница входа; 403; 5xx; таймаут; редирект на login;
- HTML/JSON/редирект/`206` не кэшируются; чужой origin и API/SSE не перехватываются;
- лимит кэша ассетов; `SKIP_WAITING` обрабатывается;
- заголовки SW: `text/javascript`, `no-cache`, нет `Service-Worker-Allowed: /`;
- манифест: пути `/claude/`, иконки существуют и совпадают по размерам.

---

## 6. `<head>` и регистрация

### 6.1 Строки в `<head>`

Порядок важен: манифест — один, до любых framework-манифестов. Если шаблон приложения уже вставляет
свой `<link rel="manifest">`, его нужно убрать, а не дублировать.

```html
<link rel="manifest" href="/claude/manifest.webmanifest" crossorigin="use-credentials">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F0EEE6">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1F1E1D">
<meta name="application-name" content="Claude">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Claude">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="apple-touch-icon" sizes="180x180" href="/claude/icons/apple-touch-icon-180.png">
<link rel="icon" href="/claude/icons/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/claude/icons/favicon-32.png" sizes="32x32" type="image/png">
```

- `crossorigin="use-credentials"` — страховка на случай, если манифест когда-нибудь снова закроют
  авторизацией; для публичного same-origin манифеста он безвреден.
- `apple-mobile-web-app-status-bar-style`: `default` безопасен. `black-translucent` требует
  `viewport-fit=cover` и ручных safe-area отступов — иначе контент уедет под вырез.
- `theme-color` meta задаёт цвет браузерной панели; манифестный `theme_color` — цвет установленного
  приложения/панели задач. Они могут различаться (светлая/тёмная тема).
- `viewport`: `width=device-width, initial-scale=1`; `viewport-fit=cover` только если UI реально
  обрабатывает `env(safe-area-inset-*)`.
- `<base href="/claude/">` допустим, но регистрацию и манифест всё равно писать абсолютными путями.
- Относительные пути (`href="manifest.webmanifest"`, `icons/icon-192.png`, `register('sw.js')`) на
  странице `/claude/` резолвятся в `/claude/...` и тоже работают. Но при заходе на `/claude` без слеша
  или при чужом `<base href="/">` они уедут в корень; поэтому абсолютные `/claude/...` надёжнее.
  Если используете относительный `register('sw.js')`, всё равно передавайте `scope: '/claude/'` явно.

### 6.2 Регистрация и update UX

```html
<script>
(() => {
  if (!('serviceWorker' in navigator)) return
  const BASE = '/claude/'
  let updateRequested = false
  let reloading = false
  let registration = null

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return
    reloading = true
    location.reload()
  })

  function offer(worker) {
    if (!worker || !navigator.serviceWorker.controller) return
    window.dispatchEvent(new CustomEvent('claude:pwa-update', { detail: { worker } }))
  }

  window.claudePwa = {
    update(worker) {
      updateRequested = true
      worker?.postMessage({ type: 'SKIP_WAITING' })
    },
    get registration() { return registration },
  }

  addEventListener('load', async () => {
    try {
      registration = await navigator.serviceWorker.register(`${BASE}sw.js`, {
        scope: BASE,
        updateViaCache: 'none',
      })
      if (registration.waiting) offer(registration.waiting)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') offer(worker)
        })
      })
      let lastCheck = 0
      addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (Date.now() - lastCheck < 60 * 60 * 1000) return
        lastCheck = Date.now()
        registration.update().catch(() => {})
      })
    } catch (error) {
      console.warn('claude pwa: service worker registration failed', error)
    }
  })
})()
</script>
```

Приложение должно слушать `claude:pwa-update` и показать свой toast/banner с кнопкой, вызывающей
`window.claudePwa.update(worker)`. Если UI ещё нет, можно добавить минимальный встроенный banner —
но не авто-перезагрузку.

Регистрация после `load`, чтобы не конкурировать с boot приложения; `updateViaCache: 'none'` — чтобы
не залипнуть на старом SW. `scope` задаётся явно, хотя совпадает с дефолтным.

---

## 7. Caddy: публичные install-ассеты и маршрут `/claude/*`

### 7.1 Точный публичный список

```
/claude/manifest.webmanifest
/claude/icons/icon-192.png
/claude/icons/icon-512.png
/claude/icons/icon-maskable-512.png
/claude/icons/apple-touch-icon-180.png
```

Почему именно это:

- **Манифест и иконки** нужны WebAPK minter'у, который скачивает их по публичному URL **без cookie**
  (это же зафиксировано в [dsh-pwa-android.md](../dsh-pwa-android.md)). Без них Chrome на Android
  отвечает «app cannot be installed».
- **`/claude/sw.js` не публикуем**: его забирает браузер с сессией; публичный доступ к скрипту не нужен
  для установки и расширяет поверхность. Если сессия истекла, обновление SW просто не произойдёт до входа.
- **`/claude/` не публикуем**: это HTML приложения; публичный доступ = обход auth.
- **`/claude/assets/*` не публикуем**: для установки не нужны; отдаются после входа.
- **`/claude/api/*`, `/claude/events`, `/claude/ws`** — никогда.
- **`/claude/icons/*` целиком не открываем**: только точные 4 файла. Wildcard может случайно открыть
  исходники/черновики иконок.
- Если появятся `screenshots` или `shortcuts[].icons` — добавить **точные** пути в список и в манифест,
  а не открывать каталог.

Ключевой момент: Caddy-байпас бесполезен, если upstream-приложение всё равно требует сессию на этих
путях. Поэтому либо:
- **вариант A**: приложение отдаёт эти 5 путей без auth (явный allowlist перед auth-middleware), либо
- **вариант B**: Caddy `file_server` отдаёт их из отдельного каталога, и приложение о них не знает.

Вариант B безопаснее (auth-баг приложения не откроет лишнего), но требует caddy-читаемого каталога:
`/home/dsh` имеет режим `0750 dsh:dsh`, поэтому Caddy под пользователем `caddy` **не сможет** читать
`/home/dsh/projects/claude-pwa`. Нужен `/srv/claude-pwa` (или `/var/lib/claude-pwa`) с `0755`/`0644`.

Если выбран вариант A, публичный allowlist в приложении должен быть **точным** и стоять **до**
auth-middleware. Пример для Express:

```js
const PUBLIC_PWA = new Set([
  '/claude/manifest.webmanifest',
  '/claude/icons/icon-192.png',
  '/claude/icons/icon-512.png',
  '/claude/icons/icon-maskable-512.png',
  '/claude/icons/apple-touch-icon-180.png',
])

app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PWA.has(req.path)) {
    return servePwaFile(req, res) // sendFile + Content-Type/Cache-Control/ETag
  }
  next()
})
app.use(requireAuth) // только после публичного allowlist
```

Нельзя делать `app.use('/claude', express.static(publicDir))` — это откроет весь каталог и, при
`index.html`, ещё и HTML. В Next.js аналогично: исключить эти 5 путей в `middleware.ts` matcher (или
отдавать их до middleware), иначе framework вернёт login/404. Проверить, что middleware не делает
redirect на `/login` для публичных путей.

### 7.2 Вариант A: приложение отдаёт install-ассеты, Caddy — только байпас auth

Проверенный на временном Caddy v2.11.9 фрагмент (порядок `route`/`handle` сохранён):

```caddyfile
:10000 {
	# ... существующие security headers / encode / log ...

	route /claude/* {
		# Публичные install-ассеты: точные пути, GET/HEAD, без forward_auth.
		@install path /claude/manifest.webmanifest /claude/icons/icon-192.png /claude/icons/icon-512.png /claude/icons/icon-maskable-512.png /claude/icons/apple-touch-icon-180.png
		handle @install {
			reverse_proxy 127.0.0.1:3081
		}

		# Всё остальное под /claude/: сначала проверка сессии, потом приложение.
		handle {
			# Порядок внутри route важен: удалить клиентский identity-заголовок
			# ДО forward_auth, иначе copy_headers либо не сработает, либо оставит подделку.
			route {
				request_header -X-Auth-User
				forward_auth 127.0.0.1:9090 {
					uri /verify
					copy_headers X-Auth-User
				}
				reverse_proxy 127.0.0.1:3081 {
					header_up -Cookie
					flush_interval -1
				}
			}
		}
	}

	# ... существующий catch-all для DSH ...
}
```

Проверено на мок-серверах: без cookie `/claude/manifest.webmanifest` → `200` и `/verify` не вызывается;
`/claude/` и `/claude/sw.js` без cookie → `401`; с cookie → `200`; upstream не видит `Cookie`; при
`X-Auth-User: evil` + валидной cookie upstream видит `test` (значение от `/verify`), а не `evil`.

Если identity-заголовок не нужен (single-user приложение), `request_header`/`copy_headers` можно убрать:

```caddyfile
handle {
	forward_auth 127.0.0.1:9090 {
		uri /verify
	}
	reverse_proxy 127.0.0.1:3081 {
		header_up -Cookie
		flush_interval -1
	}
}
```

`header_up -Cookie` означает, что Claude-приложение **не получает** `__Host-dsh_session`. Это осознанный
контракт: аутентификация — на Caddy/шлюзе, приложение доверяет только loopback-трафику от Caddy. Если
приложению нужна собственная сессия, не смешивайте её с gateway-cookie: либо пропускайте cookie и
валидируйте её сами (плохо), либо заведите отдельную cookie/токен приложения. Решение фиксируется в
`gateway-route`, но PWA-слой от него не зависит.

### 7.3 Вариант B: Caddy сам отдаёт install-ассеты

```caddyfile
route /claude/* {
	@install path /claude/manifest.webmanifest /claude/icons/icon-192.png /claude/icons/icon-512.png /claude/icons/icon-maskable-512.png /claude/icons/apple-touch-icon-180.png
	handle @install {
		root * /srv/claude-pwa
		header Cache-Control "public, max-age=86400"
		@manifest path /claude/manifest.webmanifest
		header @manifest Cache-Control "no-cache"
		header @manifest Content-Type "application/manifest+json; charset=utf-8"
		file_server
	}
	handle {
		forward_auth 127.0.0.1:9090 {
			uri /verify
		}
		reverse_proxy 127.0.0.1:3081 {
			flush_interval -1
		}
	}
}
```

Раскладка: `/srv/claude-pwa/claude/manifest.webmanifest`, `/srv/claude-pwa/claude/icons/...`.
Требования: `0755` на каталоги, `0644` на файлы, владелец/группа с доступом для `caddy`; `browse` не
включать; в каталоге не должно быть ничего, кроме публичных файлов. Проверить, что Caddy отдаёт
`.webmanifest` как `application/manifest+json` (иначе `header @manifest Content-Type ...` обязателен) и
что `file_server` не перетирает этот заголовок — проверить `curl -I`.
Плюс: приложение вообще не участвует в публичной выдаче. Минус: манифест/иконки нужно синхронизировать
из сборки атомарно (temp + rename), иначе WebAPK может поймать половину файла.

### 7.4 Порядок директив — главный подводный камень

- `handle`-блоки взаимоисключающие, но сортируются по матчерам; `route` сохраняет порядок директив.
  Внутри `handle` Caddy переупорядочивает `request_header`/`forward_auth`/`reverse_proxy`, поэтому
  «удалить клиентский `X-Auth-User`, проверить сессию, скопировать проверенный заголовок» работает
  только в `route` (проверено: в `handle` заголовок удалялся уже после `copy_headers`).
- Если `forward_auth` в существующем Caddyfile стоит **на уровне сайта**, он выполнится и для
  `/claude/*`, включая публичные install-ассеты. Тогда:
  - либо перенесите его в DSH catch-all `handle`;
  - либо исключите Claude из его матчера: `@needs_auth not path /claude/*` (а `/claude/*` проверяет
    собственный `forward_auth` внутри route);
  - либо, как минимум, исключите точные install-пути.
- Если конфиг обёрнут в `route { ... }`, вставьте блок `/claude/*` **первым внутри** этого `route`.
- Валидация и просмотр адаптированного порядка:

```bash
sudo caddy validate --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile
sudo caddy adapt --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile --pretty | less
```

`caddy adapt --pretty` покажет, что `@install`-route идёт раньше fallback и что `/claude/*` не поглощён
catch-all. Без этого не перезагружайте Caddy.

### 7.5 Заголовки, SSE/WS, префикс

- Публичные ассеты: `Cache-Control: no-cache` (манифест), `public, max-age=86400` (иконки), ETag;
  никаких `Set-Cookie`, `Vary: Cookie`, `WWW-Authenticate`.
- Если site-level `header Cache-Control no-store` стоит на всём сайте — переопределить внутри
  `@install`, иначе WebAPK/minter получит `no-store` (установка может не сломаться, но кэш и обновления
  будут вести себя непредсказуемо).
- Приложение: `text/html` → `no-store`; API → `no-store`; `assets` → `immutable`; SW → `no-cache`.
- SSE: `flush_interval -1` (Caddy не буферизует поток). Если включён `encode`, проверить, что SSE не
  залипает; при необходимости исключить `/claude/events` из `encode`.
- WebSocket: `reverse_proxy` сам обрабатывает Upgrade; отдельный `flush_interval` не нужен. `forward_auth`
  для WS Caddy выполняет как GET `/verify` с Upgrade — шлюз это поддерживает (см. `gateway.mjs`).
- CSRF: `SameSite=Lax` не отправляет cookie на cross-site POST, но не полагайтесь только на это.
  Приложение (или Caddy) должно проверять `Origin`/`Sec-Fetch-Site` для небезопасных методов, потому что
  маршрут `/claude/*` обходит `checkOrigin` шлюза. Для GET-навигаций это не требуется.
- Префикс: не срезать. Если всё же `handle_path`, добавить `header_up X-Forwarded-Prefix /claude` и
  научить приложение строить публичные URL; иначе `start_url`/ассеты уедут в корень.
- `/claude` → `/claude/` (308) можно сделать публично до auth; это не install-ассет, данных не отдаёт.

### 7.6 Чего не делать

- Не добавлять `/claude/*` или `/claude/icons/*` в публичный matcher.
- Не добавлять `/claude/sw.js`, `/claude/`, `/claude/assets/*`, `/claude/api/*`.
- Не направлять публичные install-ассеты на DSH `:3080` или на gateway `:9090` «как в DSH-доке»: для
  Claude upstream — `:3081`; иначе манифест будет DSH или 401.
- Не открывать листинг каталога и не класть в публичный каталог `.map`, `.env`, исходники.
- Не делать `reverse_proxy` без `header_up -Cookie`/identity-контракта, если решение — «приложение не
  видит gateway-cookie».

---

## 8. Угрозы и меры

| Угроза | Мера |
|---|---|
| Публичные install-ассеты раскрывают лишнее | Только 5 точных путей; статический контент; никакой персонализации; приложение не отдаёт по ним HTML/API |
| Login-страница прокси попадает в кэш и подменяет ассет/манифест | `cacheable()`: `!redirected`, URL совпадает, не HTML, тип по расширению, не `no-store`; навигация не кэшируется вообще |
| SW с root-scope перехватывает DSH | SW только `/claude/sw.js`, scope `/claude/`, без `Service-Worker-Allowed: /` |
| Подделка identity-заголовка (`X-Auth-User`) | `route`-порядок: удалить клиентский заголовок до `forward_auth`, скопировать проверенный после; либо не передавать identity вовсе; приложение слушает только loopback |
| CSRF на `/claude/api/*` в обход gateway | `SameSite=Lax` + проверка `Origin`/`Sec-Fetch-Site` для POST/PUT/PATCH/DELETE; не полагаться на cookie |
| XSS/фишинг в синтезированных страницах | Статические строки, без отражения URL/заголовков, без формы пароля, CSP, `no-store` |
| Устаревший SW/ассеты после деплоя | `VERSION` + `claude-pwa-` префикс; `updateViaCache: 'none'`; кнопка обновления; bounded cache |
| Вложенный scope и перехват ссылок | По возможности отдельный origin; иначе уникальный `id`, scope `/claude/`, установка Claude до DSH/вручную; принять ограничения |
| Общие localStorage/IndexedDB с DSH | Неймспейс ключей `claude:`; не трогать ключи DSH; помнить, что очистка site data затронет оба приложения |
| Публичный манифест как fingerprint | Никаких внутренних адресов/имён/токенов; только имя, описание, иконки, start_url |
| Подмена `/claude` без слеша | Публичный 308 на `/claude/`; не отдавать HTML |

---

## 9. Отличия от `dsh-web-pwa`

### 9.1 Что переиспользовать

| Идея/код | Как использовать |
|---|---|
| `staticResource()` с ETag/304/405 (`index.js`) | Скопировать для `/claude/manifest.webmanifest` и `/claude/sw.js`; заменить пути/типы |
| `cacheable()`/`remember()`/`prune()` (`sw.js`) | Скопировать с путями `/claude/`; сохранить проверки HTML/редиректа/типа |
| `navigate()` с таймаутом и страницами 401/5xx | Скопировать, заменить тексты/бренд/sign-in |
| Локализованные страницы en/ru | Переиспользовать структуру; добавить «session expired»/«unreachable» для Claude |
| Регистрация после `load`, `updateViaCache: 'none'` | Переиспользовать; добавить update-banner вместо `skipWaiting` |
| Идея head-строк (`webserver/index-inject`) | В standalone-приложении — шаблон/серверный HTML, не Cordis-событие |
| Тесты VM + Cache/fetch doubles | Скопировать `test/pwa.test.mjs` и адаптировать пути/кэши |
| Caddy-паттерн «точный публичный matcher перед auth» | Использовать, но направить в Claude upstream и расширить на `/claude/*` |

### 9.2 Что переписать

| Область | Почему |
|---|---|
| `id`/`start_url`/`scope` | `/claude/` вместо `/`; иначе Claude захватит DSH |
| `name`/`short_name`/`description`/цвета | Бренд Claude, а не DSH |
| Иконки | Свои PNG 192/512/maskable/180; не root-иконки dist |
| Путь SW и scope | `/claude/sw.js`; без `Service-Worker-Allowed: /` |
| Кэши | Префикс `claude-pwa-`; `activate` не удаляет `dsh-web-pwa-*` |
| `skipWaiting` | Убрать из `install`; обновление по кнопке |
| Статические пути | `/claude/assets/*`, `/claude/icons/*`; не `/assets/*` |
| Публичный список | `/claude/*`-точки; не root `/manifest`, `/icon-*` |
| Sign-in | `/auth/tg?next=%2Fclaude%2F` (шлюз пока игнорирует `next`) |
| Интеграция | Шаблон/сервер приложения, а не Cordis-плагин; отдельный деплой |
| Caddy upstream | `:3081`, не `:3080`; не через DSH-прокси шлюза |

### 9.3 DSH-специфичные поля, которые не подходят

- `id: "/"`, `start_url: "/"`, `scope: "/"` — конфликт с DSH.
- `name: "DeepSeek Harness"`, `short_name: "DSH"`, `description` DSH, `theme_color/background_color #151517`.
- `icons: /icon-192.png, /icon-512.png, /icon-maskable-512.png` — root-пути и чужая айдентика.
- `/sw.js` + `service-worker-allowed: "/"` — root-scope, заменит/пересечётся с DSH SW.
- `PRECACHE_PATHS` и `STATIC_PATHS` с root-путями; `SHELL_CACHE`/`ASSET_CACHE` с `dsh-web-pwa-` префиксом.
- `skipWaiting()` в `install` и немедленный `clients.claim()` — для live-приложения слишком агрессивно.
- `webserver/index-inject` — API Cordis-плагина DSH; у standalone-приложения его нет.
- Комментарии/тексты про «Host»/«DSH server» — заменить на Claude.

---

## 10. Чек-лист приёмки

### 10.1 Публичные и приватные пути (curl без cookie)

```bash
BASE=https://vps-4692.tailfbc4b2.ts.net:10000

# Ожидается 200 + корректный content-type; Set-Cookie быть не должно.
for p in \
  /claude/manifest.webmanifest \
  /claude/icons/icon-192.png \
  /claude/icons/icon-512.png \
  /claude/icons/icon-maskable-512.png \
  /claude/icons/apple-touch-icon-180.png
do
  printf '%-46s ' "$p"
  curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE$p"
done

# Ожидается 401 (не 200, не 302 на login).
for p in /claude/ /claude/sw.js /claude/assets/app.js /claude/api/health; do
  printf '%-46s ' "$p"
  curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE$p"
done

# Публичный ответ не должен ставить cookie.
curl -sSI "$BASE/claude/manifest.webmanifest" | grep -i '^set-cookie' && echo 'FAIL: Set-Cookie' || echo 'ok: no Set-Cookie'

# POST на публичный путь не должен отдавать файл.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/claude/manifest.webmanifest"   # ожидается 401/405, не 200
```

Проверить, что `content-type` манифеста — `application/manifest+json` (с charset допустим), иконок —
`image/png`, SW (с cookie) — `text/javascript`.

### 10.2 Манифест и иконки

```bash
node --input-type=module - <<'EOF'
const base = 'https://vps-4692.tailfbc4b2.ts.net:10000'
const m = await (await fetch(base + '/claude/manifest.webmanifest')).json()
console.log({ id: m.id, start_url: m.start_url, scope: m.scope, display: m.display })
if (m.id !== '/claude/' || m.start_url !== '/claude/' || m.scope !== '/claude/') throw new Error('bad paths')
if (!m.icons?.some(i => i.sizes === '192x192' && i.purpose === 'any')) throw new Error('no 192 any')
if (!m.icons?.some(i => i.sizes === '512x512' && i.purpose === 'any')) throw new Error('no 512 any')
if (!m.icons?.some(i => i.purpose === 'maskable')) throw new Error('no maskable')
for (const icon of m.icons) {
  const r = await fetch(new URL(icon.src, base))
  console.log(icon.src, r.status, r.headers.get('content-type'))
  if (r.status !== 200 || r.headers.get('content-type') !== 'image/png') throw new Error('icon ' + icon.src)
}
EOF
```

Дополнительно: размеры PNG совпадают с `sizes`; maskable-знак в safe zone; apple-touch без альфы.

### 10.3 Заголовки SW (с сессией)

Взять cookie из DevTools → Application → Cookies (не вставлять в отчёт/логи):

```bash
curl -sSI "$BASE/claude/sw.js" -H "Cookie: __Host-dsh_session=..." | grep -Ei 'HTTP/|content-type|cache-control|service-worker-allowed|set-cookie'
```

Ожидается `200`, `text/javascript`, `no-cache`, **нет** `Service-Worker-Allowed: /`, нет `Set-Cookie`.
Без cookie — `401` (не 302). `curl -I` на `/claude/` с cookie — HTML и `Cache-Control: no-store`.

### 10.4 Caddy

- Бэкап: `sudo cp /etc/dsh-gateway-caddy/Caddyfile{,.bak}`.
- `sudo caddy validate --config ... --adapter caddyfile`; `sudo caddy adapt ... --pretty` — проверить,
  что `@install` идёт до fallback, `/claude/*` — до catch-all, `forward_auth` не накрывает install-пути.
- `sudo systemctl reload dsh-gateway-caddy`; повторить 10.1.
- Проверить, что DSH не сломан: `/` с cookie 200, `/manifest.webmanifest` DSH отдаётся, `/sw.js` DSH 200,
  `/auth/tg` открывается.
- Откат: вернуть `.bak`, reload, снова 10.1 (публичные снова 401).

### 10.5 Chrome DevTools

- **Application → Manifest**: без ошибок; `id/start_url/scope` = `/claude/`; иконки загружены;
  installability не ругается; «Install» доступен.
- **Application → Service Workers**: `/claude/sw.js` — `activated`, scope `/claude/`; update не
  запускается сам; после деплоя появляется `waiting`.
- **Application → Cache Storage**: `claude-pwa-assets-vN`; нет HTML-ответов; нет `dsh-web-pwa-*`
  среди удалённых.
- **Network**: запросы `/claude/api/*`, `/claude/events`, `/claude/ws` не помечены «(ServiceWorker)»;
  навигация не из кэша.
- **Lighthouse**: в v12+ категории PWA больше нет (удалена); не ориентироваться на «PWA score».
  Использовать Application-панель; если Lighthouse старый — installable-аудиты, но не как единственный
  критерий.

### 10.6 Android Chrome (WebAPK)

1. Chrome stable (не Яндекс.Браузер, не WebView, не встроенный браузер Telegram).
2. Войти через `/auth/tg`; открыть `https://.../claude/`; дождаться регистрации SW.
3. Меню ⋮ → «Установить приложение» (если баннера нет — это ожидаемо при вложенном scope/установленном
   DSH; установка из меню должна работать). Если пункта нет — проверить 10.1/10.2 и `about://webapks`.
4. После установки: долгое нажатие на иконку → «Информация о приложении»; это WebAPK
   (`org.chromium.webapk...`), а не ярлык. `about://webapks` показывает запись и `Update Status`.
5. Запуск: standalone без адресной строки; splash с иконкой/цветом; иконка не белый круг.
6. Офлайн: авиарежим → запуск → страница «сервер недоступен», кнопка «Повторить»; при возврате сети
   страница сама перезагружается.
7. Истёкшая сессия: удалить cookie/ревокнуть сессию → запуск → «Сессия завершилась» + «Войти»;
   после входа шлюз вернёт на `/` (известное ограничение), затем открыть Claude снова.
8. Обновление: изменить `VERSION`/сборку → перезапуск приложения → баннер «Доступно обновление» →
   кнопка → один reload; в Cache Storage новый `vN`, старый удалён.
9. Обновление манифеста: изменить `name`/иконку; `about://webapks` → Update; проверить, что WebAPK
   пересобрался (может занять время, нужен Wi-Fi/зарядка).
10. Удаление: долгое нажатие → удалить; проверить, что DSH-PWA/данные DSH не пострадали (общий origin:
    Chrome может предложить очистить данные сайта — это затронет оба приложения).

### 10.7 iOS Safari

- Share → «На экран Домой»; иконка 180 берётся из `apple-touch-icon` (SVG iOS игнорирует).
- Запуск — standalone (iOS учитывает manifest `display` в современных версиях); проверить, что
  `apple-mobile-web-app-title` и статус-бар выглядят нормально.
- SW на iOS работает, но установка не показывает install prompt; это нормально.

### 10.8 Кэш и изоляция

В консоли на `/claude/`:

```js
const names = await caches.keys()
console.log(names)
for (const name of names) {
  const cache = await caches.open(name)
  for (const req of await cache.keys()) console.log(name, req.url)
}
```

Ожидается: `claude-pwa-assets-vN` и, если DSH открыт, `dsh-web-pwa-*`; никаких HTML-URL в Claude-кэше;
после обновления Claude старые `claude-pwa-*` удалены, `dsh-web-pwa-*` на месте.

### 10.9 Откат

1. Caddy: вернуть `Caddyfile.bak`, `caddy validate`, reload; публичные пути снова 401; DSH работает.
2. Приложение: остановить сервис/убрать маршрут; установленное приложение покажет offline-страницу.
3. SW: DevTools → Application → Service Workers → Unregister; или удалить приложение с устройства;
   при необходимости — Clear site data.
4. Убедиться, что DSH-PWA и его кэш не затронуты. Помнить: очистка site data на общем origin удалит
   данные обоих приложений.

---

## 11. Открытые вопросы и зависимости

1. **Кто маршрутизирует `/claude/*`** — Caddy напрямую в `:3081` (рекомендуется) или gateway с новым
   маршрутом? Сейчас `gateway.mjs` проксирует всё в DSH и подставляет DSH-cookie; для Claude это
   требует изменений. PWA-спецификация совместима с обоими, но публичный байпас должен вести в Claude.
2. **Стек приложения и prefix-awareness**: Express/Next/Vite? Есть ли `BASE_PATH`/`basePath`? Все ли
   API/WS под `/claude/`? От этого зависит, можно ли вообще срезать префикс (рекомендация — не срезать).
3. **`next` после логина**: `authflow.mjs`/`pages.mjs` жёстко ведут на `/`; SW-ссылка
   `/auth/tg?next=%2Fclaude%2F` пока не работает. Нужна правка gateway с allowlist same-origin next.
4. **Официальный логотип**: есть ли разрешение на знак Claude? Если нет — нейтральный знак из §4.4.
5. **Caddyfile**: файл недоступен (`/etc/dsh-gateway-caddy` — root:caddy), sudo запрещён; нужен
   оператор с root для validate/reload. Фрагмент проверен на временном Caddy, но не на боевом конфиге.
6. **Вложенный scope**: если DSH-PWA уже установлен на Android, установка Claude может не показывать
   промпт; тестировать вручную из меню. Радикальное решение — отдельный origin/поддомен (web.dev
   рекомендует), но это меняет постановку «тот же адрес, путь `/claude/`».
7. **WebAPK minter и `start_url`**: по локальному исследованию minter тянет манифест/иконки без cookie,
   а `start_url` открывается в профиле Chrome. Проверить на устройстве; если установка всё же требует
   публичного `start_url`, **не** открывать HTML приложения — лучше пересмотреть архитектуру/отдельный
   origin, чем публиковать интерфейс.
8. **DSH SW и `/claude/`**: follow-up — научить root-SW не перехватывать `/claude/*`; сейчас плагин
   трогать нельзя.
9. **UI обновления**: приложение должно слушать `claude:pwa-update` и показывать кнопку; иначе
   обновления будут ждать закрытия вкладок.
10. **Screenshots/shortcuts**: добавлять только с точными публичными путями и реальными маршрутами.

---

## Приложение A. Манифест (полный пример)

См. §3.2. Перед деплоем заменить `shortcuts` на реальные маршруты; при добавлении `screenshots`
внести их точные URL в Caddy-список.

---

## Приложение B. Каркас service worker

```js
/**
 * Claude PWA service worker.
 * Served at /claude/sw.js; default scope /claude/ (no Service-Worker-Allowed).
 * Only hashed build assets are cached. HTML, API, SSE and WS are never touched.
 * Bump VERSION when the caching rules change; activate() drops only claude-pwa-* caches.
 */
const VERSION = '1'
const PREFIX = 'claude-pwa-'
const ASSET_CACHE = `${PREFIX}assets-v${VERSION}`
const ASSET_LIMIT = 100
const NAV_TIMEOUT_MS = 10000
const BASE = '/claude/'
const ASSET_PREFIX = `${BASE}assets/`
const SIGN_IN_URL = '/auth/tg?next=%2Fclaude%2F'

/** Paths the worker must never intercept. */
const PASSTHROUGH = [
  `${BASE}api/`,
  `${BASE}events`,
  `${BASE}ws`,
  `${BASE}auth/`,
  `${BASE}login`,
  `${BASE}manifest.webmanifest`,
  `${BASE}sw.js`,
]

const EXPECTED_TYPES = new Map([
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.css', 'text/css'],
  ['.woff2', 'font/'],
  ['.woff', 'font/'],
  ['.ttf', 'font/'],
  ['.otf', 'font/'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
])

const OFFLINE_TEXT = {
  en: {
    title: 'The Claude server is unreachable',
    message: 'The page needs the Claude backend on this server.',
    hint: 'Check the network or the Tailscale connection, then retry.',
    retry: 'Retry',
  },
  ru: {
    title: 'Сервер Claude недоступен',
    message: 'Для страницы нужен backend Claude на этом сервере.',
    hint: 'Проверьте сеть или подключение Tailscale и повторите.',
    retry: 'Повторить',
  },
}

const SIGNED_OUT_TEXT = {
  en: {
    title: 'The session has ended',
    message: 'Sign in again to continue in this window.',
    hint: 'The auth gateway closed the session; saved work stays on the server.',
    retry: 'Retry',
    signIn: 'Sign in',
  },
  ru: {
    title: 'Сессия завершилась',
    message: 'Войдите снова, чтобы продолжить в этом окне.',
    hint: 'Шлюз авторизации закрыл сессию; сохранённая работа осталась на сервере.',
    retry: 'Повторить',
    signIn: 'Войти',
  },
}

function isPassthrough(pathname) {
  return PASSTHROUGH.some((path) => pathname === path || pathname.startsWith(path))
}

function localized(texts) {
  const language = (self.navigator.language || 'en').slice(0, 2).toLowerCase()
  return { lang: language in texts ? language : 'en', ...(texts[language] ?? texts.en) }
}

/** A response whose bytes this worker may store. */
function cacheable(request, response) {
  if (!response || !response.ok || response.type !== 'basic') return false
  if (response.redirected || response.url !== request.url) return false
  if (response.headers.has('content-range') || response.status === 206) return false
  if ((response.headers.get('cache-control') || '').toLowerCase().includes('no-store')) return false
  const type = (response.headers.get('content-type') || '').toLowerCase()
  if (type.startsWith('text/html')) return false
  const pathname = new URL(request.url).pathname
  const dot = pathname.lastIndexOf('.')
  if (dot === -1) return false
  const expected = EXPECTED_TYPES.get(pathname.slice(dot).toLowerCase())
  return expected !== undefined && type.startsWith(expected)
}

async function remember(cache, request, response) {
  try {
    await cache.put(request, response.clone())
  } catch {
    // Quota/eviction is the browser's concern; the response still ships.
  }
}

async function prune(cache) {
  const keys = await cache.keys()
  let excess = keys.length - ASSET_LIMIT
  if (excess <= 0) return
  for (const key of keys) {
    if (excess <= 0) break
    await cache.delete(key)
    excess -= 1
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE)
  const hit = await cache.match(request)
  if (hit !== undefined) return hit
  try {
    const response = await fetch(request)
    if (cacheable(request, response)) {
      await remember(cache, request, response)
      await prune(cache)
    }
    return response
  } catch {
    return new Response('', { status: 504, statusText: 'Gateway Timeout' })
  }
}

const PAGE_STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;
 font:15px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;background:#fff;color:#0f1115}
.card{width:100%;max-width:400px;padding:28px 24px;border:1px solid rgba(127,127,127,.28);border-radius:16px}
.mark{width:44px;height:44px;margin:0 auto 14px;border:2px solid currentColor;border-radius:12px;opacity:.9}
h1{margin:0 0 8px;font-size:18px;line-height:1.3}
p{margin:0 0 6px;opacity:.82}
.hint{font-size:13px;opacity:.6;margin-top:12px}
.actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:18px}
button,a.button{display:inline-block;padding:9px 18px;font:inherit;font-weight:500;color:inherit;cursor:pointer;
 text-decoration:none;background:transparent;border:1px solid rgba(127,127,127,.38);border-radius:10px}
@media (prefers-color-scheme:dark){body{background:#151517;color:#f9fafb}}`

function appPage(texts, { variant, canSignIn = false }) {
  const text = localized(texts)
  const offline = variant === 'offline'
  const autoRetry = offline
    ? `
      const probe = async () => {
        if (document.visibilityState !== 'visible') return
        try {
          const response = await fetch('${BASE}manifest.webmanifest', { method: 'HEAD', cache: 'no-store' })
          if (response.ok) location.reload()
        } catch {}
      }
      addEventListener('online', probe)
      setInterval(probe, 15000)`
    : ''
  const html = `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'">
<title>${text.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <main class="card" role="alert">
    <div class="mark" aria-hidden="true"></div>
    <h1>${text.title}</h1>
    <p>${text.message}</p>
    <p class="hint">${text.hint}</p>
    <div class="actions">
      <button type="button" id="retry">${text.retry}</button>${
        canSignIn ? `\n      <a class="button" href="${SIGN_IN_URL}">${text.signIn}</a>` : ''}
    </div>
  </main>
  <script>
    (() => {
      const retry = document.querySelector('#retry')
      const label = retry.textContent
      retry.addEventListener('click', () => {
        retry.disabled = true
        retry.textContent = '…'
        location.reload()
      })
      addEventListener('pageshow', () => {
        retry.disabled = false
        retry.textContent = label
      })${autoRetry}
    })()
  </script>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function navigate(event) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS)
  try {
    const response = await fetch(event.request, { signal: controller.signal })
    if (response.status === 401 || response.status === 403) {
      return appPage(SIGNED_OUT_TEXT, { variant: 'signed-out', canSignIn: true })
    }
    if (response.status >= 500) return appPage(OFFLINE_TEXT, { variant: 'offline' })
    if (response.redirected && !new URL(response.url).pathname.startsWith(BASE)) {
      return appPage(SIGNED_OUT_TEXT, { variant: 'signed-out', canSignIn: true })
    }
    if (response.ok) {
      const type = (response.headers.get('content-type') || '').toLowerCase()
      if (!type.startsWith('text/html')) return appPage(OFFLINE_TEXT, { variant: 'offline' })
    }
    return response
  } catch {
    return appPage(OFFLINE_TEXT, { variant: 'offline' })
  } finally {
    clearTimeout(timer)
  }
}

self.addEventListener('install', () => {
  // No precache and no skipWaiting: HTML must never be stored, and an update
  // must wait for the page to offer a reload.
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([ASSET_CACHE])
    const stale = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && !keep.has(key))
    await Promise.all(stale.map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || request.headers.has('range')) return
  if (request.headers.has('authorization')) return
  if ((request.headers.get('accept') || '').includes('text/event-stream')) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(BASE)) return
  if (isPassthrough(url.pathname)) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(event))
    return
  }
  if (url.pathname.startsWith(ASSET_PREFIX)) {
    event.respondWith(cacheFirst(request))
  }
})
```

Замечания:

- `PASSTHROUGH` должен включать все реальные API/SSE/WS-префиксы приложения; если API называется
  `/claude/rpc`, добавьте его.
- `/claude/icons/*` и `/claude/manifest.webmanifest` не перехватываются: HTTP-кэш и Caddy/public-слой
  отвечают за них.
- Если сборка не хеширует ассеты, при деплое нужно менять `VERSION` (иначе cache-first отдаст старый
  файл по тому же URL).
- `appPage()` не отражает URL/заголовки и не содержит формы пароля — это осознанно.

---

## Приложение C. Регистрация и update-событие

См. §6.2. Минимальный слушатель в приложении:

```js
window.addEventListener('claude:pwa-update', (event) => {
  // Показать свой toast; по клику:
  // window.claudePwa.update(event.detail.worker)
  const worker = event.detail.worker
  if (confirm('Доступно обновление Claude. Перезагрузить сейчас?')) {
    window.claudePwa.update(worker)
  }
})
```

`confirm()` — только заглушка; в реальном UI использовать свой компонент, чтобы не блокировать ввод.

---

## Приложение D. Zero-dependency генератор PNG

Полный скрипт (проверен на Node v24.22.3; рисует нейтральный знак, не официальный логотип):

```js
#!/usr/bin/env node
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] || 'icons'
const BG = [217, 119, 87]   // #D97757
const FG = [247, 243, 238]  // #F7F3EE

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const SS = 4
function sdRoundRect(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - (w / 2 - r)
  const qy = Math.abs(y - cy) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
function inTriangle(px, py, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a)
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

function render(size, contentScale) {
  const hi = size * SS
  const buf = Buffer.alloc(hi * hi * 4)
  for (let i = 0; i < hi * hi; i++) {
    buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255
  }
  const k = hi / 512
  const scale = contentScale
  const cx = hi / 2, cy = hi / 2
  const P = (x, y) => [cx + (x - 256) * k * scale, cy + (y - 256) * k * scale]
  const bubble = { x: 256, y: 246, w: 250, h: 170, r: 46, sw: 22 * k * scale }
  const tail = [P(160, 330), P(238, 330), P(160, 408)]
  const dotR = 13 * k * scale
  const dots = [P(208, 246), P(256, 246), P(304, 246)]

  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      let paint = inTriangle(x + 0.5, y + 0.5, ...tail)
      if (!paint) {
        const [bx, by] = P(bubble.x, bubble.y)
        const d = sdRoundRect(x + 0.5, y + 0.5, bx, by,
          bubble.w * k * scale, bubble.h * k * scale, bubble.r * k * scale)
        paint = Math.abs(d) <= bubble.sw / 2
      }
      if (!paint) {
        for (const [dx, dy] of dots) {
          if (Math.hypot(x + 0.5 - dx, y + 0.5 - dy) <= dotR) { paint = true; break }
        }
      }
      if (!paint) continue
      const i = (y * hi + x) * 4
      buf[i] = FG[0]; buf[i + 1] = FG[1]; buf[i + 2] = FG[2]; buf[i + 3] = 255
    }
  }
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * hi + (x * SS + sx)) * 4
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]
        }
      }
      const n = SS * SS, o = (y * size + x) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

mkdirSync(OUT, { recursive: true })
for (const [name, size, scale] of [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.78],
  ['apple-touch-icon-180.png', 180, 0.92],
  ['icon-96.png', 96, 1],
]) {
  const bytes = png(size, render(size, scale))
  writeFileSync(join(OUT, name), bytes)
  console.log(name, `${size}x${size}`, `${bytes.length}B`)
}
```

Генератор не заменяет официальный SVG; для официального знака используйте `sharp` или другой
растеризатор. Скрипт проверен в том виде, в котором приведён: 5 PNG, непрозрачные, maskable-знак
в safe zone.

---

## Приложение E. Быстрые команды

```bash
# Caddy
sudo cp /etc/dsh-gateway-caddy/Caddyfile{,.bak}
sudo caddy validate --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile
sudo caddy adapt --config /etc/dsh-gateway-caddy/Caddyfile --adapter caddyfile --pretty | less
sudo systemctl reload dsh-gateway-caddy

# Публичные install-ассеты (без cookie)
BASE=https://vps-4692.tailfbc4b2.ts.net:10000
for p in /claude/manifest.webmanifest /claude/icons/icon-192.png /claude/icons/icon-512.png \
         /claude/icons/icon-maskable-512.png /claude/icons/apple-touch-icon-180.png; do
  printf '%-46s ' "$p"; curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE$p"
done

# Приватные
for p in /claude/ /claude/sw.js /claude/assets/app.js /claude/api/health; do
  printf '%-46s ' "$p"; curl -sS -o /dev/null -w '%{http_code}\n' "$BASE$p"
done
```

---

## Источники

- [What does it take to be installable? — web.dev](https://web.dev/articles/install-criteria)
- [Building multiple PWAs on the same domain — web.dev](https://web.dev/articles/building-multiple-pwas-on-the-same-domain)
- [What is a WebAPK — web.dev](https://web.dev/articles/webapks)
- [How Chrome handles updates to the web app manifest — web.dev](https://web.dev/articles/manifest-updates)
- [Maskable icons — web.dev](https://web.dev/articles/maskable-icon)
- [Handling service worker updates — Chrome for Developers](https://developer.chrome.com/docs/workbox/handling-service-worker-updates)
- [`id` manifest member — MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id)
- [Web Apps concepts (installability, scope) — Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/webapps/concepts.md)
- [WebAPK — OpenPWA](https://openpwa.net/reference/installation/webapk/)
- [forward_auth — Caddy](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
- [handle — Caddy](https://caddyserver.com/docs/caddyfile/directives/handle)
- [Request matchers (path) — Caddy](https://caddyserver.com/docs/caddyfile/matchers)
- [Lighthouse v12.0.0: PWA category removed](https://github.com/GoogleChrome/lighthouse/releases/tag/v12.0.0)
- [Service-Worker-Allowed — MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Service-Worker-Allowed)
- [dsh-pwa-android.md](../dsh-pwa-android.md) — локальное исследование WebAPK/401
- [`dsh-web-pwa/sw.js`](../../dsh-web-pwa/sw.js), [`dsh-web-pwa/index.js`](../../dsh-web-pwa/index.js) — паттерны для переиспользования
