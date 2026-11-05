// Routing: the JSON API under /api plus /healthz, the MCP endpoint at exactly /mcp, and static
// files for everything else.
// `routes` is the route table (docs/architecture.md lists every entry; test/docs.test.mjs checks).

import { fileURLToPath } from 'node:url';
import { HttpError, setSecurityHeaders, sendJson, sendError, guardPost, readJsonBody } from './http.mjs';
import { createStatic } from './static.mjs';
import * as h from './handlers.mjs';
import * as k from './keys.mjs';
import { createKeyService, loadServerSecret } from '../mcp/keys.mjs';
import { createMcpHandler } from '../mcp/index.mjs';

const TABLE = [
  { method: 'GET', path: '/healthz', handler: h.healthz },
  { method: 'GET', path: '/api/scenario', handler: h.getScenario },
  { method: 'POST', path: '/api/recs/:id/action', handler: h.recAction },
  { method: 'POST', path: '/api/wargame/:name/pick', handler: h.wargamePick },
  { method: 'POST', path: '/api/packs/:id/toggle', handler: h.packToggle },
  { method: 'POST', path: '/api/packs/:id/whatif', handler: h.packWhatIf },
  { method: 'POST', path: '/api/engine', handler: h.setEngine },
  { method: 'POST', path: '/api/ask', handler: h.ask },
  { method: 'POST', path: '/api/onboarding', handler: h.onboarding },
  { method: 'POST', path: '/api/demo/reset', handler: h.demoReset },
  { method: 'GET', path: '/api/keys', handler: k.listKeys },
  { method: 'POST', path: '/api/keys', handler: k.createKey },
  { method: 'POST', path: '/api/keys/:id/revoke', handler: k.revokeKey },
  { method: 'GET', path: '/api/mcp', handler: k.mcpInfo },
];

export const routes = TABLE.map(({ method, path }) => ({ method, path }));

const compiled = TABLE.map(r => ({ ...r, parts: r.path.split('/').slice(1) }));

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared/', import.meta.url));

// Path -> { params } for a route pattern, or null.
function matchPath(parts, segments) {
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      if (!segments[i]) return null;
      params[parts[i].slice(1)] = segments[i];
    } else if (parts[i] !== segments[i]) {
      return null;
    }
  }
  return params;
}

function findRoute(method, rawPath) {
  let segments;
  try {
    segments = rawPath.split('/').slice(1).map(decodeURIComponent);
  } catch {
    throw new HttpError(404, 'not found');
  }
  const hits = compiled.map(r => ({ r, params: matchPath(r.parts, segments) })).filter(x => x.params);
  if (!hits.length) throw new HttpError(404, 'not found');
  const hit = hits.find(x => x.r.method === method || (method === 'HEAD' && x.r.method === 'GET'));
  if (!hit) throw new HttpError(405, 'method not allowed', { Allow: [...new Set(hits.map(x => x.r.method))].join(', ') });
  return hit;
}

// `keys` (key service) and `mcp` (the /mcp handler) are built from config.dataDir on first use
// when not passed in.
export function createHandler({ db, config, answerer, keys, mcp, webDir = WEB_DIR, sharedDir = SHARED_DIR }) {
  const serveStatic = createStatic({ webDir, sharedDir });
  let keyService = keys;
  let mcpHandler = mcp;
  const getKeys = () => (keyService ??= createKeyService({ db, serverSecret: loadServerSecret(config.dataDir) }));
  const getMcp = () => (mcpHandler ??= createMcpHandler({ db, keys: getKeys(), config }));
  return async function handle(req, res) {
    setSecurityHeaders(res);
    const url = req.url || '/';
    const q = url.indexOf('?');
    const rawPath = q >= 0 ? url.slice(0, q) : url;
    try {
      if (rawPath === '/mcp') {
        await getMcp()(req, res);
        return;
      }
      if (rawPath === '/healthz' || rawPath === '/api' || rawPath.startsWith('/api/')) {
        const { r, params } = findRoute(req.method, rawPath);
        let body = {};
        if (r.method === 'POST') {
          guardPost(req);
          body = await readJsonBody(req);
        }
        const out = await r.handler({ db, config, answerer, params, body, req, get keys() { return getKeys(); } });
        sendJson(res, 200, out);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' });
      }
      await serveStatic(req, res, rawPath);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (req.readable) req.resume();
      sendError(res, err);
    }
  };
}
