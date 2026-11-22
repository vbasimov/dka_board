# Claude Runtime для «Claude PWA»: SDK vs spawn, auth, лимиты и безопасность

Дата: 2026-11-21. Хост: Ubuntu VPS, пользователь `dsh` (uid 1001), Node v24.22.3, Claude Code 2.1.329,
Pro-подписка через claude.ai. Sudo недоступен (`no_new_privs`), systemd-user bus отсутствует.
Каталог исследования: `/home/dsh/projects/tmp-research/` (после отчёта удалён).

---

## 0. Итог (TL;DR)

1. **Рантайм: `@anthropic-ai/claude-agent-sdk@0.3.330`** (Node 24 ОК, ставится локально, тянет
   собственный native-бинарник Claude Code 2.1.330 — глобальный `/usr/bin/claude` не нужен).
   SDK даёт типизированные сообщения, `resume`, `canUseTool`, `interrupt()`, `settingSources`,
   `cwd`, `allowedTools`/`disallowedTools`, лимиты. Прямой `spawn claude -p --input-format
   stream-json ...` — рабочий fallback, но придётся вручную реализовать NDJSON-протокол,
   permission-запросы, interrupt и resume; мы его проверили, кадры и `control_request/interrupt`
   задокументированы ниже.
2. **Auth: не полагаться на файл `~/.claude/.credentials.json`** для сервиса. Он живёт ~8 ч
   (access token) и обновляется перезаписью файла под блокировкой `$CLAUDE_CONFIG_DIR/.oauth_refresh.lock`.
   Любой read-only/sandbox-контекст ломает refresh → `401 OAuth access token has expired`
   (именно это и наблюдалось в исследовании). Для сервиса: `claude setup-token` →
   `CLAUDE_CODE_OAUTH_TOKEN` (1 год, без ротации, только model requests) + отдельный
   `CLAUDE_CONFIG_DIR` внутри каталога приложения.
3. **Изоляция: свой `CLAUDE_CONFIG_DIR` + `settingSources: []` + allowlist инструментов + deny-правила
   путей**. Сервис должен жить под `dsh` (создать отдельного пользователя без root нельзя), поэтому
   файловые права `0600` от него не защищают — нужен второй слой в виде permission-правил и,
   в идеале, OS-sandbox (bubblewrap не установлен, см. §4.4).
4. **Память: ~210 МБ на сессию (child) + ~80 МБ host-процесса**, 1 процесс на сессию, старт
   ~1.8 с. На 2 ГБ при работающем DSH (уже ~400 МБ) реалистично **2 одновременные сессии**, 3 — с риском.
5. **ToS:** PWA для одного владельца под его же Pro-подпиской — обычное индивидуальное
   использование; шаринг/мультиюзер/перепродажа лимитов запрещены, сторонний claude.ai-login
   в «свой продукт» без разрешения Anthropic — нельзя.
6. **Проверено практикой:** install SDK, handshake (`system/init`), стриминговые кадры,
   `control_request` → `interrupt` → `control_response`, resume с несуществующим ID.
   **Не проверено:** успешный ответ модели и текстовая стриминг-выдача — заблокировано 401 из-за
   sandbox (см. §5.3); minting setup-token (нужен браузер).

---

## 1. Что установлено: версии, пакеты, exports

### 1.1 Глобальный Claude Code

```
$ claude --version
2.1.329 (Claude Code)
$ readlink -f /usr/bin/claude
/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe   # native ELF, 377 545 232 bytes
```

`/usr/lib/node_modules/@anthropic-ai/claude-code/package.json`:

```json
{
  "name": "@anthropic-ai/claude-code",
  "version": "2.1.329",
  "bin": { "claude": "bin/claude.exe" },
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "dependencies": {},
  "optionalDependencies": {
    "@anthropic-ai/claude-code-linux-x64": "2.1.329", "...": "..."
  },
  "files": ["bin/claude.exe", "install.cjs", "cli-wrapper.cjs", "sdk-tools.d.ts"]
}
```

Факты:

* **`sdk.mjs` и `sdk.d.ts` внутри глобального пакета отсутствуют** (`find` дал только
  `sdk-tools.d.ts` — это лишь схемы инструментов, 180 КБ). Поля `exports` в package.json нет,
  `main` нет. Импортировать `@anthropic-ai/claude-code` как библиотеку нельзя.
* `cli-wrapper.cjs` — fallback-лончер: если postinstall не отработал, он ищет платформенный пакет
  (`@anthropic-ai/claude-code-linux-x64/claude`) и делает `spawnSync`. В нашем случае postinstall
  отработал и `bin/claude.exe` — уже сам бинарник.
* Итог: **веб-приложению нужен отдельный пакет SDK** либо прямой spawn бинарника.

### 1.2 `@anthropic-ai/claude-agent-sdk`

Установка в `/home/dsh/projects/tmp-research` (без глобальных изменений, с локальным npm-кэшем):

```
$ npm install @anthropic-ai/claude-agent-sdk@0.3.330 --cache /home/dsh/projects/tmp-research/.npm-cache
added 105 packages in 40s
```

Размеры: `node_modules` 429 МБ, из них `@anthropic-ai/claude-agent-sdk-linux-x64` 364 МБ
(бинарник `claude` 381 121 040 байт), JS-часть SDK ~5.1 МБ; npm-кэш 209 МБ (можно удалить).

package.json (сокращённо):

```json
{
  "name": "@anthropic-ai/claude-agent-sdk",
  "version": "0.3.330",
  "main": "sdk.mjs",
  "types": "sdk.d.ts",
  "type": "module",
  "engines": { "node": ">=18.14.0" },
  "exports": {
    ".":         { "types": "./sdk.d.ts",        "default": "./sdk.mjs" },
    "./core":    { "types": "./core.d.ts",       "default": "./core.mjs" },
    "./extract": { "types": "./extractFromBunfs.d.ts", "default": "./extractFromBunfs.js" },
    "./browser": { "types": "./browser-sdk.d.ts","default": "./browser-sdk.js" },
    "./bridge":  { "types": "./bridge.d.ts",     "default": "./bridge.mjs" },
    "./sdk-tools": { "types": "./sdk-tools.d.ts" }
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.93.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  },
  "optionalDependencies": { "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.330", "...": "..." },
  "claudeCodeVersion": "2.1.330"
}
```

