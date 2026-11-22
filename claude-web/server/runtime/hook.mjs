/**
 * runtime/hook.mjs — реальная граница для путей (plan §6.3, §7.1 п.11).
 *
 * makePathGuard({workspacesRoot, homeDir}) резолвит realpath и разрешает только
 * /srv/claude-web/workspaces/**; отдельно запрещает /proc, /etc, /var/lib/claude-web,
 * /var/log/claude-web, ~/.claude, ~/.dsh, ~/.ssh, ~/.gnupg и ЛЮБЫЕ симлинки
 * внутри workspace (обход deny через link → /proc/self/environ или /var/log/...).
 *
 * Покрывает Read/Edit/Write/Grep/Glob (и NotebookEdit), а не только Read.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_PATH_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function normRoot(p) {
  try {
    return realpathSync(p);
  } catch {
    throw new Error('workspaces root unavailable');
  }
}

function inside(root, target) {
  return target === root || target.startsWith(root + sep);
}

function isSensitive(target, homeDir) {
  const list = [
    '/proc',
    '/sys',
    '/etc',
    '/root',
    '/var/lib/claude-web',
    '/var/log/claude-web',
    '/var/run',
    '/boot',
    '/dev',
  ];
  if (homeDir) {
    list.push(join(homeDir, '.claude'), join(homeDir, '.dsh'), join(homeDir, '.ssh'), join(homeDir, '.gnupg'));
  }
  for (const p of list) {
    if (target === p || target.startsWith(p + '/')) return p;
  }
  return null;
}

/** Разрешает путь, которого ещё нет: realpath ближайшего существующего предка. */
function resolveNonexistent(target, root) {
  let cur = target;
  const missing = [];
  for (let i = 0; i < 64; i += 1) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return { ok: false, reason: 'invalid_path' };
      missing.unshift(basename(cur));
      cur = parent;
      continue;
    }
    // существующий предок: проверяем симлинки на всём пути root → cur
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    let real;
    try {
      real = realpathSync(cur);
    } catch {
      return { ok: false, reason: 'invalid_path' };
    }
    if (cur !== root && !inside(root, cur)) {
      // путь мог быть задан через симлинк выше root — сравниваем по realpath
      if (!inside(root, real)) return { ok: false, reason: 'outside_workspace' };
    }
    // walk root → cur, запрещая симлинки в компонентах
    if (inside(root, cur) && cur !== root) {
      const rel = relative(root, cur);
      let p = root;
      for (const part of rel.split(sep).filter(Boolean)) {
        p = join(p, part);
        try {
          if (lstatSync(p).isSymbolicLink()) return { ok: false, reason: 'symlink' };
        } catch {
          return { ok: false, reason: 'invalid_path' };
        }
      }
    }
    const resolved = missing.length ? join(real, ...missing) : real;
    return { ok: true, path: resolved };
  }
  return { ok: false, reason: 'too_deep' };
}

/**
 * @param {{workspacesRoot:string, homeDir?:string}} opts
 */
