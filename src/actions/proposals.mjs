// Stored proposals for Ask. In Ask chat every offered write tool takes `propose: true`, which
// validates and records the operation (ctx.onProposal) instead of writing. The answerer stores it
// on the reply as provenance.pendingAction { tool, operation, args, scopes, basis, description,
// details? } (description and details from describe.mjs, for the card and its receipt); a typed
// explicit yes or the Confirm control runs it through the registry with no model call.
//
// basis is a sha256 hex digest of the rows the operation and its sources depend on: its target row
// (the `id` or `key` argument) or, without one, the whole target table; for goals always the whole
// goals table (a value may come from another goal's note); plus every goal, every fact and every
// figure value. Account, category and Confirm proposals use their affected rows and Undo logs
// instead. A changed basis makes the proposal stale.

import { queueCategoryChecks } from '../categories/store.mjs';
import { normalizeMerchant } from '../categories/resolve.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { queueAccountPairs, mergePlan } from '../ingest/account-merge.mjs';
import { normalizeName } from '../ingest/confirm.mjs';
import { dedupeKey } from '../ingest/dedupe.mjs';
import { DEFAULT_UNDO } from '../facts/derive.mjs';
import { createHash } from 'node:crypto';
import { parseJson as parse, tx } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { getTool, callTool } from '../tools/index.mjs';
import { operationScopes } from '../tools/tools.mjs';
import { WRITE_SCOPES } from '../shared/action-scopes.mjs';
import { requireActor, receiptScopes } from './receipts.mjs';
import { describedFields, describeProposal, useRouteLabels } from './describe.mjs';

// The reply rule lives in evidence.mjs (confirmedProposal uses it); the tool catalog imports
// evidence.mjs, so it cannot import this module without a cycle through the registry.
import { isExplicitYes } from './evidence.mjs';
import { filterSeries, flatMapSeries, mapSeries, someSeries } from '../shared/series.mjs';
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
  'write:steps': ['recs', 'id'], 'write:preferences': ['preferences', 'id'], 'write:decisions': ['decisions', 'id'], 'write:imports': ['files', 'id'], 'write:jobs': ['jobs', 'id'] };

const DOMAIN_TABLES = {
  'write:sources': ['accounts','files','transactions','balances','positions','pnl_lines','tax_payments','documents','held_facts','entity_aliases','sources','source_changes','confirm_items','confirm_undo','ingest_epoch','transaction_category_corrections','transaction_category_imports','transaction_category_guesses'],
  'write:accounts': ['accounts','transactions','balances','positions','simplefin_accounts','simplefin_snapshots','confirm_items','confirm_undo','confirm_auto','confirm_auto_declined','ingest_epoch','sources','superseded_rows','transaction_category_corrections','transaction_category_imports','transaction_category_guesses'],
  'write:categories': ['accounts','transactions','transaction_category_corrections','category_merchant_rules','category_source_rules','confirm_items','confirm_undo','confirm_auto'],
  'write:confirm': ['accounts','transactions','balances','positions','documents','tax_payments','pnl_lines','sources','files','confirm_items','confirm_undo','confirm_auto','confirm_auto_declined','ingest_epoch','held_facts','entity_aliases','category_source_rules','category_merchant_rules','transaction_category_corrections','yearend_marks'],
};