```
$ ./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version
2.1.330 (Claude Code)
```

Важно: **SDK 0.3.330 несёт свой CLI 2.1.330**, он не использует `/usr/bin/claude` 2.1.329.
Версии SDK и CLI синхронизированы (`claudeCodeVersion`), поэтому апгрейд SDK — это апгрейд рантайма.
`pathToClaudeCodeExecutable` позволяет подсунуть другой бинарник, но тогда возможны несовместимости
по фичам (`initialize`-поля, capabilities).

Entry points:

* `.` — полный API (query, hooks, sessions, tools, MCP).
* `./core` — тот же `query()`/`startup()`/`prewarm()`/`tool()`/`createSdkMcpServer()`/сессии, но
  меньше eagerly-loaded кода (для бандлинга); peer-deps импортируются из вашего `node_modules`.
* `./browser` — браузерный клиент для **удалённых** (claude.ai/CCR) сессий по WebSocket/SSE
  (`OAuthCredential`, `streamUrl`, `sendUrl`). Для self-hosted VPS не подходит: это подключение к
  сессионному сервису Anthropic, и OAuth-токен пришлось бы держать в браузере. **Не использовать.**
* `./extract` — вытащить embedded-бинарник при сборке `bun build --compile`.

Требования: Node ≥ 18.14 (на 24.22.3 проверено), на диске ~430 МБ на установку. `bun` не нужен.

---

## 2. Как вести сессии Claude Code из Node 24

### 2.1 SDK: API, который нужен PWA

`query(params): Query`, где `Query extends AsyncGenerator<SDKMessage, void>` и имеет управляющие методы.

```ts
import { query, type Options, type SDKMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const q = query({ prompt: '…' /* string | AsyncIterable<SDKUserMessage> */, options: { /* Options */ } });

for await (const m of q) {
  // m.type: 'system' | 'assistant' | 'user' | 'result' | 'stream_event' | 'tool_progress' |
  //         'tool_use_summary' | 'auth_status' | 'rate_limit_event' | ...
}
```

Ключевые поля `Options` (0.3.330, `sdk.d.ts`):

| Опция | Назначение |
|---|---|
| `cwd` | рабочий каталог сессии (по умолчанию `process.cwd()`) |
| `additionalDirectories` | доп. каталоги (`--add-dir`), только абсолютные пути |
| `settingSources` | `'user' \| 'project' \| 'local'`; `[]` = не читать `~/.claude/settings.json`, `.claude/settings.json`, CLAUDE.md |
| `tools` | `[]` — выключить все инструменты; `['Read','Edit']` — allowlist; `{type:'preset',preset:'claude_code'}` — полный набор |
| `allowedTools` / `disallowedTools` | правила allow/deny (синтаксис как `--allowedTools`), deny применяется даже в bypass |
| `permissionMode` | `default \| acceptEdits \| plan \| dontAsk \| auto \| bypassPermissions` (+ `allowDangerouslySkipPermissions`) |
| `canUseTool` | callback ручного подтверждения инструментов (см. §4.1) |
| `resume` / `continue` / `forkSession` / `sessionId` | продолжение/форк сессии |
| `persistSession` | `false` — не писать транскрипт (`--no-session-persistence`) |
| `includePartialMessages` | отдавать `stream_event` (токены в реальном времени) |
| `maxTurns`, `maxBudgetUsd` | предохранители |
| `model`, `fallbackModel`, `effort`, `thinking` | модель/усилие |
| `env` | **заменяет** окружение child-процесса целиком; всегда `{...process.env, ...}` |
| `stderr` | колбэк stderr CLI (для диагностики, не для секретов) |
| `pathToClaudeCodeExecutable` | свой бинарник CLI |
| `sandbox` | настройки OS-sandbox для Bash (bubblewrap; см. §4.4) |
| `settings` | inline settings (файл или объект), высший приоритет после managed |
| `hooks`, `mcpServers`, `strictMcpConfig`, `plugins`, `agents` | расширения |
| `debug`, `debugFile` | debug-логи (писать в каталог приложения, не в логи с промптами) |

Управляющие методы `Query`: `interrupt()`, `setPermissionMode(mode)`, `setModel(model)`,
`setMaxThinkingTokens(n)`, `applyFlagSettings()`, `initializationResult()`, `supportedModels()`,
`supportedCommands()`, `mcpServerStatus()`, `getContextUsage()`, `streamInput(stream)`, `close()`.

Модульные функции для списка/чтения/удаления сессий: `listSessions()`, `getSessionInfo()`,
`getSessionMessages()`, `renameSession()`, `tagSession()`, `archiveSession()`, `deleteSession()`,
`forkSession()` — удобно для «истории чатов» в PWA без парсинга JSONL (формат внутренний и меняется).

### 2.2 Минимальный серверный пример (streaming input + resume + approvals)

