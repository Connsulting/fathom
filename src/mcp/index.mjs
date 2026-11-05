// POST /mcp: stateless Streamable HTTP MCP endpoint. Per request, in order: Host allowlist (403),
// Origin match (403), Bearer key (401, one generic body), method (405), body (413, 400), last-use
// stamp, then a fresh tool server and transport scoped to the key. Keys, tool arguments and tool
// results are never logged.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HttpError, sendJson, sendError, readJsonBody } from '../api/http.mjs';
import { isAllowedHost, isAllowedOrigin } from './guard.mjs';
import { createToolServer } from './server.mjs';

export const MCP_BODY_LIMIT = 1024 * 1024;

const BEARER = /^bearer +(\S+)$/i;

function refuse(req, res, status, body, headers) {
  if (req.readable) req.resume();
  sendJson(res, status, body, headers);
}

// The key record for the request's Authorization header, or null.
function authenticate(req, keys) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = BEARER.exec(header.trim());
  return m ? keys.verify(m[1]) : null;
}

export function createMcpHandler({ db, keys, config }) {
  return async function handleMcp(req, res) {
    const host = req.headers.host;
    if (!isAllowedHost(host, config)) return refuse(req, res, 403, { error: 'forbidden host' });
    if (!isAllowedOrigin(req.headers.origin, host)) return refuse(req, res, 403, { error: 'forbidden origin' });
    const record = authenticate(req, keys);
    if (!record) return refuse(req, res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return refuse(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST' });

    let body;
    try {
      body = await readJsonBody(req, MCP_BODY_LIMIT);
    } catch (err) {
      if (req.readable) req.resume();
      return sendError(res, err instanceof HttpError ? err : new HttpError(400, 'malformed JSON body'));
    }

    keys.touch(record.id);
    const ctx = { db, now: new Date(), dataDir: config.dataDir, clock: config.clock };
    const server = createToolServer({ scopes: record.scopes, ctx });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error(`mcp: request failed (${err && err.name ? err.name : 'Error'})`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  };
}
