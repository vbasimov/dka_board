/**
 * runtime/sdk.mjs — реальный провайдер @anthropic-ai/claude-agent-sdk 0.3.330.
 *
 * Инварианты (plan §6.2, §6.3, CONTRACT §3):
 *   - permissionMode только 'default'; tools — безопасный whitelist;
 *     disallowedTools Bash/BashOutput/KillShell/WebFetch/WebSearch/Task/Agent;
 *   - НИКАКИХ allow-правил, обходящих canUseTool; settingSources: [];
 *     additionalDirectories: []; strictMcpConfig: true;
 *   - Edit/Write/др. — подтверждение через requestApproval (5 мин -> deny);
 *     Read/Glob/Grep разрешаются, но эмитят tool_request (auto:true);
 *   - PreToolUse-хук делает realpath и режет пути вне workspace, /proc, /etc,
 *     /var/lib/claude-web, /var/log/claude-web, ~/.claude, ~/.dsh и симлинки;
 *   - child env — минимальный allowlist, без EDGE_SECRET/DSH-переменных.
 *
 * Модуль импортируется лениво; @anthropic-ai/claude-agent-sdk грузится только
 * в createSdkSession(), поэтому fake-режим и тесты не требуют node_modules.
 */
import { randomUUID } from 'node:crypto';
import { makePathGuard } from './hook.mjs';

export const DISALLOWED_TOOLS = Object.freeze([
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
]);

export const SAFE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion']);

const READ_ONLY = new Set(['Read', 'Glob', 'Grep']);

const PATH_DENY = [
  'Read(//proc/**)',
  'Read(//sys/**)',
  'Read(//etc/**)',
  'Read(//root/**)',
  'Read(//var/lib/claude-web/**)',
  'Read(//var/log/claude-web/**)',
  'Read(//dev/**)',
  'Read(//**/.env)',
  'Read(~/.claude/**)',
  'Read(~/.dsh/**)',
  'Read(~/.ssh/**)',
  'Read(~/.gnupg/**)',
  'Edit(//proc/**)',
  'Edit(//sys/**)',
  'Edit(//etc/**)',
  'Edit(//root/**)',
  'Edit(//var/lib/claude-web/**)',
  'Edit(//var/log/claude-web/**)',
  'Edit(//**/.env)',
  'Edit(~/.claude/**)',
  'Edit(~/.dsh/**)',
  'Edit(~/.ssh/**)',
  'Edit(~/.gnupg/**)',
  'Write(//proc/**)',
  'Write(//sys/**)',
  'Write(//etc/**)',
  'Write(//root/**)',
  'Write(//var/lib/claude-web/**)',
  'Write(//var/log/claude-web/**)',
  'Write(//**/.env)',
  'Write(~/.claude/**)',
  'Write(~/.dsh/**)',
  'Write(~/.ssh/**)',
  'Write(~/.gnupg/**)',
];

export const PERMISSION_DENY_RULES = Object.freeze(PATH_DENY);

/**
 * Минимальный env для child. Никогда не {...process.env}: EDGE_SECRET,
 * DSH/Telegram/прокси-переменные не должны наследоваться.
 */
export function buildChildEnv(config) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: config.home,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DO_NOT_TRACK: '1',
  };
  if (config.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  return env;
}

/** Опции query() — чистый объект, тестируется без установленного SDK. */
export function buildSdkOptions({ config, cwd, resume, canUseTool, hooks, abortController }) {
  const options = {
    cwd,
    includePartialMessages: true,
    permissionMode: 'default',
    disallowedTools: [...DISALLOWED_TOOLS],
    tools: [...SAFE_TOOLS],
    settingSources: [],
    strictMcpConfig: true,
    additionalDirectories: [],
    maxTurns: config.maxTurns ?? 30,
    env: buildChildEnv(config),
    settings: { permissions: { deny: [...PERMISSION_DENY_RULES] } },
    canUseTool,
    hooks,
  };
  if (resume) options.resume = resume;
  if (abortController) options.abortController = abortController;
  return options;
}