```ts
// server/claude-runtime.ts  (Node 24, ESM)
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

const CWD = '/home/dsh/projects/workspace';           // один проект = один cwd
const CONFIG_DIR = '/home/dsh/projects/claude-pwa/data/claude-config';

type Pending = {
  resolve: (r: PermissionResult) => void;
  timer: NodeJS.Timeout;
  input: Record<string, unknown>;            // нужен для updatedInput при allow
};

export class ClaudeSession {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  private pending = new Map<string, Pending>();        // requestId -> ответ UI
  private q?: ReturnType<typeof query>;

  constructor(private onMessage: (m: SDKMessage) => void,
              private onPermission: (reqId: string, tool: string, input: unknown) => void,
              private onError: (e: Error) => void,
              private sessionId?: string) {}

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const m = this.queue.shift();
      if (m) { yield m; continue; }
      await new Promise<void>((r) => (this.wake = r));  // ждём следующее сообщение
    }
  }

  start() {
    const options: Options = {
      cwd: CWD,
      settingSources: [],                              // не тащить ~/.claude настройки/CLAUDE.md
      tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],// allowlist вместо preset
      disallowedTools: ['WebFetch', 'WebSearch'],
      permissionMode: 'default',                       // всё неразрешённое -> canUseTool
      includePartialMessages: true,
      persistSession: true,                            // нужно для resume
      resume: this.sessionId,
      env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
      canUseTool: async (tool, input) => {
        const reqId = crypto.randomUUID();
        const answer = new Promise<PermissionResult>((resolve) => {
          const timer = setTimeout(
            () => resolve({ behavior: 'deny', message: 'Approval timed out' }), 300_000);
          this.pending.set(reqId, { resolve, timer, input });
        });
        this.onPermission(reqId, tool, input);         // -> WebSocket/SSE в PWA
        return answer;                                 // ждём решение пользователя
      },
      stderr: (d) => { /* диагностика, без промптов и секретов */ },
    };

    this.q = query({ prompt: this.input(), options });
    void (async () => {
      try {
        for await (const m of this.q!) this.onMessage(m); // result/assistant/stream_event/init
      } catch (e) {
        // query() бросает ПОСЛЕ выдачи error-result; session_id уже сохранён из init/result.
        // Транспортная ошибка (child упал) — это не result, отдаём отдельно.
        this.onError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  }

  send(text: string) {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.wake?.(); this.wake = undefined;
  }

  answerPermission(reqId: string, allow: boolean, message = 'User denied') {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    p.resolve(allow
      ? { behavior: 'allow', updatedInput: p.input }   // исходный input, не пустой объект!
      : { behavior: 'deny', message });
  }

  async interrupt() { await this.q?.interrupt(); }     // control_request interrupt
  close() { this.q?.close(); }                        // гасит child + MCP
}
```

Замечания к примеру:

* `canUseTool` **обязан** вернуть `PermissionResult` (или `null` только если вы сами отправили
  `control_response` вне SDK). `null` без ответа = fail-closed и вечное ожидание.
  Callback может висеть бесконечно — обязательно свой таймаут в UI.
* `permissionMode: 'default'` + `tools: [...]` — pre-approved только перечисленные инструменты;
  чтение внутри `cwd` и read-only Bash вообще не спрашивают (так устроен permission-flow).
  Если нужен вопрос на **каждый** вызов — только `PreToolUse` hook (он видит и auto-approved).
* `session_id` берите из `system/init` (приходит раньше) или из `result` — он есть всегда,
  включая error-result.
* `env` заменяет окружение целиком: без `...process.env` child потеряет `PATH`/`HOME`.
* Никогда не передавайте токен через argv: он виден в `ps`. Только env/`EnvironmentFile`.

### 2.3 Прямой spawn: протокол, проверенный на 2.1.329/2.1.330

Флаги (проверены, кадры совпадают с SDK):

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --replay-user-messages \
  --tools "" \
  --setting-sources "" \
  --no-session-persistence \
  --model haiku
```

Кадры stdout (NDJSON, по одному JSON на строку) — фактические с данного хоста:

```
{"type":"system","subtype":"init","cwd":"…","session_id":"…","tools":[],"mcp_servers":[],
 "model":"claude-haiku-5-5","permissionMode":"default","slash_commands":[…],"capabilities":[…]}
{"type":"system","subtype":"status","status":"requesting","session_id":"…","uuid":"…"}
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":11,"error_status":401,…}
{"type":"assistant","message":{…},"session_id":"…","uuid":"…"}
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"…"}
```

Вход (stdin, NDJSON) — проверено, `--replay-user-messages` возвращает user-кадр обратно:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},
 "parent_tool_use_id":null,"session_id":""}
```

Прерывание — это **control request**, а не SIGINT (проверено: ответ пришёл):

```json
→ {"type":"control_request","request_id":"req_int_1","request":{"subtype":"interrupt"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"req_int_1",
                                          "response":{"still_queued":[]}}}
```

`capabilities` из init подтверждают поддержку: `interrupt_receipt_v1`,
`interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `msg_lifecycle_v1`, `ui_surface_v1`,
`mcp_call_check_permissions_v1` и др. (полный список — в init, 22 значения).

Permission-запрос от CLI идёт как `control_request` c `request.subtype == "can_use_tool"` и полями
`tool_name`, `input`, `permission_suggestions`, `blocked_path`; SDK отвечает
`control_response` → `{"behavior":"allow","updatedInput":…}` или `{"behavior":"deny","message":…}`
(см. `sdk.mjs`, обработчик `can_use_tool`).

Сигналы: `SIGTERM` → exit 143, турн не записывается; `SIGINT` завершает турн корректно;
SDK `interrupt()` — предпочтительный путь. `close()` = stdin EOF + ~2 с grace, затем kill.

### 2.4 Сравнение и рекомендация

| Критерий | Agent SDK | spawn CLI |
|---|---|---|
| Типы/сообщения | `SDKMessage`, d.ts на 619 КБ | руками парсить NDJSON |
| Permission callback | `canUseTool` + `control_response` из коробки | свой control_request/response |
| Interrupt | `q.interrupt()` (receipt `still_queued`) | свой control_request или SIGINT |
| Resume/fork | `resume`, `continue`, `forkSession`, список сессий | `--resume`, руками |
| Streaming | `includePartialMessages` → `stream_event` | `--include-partial-messages` |
| Обновления | обновляете пакет (и рантайм) | обновляется системный CLI |
| Зависимость | 429 МБ `node_modules` | 0 (использует `/usr/bin/claude`) |
| Риск поломки | низкий (контракт типизирован) | высокий (внутренний протокол) |
| Отладка | `stderr`, `debugFile`, init | полный контроль argv |

**Рекомендация: SDK.** Spawn оставить как аварийный путь (или для минимального MVP без 430 МБ),
протокол выше — рабочий. Для PWA критичны именно `canUseTool`, `interrupt` и `resume` — в SDK это
готовые API, в spawn — самостоятельная реализация на 300+ строк с риском разъезда версий.

Альтернатива «совсем без Node-слоя» — `claude --remote-control` / cloud sessions — не подходит:
это управление через claude.ai, а не self-hosted веб-интерфейс.

---

## 3. Аутентификация headless-сервиса

### 3.1 Что сейчас в `~/.claude` (без вывода секретов)

```
$ claude auth status
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "projectsDirectory": "/home/dsh/.claude/projects",
  "configDirectory": "/home/dsh/.claude",
  "loginExpiresAt": "2026-12-20T01:19:41.204Z",
  "subscriptionType": "pro", "planTier": "pro", … }

