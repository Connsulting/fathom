// API key and MCP connection handlers. Same contract as ./handlers.mjs, with ctx.keys the key
// service. Key responses carry no scenario. A new key appears only in the create response.

import { HttpError } from './http.mjs';
import { tools } from '../tools/index.mjs';
import { KeyError, SCOPE_INFO } from '../mcp/keys.mjs';
import { getSetting } from '../store/db.mjs';

function keyCall(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KeyError) throw new HttpError(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400, err.message);
    throw err;
  }
}

function keyOwner(ctx) {
  if (getSetting(ctx.db, 'mode', null) === 'demo') return {};
  const identity = ctx.auth.requireUser(ctx.req);
  return identity.role === 'admin' ? {} : { userId: identity.id };
}

export function listKeys(ctx) {
  return { keys: ctx.keys.list(keyOwner(ctx)) };
}

export function createKey(ctx) {
  const userId = getSetting(ctx.db, 'mode', null) === 'demo' ? null : ctx.auth.requireUser(ctx.req).id;
  const { key, record } = keyCall(() => ctx.keys.create({ name: ctx.body.name, scopes: ctx.body.scopes, userId }));
  return { key, record, ...listKeys(ctx) };
}

export function revokeKey(ctx) {
  const record = keyCall(() => ctx.keys.revoke(ctx.params.id, keyOwner(ctx)));
  return { record, ...listKeys(ctx) };
}

export function mcpUrl(config) {
  return new URL(config.publicUrl).origin + '/mcp';
}

export function mcpInfo(ctx) {
  let config = ctx.config;
  if (!config.publicUrl && getSetting(ctx.db, 'mode', null) === 'demo') {
    const proto = ctx.req.socket?.encrypted ? 'https' : 'http';
    config = { ...config, publicUrl: `${proto}://${ctx.req.headers.host}` };
  }
  return {
    url: mcpUrl(config),
    publicUrlSet: Boolean(ctx.config.publicUrl),
    tools: tools.map(t => ({ name: t.name, description: t.description, scope: t.scope })),
    scopes: SCOPE_INFO.map(s => ({ ...s })),
  };
}
