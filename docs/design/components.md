# Инвентарь компонентов

Готовая к копированию разметка и CSS для интерфейса ассистента архитектора. Без фреймворков, без CDN, без сборки — обычный HTML и CSS, системные шрифты. Значения переменных соответствуют `design-tokens.json`. Класс-имена совместимы с текущими `assistant/ui/style.css` (`.card`, `.chip`, `.badge`, `.btn`, `.num`, `table`) — новые переменные и компоненты дополняют их, не переопределяя.

## 0. Корневые переменные

Добавляются в `:root` рядом с существующими (`--bg`, `--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--chip`).

```css
:root{
  /* фон и поверхности */
  --color-bg-page:#f4f5f7;
  --color-bg-panel:#ffffff;
  --color-bg-chip:#eef1f5;
  --color-bg-draft:#fbfcfd;
  --color-bg-banner:#fff9e6;

  /* текст */
  --color-text-primary:#1b1f24;
  --color-text-secondary:#5b6672;
  --color-text-on-accent:#ffffff;
  --color-text-banner:#5b4200;

  /* границы и фокус */
  --color-border:#d7dce2;
  --color-border-focus:#1f5fa8;
  --color-border-banner:#e6d2a8;

  /* акцент (единственный на экран) */
  --color-accent:#1f5fa8;
  --color-accent-hover:#174a85;
  --color-accent-pressed:#123a69;

  /* статусы: всегда текст + цвет, никогда только цвет */
  --color-status-ok-text:#1d6b3a; --color-status-ok-border:#bcd9c6; --color-status-ok-bg:#eef7f1;
  --color-status-warn-text:#8a5a00; --color-status-warn-border:#e6d2a8; --color-status-warn-bg:#fdf6e7;
  --color-status-bad-text:#8f2a22; --color-status-bad-border:#e3bcb8; --color-status-bad-bg:#fbeceb;

  /* приоритет задачи */
  --color-priority-escalation-text:#8f2a22; --color-priority-escalation-bg:#fdecea;
  --color-priority-deadline-text:#8a5a00; --color-priority-deadline-bg:#fff4e0;
  --color-priority-instruction-text:#1b1f24; --color-priority-instruction-bg:#eef1f5;

  /* типографика */
  --font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --font-size-caption:12px;
  --font-size-small:13px;
  --font-size-body:14px;
  --font-size-base:15px;
  --font-size-subtitle:16px;
  --font-size-title:18px;
  --font-size-display:28px;
  --line-height-tight:1.2;
  --line-height-dense:1.3;
  --line-height-base:1.5;

  /* форма */
  --radius-sm:6px;
  --radius-md:8px;
  --radius-pill:999px;

  /* отступы, шаг 4px */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px;

  /* плотность списков */
  --row-height-min:40px;
  --row-height-max:44px;

  /* движение */
  --duration-fast:100ms;
  --duration-base:150ms;
  --skeleton-threshold:300ms;
}
```

## 1. Счётная полоса

Главные числа экрана (2–4). Число всегда минимум вдвое крупнее подписи.

```html
<div class="strip" role="group" aria-label="Сводные показатели">
  <div class="num">
    <b>4</b>
    <span>нужны ваше решение или ответ сегодня</span>
  </div>
  <div class="num">
    <b>2</b>
    <span>просрочено</span>
  </div>
  <div class="num">
    <b>3</b>
    <span>решения не зафиксированы в КАФО</span>
  </div>
</div>
```

```css
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-3);margin-bottom:var(--space-4)}
.num{background:var(--color-bg-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4)}
.num b{display:block;font-size:var(--font-size-display);line-height:var(--line-height-tight);font-weight:var(--font-weight-medium,600)}
.num span{display:block;color:var(--color-text-secondary);font-size:var(--font-size-small);margin-top:var(--space-1)}
```

## 2. Карточка задачи

Заголовок — одна строка полужирным; причины и срок — чипы в строке под заголовком, не абзацы.