$ stat ~/.claude/.credentials.json
-rw------- 1 dsh dsh 695 bytes  2026-11-21 06:39:15
```

Структура (только имена полей; значения не выводились):

```
claudeAiOauth = {
  accessToken: string, refreshToken: string,
  expiresAt: number,            // 2026-11-21T14:39:15.180Z  (~8 ч после записи файла)
  refreshTokenExpiresAt: number,// 2026-12-20T01:19:41.204Z  (~29 суток)
  scopes, subscriptionType, subscriptionTypeSource, rateLimitTier,
  accountUuid, organizationUuid
}
```

`loginExpiresAt` из `auth status` = `refreshTokenExpiresAt`, т.е. «логин живёт ~30 дней»,
а access token — ~8 часов.

### 3.2 Почему headless-вызов сейчас падает с 401 (и почему это артефакт песочницы)

Фактический вызов (и через SDK, и через `claude -p`) даёт:

```
{"is_error":true,"api_error_status":401,"api_error_type":"authentication_error",
 "result":"Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
 "credential_expires_at":"2026-12-20T01:19:41.204Z"}
```

Debug-лог (`--debug-file`) показывает причину:

```
[ERROR] Error: EACCES: permission denied, mkdir '/home/dsh/.claude/.oauth_refresh.lock'
[ERROR] Failed to fetch oauth profile from OAuth token=<redacted>
[ERROR] Failed to save config with lock: EACCES … '/home/dsh/.claude.json.lock'
[DEBUG] [concurrentSessions] register failed: EACCES … '/home/dsh/.claude/sessions/12358.json'
[ERROR] API error (attempt 1/11): 401 … "OAuth access token has expired"
```

Проверка прав из этой сессии:

```
$ touch /home/dsh/.claude/.dsh-write-probe
touch: cannot touch '/home/dsh/.claude/.dsh-write-probe': Permission denied
$ grep NoNewPrivs /proc/self/status   → NoNewPrivs: 1
```

Т.е. access token истёк, а **refresh не может взять блокировку и перезаписать credentials**, потому
что DSH-песочница (workspace-write) запрещает запись вне `/home/dsh/projects`. Это ограничение
*нашего исследовательского процесса*, а не сломанный логин: обычный процесс от `dsh` с writable
`$CLAUDE_CONFIG_DIR` должен обновить токен сам (файл `0600`, лок `$CONFIG_DIR/.oauth_refresh.lock`).

**Проверить это отсюда нельзя**: запуск вне песочницы недоступен (approval отключён), а копировать
`~/.claude/.credentials.json` в другой каталог нельзя — сервер может ротировать refresh-token
(поведение не проверялось), и тогда копия либо «съест» ротацию и разлогинит интерактивный Claude Code,
либо сама станет невалидной. Поэтому в отчёте это
помечено как «ожидаемо работает, требует проверки после перелогина вне sandbox».

### 3.3 Рекомендуемая схема: long-lived token

`claude setup-token` — интерактивная команда (открывает браузер, как `/login`), печатает токен в
терминал **один раз и нигде не сохраняет**. Требует Pro/Max/Ultra/Team/Enterprise. Токен:
`sk-ant-oat01-…`, срок 1 год, только model requests (не даёт Remote Control и claude.ai-коннекторы),
не читается в `--bare` (там только API key/apiKeyHelper).

Проверено на практике (с заведомо невалидным токеном), что переменная подхватывается и **не трогает
файл credentials**:

```
$ CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-DUMMY claude auth status
{ "loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty",
  "loginExpiresAt": null, … }                      # ← refresh-логики нет

$ CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-DUMMY claude -p "say ok" … --output-format json
{ "is_error": true, "api_error_status": 401,
  "result": "Failed to authenticate. API Error: 401 OAuth access token is invalid." }
