// Static files: web/ at /, src/shared/ at /shared/. Resolves inside those directories only;
// any traversal, encoded or not, is a 404. Unknown extensionless paths fall back to
// web/index.html so app routes load the UI.

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_FOUND = Symbol('not found');

async function fileIn(base, rel) {
  let root;
  try { root = await realpath(base); } catch { return NOT_FOUND; }
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return NOT_FOUND;
  let real;
  try { real = await realpath(abs); } catch { return NOT_FOUND; }
  if (!real.startsWith(root + sep)) return NOT_FOUND;
  try {
    const st = await stat(real);
    return st.isFile() ? real : NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Not found');
}

async function send(req, res, file) {
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createStatic({ webDir, sharedDir }) {
  return async function serveStatic(req, res, rawPath) {
    let path;
    try { path = decodeURIComponent(rawPath); } catch { return notFound(res); }
    if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) return notFound(res);
    const segments = path.split('/').slice(1);
    // No dot segments and no dotfiles, before or after decoding.
    if (segments.some(s => s.startsWith('.')) || rawPath.split('/').some(s => s === '..' || s === '.')) return notFound(res);

    let base = webDir;
    let rel = segments.join('/');
    if (segments[0] === 'shared') {
      base = sharedDir;
      rel = segments.slice(1).join('/');
      if (!rel) return notFound(res);
    } else if (rel === '' || rel.endsWith('/')) {
      rel += 'index.html';
    }

    const file = await fileIn(base, rel);
    if (file !== NOT_FOUND) return send(req, res, file);

    const last = segments[segments.length - 1] || '';
    if (base === webDir && !last.includes('.')) {
      const index = await fileIn(webDir, 'index.html');
      if (index !== NOT_FOUND) return send(req, res, index);
    }
    return notFound(res);
  };
}
