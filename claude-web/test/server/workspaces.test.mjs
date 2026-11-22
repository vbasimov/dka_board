import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkspaces, resolveCwd } from '../../server/workspaces.mjs';
import { HttpError } from '../../server/http-util.mjs';
import { makeConfig, tempRoot } from './helpers.mjs';

function setup() {
  const root = tempRoot('ws-');
  const cfg = makeConfig(root);
  const wsRoot = join(root, 'workspaces');
  mkdirSync(join(wsRoot, 'project-c'), { recursive: true });
  mkdirSync(join(wsRoot, 'project-a', 'nested'), { recursive: true });
  mkdirSync(join(wsRoot, '.hidden'), { recursive: true });
  writeFileSync(join(wsRoot, 'not-a-dir.txt'), 'x');
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  try {
    symlinkSync(outside, join(wsRoot, 'link-dir'));
  } catch {
    /* ignore */
  }
  return { root, cfg, wsRoot, outside };
}

test('listWorkspaces: только реальные каталоги, отсортированы, без симлинков/dotfiles', () => {
  const { cfg, wsRoot, root } = setup();
  const list = listWorkspaces(cfg);
  const wsReal = realpathSync(wsRoot);
  const ids = list.map((w) => w.id);
  assert.deepEqual(ids, ['project-a', 'project-b', 'project-c']);
  assert.equal(list.every((w) => w.path.startsWith(wsReal)), true);
  assert.equal(list.some((w) => w.id === '.hidden'), false);
  assert.equal(list.some((w) => w.id === 'not-a-dir.txt'), false);
  assert.equal(list.some((w) => w.id === 'link-dir'), false);
  // canonical path (realpath)
  const a = list.find((w) => w.id === 'project-a');
  assert.equal(a.path, join(wsReal, 'project-a'));
});

test('resolveCwd: id и абсолютный путь из списка', () => {
  const { cfg } = setup();
  const byId = resolveCwd(cfg, 'project-a');
  assert.equal(byId.endsWith('/project-a'), true);
  const byPath = resolveCwd(cfg, byId);
  assert.equal(byPath, byId);
});

test('resolveCwd: nested/неизвестный/относительный путь отклоняются', () => {
  const { cfg } = setup();
  assert.throws(() => resolveCwd(cfg, 'project-a/nested'), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => resolveCwd(cfg, '/tmp'), (e) => e instanceof HttpError);
  assert.throws(() => resolveCwd(cfg, 'relative'), (e) => e instanceof HttpError && e.status === 400);
  assert.throws(() => resolveCwd(cfg, 42), (e) => e.status === 400);
});

test('resolveCwd: путь вне root -> 403, существующий чужой каталог -> 403/400', () => {
  const { cfg, outside } = setup();
  assert.throws(
    () => resolveCwd(cfg, join(outside, 'sub')),
    (e) => e instanceof HttpError && (e.status === 403 || e.status === 400),
  );
  // существующий каталог вне root
  assert.throws(() => resolveCwd(cfg, outside), (e) => e instanceof HttpError && e.status === 403);
});

test('resolveCwd: пустой cwd допустим только при одном workspace', () => {
  const root = tempRoot('ws-single-');
  const cfg = makeConfig(root);
  const wsRoot = join(root, 'workspaces');
  // makeEnv создаёт project-a и project-b; удалим project-b
  rmSync(join(wsRoot, 'project-b'), { recursive: true, force: true });
  assert.equal(resolveCwd(cfg, undefined).endsWith('/project-a'), true);
});

test('resolveCwd: при нескольких workspace пустой cwd -> 400', () => {
  const { cfg } = setup();
  assert.throws(() => resolveCwd(cfg, undefined), (e) => e.status === 400);
});

test('listWorkspaces: отсутствующий root -> 500', () => {
  const { cfg } = setup();
  const broken = { ...cfg, workspaces: '/definitely/not/existing/claude-web' };
  assert.throws(() => listWorkspaces(broken), (e) => e instanceof HttpError && e.status === 500);
});