```

То есть токен реально уходит в API, никаких `EACCES` на `~/.claude` (сравните с §3.2).

Порядок получения и размещения:

```bash
# 1) на хосте, руками владельца (нужен браузер; в headless-сессии не выполнить):
claude setup-token
# 2) сохранить вывод в файл, доступный только сервису:
install -m 600 /dev/null /home/dsh/projects/claude-pwa/data/oauth.env
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' 'sk-ant-oat01-…' > /home/dsh/projects/claude-pwa/data/oauth.env
# 3) проверить:
CLAUDE_CODE_OAUTH_TOKEN=… claude auth status   # authMethod: oauth_token
```

В systemd-юните (создаёт root; у нас его нет) — `EnvironmentFile=/home/dsh/projects/claude-pwa/data/oauth.env`,
`User=dsh`, `UMask=0077`. **Токен не класть в git, в argv, в JSON-конфиг фронтенда и в логи.**
Ротация: сгенерировать новый, заменить файл, перезапустить сервис; старый отозвать через claude.ai
(настройки аккаунта) — иначе он живёт до года.

Плюсы: нет ротации и гонок за `~/.claude/.credentials.json`, не зависим от 8-часового access token,
не мешаем интерактивному Claude Code. Минусы: 1 год и «повезёт, если не утечёт»; отзыв — вручную.

### 3.4 Альтернатива: файловый OAuth с отдельным config dir

Если не хочется long-lived токена — сделать `claude auth login` **под тем же `dsh`**, но с
`CLAUDE_CONFIG_DIR=/home/dsh/projects/claude-pwa/data/claude-config` (свой `.credentials.json`,
свой `projects/`, свой `.claude.json`). Проверено, что переменная изолирует конфиг:

```
$ CLAUDE_CONFIG_DIR=…/.claude-cfg claude auth status
{ "projectsDirectory": "…/.claude-cfg/projects", "configDirectory": "…/.claude-cfg", … }
$ find …/.claude-cfg → .claude.json, backups/…
```

Плюс: автоматический refresh, «как у людей». Минус: сервис должен иметь **право записи** в
`$CLAUDE_CONFIG_DIR` (не read-only volume!), и логин живёт ~30 дней — за этим надо следить
(`auth status` → `loginExpiresAt`), иначе сессии начнут отдавать 401.

### 3.5 Отдельный пользователь `claudeapp`?

Технически «правильно», практически **невозможно в текущих ограничениях**:

* `sudo` заблокирован (`no new privileges`), `systemd --user` недоступен (нет `/run/user/1001`,
  `Failed to connect to bus: No medium found`, linger не включён, `~/.config/systemd/user` нет),
  `crontab -l` → `Permission denied`. Создать пользователя и сервис может только root.
* Копировать `~/.claude/.credentials.json` в чужой `$HOME` нельзя без анализа риска ротации
  refresh-token (см. §3.2) и без согласия владельца.
* Если root всё же выделит пользователя — правильный путь не копирование файла, а **mint
  setup-token владельцем** и `EnvironmentFile` c `0600`, принадлежащий сервисному пользователю
  (или `root:claudeapp 0640`). Плюс: сервис не сможет читать `~/.claude`, `~/.dsh`, `~/.ssh` dsh'а
  на уровне ОС. Минус: нужно, чтобы root создал пользователя, каталог данных и unit.

До этого сервис живёт под `dsh`, и единственная защита — permission-правила Claude Code + `cwd`
(см. §4).

### 3.6 Обновление, истечение, что писать в логи

* **Истечение**: запрос завершается `result` c `is_error:true`, `api_error_status:401`,
  текстом `OAuth access token has expired` (файл) или `… is invalid` (env-токен).
  UI должен показать «нужно обновить вход», а не «ошибка инструмента». Сессии при этом не теряются:
  после нового токена `resume: session_id` продолжит разговор.
* **Refresh**: пишет новый access/refresh в `.credentials.json` под `mkdir $CONFIG_DIR/.oauth_refresh.lock`;
  в логах видно только `EACCES`/`401` — сам токен не логируется.
* **Что логировать можно**: `authMethod` (`claude.ai` / `oauth_token` / `api_key`), `subscriptionType`,
  `planTier`, `loginExpiresAt`, `apiKeySource` из init (`'none'` для OAuth — хороший индикатор, что
  используется подписка, а не API-ключ), `api_error_status`, `request_id`.
* **Что нельзя**: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, содержимое `.credentials.json`,
  `--settings` с секретами (попадает в argv), промпты/транскрипты в общий journal (там могут быть
  секреты из кода).
* **Гигиена**: `chmod 600` на env-файл, `UMask=0077`, не печатать env целиком, фильтровать
  `sk-ant-` в логгере (`/sk-ant-[a-z0-9_-]+/gi → '<redacted>'`).

### 3.7 Соответствие условиям Pro-подписки (один владелец)

Из официальных документов (цитаты):

* «Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of
  Claude Code and the Agent SDK.» (legal-and-compliance).
* OAuth «intended exclusively for purchasers … and is designed to support ordinary use of Claude Code
  and other native Anthropic applications».
* «Anthropic does not permit third-party developers to offer Claude.ai login into their own
  applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of
  their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or
  session tokens — sign-in to a Claude account must complete through Anthropic's own flow.»
* Но: «Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
  their own Claude subscription, including where a platform hosts Claude Code».

Вывод для PWA:

* **Можно**: один владелец, свой VPS, свой аккаунт, PWA за существующим auth-gateway (только для
  владельца), запускается немодифицированный Claude Code/SDK, токен хранится на его же хосте для
  его же запросов. Это «ordinary, individual use» — как если бы он запускал CLI.
* **Нельзя**: давать доступ кому-то ещё (друзьям, «демо», мультиюзер), продавать/перепродавать
  доступ, выставлять как публичный продукт с claude.ai-логином, проксировать чужие запросы через
  свою подписку, собирать/хранить чужие claude.ai-токены. Для мультиюзера — только Console API
  keys (каждый со своим биллингом) или одобрение Anthropic.
* Риск: автоматизация через веб-интерфейс может упираться в 5-часовые/7-дневные лимиты Pro чаще,
  чем интерактивная работа; это не нарушение, но UX должен показывать rate-limit события
  (`rate_limit_event`, `system/api_retry` с `rate_limit`).

---

## 4. Ограничения рантайма и безопасность

### 4.1 Permission modes и ручное подтверждение

Режимы (0.3.330): `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, `bypassPermissions`.
`bypassPermissions` требует `allowDangerouslySkipPermissions: true` и не рекомендуется; root/sudo
он и так отказывается запускать.

Порядок проверки: hooks → deny-правила → ask-правила → режим → allow-правила → `canUseTool`.
Важно:

* Allow-правило/`acceptEdits`/`bypass` **обходят** `canUseTool` — для аудита каждого вызова нужен
  `PreToolUse` hook.
* `dontAsk` — жёсткий deny всего, что не разрешено (хорошо для автономных задач без UI).
* `canUseTool` получает `signal`, `suggestions` (для «разрешить всегда»), `blockedPath`,
  `decisionReason`, `title`/`displayName`/`description` — удобно для UI.
* Ответ: `{behavior:'allow', updatedInput}` | `{behavior:'deny', message}`; можно вернуть
  `updatedPermissions`, чтобы больше не спрашивать (но для PWA лучше не persist, а спрашивать).