```html
<article class="card task" tabindex="0">
  <b>Согласовать интеграцию сервиса платежей с антифродом</b>
  <div class="row">
    <span class="chip priority-escalation">эскалация: руководитель антифрода написал дважды</span>
    <span class="chip priority-deadline">срок: сегодня 18:00</span>
    <span class="muted">ждёт: архитектор ФО Риски</span>
  </div>
</article>
```

```css
.card{background:var(--color-bg-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);margin-bottom:var(--space-2)}
.card b{display:block;margin-bottom:var(--space-1);font-size:var(--font-size-base)}
.card.task:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
.row{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
.muted{color:var(--color-text-secondary);font-size:var(--font-size-small)}
```

## 3. Чипы приоритета

Одна причина на чип. Не больше двух чипов в одной карточке.

```html
<span class="chip priority-escalation">эскалация</span>
<span class="chip priority-deadline">срок: завтра</span>
<span class="chip priority-instruction">поручение руководителя</span>
<span class="chip">нейтральная подсказка</span>
```

```css
.chip{display:inline-flex;align-items:center;background:var(--color-bg-chip);color:var(--color-text-secondary);border-radius:var(--radius-pill);padding:2px var(--space-2);font-size:var(--font-size-caption)}
.chip.priority-escalation{background:var(--color-priority-escalation-bg);color:var(--color-priority-escalation-text)}
.chip.priority-deadline{background:var(--color-priority-deadline-bg);color:var(--color-priority-deadline-text)}
.chip.priority-instruction{background:var(--color-priority-instruction-bg);color:var(--color-priority-instruction-text)}
```

## 4. Бейдж статуса

Всегда с текстовой подписью — цвет только усиление, никогда единственный канал смысла.

```html
<span class="badge ok"><span aria-hidden="true"></span>свежо</span>
<span class="badge warn"><span aria-hidden="true"></span>устарело</span>
<span class="badge bad"><span aria-hidden="true"></span>не сверено</span>
```

```css
.badge{display:inline-flex;align-items:center;gap:var(--space-1);font-size:var(--font-size-caption);padding:2px var(--space-2);border-radius:var(--radius-pill);border:1px solid var(--color-border)}
.badge.ok{color:var(--color-status-ok-text);border-color:var(--color-status-ok-border);background:var(--color-status-ok-bg)}
.badge.warn{color:var(--color-status-warn-text);border-color:var(--color-status-warn-border);background:var(--color-status-warn-bg)}
.badge.bad{color:var(--color-status-bad-text);border-color:var(--color-status-bad-border);background:var(--color-status-bad-bg)}
```

## 5. Таблица списка

Строки 40–44 px, заголовок приглушён. Не больше 7 видимых строк без «показать все».

```html
<table>
  <thead>
    <tr><th>Страница</th><th>Версия</th><th>Проверено</th><th>Состояние</th><th><span class="sr-only">Действие</span></th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Платежи</td>
      <td>14</td>
      <td>сегодня</td>
      <td><span class="badge warn">устарело</span></td>
      <td><button class="btn ghost" type="button">Обновить</button></td>
    </tr>
  </tbody>
</table>
```

```css
table{width:100%;border-collapse:collapse;background:var(--color-bg-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden}
th,td{text-align:left;padding:0 var(--space-3);height:var(--row-height-max);font-size:var(--font-size-body);border-bottom:1px solid var(--color-border)}
th{background:var(--color-bg-chip);color:var(--color-text-secondary);font-weight:600;font-size:var(--font-size-small);height:var(--row-height-min)}
tr:last-child td{border-bottom:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
```

## 6. Кнопки

Одна первичная (`.btn`) на экран на уровне главного действия, остальные — `.btn.ghost`. Действие — всегда видимая кнопка в строке, никогда за меню «…».

```html
<div class="row">
  <button class="btn" type="button">Скопировать черновик</button>
  <button class="btn ghost" type="button">Открыть источник</button>
  <button class="btn ghost" type="button">Отложить</button>
</div>
```

```css
.btn{background:var(--color-accent);color:var(--color-text-on-accent);border:0;border-radius:var(--radius-sm);padding:8px var(--space-3);font:inherit;font-size:var(--font-size-body);cursor:pointer;transition:background var(--duration-fast) ease}
.btn:hover{background:var(--color-accent-hover)}
.btn:active{background:var(--color-accent-pressed)}
.btn:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
.btn.ghost{background:var(--color-bg-panel);color:var(--color-accent);border:1px solid var(--color-accent)}
.btn:disabled{opacity:.55;cursor:default}
```

