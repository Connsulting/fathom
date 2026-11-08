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
// Access on a real instance: `public` routes need nothing; `auth` routes (sign-in, self-service) and
// `session` routes need a session only; `operator` routes need a session and do their own operator
// check; `admin` routes need the admin role in the identity's own household; every other /api route
// is financial and needs an active membership in the identity's own active household (403
// `household membership required`).
// Household resolution: there is no process-wide financial store. A financial route resolves its
// household before the body is read: the identity's household through the runtime registry (a
// session with no household, or a household with no runtime, is 403), or on a demo instance the
// demo household. The handler ctx then carries that one context and its db, engine, packs,
// answerer, scheduler and transport; the context is held (acquire) until the response is done.
// Public, auth, session and operator routes get no household; they use ctx.platform.
// Model admission: a gated financial handler runs under a principal (runWithPrincipal) whose
// check() re-resolves the request's identity and holds only while it still names the same user and
// household with an active membership, so a revoked session or membership stops the next model
// round of a request already in flight. Demo (ungated) requests carry no principal.

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, setSecurityHeaders, sendJson, sendError, guardPost, readJsonBody, createEventStream, wantsEventStream } from './http.mjs';
import { guardUpload, readMultipart } from './upload.mjs';
import { createStatic } from './static.mjs';
import * as h from './handlers.mjs';
import { recAnswers } from './fact-answers.mjs';
import * as k from './keys.mjs';
import { createMcpHandler } from '../mcp/index.mjs';
import { isAllowedHost } from '../mcp/guard.mjs';
import * as ih from './ingest-handlers.mjs';
import * as eh from './email-handlers.mjs';
import * as sf from './simplefin-handlers.mjs';
import * as yh from './yearend-handlers.mjs';
import * as gh from './goals.mjs';
import * as tour from './tour-handlers.mjs';
import * as accts from './accounts.mjs';
import * as ad from './account-detail.mjs';
import * as pl from './pnl-handlers.mjs';
import * as oh from './onboarding-handlers.mjs';
import * as ah from './advisor-handlers.mjs';
import * as obh from './outbound-handlers.mjs';
import { identityOf, sendUnauthorized } from './identity.mjs';
import * as authHandlers from '../auth/handlers.mjs';
import { demoRouteBehavior, DEMO_OFF_MESSAGE } from '../public-demo/control.mjs';
import { runWithPrincipal } from '../platform/model-budget.mjs';

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
  { method: 'POST', path: '/api/auth/invitations/accept', handler: authHandlers.acceptInvitation, quiet: true, auth: true },
  { method: 'POST', path: '/api/operator/households', handler: authHandlers.provisionHousehold, quiet: true, operator: true },
  { method: 'GET', path: '/api/scenario', handler: h.getScenario },
  { method: 'GET', path: '/api/pace', handler: gh.getPace },
  { method: 'POST', path: '/api/tour/seen', handler: tour.tourSeen },
  { method: 'GET', path: '/api/identity', handler: h.getIdentity, session: true },
  { method: 'POST', path: '/api/recs/:id/action', handler: h.recAction },
  { method: 'POST', path: '/api/actions/:id/undo', handler: h.actionUndo },
  { method: 'POST', path: '/api/preferences', handler: h.preferenceSave },
  { method: 'POST', path: '/api/preferences/:id', handler: h.preferenceSave },
  { method: 'POST', path: '/api/preferences/:id/delete', handler: h.preferenceDelete },
  { method: 'POST', path: '/api/recs/:id/answers', handler: recAnswers, quiet: true },
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
  { method: 'POST', path: '/api/threads/:id/proposals/:messageId', handler: h.proposalDecide },
  { method: 'GET', path: '/api/accounts/:id', handler: ad.accountDetail },
  { method: 'GET', path: '/api/accounts/:id/transactions', handler: ad.accountTransactions },
  { method: 'GET', path: '/api/pnl', handler: pl.getPnl },
  { method: 'GET', path: '/api/pnl/rows', handler: pl.getPnlRows },
  { method: 'GET', path: '/api/spending', handler: pl.getSpending },
  { method: 'GET', path: '/api/spending/rows', handler: pl.getSpendingRows },
  { method: 'POST', path: '/api/accounts/:id/name', handler: accts.accountRename },
  { method: 'POST', path: '/api/accounts/:id/mask', handler: accts.accountMask },
  { method: 'POST', path: '/api/accounts/:id/owner', handler: accts.accountOwner },
  { method: 'POST', path: '/api/accounts/:id/kind', handler: accts.accountKind },
  { method: 'GET', path: '/api/accounts/:id/merge-candidates', handler: accts.accountMergeCandidates },
  { method: 'POST', path: '/api/accounts/:id/merge', handler: accts.accountMerge },
  { method: 'POST', path: '/api/accounts/:id/archive', handler: accts.accountArchive },
  { method: 'GET', path: '/api/sources', handler: accts.sourcesList },
  { method: 'GET', path: '/api/goals/suggestions', handler: gh.goalSuggestions },
  { method: 'POST', path: '/api/goals', handler: gh.goalCreate },
  { method: 'POST', path: '/api/goals/:id', handler: gh.goalUpdate },
  { method: 'POST', path: '/api/goals/:id/archive', handler: gh.goalArchive },
  { method: 'POST', path: '/api/goals/:id/delete', handler: gh.goalDelete },
  { method: 'POST', path: '/api/goals/:id/suggestion', handler: gh.goalSuggestion },
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
  { method: 'POST', path: '/api/files/:id/remove', handler: accts.fileRemove, ingest: true },
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
  { method: 'GET', path: '/api/household/outbound', handler: obh.getOutbound, quiet: true },
  { method: 'POST', path: '/api/household/outbound', handler: obh.setOutboundFlags, quiet: true, admin: true },
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