function textFromMessage(message) {
  const content = message && typeof message === 'object' ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Маппинг SDKMessage -> внутренние события сервера (CONTRACT §5).
 * Чистая функция: без сети/файлов, удобна для проверки на VPS без токена.
 * @returns {{type:string, [key:string]:unknown}[]}
 */
export function mapSdkMessage(msg) {
  const out = [];
  if (!msg || typeof msg !== 'object') return out;
  if (msg.type === 'system') {
    if (msg.subtype === 'init') {
      if (typeof msg.session_id === 'string' && msg.session_id) {
        out.push({ type: '_sdk_session_id', sdkSessionId: msg.session_id });
      }
    } else if (msg.subtype === 'status') {
      if (msg.status === 'compacting' || msg.status === 'requesting') out.push({ type: 'status', status: 'running' });
    }
    return out;
  }
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (
      ev &&
      ev.type === 'content_block_delta' &&
      ev.delta &&
      ev.delta.type === 'text_delta' &&
      typeof ev.delta.text === 'string' &&
      ev.delta.text
    ) {
      out.push({ type: 'assistant_delta', text: ev.delta.text });
    }
    return out;
  }
  if (msg.type === 'assistant') {
    const text = textFromMessage(msg.message);
    if (text) out.push({ type: 'assistant_message', text, messageId: msg.message?.id });
    if (msg.error) {
      const auth = msg.error === 'authentication_failed' || msg.error === 'oauth_org_not_allowed';
      out.push({
        type: 'error',
        code: auth ? 'auth_expired' : 'assistant_error',
        message: auth
          ? 'Требуется повторный вход: токен истёк или отозван'
          : 'Ошибка ответа модели',
      });
    }
    return out;
  }
  if (msg.type === 'result') {
    if (msg.subtype === 'success') {
      out.push({
        type: 'result',
        text: typeof msg.result === 'string' ? msg.result : '',
        usage: msg.usage,
        stopReason: msg.stop_reason ?? null,
      });
    } else {
      out.push({ type: 'error', code: 'turn_failed', message: 'Ход завершился ошибкой' });
    }
    return out;
  }
  return out;
}

/**
 * @param {{sessionId:string, cwd:string, resume?:string, emit:Function,
 *          requestApproval:Function, config:object}} opts
 */
