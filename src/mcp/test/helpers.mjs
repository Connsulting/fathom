// MCP test helpers on top of test/helpers/server.mjs: keys through the real POST /api/keys route,
// raw JSON-RPC posts to /mcp with full header control, and store and platform reads.

import { request, postJson, openStore } from '../../../test/helpers/server.mjs';

export const ACCEPT = 'application/json, text/event-stream';
export const PROTOCOL = '2025-06-18';
export const KEY_RE = /^fathom_[A-Za-z0-9_-]{43}$/;
export const UNAUTHORIZED = '{"error":"unauthorized"}';
export const PERMISSION_TEXT = 'Permission denied: act_on_recommendation.status needs the write:recs scope, which this key does not have.';

// Create a key through the real route. Returns { key, record, keys }.
export async function createKey(baseUrl, name, scopes) {
  const body = scopes === undefined ? { name } : { name, scopes };
  const r = await postJson(baseUrl, '/api/keys', body);
  if (r.status !== 200 || !r.json || typeof r.json.key !== 'string') {
    throw new Error(`POST /api/keys -> ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.json;
}

export async function revokeKey(baseUrl, id) {
  const r = await postJson(baseUrl, `/api/keys/${encodeURIComponent(id)}/revoke`, {});
  if (r.status !== 200) throw new Error(`revoke -> ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

let nextId = 1;

// One raw JSON-RPC POST to /mcp. `auth` is the full Authorization value (or undefined for none);
// `headers` adds or overrides headers (host, origin, ...).
export function mcpPost(baseUrl, { auth, method = 'tools/list', params = {}, headers = {}, body } = {}) {
  const h = { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': PROTOCOL };
  if (auth !== undefined) h.authorization = auth;
  Object.assign(h, headers);
  const payload = body !== undefined ? body : JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  return request(baseUrl, { method: 'POST', path: '/mcp', headers: h, body: payload });
}

export const bearer = key => `Bearer ${key}`;

export function initializeParams() {
  return { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'fathom-test-client', version: '1.0.0' } };
}

// JSON-RPC result of a 200 response, or a thrown error describing the response.
export function rpcResult(r) {
  if (r.status !== 200 || !r.json || !r.json.result) {
    throw new Error(`expected a JSON-RPC result, got ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.json.result;
}

export async function listToolNames(baseUrl, key) {
  return rpcResult(await mcpPost(baseUrl, { auth: bearer(key), method: 'tools/list' })).tools.map(t => t.name);
}

export function callToolRpc(baseUrl, key, name, args = {}, headers = {}) {
  return mcpPost(baseUrl, { auth: bearer(key), method: 'tools/call', params: { name, arguments: args }, headers });
}

// Run fn(db) on a store or platform file (opened without migrating) and close it.
export async function withStore(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

// The platform api_keys row of a key (MT-03: keys live in platform.sqlite, bound to a household).
export function apiKeyRow(platformFile, id) {
  return withStore(platformFile, db => {
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    return row ? { ...row } : null;
  });
}

// A well-formed key string that no store has issued.
export function unknownKey() {
  return 'fathom_' + 'A'.repeat(20) + 'b'.repeat(23);
}