export function findRoute(method, segments) {
  const hits = compiled.map(r => ({ r, params: matchPath(r.parts, segments) })).filter(x => x.params);
  if (!hits.length) throw new HttpError(404, 'not found');
  const hit = hits.find(x => x.r.method === method || (method === 'HEAD' && x.r.method === 'GET'));
  if (!hit) throw new HttpError(405, 'method not allowed', { Allow: [...new Set(hits.map(x => x.r.method))].join(', ') });
  return hit;
}

export function normalizePath(rawPath) {
  if (!rawPath.startsWith('/')) throw new HttpError(404, 'not found');
  let segments;
  try { segments = rawPath.split('/').slice(1).map(decodeURIComponent); }
  catch { throw new HttpError(404, 'not found'); }
  if (segments.some(segment => segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment))) {
    throw new HttpError(404, 'not found');
  }
  return { segments, path: '/' + segments.join('/') };
}

// The query string as { key: string }, or { key: [strings] } for a repeated key. Handlers that read
// a query validate every value they use.
function queryOf(url, q) {
  const out = Object.create(null);
  if (q < 0) return out;
  for (const [k, v] of new URLSearchParams(url.slice(q + 1))) {
    if (!Object.hasOwn(out, k)) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  return out;
}

// A log-safe error code: the error's code or class name when it is a plain identifier.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const safeCode = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && IDENT.test(v)) || 'unknown';

const membershipRequired = () => new HttpError(403, 'household membership required');
const adminRequired = () => new HttpError(403, 'administrator required');

const financial = r => !r.public && !r.auth && !r.session && !r.operator;

// `platform` is the platform DB (accounts, memberships, sessions, keys); `runtimes` the household
// runtime registry (src/platform/runtime.mjs); `auth` the auth service; `keys` the MCP key service.
export function createHandler({ platform, config, runtimes, auth, keys, mcp = null, webDir = WEB_DIR, sharedDir = SHARED_DIR }) {
  if (!platform || !runtimes || !auth || (!keys && !config.publicDemo)) throw new TypeError('createHandler needs the platform, runtimes, auth and keys');
  const gated = !auth.demo;
  const serveStatic = createStatic({ webDir, sharedDir });
  // A public demo serves no MCP endpoint and no key routes.
  const mcpHandler = config.publicDemo ? null : (mcp ?? createMcpHandler({ keys, runtimes, config }));
  const demoOff = () => new HttpError(403, DEMO_OFF_MESSAGE);
  // Route access beyond a session (see the header).
  const checkAccess = (r, identity) => {
    if (r.admin && !auth.servedAdmin(identity)) throw adminRequired();
    if (financial(r) && !auth.servedMember(identity)) throw membershipRequired();
  };
  function resolveHousehold(identity) {
    if (gated) return runtimes.forIdentity(identity);
    try {
      return runtimes.demo();
    } catch {
      throw new HttpError(503, 'household unavailable');
    }
  }
  return async function handle(req, res) {
    setSecurityHeaders(res);
    const url = req.url || '/';
    const q = url.indexOf('?');
    const rawPath = q >= 0 ? url.slice(0, q) : url;
    let route = null;
    let authPath = false;
    let held = null;
    try {
      auth.sweep();
      if (rawPath === '/mcp') {
        if (!mcpHandler) throw demoOff();
        await mcpHandler(req, res);
        return;
      }
      const { segments, path } = normalizePath(rawPath);
      const isApi = segments[0] === 'api';
      authPath = isApi && ['auth', 'admin', 'operator'].includes(segments[1]);
      const read = req.method === 'GET' || req.method === 'HEAD';
      const candidate = compiled.find(r => (r.method === req.method || (req.method === 'HEAD' && r.method === 'GET')) && matchPath(r.parts, segments));
      route = candidate || null;
      const publicPage = read && ['/signin', '/enroll', '/auth/auth.js', '/auth/auth.css', '/auth/return-path.js', '/favicon.svg'].includes(path);
      let identity = gated ? identityOf(req, auth) : null;
      if (gated && !candidate?.public && !publicPage && !identity) {
        sendUnauthorized(req, res, isApi);
        return;
      }
      if (!gated && authPath && path !== '/api/auth/session') throw new HttpError(404, 'not found');
      if (isApi || path === '/healthz') {
        if (isApi && !isAllowedHost(req.headers.host, config)) throw new HttpError(403, 'forbidden host');
        const { r, params } = findRoute(req.method, segments);
        route = r;
        if (config.publicDemo && demoRouteBehavior(r.method, r.path) === 'off') throw new HttpError(403, DEMO_OFF_MESSAGE);
        if (gated && !r.public) checkAccess(r, identity);
        // The household is fixed before the body is read and kept for the whole request.
        let household = null;
        if (financial(r)) {
          household = resolveHousehold(identity);
          if (!household) throw membershipRequired();
          held = runtimes.acquire(household);
        }
        let body = {};
        let readUpload = null;
        if (r.upload) {
          guardUpload(req, { origin: gated ? new URL(config.publicUrl).origin : null });
          readUpload = () => readMultipart(req);
        } else if (r.method === 'POST') {
          guardPost(req, { origin: gated || config.publicDemo ? new URL(config.publicUrl).origin : null });
          body = await readJsonBody(req);
        }
        if (gated && !r.public) {
          identity = identityOf(req, auth);
          if (!identity) throw new HttpError(401, 'unauthorized');
          checkAccess(r, identity);
          if (household && identity.householdId !== household.householdId) throw membershipRequired();
        }
        // A write to a seeded demo household drops its synthetic marker.
        const seeded = household && !gated && !config.publicDemo && r.method === 'POST' && path !== '/api/demo/reset' ? household.db : null;
        const changesBefore = seeded ? seeded.prepare('SELECT total_changes() AS n').get().n : 0;
        const events = r.stream && wantsEventStream(req) ? createEventStream(req, res) : null;
        const caller = identity;
        const principal = gated && household ? { check() {
          const now = identityOf(req, auth);
          return Boolean(now) && now.id === caller.id && now.householdId === caller.householdId && auth.servedMember(now);
        } } : null;
        const run = fn => (principal ? runWithPrincipal(principal, fn) : fn());
        let out;
        try {
          out = await run(() => r.handler({
            household, db: household?.db, engine: household?.engine, packs: household?.packs, answerer: household?.answerer,
            scheduler: household?.scheduler, transport: household?.transport, platform, config, identity, auth,
            get keys() { if (config.publicDemo) throw demoOff(); return keys; },
            params, query: queryOf(url, q), body, readUpload, req, res, ...(events ? { onEvent: events.send } : {}),
          }));
        } catch (err) {
          // Once the event stream has started, an error is its last event.
          if (!events || !events.started) throw err;
          if (!(err instanceof HttpError)) console.error(err);
          events.fail(err);
          return;
        } finally {
          if (seeded && seeded.prepare('SELECT total_changes() AS n').get().n !== changesBefore) {
            seeded.prepare("DELETE FROM settings WHERE key = 'synthetic_demo'").run();
          }
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
      if (gated && path === '/admin/users' && !auth.servedAdmin(identity)) throw adminRequired();
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
    } finally {
      if (held) runtimes.release(held);
    }
  };
}
