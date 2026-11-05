// API key and MCP connection handlers. Same contract as ./handlers.mjs, with ctx.keys the key
// service. Key responses carry no scenario. A new key appears only in the create response.

import { HttpError } from './http.mjs';
import { tools } from '../tools/index.mjs';
import { KeyError, SCOPE_INFO } from '../mcp/keys.mjs';

function keyCall(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KeyError) throw new HttpError(err.code === 'not_found' ? 404 : 400, err.message);
    throw err;
  }
}

export function listKeys(ctx) {
  return { keys: ctx.keys.list() };
}

export function createKey(ctx) {
  const { key, record } = keyCall(() => ctx.keys.create({ name: ctx.body.name, scopes: ctx.body.scopes }));
  return { key, record, keys: ctx.keys.list() };
}

export function revokeKey(ctx) {
  const record = keyCall(() => ctx.keys.revoke(ctx.params.id));
  return { record, keys: ctx.keys.list() };
}

// The URL clients connect to: FATHOM_PUBLIC_URL with /mcp appended unless it already ends in it,
// else this request's scheme and Host.
export function mcpUrl(config, req) {
  if (config.publicUrl) {
    const u = new URL(config.publicUrl);
    const path = u.pathname.replace(/\/+$/, '');
    return u.origin + (path.split('/').pop() === 'mcp' ? path : `${path}/mcp`);
  }
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : req.socket && req.socket.encrypted ? 'https' : 'http';
  if (!req.headers.host) throw new HttpError(400, 'missing Host header');
  return `${proto}://${req.headers.host}/mcp`;
}

export function mcpInfo(ctx) {
  return {
    url: mcpUrl(ctx.config, ctx.req),
    publicUrlSet: Boolean(ctx.config.publicUrl),
    tools: tools.map(t => ({ name: t.name, description: t.description, scope: t.scope })),
    scopes: SCOPE_INFO.map(s => ({ ...s })),
  };
}
