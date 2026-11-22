/**
 * runtime/fake.mjs — fake-провайдер для тестов и локального UI (CONTRACT §3).
 *
 * sendUserText(text):
 *   - 2–4 assistant_delta, assistant_message, result;
 *   - если в тексте есть 'tool:' — tool_request (Edit) -> requestApproval ->
 *     tool_result (allow/deny/timeout), затем result;
 *   - 'slow' добавляет задержку, чтобы тестировать interrupt.
 *
 * Никаких сетевых вызовов и файловых операций.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function splitChunks(text, count) {
  const n = Math.max(2, Math.min(4, count));
  const str = String(text);
  const words = str.split(/(\s+)/).filter(Boolean);
  const per = Math.max(1, Math.ceil(words.length / n));
  const out = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(''));
  if (out.length >= 2) return out;
  // одно слово: режем на 2 части, чтобы контракт (2–4 delta) выполнялся
  const mid = Math.max(1, Math.ceil(str.length / 2));
  return [str.slice(0, mid), str.slice(mid)].filter(Boolean);
}

function toolFromText(text) {
  const m = /tool:\s*(edit|write)/i.exec(text);
  return m ? (m[1].toLowerCase() === 'write' ? 'Write' : 'Edit') : 'Edit';
}

/**
 * @param {{sessionId:string, cwd:string, resume?:string, emit:Function,
 *          requestApproval:Function, config?:object, delayMs?:number}} opts
 */
export function createFakeSession({ sessionId, cwd, resume, emit, requestApproval, delayMs = 2 }) {
  let sdkSessionId = resume || null;
  let closed = false;
  let interrupted = false;
  let status = 'idle';
  let messageSeq = 0;
  const filePath = join(cwd, 'fake-edit.txt');

  const safeEmit = (ev) => {
    if (closed) return;
    try {
      emit(ev);
    } catch {
      /* emit не должен ронять fake */
    }
  };

  async function runTurn(text) {
    status = 'running';
    interrupted = false;
    safeEmit({ type: '_sdk_session_id', sdkSessionId: sdkSessionId || `fake-sdk-${sessionId}` });
    if (!sdkSessionId) sdkSessionId = `fake-sdk-${sessionId}`;

    const chunks = splitChunks(text, 3);
    const step = /slow/i.test(text) ? Math.max(delayMs, 12) : delayMs;
    for (const chunk of chunks) {
      if (closed) return;
      if (interrupted) break;
      safeEmit({ type: 'assistant_delta', text: chunk });
      await sleep(step);
    }
    if (closed) return;
    if (!interrupted) {
      messageSeq += 1;
      safeEmit({ type: 'assistant_message', text, messageId: `fake-msg-${messageSeq}` });
    }

    if (!interrupted && /tool:/i.test(text)) {
      const tool = toolFromText(text);
      const reqId = randomUUID();
      const decision = await requestApproval({
        reqId,
        tool,
        input:
          tool === 'Write'
            ? { file_path: filePath, content: 'fake content\n' }
            : { file_path: filePath, old_string: 'a', new_string: 'b' },
        cwd,
        warnings: ['Изменение файла в workspace — проверьте путь и содержимое'],
      });
      if (closed) return;
      safeEmit({
        type: 'tool_result',
        reqId,
        tool,
        ok: decision?.decision === 'allow',
        summary:
          decision?.decision === 'allow'
            ? 'выполнено (fake)'
            : `отклонено: ${decision?.reason || 'deny'}`,
      });
    }

    if (closed) return;
    safeEmit({
      type: 'result',
      text: interrupted ? '' : text,
      usage: { input_tokens: 0, output_tokens: 0 },
      stopReason: interrupted ? 'interrupted' : 'end_turn',
    });
    status = 'idle';
  }

  let chain = Promise.resolve();

  return {
    sendUserText(text) {
      if (closed) return Promise.reject(new Error('session closed'));
      const run = chain.then(() => runTurn(text));
      chain = run.catch(() => {});
      return run;
    },
    async interrupt() {
      interrupted = true;
      status = 'idle';
    },
    async close() {
      closed = true;
      interrupted = true;
      status = 'closed';
    },
    info() {
      return { sdkSessionId, status: closed ? 'closed' : status };
    },
  };
}

export default createFakeSession;
