// Routing: the JSON API under /api plus /healthz, the MCP endpoint at exactly /mcp, and static
// files for everything else.
// `routes` is the route table (docs/architecture.md lists every entry; test/docs.test.mjs checks).
// `upload: true` routes take multipart bodies (read by the handler through ctx.readUpload);
// `download: true` routes answer { filename, type, bytes } as an attachment instead of JSON;
// `ingest: true` routes never log error details, which could carry file contents; `quiet: true`
// routes (email, jobs and the packet) likewise log an error code only. `stream: true` routes (the two
// that ask a question) answer as Server-Sent Events when the request's Accept header asks for
// text/event-stream (see createEventStream); the gate, Host allowlist and POST guards run first,
// exactly as for JSON. `raw: true` routes write the response themselves (the packet zip).

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, setSecurityHeaders, sendJson, sendError, guardPost, readJsonBody, createEventStream, wantsEventStream } from './http.mjs';
import { guardUpload, readMultipart } from './upload.mjs';
import { createStatic } from './static.mjs';
import * as h from './handlers.mjs';
import * as k from './keys.mjs';
import { createKeyService, loadServerSecret } from '../mcp/keys.mjs';
import { createMcpHandler } from '../mcp/index.mjs';
import { isAllowedHost } from '../mcp/guard.mjs';
import * as ih from './ingest-handlers.mjs';
import * as eh from './email-handlers.mjs';
import * as sf from './simplefin-handlers.mjs';
import * as yh from './yearend-handlers.mjs';
import * as gh from './goals.mjs';
import * as oh from './onboarding-handlers.mjs';
import * as ah from './advisor-handlers.mjs';
import { identityOf, sendUnauthorized } from './identity.mjs';
import { createAuthService } from '../auth/service.mjs';
import * as authHandlers from '../auth/handlers.mjs';
import { getSetting } from '../store/db.mjs';

