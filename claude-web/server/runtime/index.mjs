/**
 * runtime/index.mjs — выбор провайдера рантайма (CONTRACT §3).
 *
 * createRuntime(config) -> {mode, createSession}
 * SDK импортируется лениво (внутри createSession), поэтому fake-режим и тесты
 * работают без node_modules.
 */
import { createFakeSession } from './fake.mjs';

/**
 * @param {object} config
 * @returns {{mode:'sdk'|'fake', createSession:(opts:object)=>Promise<object>}}
 */
export function createRuntime(config) {
  const mode = config.runtimeMode === 'fake' ? 'fake' : 'sdk';
  return {
    mode,
    async createSession(opts) {
      if (mode === 'fake') {
        return createFakeSession({
          sessionId: opts.sessionId,
          cwd: opts.cwd,
          resume: opts.resume,
          emit: opts.emit,
          requestApproval: opts.requestApproval,
        });
      }
      const { createSdkSession } = await import('./sdk.mjs');
      return createSdkSession({ ...opts, config });
    },
  };
}

export default createRuntime;