async function localProposalRows(db, tool, args) {
  const parts = [];
  const rows = async (table, column, values) => {
    const ids = [...new Set(values)].filter(v => v !== undefined && v !== null).sort();
    parts.push([table, ids.length ? await db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(...ids) : []]);
  };
  const select = async (table, where, ...params) => {
    const selected = await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(...params);
    parts.push([table, selected]);
    return selected;
  };
  const filtered = async (table, predicate) => {
    const selected = await filterSeries(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), predicate);
    parts.push([table, selected]);
    return selected;
  };
  const refers = (value, id) => value === id || (value && typeof value === 'object' && Object.values(value).some(v => refers(v, id)));
  const categoryRows = async ids => {
    for (const table of ['transaction_category_corrections', 'transaction_category_imports', 'transaction_category_guesses']) await rows(table, 'transaction_id', ids);
  };
  const undoRows = async ids => {
    for (const table of ['confirm_undo', 'confirm_auto', 'confirm_auto_declined', 'confirm_guesses']) await rows(table, 'item_id', ids);
    for (const id of ids) {
      const changes = parse((await db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(id))?.changes, []);
      for (const change of changes) {
        const table = '"' + change.table.replaceAll('"', '""') + '"';
        parts.push([change.table, change.rowid, await db.prepare(`SELECT * FROM ${table} WHERE rowid=?`).get(change.rowid) ?? null]);
      }
    }
  };
  const mergeRows = async (keepId, ownId) => {
    const accounts = await select('accounts', 'id IN (?, ?)', keepId, ownId);
    const moved = await select('transactions', 'account_id=?', ownId);
    const targets = await filtered('transactions', r => r.account_id === keepId && moved.some(m => Math.round(r.amount * 100) === Math.round(m.amount * 100)
      && ((m.external_id && r.external_id === m.external_id) || Math.abs(Date.parse(r.date) - Date.parse(m.date)) <= 3 * 86400000)));
    const transactions = [...moved, ...targets];
    const snapshots = await flatMapSeries(['balances', 'positions'], async table => {
      const source = await select(table, 'account_id=?', ownId);
      return [...source, ...await filtered(table, r => r.account_id === keepId && source.some(m => table === 'balances'
        ? m.date === r.date : m.as_of === r.as_of && m.symbol === r.symbol))];
    });
    await rows('files', 'id', snapshots.map(r => r.file_id));
    await categoryRows(transactions.map(r => r.id));
    await select('account_holders', 'account_id IN (?, ?)', keepId, ownId);
    await select('expected_transactions', 'account_id=?', ownId);
    const mappings = await select('simplefin_accounts', 'account_id=? OR candidate_id=?', ownId, ownId);
    await rows('simplefin_snapshots', 'sf_key', mappings.map(r => r.sf_key));
    const keys = new Set(moved.map(r => r.dedupe_key));
    await filtered('superseded_rows', r => parse(r.row, {})?.account_id === ownId || keys.has(r.survivor_key));
    const ownFigure = accounts.find(a => a.id === ownId)?.fig_key;
    for (const table of ['goals', 'recs']) await filtered(table, r => refers(parse(r.def, {}), ownId) || (ownFigure && refers(parse(r.def, {}), ownFigure)));
    const items = await filtered('confirm_items', r => r.subject === `merge:${keepId}:${ownId}` || (r.kind === 'transaction_category' && transactions.some(t => String(t.id) === r.subject)) || (r.kind === 'near_duplicate' && parse(r.context, {}).accountId === keepId) || (r.status === 'pending'
      && (r.subject === ownId || refers(parse(r.context, {}), ownId) || (parse(r.context, {}).keys ?? []).some(k => keys.has(k)))));
    await undoRows(items.map(i => i.id));
  };
  if (tool === 'update_account' && args.withId) {
    if ((await select('accounts', 'id IN (?, ?)', args.id, args.withId)).length === 2) {
      const plan = await mergePlan(db, args.id, args.withId);
      await mergeRows(plan.keepId, plan.ownId);
    }
    return parts;
  }
  if (tool === 'update_account' && !args.withId) {
    await rows('accounts', 'id', [args.id]);
    if (args.owner !== undefined || args.kind !== undefined) {
      const kind = args.owner !== undefined ? 'account_owner' : 'account_kind';
      parts.push(['confirm_items', await db.prepare('SELECT * FROM confirm_items WHERE kind=? AND subject=? ORDER BY id').all(kind, args.id)]);
    }
    return parts;
  }
  if (tool === 'categorize') {
    const transactions = args.transactionId !== undefined
      ? await db.prepare('SELECT * FROM transactions WHERE id=?').all(args.transactionId)
      : (await db.prepare('SELECT * FROM transactions ORDER BY id').all()).filter(t => normalizeMerchant(t.description) === normalizeMerchant(args.merchant));
    parts.push(['transactions', transactions]);
    const ids = transactions.map(t => t.id);
    await rows('accounts', 'id', transactions.map(t => t.account_id));
    for (const table of ['transaction_category_corrections', 'transaction_category_imports', 'transaction_category_guesses']) await rows(table, 'transaction_id', ids);
    await rows('category_merchant_rules', 'merchant', args.transactionId !== undefined ? transactions.map(t => normalizeMerchant(t.description)) : [normalizeMerchant(args.merchant)]);
    const parsers = new Set(transactions.map(t => t.parser));
    parts.push(['category_source_rules', (await db.prepare('SELECT * FROM category_source_rules ORDER BY rowid').all()).filter(r => parsers.has(r.parser) || r.category === args.category)]);
    return parts;
  }
  if (tool === 'answer' && (args.items || args.ids)) {
    const ids = args.ids ?? args.items.map(i => i.id);
    const dependents = await filtered('confirm_auto', r => (parse(r.evidence, {}).ancestors ?? []).some(id => ids.includes(id)));
    const allIds = [...new Set([...ids, ...dependents.map(r => r.item_id)])];
    const items = await mapSeries(allIds, async id => await db.prepare('SELECT * FROM confirm_items WHERE id=?').get(id) ?? null);
    parts.push(['confirm_items', items]);
    await undoRows(allIds);
    if (args.ids || args.revise) await select('ingest_epoch', 'id=1');
    for (const item of items.filter(Boolean)) {
      const c = parse(item.context, {}), answer = args.items?.find(a => a.id === item.id)?.answer ?? item.answer;
      switch (item.kind) {
        case 'account_owner': case 'account_kind': await rows('accounts', 'id', [item.subject]); break;
        case 'fact_check': case 'resolver_fact':
          await rows('facts', 'key', [c.key, ...(item.kind === 'resolver_fact' ? [DEFAULT_UNDO[c.key]] : [])]);
          break;
        case 'entity_alias': {
          await rows('entity_aliases', 'alias', [item.subject]);
          const entity = answer?.startsWith('entity:') ? answer.slice(7) : null;
          const source = await filtered('pnl_lines', r => normalizeName(r.entity) === item.subject && r.entity !== entity);
          await rows('pnl_lines', 'dedupe_key', source.map(r => dedupeKey({kind:'pnl_line',entity,period:r.period,category:r.category})));
          break;
        }
        case 'tax_year': await select('tax_payments', 'source_slot LIKE ?', `${item.subject}:%`); break;
        case 'near_duplicate': {
          const transactions = await select('transactions', 'dedupe_key IN (?, ?)', ...item.subject.split('|'));
          await categoryRows(transactions.map(r => r.id));
          const questions = await filtered('confirm_items', r => r.kind === 'transaction_category' && transactions.some(t => String(t.id) === r.subject));
          await undoRows(questions.map(r => r.id));
          break;
        }
        case 'employer_relation': {
          const held = await select('held_facts', 'hold=?', `employer:${item.subject}`);
          await rows('files', 'id', held.map(r => r.file_id));
          const keys = new Set(answer === 'household' ? ['income.sCorp'] : held.map(r => r.key));
          await rows('facts', 'key', [...keys]);
          const checks = await filtered('confirm_items', r => r.kind === 'fact_check' && keys.has(parse(r.context, {}).key));
          await undoRows(checks.map(r => r.id));
          break;
        }
        case 'withholding_conflict': case 'employer_recipient': case 'document_recipient': {
          const payments = item.kind === 'withholding_conflict' ? await select('tax_payments', 'id IN (?, ?)', c.first?.id ?? null, c.second?.id ?? null)
            : item.kind === 'document_recipient' ? await select('tax_payments', 'payer=?', item.subject)
            : await select('tax_payments', "source_slot LIKE ? AND (payer LIKE 'paystub:%' OR payer LIKE 'w2:%')", `wh:${item.subject}:%:unknown`);
          const slots = new Set(payments.map(r => String(r.source_slot).replace(/:[^:]*$/, `:${answer}`)));
          const rekeyed = new Set(payments.filter(r => r.source_slot?.startsWith('wh:') && r.source_slot.endsWith(':unknown')).map(r => dedupeKey({
            kind:'tax_payment', jurisdiction:r.jurisdiction, sheetYear:r.tax_year, date:r.date,
            payer:`${String(r.payer).replace(/:doc:[^:]*$/, '')}:${answer}`,
          })));
          const related = await filtered('tax_payments', r => slots.has(r.source_slot) || rekeyed.has(r.dedupe_key));
          const paymentIds = new Set([...payments, ...related].map(r => r.id));
          const payers = new Set(payments.map(r => r.payer));
          const rememberedRecipient = item.kind === 'employer_recipient' && answer === 'both' && (await db.prepare(
            "SELECT subject FROM confirm_items WHERE kind='document_recipient' AND status='answered' AND answer IN ('owner','spouse')"
          ).all()).some(r => payers.has(r.subject));
          const sweepsConflicts = ['owner','spouse'].includes(answer) || rememberedRecipient
            || (item.kind === 'withholding_conflict' && ['first','second'].includes(answer));
          const checks = await filtered('confirm_items', async r => (item.kind === 'employer_recipient' && answer === 'both' && r.kind === 'document_recipient' && payers.has(r.subject))
            || (sweepsConflicts && r.kind === 'withholding_conflict' && await someSeries([parse(r.context, {}).first, parse(r.context, {}).second], async ref => {
              const row = ref && await db.prepare('SELECT * FROM tax_payments WHERE id=?').get(ref.id);
              return paymentIds.has(ref?.id) || (r.status === 'pending' && (!row || row.dedupe_key !== ref.key
                || (row.file_id ?? null) !== ref.fileId || Math.round(row.amount * 100) !== ref.cents));
            })));
          await undoRows(checks.map(r => r.id));
          break;
        }
        case 'account_match':
          await rows('simplefin_accounts', 'sf_key', [c.sfKey]);
          if (c.repair) await mergeRows(c.candidateId, c.ownId);
          break;
        case 'transaction_category': {
          const transactions = await select('transactions', 'id=?', c.transactionId);
          await categoryRows(transactions.map(r => r.id));
          if (answer?.startsWith('always:')) await rows('category_merchant_rules', 'merchant', transactions.map(r => normalizeMerchant(r.description)));
          const category = answer?.replace(/^always:/, '');
          await select('category_source_rules', 'category=?', category ?? null);
          break;
        }
        case 'category_mapping': await select('category_source_rules', 'parser=? AND category=?', c.parser, c.category); break;
      }
    }
    return parts;
  }
  return null;
}