const TABLE = [
  { method: 'GET', path: '/healthz', handler: h.healthz, public: true },
  { method: 'GET', path: '/api/auth/session', handler: authHandlers.session, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/register/options', handler: authHandlers.registerOptions, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/register/verify', handler: authHandlers.registerVerify, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/signin/options', handler: authHandlers.signinOptions, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/signin/verify', handler: authHandlers.signinVerify, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/recover', handler: authHandlers.recover, public: true, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/signout', handler: authHandlers.signout, quiet: true, auth: true },
  { method: 'GET', path: '/api/auth/passkeys', handler: authHandlers.passkeys, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/passkeys/link', handler: authHandlers.requestDeviceLink, quiet: true, auth: true },
  { method: 'POST', path: '/api/auth/passkeys/:id/revoke', handler: authHandlers.revokePasskey, quiet: true, auth: true },
  { method: 'GET', path: '/api/admin/users', handler: authHandlers.users, quiet: true, auth: true, admin: true },
  { method: 'POST', path: '/api/admin/users/invite', handler: authHandlers.invite, quiet: true, auth: true, admin: true },
  { method: 'POST', path: '/api/admin/users/:id/role', handler: authHandlers.setRole, quiet: true, auth: true, admin: true },
  { method: 'POST', path: '/api/admin/users/:id/remove', handler: authHandlers.removeUser, quiet: true, auth: true, admin: true },
  { method: 'POST', path: '/api/admin/users/:id/passkeys/:keyId/revoke', handler: authHandlers.adminRevokePasskey, quiet: true, auth: true, admin: true },
  { method: 'GET', path: '/api/scenario', handler: h.getScenario },
  { method: 'GET', path: '/api/pace', handler: gh.getPace },
  { method: 'GET', path: '/api/identity', handler: h.getIdentity },
  { method: 'POST', path: '/api/recs/:id/action', handler: h.recAction },
  { method: 'POST', path: '/api/recs/:id/start-over', handler: h.recStartOver },
  { method: 'POST', path: '/api/wargame/:name/pick', handler: h.wargamePick },
  { method: 'POST', path: '/api/decisions/:id/decide', handler: h.decisionDecide },
  { method: 'POST', path: '/api/decisions/:id/revisit', handler: h.decisionRevisit },
  { method: 'POST', path: '/api/packs/:id/toggle', handler: h.packToggle },
  { method: 'POST', path: '/api/packs/:id/whatif', handler: h.packWhatIf },
  { method: 'GET', path: '/api/packs/:id/entries/:entryId', handler: h.packEntry },
  { method: 'POST', path: '/api/engine', handler: h.setEngine },
  { method: 'POST', path: '/api/engine/cap', handler: h.setCap },
  { method: 'POST', path: '/api/your-plans/build', handler: h.yourPlansBuild },
  { method: 'POST', path: '/api/ask', handler: h.ask, stream: true },
  { method: 'GET', path: '/api/threads', handler: h.threadList },
  { method: 'POST', path: '/api/threads', handler: h.threadCreate, stream: true },
  { method: 'GET', path: '/api/threads/:id', handler: h.threadGet },
  { method: 'POST', path: '/api/threads/:id/rename', handler: h.threadRename },
  { method: 'POST', path: '/api/threads/:id/archive', handler: h.threadArchive },
  { method: 'POST', path: '/api/threads/:id/trash', handler: h.threadTrash },
  { method: 'POST', path: '/api/threads/:id/restore', handler: h.threadRestore },
  { method: 'POST', path: '/api/threads/:id/delete', handler: h.threadDelete },
  { method: 'POST', path: '/api/goals', handler: gh.goalCreate },
  { method: 'POST', path: '/api/goals/:id', handler: gh.goalUpdate },
  { method: 'POST', path: '/api/goals/:id/archive', handler: gh.goalArchive },
  { method: 'POST', path: '/api/goals/:id/delete', handler: gh.goalDelete },
  { method: 'POST', path: '/api/curve', handler: gh.curveSet },
  { method: 'POST', path: '/api/onboarding', handler: h.onboarding },
  { method: 'POST', path: '/api/onboarding/notes', handler: oh.saveNotes, ingest: true },
  { method: 'POST', path: '/api/demo/reset', handler: h.demoReset },
  { method: 'GET', path: '/api/keys', handler: k.listKeys },
  { method: 'POST', path: '/api/keys', handler: k.createKey },
  { method: 'POST', path: '/api/keys/:id/revoke', handler: k.revokeKey },
  { method: 'GET', path: '/api/mcp', handler: k.mcpInfo },
  { method: 'POST', path: '/api/files', handler: ih.uploadFiles, upload: true, ingest: true },
  { method: 'GET', path: '/api/files', handler: ih.listFiles, ingest: true },
  { method: 'POST', path: '/api/files/:id/retry', handler: ih.retryFile, ingest: true },
  { method: 'GET', path: '/api/confirm', handler: ih.listPendingConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/list', handler: ih.listConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/answers', handler: ih.answerConfirmBatch, ingest: true },
  { method: 'POST', path: '/api/confirm/reopen-many', handler: ih.reopenConfirmBatch, ingest: true },
  { method: 'GET', path: '/api/confirm/:id', handler: ih.getConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/:id/answer', handler: ih.answerConfirm, ingest: true },
  { method: 'POST', path: '/api/confirm/:id/reopen', handler: ih.reopenConfirm, ingest: true },
  { method: 'GET', path: '/api/email', handler: eh.getEmail, quiet: true },
  { method: 'POST', path: '/api/email/test', handler: eh.sendTestEmail, quiet: true },
  { method: 'POST', path: '/api/email/brief', handler: eh.sendBriefEmail, quiet: true },
  { method: 'GET', path: '/api/jobs', handler: eh.listJobs, quiet: true },
  { method: 'POST', path: '/api/advisor/reviews', handler: ah.sendReview },
  { method: 'POST', path: '/api/advisor/reviews/:id/verdict', handler: ah.reviewVerdict },
  { method: 'POST', path: '/api/advisor/checkin', handler: ah.saveCheckin },
  { method: 'POST', path: '/api/advisor/packets', handler: ah.createPacket, quiet: true },
  { method: 'GET', path: '/api/advisor/packets/:id', handler: ah.downloadPacket, quiet: true, download: true },
  { method: 'POST', path: '/api/jobs/:id/run', handler: eh.runJob, quiet: true },
  { method: 'POST', path: '/api/simplefin/connect', handler: sf.connect, quiet: true },
  { method: 'POST', path: '/api/simplefin/disconnect', handler: sf.disconnect, quiet: true },
  { method: 'POST', path: '/api/yearend/marks', handler: yh.markItem },
  { method: 'GET', path: '/api/yearend/packet', handler: yh.downloadPacket, raw: true, quiet: true },
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

function findRoute(method, segments) {
  const hits = compiled.map(r => ({ r, params: matchPath(r.parts, segments) })).filter(x => x.params);
  if (!hits.length) throw new HttpError(404, 'not found');
  const hit = hits.find(x => x.r.method === method || (method === 'HEAD' && x.r.method === 'GET'));
  if (!hit) throw new HttpError(405, 'method not allowed', { Allow: [...new Set(hits.map(x => x.r.method))].join(', ') });
  return hit;
}

function normalizePath(rawPath) {
  if (!rawPath.startsWith('/')) throw new HttpError(404, 'not found');
  let segments;
  try { segments = rawPath.split('/').slice(1).map(decodeURIComponent); }
  catch { throw new HttpError(404, 'not found'); }
  if (segments.some(segment => segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment))) {
    throw new HttpError(404, 'not found');
  }
  return { segments, path: '/' + segments.join('/') };
}

// A log-safe error code: the error's code or class name when it is a plain identifier.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const safeCode = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && IDENT.test(v)) || 'unknown';

export function createHandler({ db, config, answerer, engine = null, packs = null, scheduler = null, transport = null, keys, mcp, auth, webDir = WEB_DIR, sharedDir = SHARED_DIR }) {
  const gated = getSetting(db, 'mode', null) !== 'demo';
  const authService = auth ?? createAuthService({ db, config, transport });
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
    let authPath = false;
    try {
      authService.sweep();
      if (rawPath === '/mcp') {
        await getMcp()(req, res);
        return;
      }
      const { segments, path } = normalizePath(rawPath);
      const isApi = segments[0] === 'api';
      authPath = isApi && (segments[1] === 'auth' || segments[1] === 'admin');
      const read = req.method === 'GET' || req.method === 'HEAD';
      const candidate = compiled.find(r => (r.method === req.method || (req.method === 'HEAD' && r.method === 'GET')) && matchPath(r.parts, segments));
      route = candidate || null;
      const publicPage = read && ['/signin', '/enroll', '/auth/auth.js', '/auth/auth.css', '/favicon.svg'].includes(path);
      let identity = gated ? identityOf(req, authService) : null;
      if (gated && !candidate?.public && !publicPage && !identity) {
        sendUnauthorized(req, res, isApi);
        return;
      }
      if (!gated && authPath && path !== '/api/auth/session') throw new HttpError(404, 'not found');
      if (isApi || path === '/healthz') {
        if (isApi && !isAllowedHost(req.headers.host, config)) throw new HttpError(403, 'forbidden host');
        const { r, params } = findRoute(req.method, segments);
        route = r;
        if (gated && r.admin && identity?.role !== 'admin') throw new HttpError(403, 'administrator required');
        let body = {};
        let readUpload = null;
        if (r.upload) {
          guardUpload(req, { origin: gated ? new URL(config.publicUrl).origin : null });
          readUpload = () => readMultipart(req);
        } else if (r.method === 'POST') {
          guardPost(req, { origin: gated ? new URL(config.publicUrl).origin : null });
          body = await readJsonBody(req);
        }
        if (gated && !r.public) {
          identity = identityOf(req, authService);
          if (!identity) throw new HttpError(401, 'unauthorized');
          if (r.admin && identity.role !== 'admin') throw new HttpError(403, 'administrator required');
        }
        const events = r.stream && wantsEventStream(req) ? createEventStream(req, res) : null;
        let out;
        try {
          out = await r.handler({ db, config, answerer, engine, packs, identity, scheduler, transport, auth: authService, params, body, readUpload, req, res,
            ...(events ? { onEvent: events.send } : {}), get keys() { return getKeys(); } });
        } catch (err) {
          // Once the event stream has started, an error is its last event.
          if (!events || !events.started) throw err;
          if (!(err instanceof HttpError)) console.error(err);
          events.fail(err);
          return;
        }
        if (r.download) {
          res.writeHead(200, {
            'content-type': out.type,
            'content-length': out.bytes.length,
            'content-disposition': `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : out.bytes);
          return;
        }
        if (events) events.finish(out);
        else if (!r.raw) sendJson(res, 200, out);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'method not allowed', { Allow: 'GET, HEAD' });
      }
      if (gated && path === '/admin/users' && identity.role !== 'admin') throw new HttpError(403, 'administrator required');
      if (['/signin', '/enroll'].includes(path) || (gated && ['/account', '/admin/users'].includes(path))) {
        let page;
        try { page = await readFile(join(webDir, 'auth', 'index.html')); }
        catch { throw new HttpError(404, 'not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      await serveStatic(req, res, '/' + segments.map(encodeURIComponent).join('/'));
    } catch (err) {
      if (!(err instanceof HttpError)) {
        if (authPath) console.error('fathom: authentication request failed', 'internal_error');
        else if (route && route.ingest) console.error('fathom: ingest request failed', safeCode(err));
        else if (route && route.quiet) console.error('fathom: request failed', safeCode(err));
        else console.error(err);
      }
      if (req.readable) req.resume();
      sendError(res, err);
    }
  };
}
