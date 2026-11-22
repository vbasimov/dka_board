/**
 * static.mjs — отдача собранного SPA из distDir (CONTRACT §6, «Безопасность статики»).
 *
 * Только из distDir: realpath + prefix, запрет '..', NUL, backslash, dotfiles
 * и симлинков (в т.ч. внутри дерева). sw.js — no-store и без
 * Service-Worker-Allowed; assets — immutable; HTML/прочее — no-store.
 */
import { createReadStream, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { applySecurityHeaders, json, methodNotAllowed } from './http-util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function isInside(root, target) {
  return target === root || target.startsWith(root + sep);
}

/** Декодирует и валидирует относительный путь внутри dist. null — недопустимый. */
function normalizeRel(urlPath, basePath) {
  let p = String(urlPath || '/');
  if (p.startsWith(basePath)) p = '/' + p.slice(basePath.length);
  else if (p === basePath.slice(0, -1)) p = '/';
  else if (p.startsWith(basePath.slice(0, -1) + '?')) p = '/';
  else return null; // вне basePath статика не отдаётся
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p.includes('\0') || p.includes('\\')) return null;
  const segs = p.split('/').filter((s) => s !== '');
  const out = [];
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
    if (s.startsWith('.')) return null; // dotfiles запрещены
    out.push(s);
  }
  return out;
}

/** Проверяет отсутствие симлинков в компонентах пути от dist до файла. */
function hasSymlinkComponent(distRoot, relSegs) {
  let cur = distRoot;
  for (const s of relSegs) {
    cur = join(cur, s);
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false; // компонент не существует — обработается выше
    }
  }
  return false;
}

function cacheControlFor(rel) {
  if (rel === 'sw.js') return 'no-store';
  if (rel.startsWith('assets/')) return 'public, max-age=86400, immutable';
  if (rel === 'claude/manifest.webmanifest') return 'no-cache';
  if (rel.startsWith('claude/icons/')) return 'public, max-age=86400';
  if (rel.endsWith('.html') || rel === '') return 'no-store';
  return 'no-store';
}

function setCommonHeaders(res, rel, file, stat) {
  const ext = extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', cacheControlFor(rel));
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  if (rel === 'claude/manifest.webmanifest') {
    res.setHeader('ETag', `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);
  }
  // ВАЖНО: Service-Worker-Allowed не ставим никогда — scope SW ограничен /claude/.
}

function sendFile(req, res, absFile, rel, stat) {
  setCommonHeaders(res, rel, absFile, stat);
  if (rel === 'claude/manifest.webmanifest') {
    const inm = req.headers['if-none-match'];
    if (inm && inm === res.getHeader('ETag')) {
      res.statusCode = 304;
      res.removeHeader('Content-Length');
      res.end();
      return true;
    }
  }
  res.statusCode = 200;
  if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return true;
  }
  // Небольшие файлы отдаём синхронно (детерминированно, без лишних стримов);
  // крупные — стримом, чтобы не держать мегабайты в памяти.
  if (stat.size <= 4 * 1024 * 1024) {
    res.end(readFileSync(absFile));
    return true;
  }
  const stream = createReadStream(absFile);
  stream.on('error', () => {
    if (!res.headersSent) json(res, 500, { error: 'internal error', code: 'internal' });
    else res.destroy();
  });
  stream.pipe(res);
  return true;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{distDir:string, basePath:string, urlPath:string}} opts
 * @returns {boolean} true — ответ уже отправлен
 */
export function serveStatic(req, res, { distDir, basePath, urlPath }) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD');
    return true;
  }

  let distRoot;
  try {
    distRoot = realpathSync(distDir);
  } catch {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.statusCode = 404;
    res.end('not found');
    return true;
  }

  const segs = normalizeRel(urlPath, basePath);
  if (!segs) return false;

  const serveIndex = () => {
    const indexPath = join(distRoot, 'index.html');
    try {
      const st = statSync(indexPath);
      if (!st.isFile()) return false;
      applySecurityHeaders(res);
      return sendFile(req, res, indexPath, 'index.html', st);
    } catch {
      return false;
    }
  };

  if (segs.length === 0) return serveIndex();

  if (hasSymlinkComponent(distRoot, segs)) return false;

  // install-ассеты в dist лежат в dist/claude/*, а публичный URL — /claude/<name>;
  // это dev-fallback к Caddy file_server из /srv/claude-web/public.
  const candidateGroups = [segs];
  if (segs[0] === 'manifest.webmanifest' || (segs[0] === 'icons' && segs.length === 2)) {
    candidateGroups.push(['claude', ...segs]);
  }

  for (const group of candidateGroups) {
    if (hasSymlinkComponent(distRoot, group)) continue;
    const rel = group.join('/');
    const candidate = join(distRoot, ...group);
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      const indexRel = [...group, 'index.html'];
      if (hasSymlinkComponent(distRoot, indexRel)) continue;
      const indexPath = join(distRoot, ...indexRel);
      try {
        const st = statSync(indexPath);
        if (st.isFile()) {
          applySecurityHeaders(res);
          return sendFile(req, res, indexPath, indexRel.join('/'), st);
        }
      } catch {
        /* нет index */
      }
      continue;
    }
    if (stat && stat.isFile()) {
      let real;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!isInside(distRoot, real)) continue;
      applySecurityHeaders(res);
      return sendFile(req, res, real, rel, stat);
    }
  }

  // SPA-fallback для навигации (без расширения и с Accept: text/html).
  const last = segs[segs.length - 1];
  const accept = String(req.headers.accept || '');
  if (!last.includes('.') && accept.includes('text/html')) {
    return serveIndex();
  }
  return false;
}

export default serveStatic;