## 7. Источник

Бейдж статуса, название, версия и дата сверки в одной строке — так же выглядит и в карточке запроса, и в разделе «КАФО».

```html
<div class="src">
  <span class="badge warn">устарело</span>
  <span>КАФО «Платежи», версия 12; в хранилище уже 14 — 2 правки</span>
</div>
```

```css
.src{display:flex;gap:var(--space-2);align-items:center;padding:var(--space-2) 0;border-top:1px dashed var(--color-border);font-size:var(--font-size-small)}
```

## 8. Карточка запроса (деталь)

Открывается из строки «Сегодня»/«Задачи» как разворачивающаяся панель, а не модальное окно: у неё есть собственное место в порядке документа и в Tab-навигации, остальной экран не блокируется.

```html
<section class="detail" aria-label="Карточка запроса">
  <p class="muted">Письмо от антифрода, 24.11.2026, 09:12 · срок сегодня 18:00</p>
  <div class="split">
    <div>
      <h3>Запрос</h3>
      <div class="card">Коллеги, добрый день. К релизу нужна интеграция платежей с антифродом…</div>
    </div>
    <div>
      <h3>Черновик ответа</h3>
      <div class="draft">Коллеги, добрый день. …</div>
      <div class="src"><span class="badge warn">устарело</span> КАФО «Платежи», версия 12; уже 14</div>
      <div class="row" style="margin-top:var(--space-3)">
        <button class="btn" type="button">Скопировать черновик</button>
        <button class="btn ghost" type="button">Открыть источник</button>
        <button class="btn ghost" type="button">Править</button>
        <button class="btn ghost" type="button">Отложить</button>
      </div>
      <p class="muted">Отправка только вручную, из почтовой программы.</p>
    </div>
  </div>
</section>
```

```css
.detail{border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);margin-top:var(--space-3);background:var(--color-bg-panel)}
.split{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4)}
.draft{background:var(--color-bg-draft);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);white-space:pre-wrap;font-size:var(--font-size-body);font-family:inherit}
```

## 9. Пустое состояние

Короткий текст и не больше одного действия.

```html
<div class="empty">
  <p><b>Задач пока нет</b></p>
  <p class="muted">Добавьте задачу из письма или вручную.</p>
  <button class="btn" type="button">Новая задача</button>
</div>
```

```css
.empty{background:var(--color-bg-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4);text-align:left}
.empty p{margin:0 0 var(--space-2)}
```

## 10. Скелетон загрузки

Показывается только если данных нет дольше `--skeleton-threshold` (300 мс); при мгновенном ответе из кэша не показывается вовсе.

```html
<div class="skeleton-group" aria-hidden="true">
  <div class="skeleton skeleton-line" style="width:40%"></div>
  <div class="skeleton skeleton-line" style="width:90%"></div>
  <div class="skeleton skeleton-line" style="width:70%"></div>
</div>
<p class="sr-only" role="status">Загрузка данных</p>
```

```css
.skeleton{background:linear-gradient(90deg,var(--color-bg-chip) 25%,var(--color-border) 37%,var(--color-bg-chip) 63%);background-size:400% 100%;animation:skeleton-pulse 1.1s ease-in-out infinite;border-radius:var(--radius-sm)}
.skeleton-line{height:var(--row-height-min);margin-bottom:var(--space-2)}
@keyframes skeleton-pulse{0%{background-position:100% 50%}100%{background-position:0 50%}}
```

Примечание: сама анимация скелетона — служебный индикатор ожидания, а не декоративный эффект; правило «не дольше 150 мс» относится к переходам интерфейса (наведение, открытие панели), а не к непрерывной пульсации плейсхолдера.

## 11. Баннер ошибки

Человеческий текст: что случилось и что сделать. Без кода и стека.

