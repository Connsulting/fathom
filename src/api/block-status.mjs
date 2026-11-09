import { isDeepStrictEqual } from 'node:util';
import { HttpError } from './http.mjs';
import { getThread } from './threads.mjs';
import { callTool, getTool } from '../tools/index.mjs';
import { validateBlock } from '../blocks/validate.mjs';
import { buildSnapshot } from '../blocks/snapshot.mjs';
import { parseJson } from '../store/db.mjs';
import { resolveClock } from '../scenario/build.mjs';

const money = new Set(['usd', 'usd_per_month', 'usd_per_year']);
function displayed(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(displayed);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['provenance', 'drill', 'action'].includes(key))
    .map(([key, v]) => [key, key === 'value' && money.has(value.unit) && typeof v === 'number' ? Math.round(v * 100) : displayed(v)]));
}
function changed(a, b) {
  if (isDeepStrictEqual(a, b)) return 0;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return 1;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((n, key) => n + changed(a[key], b[key]), 0);
}
function hasRowAccount(value) {
  return value && typeof value === 'object' && (value.t === 'row' && typeof value.row?.account === 'string' || Object.values(value).some(hasRowAccount));
}

export async function blockStatus(ctx) {
  const thread = await getThread(ctx.db, ctx.params.id);
  if (!thread) throw new HttpError(404, 'no such conversation');
  const messages = await ctx.db.prepare(`SELECT id, provenance FROM messages WHERE conversation_key = ? AND role = 'fathom'
    AND json_valid(provenance) AND json_array_length(provenance, '$.blocks') > 0 ORDER BY id DESC LIMIT 20`).all(thread.key);
  const cache = [];
  const now = new Date();
  const context = { db: ctx.db, now, clock: await resolveClock(ctx.db, ctx.config?.clock), household: ctx.household,
    services: ctx.household?.services, dataDir: ctx.household?.root };
  async function replay(call) {
    const cached = cache.find(c => c.name === call.tool && isDeepStrictEqual(c.args, call.args));
    if (cached) return cached;
    const tool = getTool(call.tool);
    if (tool?.kind !== 'read' || tool.askOnly) throw new Error('not a source read');
    const entry = { name: call.tool, args: call.args };
    cache.push(entry);
    try { entry.result = await callTool(call.tool, call.args, context); }
    catch { entry.isError = true; }
    return entry;
  }
  const blocks = [];
  for (const message of messages) for (const block of parseJson(message.provenance, {}).blocks ?? []) {
    let state = 'unavailable', count = 0;
    try {
      const results = await Promise.all(block.calls.map(replay));
      if (hasRowAccount(block.snapshot)) results.push(await replay({ tool: 'accounts', args: { operation: 'list' } }));
      if (results.every(c => !c.isError) && validateBlock(block.op, block.spec, results).ok) {
        count = changed(displayed(block.snapshot), displayed(buildSnapshot(block.op, block.spec, results)));
        state = count ? 'stale' : 'current';
      }
    } catch { /* An unavailable source keeps the stored snapshot. */ }
    blocks.push({ messageId: `m${message.id}`, id: block.id, state, changed: count });
  }
  return { blocks };
}
