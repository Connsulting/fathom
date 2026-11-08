// POST /mcp: stateless Streamable HTTP MCP endpoint. Per request, in order: Host allowlist (403),
// Origin match (403), Bearer key (401, one generic body; also when the MCP secret is unavailable or
// the key's household has no runtime), method (405), body (413, 400), last-use stamp, then a fresh
// tool server and transport scoped to the key and to the household the key is bound to. A session
// cookie never selects the household. Keys, tool arguments and tool results are never logged.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HttpError, sendJson, sendError, readJsonBody } from '../api/http.mjs';
import { isAllowedHost, isAllowedOrigin } from './guard.mjs';
import { createToolServer } from './server.mjs';
import { revalidateRequest } from '../api/identity.mjs';
import { runWithPrincipal } from '../platform/model-budget.mjs';
import { packDirsFor } from '../tools/index.mjs';

export const MCP_BODY_LIMIT = 1024 * 1024;

const BEARER = /^bearer +(\S+)$/i;

function refuse(req, res, status, body, headers) {
  if (req.readable) req.resume();
  sendJson(res, status, body, headers);
}

// The key record for the request's Authorization header, or null (also when keys are unavailable).
function authenticate(req, keys) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = BEARER.exec(header.trim());
  if (!m) return null;
  try {
    return keys.verify(m[1]);
  } catch {
    return null;
  }
}

// keys: the platform key service; runtimes: the household runtime registry. Each request runs in
// the key's household: its db, root and scheduler.
export function createMcpHandler({ keys, runtimes, config }) {
  return async function handleMcp(req, res) {
    const host = req.headers.host;
    if (!isAllowedHost(host, config)) return refuse(req, res, 403, { error: 'forbidden host' });
    if (!isAllowedOrigin(req.headers.origin, host)) return refuse(req, res, 403, { error: 'forbidden origin' });
    let record = authenticate(req, keys);
    const household = record ? (await runtimes.get(record.householdId)) : null;
    if (!household) return refuse(req, res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return refuse(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    runtimes.acquire(household);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      runtimes.release(household);
    };
    res.on('close', release);

    let body;
    try {
      body = await readJsonBody(req, MCP_BODY_LIMIT);
    } catch (err) {
      if (req.readable) req.resume();
      sendError(res, err instanceof HttpError ? err : new HttpError(400, 'malformed JSON body'));
      release();
      return undefined;
    }

    try {
      record = await revalidateRequest({ authenticate: () => authenticate(req, keys), household, runtimes });
    } catch {
      refuse(req, res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      release();
      return undefined;
    }

    keys.touch(record.id);
    const principal = { check() {
      const fresh = authenticate(req, keys);
      return Boolean(fresh) && fresh.id === record.id && fresh.householdId === record.householdId
        && fresh.scopes.length === record.scopes.length && fresh.scopes.every(scope => record.scopes.includes(scope))
        && household.isCurrent();
    } };
    const scheduler = household.scheduler;
    const ctx = { db: household.db, now: new Date(), dataDir: household.root, clock: config.clock, household, services: household.services,
      config: household.config, packs: household.packs, engine: household.engine, answerer: household.answerer,
      packDirs: packDirsFor(household.root),
      channel: 'mcp', actorId: record.userId || `key:${record.id}`, scopes: record.scopes,
      replan: scheduler ? () => scheduler.runNow('plan') : null, queuePlan: () => scheduler?.soon?.('plan', 'ingest') };
    const server = createToolServer({ scopes: record.scopes, ctx, authorize: () => principal.check(), runTool: async fn => {
      runtimes.acquire(household);
      try { return await fn(); } finally { runtimes.release(household); }
    } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await runWithPrincipal(principal, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      console.error(`mcp: request failed (${err && err.name ? err.name : 'Error'})`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    } finally {
      release();
    }
  };
}
