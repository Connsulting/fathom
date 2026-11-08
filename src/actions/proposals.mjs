// Stored proposals for Ask. In Ask chat every offered write tool takes `propose: true`, which
// validates and records the operation (ctx.onProposal) instead of writing. The answerer stores it
// on the reply as provenance.pendingAction { tool, operation, args, scopes, basis }; a typed
// explicit yes or the Confirm control runs it through the registry with no model call.
//
// basis is a sha256 hex digest of the rows the operation and its sources depend on: its target row
// (the `id` or `key` argument) or, without one, the whole target table; for goals always the whole
// goals table (a value may come from another goal's note); plus every goal, every fact and every
// figure value. A changed basis makes the proposal stale.

import { createHash } from 'node:crypto';
import { parseJson as parse, tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { getTool, callTool } from '../tools/index.mjs';
import { operationScopes } from '../tools/tools.mjs';
import { WRITE_SCOPES } from '../shared/action-scopes.mjs';
import { requireActor, receiptScopes } from './receipts.mjs';

// The reply rule lives in evidence.mjs (confirmedProposal uses it); the tool catalog imports
// evidence.mjs, so it cannot import this module without a cycle through the registry.
import { isExplicitYes } from './evidence.mjs';
export { isExplicitYes };

// A typed reply that only confirms: an explicit yes followed by nothing but courtesy words. Any
// other content ("yeah, make it $5,000", "yes, for March") goes to the model instead.
const COURTESY = /^(?:please|thanks|thank you|do it|go ahead|go for it|sounds good|that works|works for me|perfect|great|good|save it|create it|add it|confirm(?:ed)?|that'?s right|right|and)\b\s*/i;
export function isPlainConfirmation(text) {
  const t = String(text ?? '').trim();
  if (!isExplicitYes(t) || /\d/.test(t)) return false;
  let rest = t.replace(/^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|do it|go ahead|absolutely|correct|confirmed)\b/i, '').replace(/[,.!;]+/g, ' ').trim();
  for (let m = COURTESY.exec(rest); rest && m && m[0]; m = COURTESY.exec(rest)) rest = rest.slice(m[0].length);
  return !rest;
}

// The write scopes a proposal may use: ctx.scopes filtered to write scopes, else all of them.
export const allowedScopes = scopes => (Array.isArray(scopes) ? WRITE_SCOPES.filter(s => scopes.includes(s)) : [...WRITE_SCOPES]);

const TABLES = { 'write:goals': ['goals', 'id'], 'write:facts': ['facts', 'key'], 'write:recs': ['recs', 'id'],
  'write:steps': ['recs', 'id'], 'write:preferences': ['preferences', 'id'], 'write:imports': ['files', 'id'], 'write:jobs': ['jobs', 'id'] };

export function proposalBasis(db, tool, scopes, args = {}) {
  const parts = [];
  if (tool === 'undo') {
    parts.push(['action_receipts', db.prepare('SELECT * FROM action_receipts ORDER BY id').all()]);
    parts.push(['expected_transactions', db.prepare('SELECT * FROM expected_transactions ORDER BY id').all()]);
    parts.push(['recs', db.prepare('SELECT * FROM recs ORDER BY id').all()]);
  }
  else for (const scope of scopes) {
    const [table, pk] = TABLES[scope];
    if (scope === 'write:preferences') {
      parts.push(['preferences', db.prepare('SELECT * FROM preferences ORDER BY id').all()]);
      parts.push(['spending_definitions', db.prepare('SELECT * FROM spending_definitions ORDER BY id').all()]);
      parts.push(['packs_state', db.prepare('SELECT * FROM packs_state ORDER BY id').all()]);
      parts.push(['recs', db.prepare('SELECT id, status, updated_at FROM recs ORDER BY id').all()]);
      continue;
    }
    if (scope === 'write:imports' || scope === 'write:jobs') {
      parts.push(['expected_transactions', db.prepare('SELECT * FROM expected_transactions ORDER BY id').all()]);
      parts.push(['accounts', db.prepare('SELECT id,kind FROM accounts ORDER BY id').all()]);
      parts.push(['files', db.prepare('SELECT * FROM files ORDER BY id').all()]);
      parts.push(['settings', db.prepare('SELECT * FROM settings ORDER BY key').all()]);
      parts.push(['job_runs', db.prepare('SELECT * FROM job_runs ORDER BY id').all()]);
      continue;
    }
    if (table === 'goals') continue;
    const target = args[pk] ?? args.id ?? args.key;
    parts.push([table, target !== undefined
      ? db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).all(target)
      : db.prepare(`SELECT * FROM ${table} ORDER BY ${pk}`).all()]);
  }
  // Sources a proposed value may come from: goal notes and targets, facts and stored figures.
  parts.push(['goals', db.prepare('SELECT id, def, origin, archived_at, done_at FROM goals ORDER BY id').all()]);
  parts.push(['facts', db.prepare('SELECT * FROM facts ORDER BY key').all()]);
  parts.push(['figures', db.prepare('SELECT key, v, unavailable_reason FROM figures ORDER BY key').all()]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// The reason a stored proposal can no longer run under `scopes`, or null.
function refusal(pending, scopes) {
  const tool = getTool(pending?.tool);
  const op = tool?.operations.find(o => o.name === pending.operation);
  if (!tool || tool.kind !== 'write' || tool.mcpOnly || !op) return 'This change is no longer available.';
  const allowed = allowedScopes(scopes);
  const needed = tool.name === 'undo' ? pending.scopes : operationScopes(op);
  if (!Array.isArray(needed) || !needed.length || (tool.name === 'undo' && needed.some(scope => !operationScopes(op).includes(scope)))) return 'This change is no longer available.';
  const missing = needed.find(s => !allowed.includes(s));
  return missing ? `Permission denied: this change needs ${missing}.` : null;
}

async function propose(tool, args, ctx) {
  const actor = requireActor(ctx);
  if (typeof ctx.onProposal !== 'function') throw new ToolError('forbidden', 'Proposals are only available in Ask.');
  const { propose: _propose, ...input } = args;
  const op = tool.validateArgs(input);
  let scopes = operationScopes(op);
  if (tool.name === 'undo') {
    const receipt = ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(input.id);
    if (!receipt || receipt.actor_id !== actor) throw new ToolError('forbidden', 'This change is not available to you.');
    scopes = receiptScopes(receipt);
  }
  const allowed = allowedScopes(ctx.scopes);
  const missing = scopes.find(s => !allowed.includes(s));
  if (missing) throw new ToolError('forbidden', `Permission denied: ${tool.name}.${op.name} needs ${missing}.`);
  const { operation, ...params } = input;
  await op.preflight?.(params, ctx);
  ctx.onProposal({ tool: tool.name, operation, args: params, scopes, basis: proposalBasis(ctx.db, tool.name, scopes, params) });
  // No argument values in the result: a tool result is grounding evidence, and a proposal must
  // never source its own amounts or dates.
  return { proposed: true, pending: { tool: tool.name, operation }, note: 'Stored for the owner to confirm. Nothing is saved yet.' };
}

// Registry tools for Ask: each write tool (not MCP only) takes `propose`. Copies; the registry
// entries and their MCP schemas are unchanged.
export function proposalTools(tools) {
  return tools.map(tool => {
    if (tool.kind !== 'write' || tool.mcpOnly) return tool;
    const inputSchema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, propose: { type: 'boolean' } } };
    return { ...tool, inputSchema, handler(args, ctx) {
      if (args?.propose === true) return propose(tool, args, ctx);
      const { propose: _propose, ...rest } = args ?? {};
      return tool.handler(rest, ctx);
    } };
  });
}