```html
<div class="error-banner" role="alert">
  <b>Не удалось получить данные из КАФО</b>
  <p>Папка с выгрузкой недоступна. Проверьте путь в настройках и нажмите «Проверить».</p>
  <button class="btn ghost" type="button">Повторить</button>
</div>
```

```css
.error-banner{background:var(--color-status-bad-bg);border:1px solid var(--color-status-bad-border);color:var(--color-status-bad-text);border-radius:var(--radius-md);padding:var(--space-3) var(--space-4);margin-bottom:var(--space-4)}
.error-banner b{display:block;margin-bottom:var(--space-1)}
.error-banner p{margin:0 0 var(--space-2);color:var(--color-text-primary)}
```

Баннер информационного характера (не ошибка) использует цвета `--color-bg-banner`/`--color-border-banner`/`--color-text-banner`:

```css
.banner{background:var(--color-bg-banner);border:1px solid var(--color-border-banner);color:var(--color-text-banner);border-radius:var(--radius-md);padding:var(--space-3) var(--space-4);margin-bottom:var(--space-4);font-size:var(--font-size-small)}
```

## 12. Квиз-карточка

Три кнопки вердикта с подписанными клавишами 1/2/3. Клавиши работают для карточки в фокусе.

```html
<article class="card quiz" data-id="fact-42" tabindex="0">
  <b>Сервис платежей передаёт события в Kafka</b>
  <p class="muted">Источник: протокол · решение от 20.11, версия 12</p>
  <div class="row" style="margin-top:var(--space-2)">
    <button class="btn" type="button" data-verdict="confirm"><kbd>1</kbd> Подтвердить</button>
    <button class="btn ghost" type="button" data-verdict="unreliable"><kbd>2</kbd> Недостоверно</button>
    <button class="btn ghost" type="button" data-verdict="skip"><kbd>3</kbd> Пропустить</button>
  </div>
</article>
```

```css
.quiz kbd{display:inline-block;min-width:14px;text-align:center;font-family:var(--font-family-mono,monospace);font-size:var(--font-size-caption);background:rgba(255,255,255,.35);border-radius:3px;padding:0 3px;margin-right:4px}
.quiz:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
```

## 13. Ссылка «показать все»

Текстовая ссылка, не кнопка. Появляется только при превышении 7 строк в блоке.

```html
<a class="show-all" href="#tasks-full">Показать все 23</a>
```

```css
.show-all{color:var(--color-accent);font-size:var(--font-size-small);text-decoration:underline;text-underline-offset:2px}
.show-all:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
```

## 14. Строка настроек с отметками проверки

Три отметки (данные/модель/источники) используют тот же бейдж, что и статусы источников — единая визуальная грамматика «можно доверять / нет».

```html
<div class="check-row" role="group" aria-label="Результат проверки">
  <span class="badge ok">данные: подключены</span>
  <span class="badge ok">модель: найдена</span>
  <span class="badge bad">источники: папка КАФО недоступна</span>
</div>
```

```css
.check-row{display:flex;gap:var(--space-3);flex-wrap:wrap;margin:var(--space-3) 0}
```

## 15. Быстрая форма (Ctrl+Alt+N)

Одна строка поверх текущего экрана. Enter — сохранить и закрыть, Escape — отменить без сохранения. Не модальное окно подтверждения в смысле чек-листа, но из тех же соображений закрывается по Escape, так как перехватывает фокус целиком.

```html
<form class="quick-add" aria-label="Быстрое добавление задачи">
  <label class="sr-only" for="quick-add-input">Текст задачи</label>
  <input id="quick-add-input" type="text" placeholder="Текст задачи — Enter сохранит" autofocus>
</form>
```

```css
.quick-add{position:fixed;top:20%;left:50%;transform:translateX(-50%);width:min(560px,90vw);background:var(--color-bg-panel);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);box-shadow:none;z-index:10}
.quick-add input{width:100%;font:inherit;font-size:var(--font-size-base);border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:var(--space-2) var(--space-3)}
.quick-add input:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
```

Примечание: тень исключена сознательно (`box-shadow:none`) — декоративные тени входят в список провальных признаков приёмки; разделение формы от фона экрана обеспечивается границей `1px solid var(--color-border)`, а не тенью.