export async function proposalBasis(db, tool, scopes, args = {}) {
  const local = await localProposalRows(db, tool, args);
  if (local) return createHash('sha256').update(JSON.stringify(local)).digest('hex');
  const parts = [];
  if (tool === 'undo') {
    const selected = await db.prepare('SELECT * FROM action_receipts WHERE id=?').get(args.id);
    const receipts = selected?.kind === 'receipt_group' ? [selected, ...await mapSeries((parse(selected.after_state, {}).childIds ?? []), async id => await db.prepare('SELECT * FROM action_receipts WHERE id=?').get(id))] : [selected];
    for (const receipt of receipts) {
      parts.push(['receipt', receipt ?? null]);
      if (!receipt) continue;
      const target = { fact: ['facts', 'key'], goal: ['goals', 'id'], step: ['recs', 'id'], status: ['recs', 'id'],
        owner: ['recs', 'id'], expected_transaction: ['expected_transactions', 'id'] }[receipt.kind];
      if (target) parts.push([target[0], await db.prepare(`SELECT * FROM ${target[0]} WHERE ${target[1]}=?`).get(receipt.entity_id) ?? null]);
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
  else for (const scope of scopes) {
    if (DOMAIN_TABLES[scope]) {
      for (const table of DOMAIN_TABLES[scope]) parts.push([table, await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
      continue;
    }
    const [table, pk] = TABLES[scope];
    if (scope === 'write:preferences') {
      parts.push(['preferences', await db.prepare('SELECT * FROM preferences ORDER BY id').all()]);
      parts.push(['spending_definitions', await db.prepare('SELECT * FROM spending_definitions ORDER BY id').all()]);
      parts.push(['packs_state', await db.prepare('SELECT * FROM packs_state ORDER BY id').all()]);
      parts.push(['recs', await db.prepare('SELECT id, status, updated_at FROM recs ORDER BY id').all()]);
      continue;
    }
    if (scope === 'write:imports' || scope === 'write:jobs') {
      if (tool === 'refresh') parts.push(['import_proposals', await db.prepare('SELECT * FROM import_proposals ORDER BY id,version').all()]);
      parts.push(['expected_transactions', await db.prepare('SELECT * FROM expected_transactions ORDER BY id').all()]);
      parts.push(['accounts', await db.prepare('SELECT id,kind FROM accounts ORDER BY id').all()]);
      parts.push(['files', await db.prepare('SELECT * FROM files ORDER BY id').all()]);
      parts.push(['settings', await db.prepare('SELECT * FROM settings ORDER BY key').all()]);
      parts.push(['job_runs', await db.prepare('SELECT * FROM job_runs ORDER BY id').all()]);
      continue;
    }
    if (table === 'goals') continue;
    const target = args.decisionId ?? args.recId ?? args[pk] ?? args.id ?? args.key;
    parts.push([table, target !== undefined
      ? await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).all(target)
      : await db.prepare(`SELECT * FROM ${table} ORDER BY ${pk}`).all()]);
  }
  if (args.recId) parts.push(['recs', await db.prepare('SELECT * FROM recs WHERE id=?').all(args.recId)]);
  const rows = async (table, order) => parts.push([table, await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]);
  if (tool === 'act_on_recommendation') {
    parts.push(['rec_threads', await db.prepare('SELECT key, rec_id, rec_detached_at FROM conversations WHERE rec_id = ? ORDER BY key').all(args.id ?? null)]);
    parts.push(['wargame', await db.prepare("SELECT * FROM content WHERE key = 'wargame'").all()]);
    parts.push(['wargame_picks', await db.prepare("SELECT * FROM settings WHERE key = 'wargame.picks'").all()]);
    if (args.decisionId) parts.push(['decision_rec', await db.prepare('SELECT * FROM recs WHERE id = (SELECT rec_id FROM decisions WHERE id = ?)').all(args.decisionId)]);
  }
  const settings = async keys => parts.push(['settings', await db.prepare(`SELECT * FROM settings WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`).all(...keys)]);
  const content = async keys => parts.push(['content', await db.prepare(`SELECT * FROM content WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`).all(...keys)]);
  if (tool === 'advisor_review') {
    if (args.recId) parts.push(['advisor_reviews', await db.prepare('SELECT * FROM advisor_reviews WHERE rec_id = ? ORDER BY id').all(args.recId)]);
    else if (args.reviewId) {
      parts.push(['advisor_reviews', await db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').all(args.reviewId)]);
      parts.push(['planner_recs', await db.prepare('SELECT * FROM planner_recs WHERE rec_id = (SELECT rec_id FROM advisor_reviews WHERE id = ?)').all(args.reviewId)]);
    } else if (args.date) await rows('advisor_checkin', 'id');
    else {
      for (const [table, order] of [['advisor_reviews', 'id'], ['advisor_checkin', 'id'], ['advisor_packets', 'id'],
        ['planner_recs', 'rec_id'], ['decisions', 'id'], ['sources', 'id'], ['accounts', 'id'],
        ['balances', 'account_id, date'], ['positions', 'id']]) await rows(table, order);
      await settings(['clock', 'mode', 'goals.suggestions', 'curve.positions', 'wargame.picks', 'planner.snapshot']);
      await content(['meta', 'names', 'law', 'pct', 'advisor', 'wargame']);
    }
  }
  if (tool === 'update_goal') await settings(['clock', 'goals.suggestions']);
  if (tool === 'update_preferences' && args.positions) {
    await settings(['curve.positions']);
    await content(['curve', 'onboarding']);
  }
  // Sources a proposed value may come from: goal notes and targets, facts and stored figures.
  parts.push(['goals', await db.prepare('SELECT * FROM goals ORDER BY id').all()]);
  parts.push(['facts', await db.prepare('SELECT * FROM facts ORDER BY key').all()]);
  parts.push(['figures', await db.prepare('SELECT key, v, unavailable_reason FROM figures ORDER BY key').all()]);
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
  const actor = await requireActor(ctx);
  if (typeof ctx.onProposal !== 'function') throw new ToolError('forbidden', 'Proposals are only available in Ask.');
  const { propose: _propose, ...input } = args;
  const op = tool.validateArgs(input);
  let scopes = operationScopes(op);
  if (tool.name === 'undo') {
    const receipt = await ctx.db.prepare('SELECT * FROM action_receipts WHERE id = ?').get(input.id);
    if (!receipt || receipt.actor_id !== actor) throw new ToolError('forbidden', 'This change is not available to you.');
    scopes = receiptScopes(receipt);
  }
  const allowed = allowedScopes(ctx.scopes);
  const missing = scopes.find(s => !allowed.includes(s));
  if (missing) throw new ToolError('forbidden', `Permission denied: ${tool.name}.${op.name} needs ${missing}.`);
  const { operation, ...params } = input;
  await op.preflight?.(params, ctx);
  if (scopes.some(scope => DOMAIN_TABLES[scope])) {
    await queueAccountPairs(ctx.db);
    await queueCategoryChecks(ctx.db, { clock: await resolveClock(ctx.db, ctx.clock ?? ctx.services?.config?.clock ?? ctx.config?.clock) });
  }
  ctx.onProposal({ tool: tool.name, operation, args: params, scopes, basis: await proposalBasis(ctx.db, tool.name, scopes, params),
    ...describedFields(await describeProposal(ctx.db, { tool: tool.name, operation, args: params })) });
  // No argument values in the result: a tool result is grounding evidence, and a proposal must
  // never source its own amounts or dates.
  return { proposed: true, pending: { tool: tool.name, operation }, note: 'Stored for the owner to confirm. Nothing is saved yet.' };
}

// describe.mjs cannot import the registry (the scenario builder imports it, and the registry's
// catalog imports the scenario builder), so the registry hands it the route labels here.
useRouteLabels((name, operation) => getTool(name)?.operations.find(o => o.name === operation)?.route ?? null);

// Registry tools for Ask: each write tool (not MCP only) takes `propose`. Copies; the registry
// entries and their MCP schemas are unchanged.
export function proposalTools(tools) {
  return tools.map(tool => {
    if (tool.kind !== 'write' || tool.mcpOnly) return tool;
    const inputSchema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, propose: { type: 'boolean' } } };
    return { ...tool, inputSchema, async handler(args, ctx) {
      if (args?.propose === true) return propose(tool, args, ctx);
      const { propose: _propose, ...rest } = args ?? {};
      return tool.handler(rest, ctx);
    } };
  });
}

// The thread's latest message when it is a fathom message with an unresolved pendingAction:
// { id (row id), pending }, else null.
export async function latestProposal(db, key) {
  const row = await db.prepare('SELECT id, role, provenance FROM messages WHERE conversation_key = ? ORDER BY id DESC LIMIT 1').get(key);
  const pending = row?.role === 'fathom' ? parse(row.provenance, null)?.pendingAction : null;
  return pending && typeof pending === 'object' && !pending.resolved ? { id: row.id, pending } : null;
}

// Sets pendingAction.resolved on the proposal message (callers hold or need no transaction).
export async function markProposal(db, id, status, at) {
  const row = await db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id);
  const provenance = parse(row?.provenance, null);
  if (!provenance?.pendingAction) return;
  provenance.pendingAction = { ...provenance.pendingAction, resolved: { status, at } };
  await db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify(provenance), id);
}

// Claims proposal message `id` in thread `key` in one synchronous transaction. decision 'confirm'
// resolves it confirmed when it is the latest message, still allowed under `scopes` and its basis
// is unchanged, else stale; 'decline' resolves it declined. -> { status, pending } with status
// 'missing' (no such proposal in the thread) or 'resolved' (already resolved) when nothing changed.
export async function claimProposal(db, { key, id, decision, scopes, at }) {
  return await tx(db, async (db) => {
    const row = await db.prepare('SELECT id, role, provenance FROM messages WHERE id = ? AND conversation_key = ?').get(id, key);
    const pending = row?.role === 'fathom' ? parse(row.provenance, null)?.pendingAction : null;
    if (!pending || typeof pending !== 'object') return { status: 'missing' };
    if (pending.resolved) return { status: 'resolved', pending };
    let status = 'declined';
    if (decision === 'confirm') {
      const latest = (await db.prepare('SELECT max(id) AS id FROM messages WHERE conversation_key = ?').get(key)).id;
      status = latest === row.id && !refusal(pending, scopes) && Array.isArray(pending.scopes)
        && pending.scopes.every(s => pending.tool === 'undo' ? WRITE_SCOPES.includes(s) : TABLES[s] || DOMAIN_TABLES[s])
        && pending.basis === await proposalBasis(db, pending.tool, pending.scopes, pending.args ?? {}) ? 'confirmed' : 'stale';
    }
    await markProposal(db, row.id, status, at);
    return { status, pending };
  });
}

// Runs a claimed proposal through the registry (validation, evidence guard, receipt) as the owner.
// ctx: { db, now, dataDir, actorId, ownerText, turnId, replan, queuePlan, conversationKey, recId,
// scopes, evidenceMessageId (the proposal row id) }. Throws ToolError when it may no longer run.
export async function executeProposal(pending, ctx) {
  const reason = refusal(pending, ctx.scopes);
  if (reason) throw new ToolError('forbidden', reason);
  const args = { operation: pending.operation, ...(pending.args ?? {}) };
  if (pending.tool === 'update_account' && pending.operation === 'merge' && isExplicitYes(ctx.ownerText)) args.evidence = ctx.ownerText;
  return callTool(pending.tool, args, ctx);
}