export function makePathGuard({ workspacesRoot, homeDir }) {
  const root = normRoot(workspacesRoot);

  /**
   * @param {unknown} absPath
   * @returns {{allowed:true,path:string}|{allowed:false,reason:string,code:string}}
   */
  function checkPath(absPath) {
    if (typeof absPath !== 'string' || !absPath) {
      return { allowed: false, reason: 'path is required', code: 'invalid_path' };
    }
    if (absPath.includes('\0')) return { allowed: false, reason: 'invalid path', code: 'invalid_path' };
    if (!isAbsolute(absPath)) return { allowed: false, reason: 'path must be absolute', code: 'invalid_path' };

    const normalized = resolve(absPath);
    const sensitive = isSensitive(normalized, homeDir);
    if (sensitive) {
      return { allowed: false, reason: 'path is not allowed', code: 'sensitive_path' };
    }
    if (!inside(root, normalized)) {
      return { allowed: false, reason: 'path outside workspace', code: 'outside_workspace' };
    }
    const resolved = resolveNonexistent(normalized, root);
    if (!resolved.ok) {
      return { allowed: false, reason: resolved.reason === 'symlink' ? 'symlinks are not allowed' : 'path is not allowed', code: resolved.reason };
    }
    if (!inside(root, resolved.path)) {
      return { allowed: false, reason: 'path escapes workspace', code: 'outside_workspace' };
    }
    return { allowed: true, path: resolved.path };
  }

  /**
   * @param {string} toolName
   * @param {Record<string, unknown>} input
   * @param {string} cwd
   */
  function checkToolInput(toolName, input, cwd) {
    const tool = String(toolName || '');
    if (!PATH_TOOLS.has(tool)) return { allowed: true, code: 'not_a_path_tool' };
    const inp = input && typeof input === 'object' ? input : {};
    const cwdCheck = typeof cwd === 'string' ? checkPath(cwd) : { allowed: true };
    if (!cwdCheck.allowed) return cwdCheck;

    let p;
    if (tool === 'Grep' || tool === 'Glob') {
      p = typeof inp.path === 'string' && inp.path ? inp.path : cwd;
    } else {
      p = inp.file_path ?? inp.notebook_path ?? inp.path;
    }
    if (typeof p !== 'string' || !p) {
      return { allowed: false, reason: 'missing file path', code: 'invalid_path' };
    }
    const candidate = isAbsolute(p) ? p : resolve(cwd, p);
    const res = checkPath(candidate);
    if (!res.allowed) return res;
    if (WRITE_TOOLS.has(tool) && res.path.endsWith(`${sep}.claude${sep}settings.json`)) {
      return { allowed: false, reason: 'settings are not writable', code: 'sensitive_path' };
    }
    return { allowed: true, path: res.path, code: 'ok' };
  }

  /**
   * @param {{tool_name?:string, tool_input?:unknown, cwd?:string}} sdkInput
   * @returns {{decision:'allow'|'deny', reason?:string, code:string}}
   */
  function preToolUse(sdkInput) {
    const input = sdkInput || {};
    const tool = String(input.tool_name || '');
    const res = checkToolInput(tool, input.tool_input, typeof input.cwd === 'string' ? input.cwd : root);
    if (res.allowed) return { decision: 'allow', code: 'ok' };
    return { decision: 'deny', reason: res.reason, code: res.code };
  }

  /** Человекочитаемые предупреждения для UI (показываем в tool_request). */
  function describeWarnings(toolName, input, cwd) {
    const warnings = [];
    const tool = String(toolName || '');
    const inp = input && typeof input === 'object' ? input : {};
    if (READ_PATH_TOOLS.has(tool) === false && !PATH_TOOLS.has(tool)) {
      warnings.push('Инструмент вне обычного набора safe-режима');
    }
    if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
      warnings.push('Изменение файла в workspace — проверьте путь и содержимое');
    }
    const text = JSON.stringify(inp);
    if (/\.env|\/etc\/|\.ssh|\.gnupg|\.claude|\.dsh|\/proc\//i.test(text)) {
      warnings.push('Входные данные ссылаются на чувствительный путь');
    }
    if (/\b(sudo|systemctl|ssh|curl|wget|nc|bash\s+-c)\b/i.test(text)) {
      warnings.push('Входные данные похожи на команду/сетевой доступ');
    }
    for (const v of Object.values(inp)) {
      if (typeof v === 'string' && !isAbsolute(v)) continue;
      if (typeof v === 'string' && isAbsolute(v)) {
        const res = checkPath(v);
        if (!res.allowed) warnings.push('Путь вне workspace будет отклонён');
        break;
      }
    }
    return [...new Set(warnings)].slice(0, 5);
  }

  return { root, checkPath, checkToolInput, preToolUse, describeWarnings };
}

export default makePathGuard;