* `AskUserQuestion` тоже приходит в `canUseTool` (toolName === 'AskUserQuestion') — это готовый
  механизм уточняющих вопросов в UI (1–4 вопроса, 2–4 варианта).
* Callback может висеть неограниченно; если пользователь ушёл — свой таймаут + deny; при
  `interrupt()` `signal` абортится.

### 4.2 Изоляция рабочего каталога

* `cwd` = каталог конкретного проекта (например `/home/dsh/projects/claude-pwa/workspaces/<id>`),
  `additionalDirectories` — только явно нужные.
* `settingSources: []` — не подхватывать `~/.claude/settings.json`, `.claude/settings.json`,
  CLAUDE.md. Если нужны project-правила/CLAUDE.md — `['project']` и доверенный каталог.
* `strictMcpConfig: true` + не задавать `mcpServers` — никаких чужих MCP-серверов.
* `--safe-mode`/`CLAUDE_CODE_SAFE_MODE=1` — отключить плагины, скиллы, hooks, MCP, кастомные
  команды (но auth и инструменты работают). Полезно для веб-поверхности; проверить, что скиллы
  не нужны.
* Отдельный `CLAUDE_CONFIG_DIR` — чтобы транскрипты и `.claude.json` не смешивались с личными.

### 4.3 Deny-правила (проверено, что CLI их принимает)