// The thread's latest message when it is a fathom message with an unresolved pendingAction:
// { id (row id), pending }, else null.
export function latestProposal(db, key) {
  const row = db.prepare('SELECT id, role, provenance FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT 1').get(key);
  const pending = row?.role === 'fathom' ? parse(row.provenance, null)?.pendingAction : null;
  return pending && typeof pending === 'object' && !pending.resolved ? { id: row.id, pending } : null;
}

// Sets pendingAction.resolved on the proposal message (callers hold or need no transaction).
export function markProposal(db, id, status, at) {
  const row = db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id);
  const provenance = parse(row?.provenance, null);
  if (!provenance?.pendingAction) return;
  provenance.pendingAction = { ...provenance.pendingAction, resolved: { status, at } };
  db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify(provenance), id);
}

// Claims proposal message `id` in thread `key` in one synchronous transaction. decision 'confirm'
// resolves it confirmed when it is the latest message, still allowed under `scopes` and its basis
// is unchanged, else stale; 'decline' resolves it declined. -> { status, pending } with status
// 'missing' (no such proposal in the thread) or 'resolved' (already resolved) when nothing changed.
export function claimProposal(db, { key, id, decision, scopes, at }) {
  return tx(db, () => {
    const row = db.prepare('SELECT id, role, provenance FROM messages WHERE id = ? AND conversation_key = ?').get(id, key);
    const pending = row?.role === 'fathom' ? parse(row.provenance, null)?.pendingAction : null;
    if (!pending || typeof pending !== 'object') return { status: 'missing' };
    if (pending.resolved) return { status: 'resolved', pending };
    let status = 'declined';
    if (decision === 'confirm') {
      const latest = db.prepare('SELECT max(id) AS id FROM messages WHERE conversation_key = ?').get(key).id;
      status = latest === row.id && !refusal(pending, scopes) && Array.isArray(pending.scopes)
        && pending.scopes.every(s => pending.tool === 'undo' ? WRITE_SCOPES.includes(s) : TABLES[s])
        && pending.basis === proposalBasis(db, pending.tool, pending.scopes, pending.args ?? {}) ? 'confirmed' : 'stale';
    }
    markProposal(db, row.id, status, at);
    return { status, pending };
  });
}

// Runs a claimed proposal through the registry (validation, evidence guard, receipt) as the owner.
// ctx: { db, now, dataDir, actorId, ownerText, turnId, replan, queuePlan, conversationKey, recId,
// scopes, evidenceMessageId (the proposal row id) }. Throws ToolError when it may no longer run.
export async function executeProposal(pending, ctx) {
  const reason = refusal(pending, ctx.scopes);
  if (reason) throw new ToolError('forbidden', reason);
  return callTool(pending.tool, { operation: pending.operation, ...(pending.args ?? {}) }, ctx);
}
