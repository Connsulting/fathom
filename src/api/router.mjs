// Routing: the JSON API under /api plus /healthz, the MCP endpoint at exactly /mcp, and static
// files for everything else.
// `routes` is the route table (docs/architecture.md lists every entry; test/docs.test.mjs checks).
// `upload: true` routes take multipart bodies (read by the handler through ctx.readUpload);
// `ingest: true` routes never log error details, which could carry file contents.

import { fileURLToPath } from 'node:url';
import { HttpError, setSecurityHeaders, sendJson, sendError, guardPost, readJsonBody } from './http.mjs';
import { guardUpload, readMultipart } from './upload.mjs';
import { createStatic } from './static.mjs';
import * as h from './handlers.mjs';
import * as k from './keys.mjs';
import { createKeyService, loadServerSecret } from '../mcp/keys.mjs';
import { createMcpHandler } from '../mcp/index.mjs';
import { isAllowedHost } from '../mcp/guard.mjs';
import * as ih from './ingest-handlers.mjs';

const TABLE = [
  { method: 'GET', path: '/healthz', handler: h.healthz },
  { method: 'GET', path: '/api/scenario', handler: h.getScenario },
  { method: 'POST', path: '/api/recs/:id/action', handler: h.recAction },
  { method: 'POST', path: '/api/wargame/:name/pick', handler: h.wargamePick },
  { method: 'POST', path: '/api/packs/:id/toggle', handler: h.packToggle },
  { method: 'POST', path: '/api/packs/:id/whatif', handler: h.packWhatIf },
  { method: 'GET', path: '/api/packs/:id/entries/:entryId', handler: h.packEntry },
  { method: 'POST', path: '/api/engine', handler: h.setEngine },
  { method: 'POST', path: '/api/engine/cap', handler: h.setCap },
  { method: 'POST', path: '/api/your-plans/build', handler: h.yourPlansBuild },
  { method: 'POST', path: '/api/ask', handler: h.ask },
  { method: 'POST', path: '/api/onboarding', handler: h.onboarding },
  { method: 'POST', path: '/api/demo/reset', handler: h.demoReset },
  { method: 'GET', path: '/api/keys', handler: k.listKeys },
  { method: 'POST', path: '/api/keys', handler: k.createKey },
  { method: 'POST', path: '/api/keys/:id/revoke', handler: k.revokeKey },
  { method: 'GET', path: '/api/mcp', handler: k.mcpInfo },
  { method: 'POST', path: '/api/jobs/plan/run', handler: h.planRun },
  { method: 'POST', path: '/api/files', handler: ih.uploadFiles, upload: true, ingest: true },
  { method: 'GET', path: '/api/files', handler: ih.listFiles, ingest: true },
  { method: 'POST', path: '/api/files/:id/retry', handler: ih.retryFile, ingest: true },
  { method: 'GET', path: '/api/confirm', handler: ih.listPendingConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/list', handler: ih.listConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/:id/answer', handler: ih.answerConfirm, ingest: true },
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

// A log-safe error code: the error's code or class name when it is a plain identifier.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const safeCode = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && IDENT.test(v)) || 'unknown';

// engine, packs and answerer are optional for static-only fixtures: handlers that need them answer
// 503, and scenarios carry no manifest fields without packs. `keys` (key service) and `mcp` (the
// /mcp handler) are built from config.dataDir on first use when not passed in.
export function createHandler({ db, config, answerer, engine = null, packs = null, keys, mcp, webDir = WEB_DIR, sharedDir = SHARED_DIR }) {
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
    let route = null;
    try {
      if (rawPath === '/mcp') {
        await getMcp()(req, res);
        return;
      }
      const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
      if (isApi || rawPath === '/healthz') {
        // Every /api path gets the DNS-rebinding Host allowlist (as /mcp does), decided on the raw
        // path before route matching so encoded spellings, unknown paths and wrong methods are covered.
        // /healthz stays open for container probes.
        if (isApi && !isAllowedHost(req.headers.host, config)) {
          throw new HttpError(403, 'forbidden host');
        }
        const { r, params } = findRoute(req.method, rawPath);
        route = r;
        let body = {};
        let readUpload = null;
        if (r.upload) {
          guardUpload(req);
          readUpload = () => readMultipart(req);
        } else if (r.method === 'POST') {
          guardPost(req);
          body = await readJsonBody(req);
        }
        const out = await r.handler({ db, config, answerer, engine, packs, params, body, readUpload, req, get keys() { return getKeys(); } });
        sendJson(res, 200, out);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' });
      }
      await serveStatic(req, res, rawPath);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        if (route && route.ingest) console.error('fathom: ingest request failed', safeCode(err));
        else console.error(err);
      }
      if (req.readable) req.resume();
      sendError(res, err);
    }
  };
}