Передаются через `settings.permissions.deny` (или `.claude/settings.json` при `settingSources` с
`'project'`), синтаксис `Read(//abs/path/**)` / `Edit(//abs/path/**)`; `Edit(...)` покрывает
Write/NotebookEdit и простые Bash-записи (`tee`, `>`), но **не** произвольный скрипт, который сам
открывает файлы. Это defense-in-depth, не sandbox.

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": [
      "Read(//home/dsh/.claude/**)",  "Edit(//home/dsh/.claude/**)",
      "Read(//home/dsh/.dsh/**)",     "Edit(//home/dsh/.dsh/**)",
      "Read(//home/dsh/.ssh/**)",     "Edit(//home/dsh/.ssh/**)",
      "Read(//home/dsh/.gnupg/**)",   "Edit(//home/dsh/.gnupg/**)",
      "Read(//home/dsh/.config/**)",  "Edit(//home/dsh/.config/**)",
      "Read(//etc/**)",               "Edit(//etc/**)",
      "Read(//root/**)",              "Edit(//root/**)",
      "Read(//home/dsh/projects/**/.env)", "Edit(//home/dsh/projects/**/.env)",
      "Bash(sudo *)", "Bash(systemctl *)", "Bash(tailscale *)",
      "Bash(curl *)", "Bash(wget *)", "Bash(nc *)", "Bash(ssh *)"
    ]
  }
}
```

Проверка: init с этими `settings` и `disallowedTools: ['Bash','WebFetch','WebSearch','Agent','Workflow']`
показал `permissionMode: "default"`, `tools` без Bash/WebFetch/WebSearch/Agent (остались
Read/Edit/Write/Glob/Grep/NotebookEdit/Skill/TaskStop/ToolSearch и т.п.), ошибок валидации нет.

Для PWA разумный дефолт:

* `tools: ['Read','Edit','Write','Glob','Grep']` (без Bash) — «чат по коду»;
* Bash — отдельный opt-in на сессию, с `canUseTool` и deny на опасные команды, `cwd` внутри workspace;
* `WebFetch`/`WebSearch` — выключены или через allowlist доменов;
* никогда `bypassPermissions`; `--dangerously-skip-permissions` не использовать.

### 4.4 OS-sandbox для Bash

`Options.sandbox` (bubblewrap на Linux) умеет ограничить FS/network для Bash. Но:

```
$ which bwrap bubblewrap     → (ничего)
$ cat /proc/sys/kernel/unprivileged_userns_clone → 1
$ cat /proc/sys/user/max_user_namespaces → 7717
```

`bubblewrap` не установлен, поставить без root нельзя (apt недоступен). При `sandbox.enabled: true`
SDK по умолчанию `failIfUnavailable: true` → сессия упадёт с ошибкой, а не запустится без песочницы.
Варианты: (а) не включать sandbox и ограничиться permission-правилами (осознанный риск);
(б) root ставит `bubblewrap` — тогда включить `{enabled: true, autoAllowBashIfSandboxed: true}`;
(в) вообще не давать Bash в веб-интерфейсе. `--restricted` (CLI) — хороший компромисс: убирает
Bash/PowerShell/WebFetch, запирает файловые инструменты в рабочих каталогах, игнорирует
user/project settings; в SDK его можно передать через `extraArgs: { restricted: null }`
(не проверялось на практике).

### 4.5 Память, процессы, параллелизм

Измерено на этом VPS (Node 24.22.3, SDK 0.3.330, `model: haiku`, `tools: []`):

| Метрика | Значение |
|---|---|
| RSS child-процесса Claude Code (idle streaming session) | 206.3 → 206.6 МБ |
| Пик RSS child за один короткий турн | 209.7–210.8 МБ |
| RSS host-процесса Node (импорт SDK, 1 сессия) | 80.6 МБ (heap used 11.2 МБ) |
| Процессов на сессию | 1 (`claude`), доп. процессы — только Bash-инструменты/субагенты |
| Старт: `system/init` | ~1.77 с (cold) |
| Первый `result` (путь с 401 и ретраями) | ~4.0 с |

Оценка: **~290 МБ на активную сессию** (210 + доля host 80). Сейчас: всего 1967 МБ, available
~1054 МБ, DSH web уже занимает ~403 МБ. Итого:

* 1 сессия — комфортно;
* 2 сессии — норма (~600 МБ), рекомендуется как лимит по умолчанию;
* 3 — на грани, при тяжёлых контекстах/субагентах возможен OOM или swap (swap 1 ГБ уже частично занят);
* больше 3 — не стоит.

Дополнительно: 2 vCPU, так что параллельные сессии конкурируют за CPU на парсинге/инструментах,
хотя основное время — сетевой ответ API. Практика: **очередь на 2 активных, остальные — «waiting»**,
idle-сессия без турна всё равно держит ~206 МБ, поэтому закрывать `query()` после N минут
неактивности (и `resume` при возврате). Лимиты на турн: `maxTurns`, `maxBudgetUsd`,
`maxThinkingTokens`/`effort`, таймаут на approval.

### 4.6 Транскрипты, диск, очистка

* Путь: `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl` (по умолчанию
  `~/.claude/projects/…`). Формат — внутренний JSONL, парсить не рекомендуется (есть
  `listSessions()`/`getSessionMessages()`).
* Наблюдения: `~/.claude` = 12 МБ; `projects` = 2.9 МБ / 6 транскриптов (total 2.7 МБ, max 1.3 МБ);
  `plugins` 2.9 МБ. Т.е. **~0.3–1.3 МБ на сессию**, растёт с tool-выводом.
* Ретенция: `cleanupPeriodDays` (по умолчанию 30 дней); `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` —
  ограничить рост одного `-p`/SDK-транскрипта; `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` или
  `persistSession: false` — вообще не писать (но тогда нет resume).
* Удаление: `claude purge <path>` (транскрипты, tasks, debug-логи, file history, запись в
  `~/.claude.json`; есть `--dry-run`). В SDK — `deleteSession(id)`, `archiveSession(id)`.
  `claude purge /home/dsh/projects/tmp-research --dry-run` на этом хосте отработал: «1 item(s)
  would be deleted» (запись проекта в `~/.claude.json`), транскриптов не было (`persistSession:false`).
* Что ещё попадает на диск: `.claude.json` (история/trust/MCP, 159 КБ у текущего пользователя),
  `backups/`, `plugins/`, `shell-snapshots/`, `sessions/*.json` (реестр конкурентных сессий),
  `sessions/*.key` (UDS auth), debug-логи (только если включить `--debug-file`), `plans/`.
  С `CLAUDE_CONFIG_DIR` всё это уезжает в каталог приложения.
* Диск: 21 ГБ свободно; install SDK 429 МБ + транскрипты — не проблема, но кэш npm (209 МБ) лучше
  не тащить в прод.

---

## 5. Практическая проверка (что реально сделано)

Все команды — в `/home/dsh/projects/tmp-research/`, без sudo, без глобальных установок,
без `--dangerously-skip-permissions`.

### 5.1 Установка SDK (успех)

```
npm install @anthropic-ai/claude-agent-sdk@0.3.330 --cache …/.npm-cache
→ added 105 packages in 40s, exit 0
```

Локальный кэш npm сработал (root-owned `~/.npm` не мешал). `node_modules` 429 МБ.

### 5.2 Headless handshake и кадры (успех)

SDK, `tools: []`, `settingSources: []`, `persistSession: false`, `model: haiku`, cwd tmp-research:

```json
{ "frame_types": ["system/init","system/status","system/api_retry","assistant","result/success"],
  "init": { "claude_code_version": "2.1.330", "model": "claude-haiku-5-5",
            "permissionMode": "default", "apiKeySource": "none", "tools": [],
            "mcp_servers": [], "session_id": "…",
            "capabilities": ["interrupt_receipt_v1","interrupt_cancel_queued_v1",…] },
  "result": { "subtype": "success", "is_error": true, "api_error_status": 401,
              "result": "Failed to authenticate. API Error: 401 OAuth access token has expired…" } }
```

То же через прямой spawn:

```bash
claude -p "Reply with exactly one word: ok" --output-format stream-json --verbose \
  --include-partial-messages --tools "" --setting-sources "" --no-session-persistence --model haiku
→ 6 строк NDJSON: system/init, system/status, system/api_retry, assistant, result/success
```

Т.е. **транспорт, NDJSON-формат, init, partial-messages, exit-коды — работают на Node 24**.

### 5.3 Модельный вызов (заблокирован, 401)

Причина — не код, а песочница: см. §3.2 (`EACCES` на `.oauth_refresh.lock`, истёкший access
token, refresh невозможен). Ни SDK, ни прямой `claude -p` не могут завершить турн без валидного
токена. **Это единственное, что не дало проверить живой текст и стриминг токенов.**

### 5.4 Interrupt (успех)

`--input-format stream-json --output-format stream-json --replay-user-messages`, отправлен
user-кадр, затем:

```
→ control_request {subtype:"interrupt"}
← control_response success {"still_queued":[]}
→ result/error_during_execution, exit 1
```

Протокол прерывания подтверждён (не «SIGINT», а control request; ответ содержит `still_queued`).

### 5.5 Resume (успех в части валидации)

```js
query({ prompt:'ok', options:{ resume:'00000000-0000-4000-8000-000000000000', persistSession:false }})
→ result error_during_execution: "No conversation found with session ID: …", total 1.7 s
```

Т.е. resume реально ищет транскрипт и корректно падает на отсутствующем; успешный resume
не проверен (нужен завершённый турн = валидный auth).

### 5.6 Policy/изоляция (успех)

init с `settings.permissions.deny` (список §4.3) и `disallowedTools` принят без ошибок:
`tools` не содержит Bash/WebFetch/WebSearch/Agent/Workflow — фильтрация работает.
Скиллы (`design`, `dataviz`, `code-review`, …) при `settingSources: []` всё равно перечисляются —
это встроенные/bundled скиллы; если нужен минимум поверхности, добавляйте `--disable-slash-commands`
или `CLAUDE_CODE_SAFE_MODE=1`.

### 5.7 Прочее (успех)

* `CLAUDE_CONFIG_DIR` изолирует `projects/` и `.claude.json` — проверено.
* `CLAUDE_CODE_OAUTH_TOKEN` переключает authMethod на `oauth_token` и не пишет в `~/.claude` —
  проверено (с dummy-токеном, ошибка «invalid», а не «expired»).
* Один процесс на сессию, ~210 МБ — измерено.

### 5.8 Ограничения исследования

1. Нельзя запустить вне DSH-песочницы → нельзя проверить успешный refresh/успешный ответ модели.
2. Копировать `~/.claude/.credentials.json` в тестовый каталог не стал: риск ротации
   refresh-token и разлогина владельца; плюс это ровно то, что запрещено делать «вслепую».
3. `claude setup-token` требует браузер — не выполнялся (в headless-сессии нет TTY/браузера).
4. Нет `bubblewrap`, нет root — OS-sandbox и отдельный пользователь не проверялись.
5. Мультисессионная нагрузка (2–3 параллельных) не гонялась — оценка по замерам одной сессии.

---

## 6. Рекомендуемая архитектура и чек-лист

```
браузер (PWA) ──HTTPS/WSS──> auth-gateway (уже есть, :9090)
                                   │  (только владелец, Tailscale Funnel)
                                   v
                       claude-pwa backend (Node 24, :3081, systemd User=dsh)
                         │  @anthropic-ai/claude-agent-sdk
                         │  CLAUDE_CONFIG_DIR=data/claude-config
                         │  CLAUDE_CODE_OAUTH_TOKEN из data/oauth.env (0600)
                         │  сессия = query({ prompt: AsyncIterable, options })
                         │    canUseTool ──WS──> UI (approve/deny)
                         │    interrupt()  <──UI
                         v
                       claude child (2.1.330, ~210 МБ) × до 2
                         cwd = workspaces/<project>
                         tools: Read/Edit/Write/Glob/Grep (+Bash opt-in)
                         settingSources: []
                         permissions.deny: ~/.claude, ~/.dsh, ~/.ssh, /etc, /root
```

Чек-лист внедрения:

1. `mkdir -p /home/dsh/projects/claude-pwa/{data,workspaces}`; `chmod 700 data`.
2. `npm i @anthropic-ai/claude-agent-sdk@0.3.330` в каталоге приложения (не глобально);
   зафиксировать версию в lockfile, обновлять осознанно (SDK = рантайм CLI).
3. Владелец запускает `claude setup-token`, кладёт токен в `data/oauth.env` (`0600`).
4. Backend: `CLAUDE_CONFIG_DIR=data/claude-config`, `env: {...process.env}`,
   `settingSources: []`, allowlist инструментов, deny-правила, `persistSession: true`,
   `includePartialMessages: true`, `maxTurns`/`maxBudgetUsd`.
   **Не использовать `--bare`**: он намеренно не читает OAuth-логин и `CLAUDE_CODE_OAUTH_TOKEN`
   (только `ANTHROPIC_API_KEY`/`apiKeyHelper`).
5. UI: кнопка Stop → `q.interrupt()`; очередь approvals с таймаутом; показ `rate_limit_event`;
   обработка `result.is_error` + `api_error_status` 401 → «обновите вход».
6. Лимит: 2 активные сессии, idle-close через 10–15 мин, `resume` при возврате.
7. Логи: без токенов/промптов; `authMethod`, `api_error_status`, `session_id`, `request_id`.
8. Ретенция: `cleanupPeriodDays` (например 14), периодический `claude purge --dry-run`/`deleteSession`.
9. Не включать `bypassPermissions`, не ставить `--dangerously-skip-permissions`, не выносить
   backend в публичный интернет (только через gateway).
10. Пересмотреть, когда появится root: отдельный пользователь + `bubblewrap` + systemd unit
    с `EnvironmentFile`, `NoNewPrivileges=yes`, `ProtectHome=read-only` (кроме каталога данных).

---

## 7. Что осталось непроверенным / открытые вопросы

1. Успешный headless-турн и реальный стриминг текста (нужен валидный токен вне песочницы).
2. Автоматический refresh файлового OAuth при writable `$CLAUDE_CONFIG_DIR` (ожидаемо работает;
   в песочнице невоспроизводимо).
3. `claude setup-token`: фактический срок/поведение при истечении, отзыв токена, работает ли он
   с SDK-сессиями resume (по докам — только model requests; resume локальный, значит должен).
4. OS-sandbox Bash (`bubblewrap`) — не установлен, включение не тестировалось.
5. Поведение `--restricted` через SDK `extraArgs`.
6. Нагрузка 2–3 параллельных сессий, OOM/swap-поведение, влияние субагентов на память.
7. Кто и как запустит backend без root: `systemd --user` недоступен, `dsh-web.service` root-only
   (`0600`), `crontab` недоступен. Нужен root/оператор для unit'а либо запуск под существующим
   супервизором — это организационный блокер, а не технический.

---

## Приложение: ключевые команды исследования

```bash
claude --version                              # 2.1.329
claude auth status                            # loggedIn, claude.ai, pro, loginExpiresAt
stat ~/.claude/.credentials.json              # 0600, 695 B
claude -p "ok" --tools "" --output-format json --no-session-persistence
claude -p "ok" --debug-file ./debug.log       # EACCES .oauth_refresh.lock → 401
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-DUMMY claude auth status
CLAUDE_CONFIG_DIR=./.claude-cfg claude auth status
claude purge /path --dry-run
npm view @anthropic-ai/claude-agent-sdk version   # 0.3.330
node -e 'import("@anthropic-ai/claude-agent-sdk").then(m=>console.log(typeof m.query))'
```

Ссылки на официальные документы:

* https://code.claude.com/docs/en/agent-sdk/overview.md
* https://code.claude.com/docs/en/agent-sdk/typescript
* https://code.claude.com/docs/en/agent-sdk/permissions.md
* https://code.claude.com/docs/en/agent-sdk/user-input.md
* https://code.claude.com/docs/en/agent-sdk/sessions.md
* https://code.claude.com/docs/en/headless.md
* https://code.claude.com/docs/en/cli-reference.md
* https://code.claude.com/docs/en/authentication.md
* https://code.claude.com/docs/en/sessions.md
* https://code.claude.com/docs/en/legal-and-compliance.md
