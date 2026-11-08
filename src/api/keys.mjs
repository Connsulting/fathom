// API key and MCP connection handlers. Same contract as ./handlers.mjs, with ctx.keys the platform
// key service and ctx.household the request's household: every key listed, created or revoked
// belongs to that household. Key responses carry no scenario. A new key appears only in the create
// response. A missing MCP secret answers 503 on every key route.

import { HttpError } from './http.mjs';
import { tools } from '../tools/index.mjs';
import { KeyError, SCOPE_INFO, isMcpTool } from '../mcp/keys.mjs';

const KEY_STATUS = { not_found: 404, forbidden: 403, unavailable: 503 };

function keyCall(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KeyError) throw new HttpError(KEY_STATUS[err.code] ?? 400, err.message);
    throw err;
  }
}

const isDemo = ctx => ctx.household.mode === 'demo';

// Admins (and the demo) manage every key of the household; members only their own.
async function keyOwner(ctx) {
  const scope = { householdId: ctx.household.householdId };
  if (isDemo(ctx)) return scope;
  const identity = await ctx.auth.requireUser(ctx.req);
  return identity.role === 'admin' ? scope : { ...scope, userId: identity.id };
}

export function listKeys(ctx) {
  return { keys: keyCall(async () => ctx.keys.list(await keyOwner(ctx))) };
}

export async function createKey(ctx) {
  const userId = isDemo(ctx) ? null : (await ctx.auth.requireUser(ctx.req)).id;
  const { key, record } = keyCall(() => ctx.keys.create({ householdId: ctx.household.householdId, name: ctx.body.name, scopes: ctx.body.scopes, userId }));
  return { key, record, ...listKeys(ctx) };
}

export function revokeKey(ctx) {
  const record = keyCall(async () => ctx.keys.revoke(ctx.params.id, await keyOwner(ctx)));
  return { record, ...listKeys(ctx) };
}

export function mcpUrl(config) {
  return new URL(config.publicUrl).origin + '/mcp';
}

export function mcpInfo(ctx) {
  let config = ctx.config;
  if (!config.publicUrl && isDemo(ctx)) {
    const proto = ctx.req.socket?.encrypted ? 'https' : 'http';
    config = { ...config, publicUrl: `${proto}://${ctx.req.headers.host}` };
  }
  return {
    url: mcpUrl(config),
    publicUrlSet: Boolean(ctx.config.publicUrl),
    tools: tools.filter(isMcpTool).map(t => ({ name: t.name, description: t.description, kind: t.kind })),
    scopes: SCOPE_INFO.map(s => ({ ...s })),
  };
}