export async function createSdkSession({ sessionId, cwd, resume, emit, requestApproval, config }) {
  // fail-closed: без workspace/guard рантайм не стартует
  const guard = makePathGuard({ workspacesRoot: config.workspaces, homeDir: config.home });
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const abortController = new AbortController();
  const toolReqByUseId = new Map();
  const inbound = [];
  let wake = null;
  let closed = false;
  let sdkSessionId = resume || null;
  let status = 'idle';
  let queryObj = null;

  const safeEmit = (ev) => {
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === '_sdk_session_id') {
      if (typeof ev.sdkSessionId === 'string' && ev.sdkSessionId) sdkSessionId = ev.sdkSessionId;
      try {
        emit(ev);
      } catch {
        /* ignore */
      }
      return;
    }
    if (closed) return;
    try {
      emit(ev);
    } catch {
      /* emit не должен ронять сессию */
    }
  };

  const emitDeniedToolResult = (toolUseID, tool, reason) => {
    const reqId = toolUseID ? toolReqByUseId.get(toolUseID) : undefined;
    if (!reqId) return;
    toolReqByUseId.delete(toolUseID);
    safeEmit({ type: 'tool_result', reqId, tool, ok: false, summary: `отклонено: ${reason}` });
  };

  const canUseTool = async (toolName, input, options = {}) => {
    if (closed) return { behavior: 'deny', message: 'session closed' };
    const tool = String(toolName || '');
    const safeInput = input && typeof input === 'object' ? input : {};
    const chk = guard.checkToolInput(tool, safeInput, cwd);
    if (!chk.allowed) {
      emitDeniedToolResult(options.toolUseID, tool, 'path');
      return { behavior: 'deny', message: 'path not allowed' };
    }
    if (READ_ONLY.has(tool)) {
      if (options.toolUseID && !toolReqByUseId.has(options.toolUseID)) {
        const reqId = randomUUID();
        toolReqByUseId.set(options.toolUseID, reqId);
        safeEmit({
          type: 'tool_request',
          reqId,
          tool,
          input: safeInput,
          cwd,
          warnings: [],
          expiresAt: null,
          auto: true,
        });
      }
      return { behavior: 'allow', updatedInput: safeInput };
    }
    if (options.signal?.aborted) {
      emitDeniedToolResult(options.toolUseID, tool, 'aborted');
      return { behavior: 'deny', message: 'aborted' };
    }
    const reqId = randomUUID();
    if (options.toolUseID) toolReqByUseId.set(options.toolUseID, reqId);
    const warnings = guard.describeWarnings(tool, safeInput, cwd);
    const decision = await requestApproval({ reqId, tool, input: safeInput, cwd, warnings });
    if (closed) {
      emitDeniedToolResult(options.toolUseID, tool, 'closed');
      return { behavior: 'deny', message: 'session closed' };
    }
    if (decision && decision.decision === 'allow') {
      return { behavior: 'allow', updatedInput: safeInput };
    }
    const reason =
      decision?.reason === 'timeout' ? 'timeout' : decision?.reason === 'interrupted' ? 'interrupted' : 'denied';
    emitDeniedToolResult(options.toolUseID, tool, reason);
    return { behavior: 'deny', message: reason === 'timeout' ? 'approval timeout' : reason };
  };

  const preToolUse = async (input) => {
    const hookInput = input || {};
    if (closed) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'session closed',
        },
      };
    }
    const tool = String(hookInput.tool_name || '');
    const chk = guard.checkToolInput(tool, hookInput.tool_input, hookInput.cwd || cwd);
    if (!chk.allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: chk.reason || 'path not allowed',
        },
      };
    }
    const useId = hookInput.tool_use_id;
    if (READ_ONLY.has(tool) && useId && !toolReqByUseId.has(useId)) {
      const reqId = randomUUID();
      toolReqByUseId.set(useId, reqId);
      safeEmit({
        type: 'tool_request',
        reqId,
        tool,
        input: hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {},
        cwd: hookInput.cwd || cwd,
        warnings: [],
        expiresAt: null,
        auto: true,
      });
    }
    return {};
  };

  const postToolUse = async (input) => {
    const hookInput = input || {};
    const useId = hookInput.tool_use_id;
    const reqId = useId ? toolReqByUseId.get(useId) : undefined;
    if (reqId) {
      toolReqByUseId.delete(useId);
      safeEmit({
        type: 'tool_result',
        reqId,
        tool: String(hookInput.tool_name || ''),
        ok: true,
        summary: 'выполнено',
        durationMs: typeof hookInput.duration_ms === 'number' ? hookInput.duration_ms : undefined,
      });
    }
    return {};
  };

  const postToolUseFailure = async (input) => {
    const hookInput = input || {};
    const useId = hookInput.tool_use_id;
    const reqId = useId ? toolReqByUseId.get(useId) : undefined;
    if (reqId) {
      toolReqByUseId.delete(useId);
      safeEmit({
        type: 'tool_result',
        reqId,
        tool: String(hookInput.tool_name || ''),
        ok: false,
        summary: 'инструмент завершился ошибкой',
      });
    }
    return {};
  };

  async function* inputStream() {
    while (!closed) {
      if (inbound.length) {
        yield inbound.shift();
        continue;
      }
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  }

  const hooks = {
    PreToolUse: [{ hooks: [preToolUse], timeout: 30 }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
  };

  const options = buildSdkOptions({ config, cwd, resume, canUseTool, hooks, abortController });
  queryObj = query({ prompt: inputStream(), options });

  void (async () => {
    try {
      for await (const msg of queryObj) {
        if (closed) break;
        const events = mapSdkMessage(msg);
        for (const ev of events) safeEmit(ev);
        if (msg && msg.type === 'result') status = 'idle';
      }
    } catch {
      if (!closed) {
        safeEmit({ type: 'error', code: 'runtime_error', message: 'Ошибка рантайма Claude' });
      }
    } finally {
      status = 'idle';
    }
  })();

  return {
    sendUserText(text) {
      if (closed) return Promise.reject(new Error('session closed'));
      inbound.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
        parent_tool_use_id: null,
      });
      status = 'running';
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
      return Promise.resolve();
    },
    async interrupt() {
      try {
        await queryObj?.interrupt();
      } catch {
        /* interrupt может не поддерживаться — turn всё равно прерывается abort'ом */
      }
      status = 'idle';
    },
    async close() {
      if (closed) return;
      closed = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
      try {
        abortController.abort();
      } catch {
        /* ignore */
      }
      try {
        queryObj?.close();
      } catch {
        /* ignore */
      }
    },
    info() {
      return { sdkSessionId, status: closed ? 'closed' : status };
    },
  };
}

export default createSdkSession;
