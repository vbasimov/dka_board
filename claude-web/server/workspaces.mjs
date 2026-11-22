/**
 * workspaces.mjs — единственный источник cwd для сессий (CONTRACT §6, plan §6.3).
 *
 * cwd никогда не берётся у клиента вслепую: только существующий каталог —
 * прямой потомок WORKSPACES, после realpath и prefix-проверки, без симлинков.
 */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { forbidden, HttpError } from './http-util.mjs';

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function realpathRoot(config) {
  try {
    const root = realpathSync(config.workspaces);
    const st = lstatSync(root);
    if (!st.isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new HttpError(500, 'internal', 'workspaces directory unavailable');
  }
}

function inside(root, target) {
  return target === root || target.startsWith(root + sep);
}

/**
 * @param {object} config
 * @returns {{id:string,name:string,path:string}[]}
 */
export function listWorkspaces(config) {
  const root = realpathRoot(config);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    throw new HttpError(500, 'internal', 'workspaces directory unavailable');
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.name || ent.name.startsWith('.')) continue;
    if (ent.isSymbolicLink()) continue;
    const abs = join(root, ent.name);
    const lst = lstatOrNull(abs);
    if (!lst || !lst.isDirectory()) continue;
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!inside(root, real) || real === root) continue;
    if (real !== abs) continue; // путь идёт через симлинк — не workspace
    out.push({ id: basename(real), name: basename(real), path: real });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Разрешает cwd из server-side списка workspace.
 * @param {object} config
 * @param {unknown} input id или абсолютный путь из listWorkspaces
 * @returns {string} канонический абсолютный путь
 */
export function resolveCwd(config, input) {
  const workspaces = listWorkspaces(config);
  if (input === undefined || input === null || input === '') {
    if (workspaces.length === 1) return workspaces[0].path;
    throw new HttpError(400, 'bad_request', 'cwd is required');
  }
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) {
    throw new HttpError(400, 'bad_request', 'invalid cwd');
  }
  const value = input.trim();
  if (!value) throw new HttpError(400, 'bad_request', 'invalid cwd');

  if (!value.includes('/') && !value.includes('\\')) {
    const byId = workspaces.find((w) => w.id === value);
    if (byId) return byId.path;
  }

  if (!value.startsWith('/')) {
    throw new HttpError(400, 'bad_request', 'cwd must be a workspace id or absolute path');
  }
  let real;
  try {
    real = realpathSync(value);
  } catch {
    throw new HttpError(400, 'bad_request', 'cwd does not exist');
  }
  const root = realpathRoot(config);
  if (!inside(root, real) || real === root) {
    throw forbidden('cwd outside workspaces');
  }
  const byPath = workspaces.find((w) => w.path === real);
  if (!byPath) throw forbidden('cwd is not an allowed workspace');
  return byPath.path;
}

export default { listWorkspaces, resolveCwd };
