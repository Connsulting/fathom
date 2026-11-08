import { createHash, randomUUID } from 'node:crypto';
import { tx, parseJson } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { getTool } from '../tools/index.mjs';
import { operationScopes } from '../tools/tools.mjs';
import { recordFact, changeGoal, changeRec } from '../actions/index.mjs';
import { expectedTransaction } from '../actions/expected-transaction.mjs';
import { requireActor, requireScope, groupReceipts, replanAction } from '../actions/receipts.mjs';
import { sourceStatement, requireEvidence } from '../actions/evidence.mjs';
import { ownerTimezone } from '../shared/timezone.mjs';
import { answerShape } from '../jobs/triggers/common.mjs';
import { indexSource } from './model-source.mjs';
import { openVault, readStoredFile } from './vault.mjs';
import { currentPrincipal } from '../platform/model-budget.mjs';

const stamp = ctx => new Date(ctx.now ?? Date.now()).toISOString();
const fail = (code, text) => { throw new ToolError(code, text); };
function context(ctx) {
  requireActor(ctx); requireScope(ctx, 'write:imports');
  if (!ctx.household || ctx.household.db !== ctx.db || !ctx.household.isCurrent()) fail('proposal_stale', 'The household changed.');
  if (currentPrincipal()?.check() === false) fail('forbidden', 'The signed-in owner is no longer authorized.');
}
const output = row => ({ proposalId: row.id, version: row.version, status: row.status, reasonCode: row.reason_code, ...parseJson(row.review_state).presentation });
const latest = (db, id) => db.prepare('SELECT * FROM import_proposals WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
function basis(db, fileId, actions) {
  const parts = [db.prepare('SELECT id,sha256,removed_at FROM files WHERE id=?').get(fileId), ownerTimezone(db)];
  for (const { tool, operation, args } of actions) {
    if (tool === 'answer' && operation === 'fact') parts.push(db.prepare('SELECT * FROM facts WHERE key=?').get(args.key) ?? null);
    else if (tool === 'update_goal' && operation === 'edit') parts.push(db.prepare('SELECT * FROM goals WHERE id=?').get(args.id) ?? null);
    else if (tool === 'act_on_recommendation') {
      const row = db.prepare('SELECT def,tasks_done,status,wake,owner,owner_override FROM recs WHERE id=?').get(args.id);
      parts.push(operation === 'step' && row ? { tasks: parseJson(row.def, {}).tasks, done: parseJson(row.tasks_done, []), status: row.status } : row ?? null);
    }
    if (args.accountId) parts.push(db.prepare('SELECT * FROM accounts WHERE id=?').get(args.accountId) ?? null);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
const apply = (action, ctx) => {
  if (action.tool === 'answer') return action.operation === 'fact' ? recordFact(action.args, ctx) : expectedTransaction(action.args, ctx);
  if (action.tool === 'update_goal') return changeGoal(action.args, ctx, action.operation === 'edit');
  return changeRec(action.args, ctx, action.operation);
};
const pairs = new Set(['answer.fact', 'answer.expected_transaction', 'update_goal.create', 'update_goal.edit',
  'act_on_recommendation.step', 'act_on_recommendation.status', 'act_on_recommendation.owner']);
function unsupported(db, action) {
  if (action.tool === 'answer' && action.operation === 'fact') {
    try { answerShape(action.args.key); } catch { return 'unsupported_fact'; }
  }
  if (action.tool === 'act_on_recommendation' && action.operation === 'step') {
    const row = db.prepare('SELECT def FROM recs WHERE id=? AND status!=?').get(action.args.id, 'hidden');
    const task = parseJson(row?.def, {}).tasks?.[action.args.index];
    if (!task) return 'missing_step';
    const label = typeof task === 'string' ? task : task.t;
    const matches = db.prepare("SELECT def FROM recs WHERE status!='hidden'").all()
      .flatMap(r => parseJson(r.def, {}).tasks ?? []).filter(t => (typeof t === 'string' ? t : t.t) === label);
    if (matches.length !== 1) return 'ambiguous_step';
  }
  return null;
}
function actionContext(ctx, source, action, capturedAt, correction) {
  return { ...ctx, ownerText: null, conversationKey: null, onReceipt: null,
    sourceEvidence: { source, span: action.span, actorId: ctx.actorId, capturedAt, correction } };
}
export function applySourceActions(ctx, source, actions, capturedAt, correction) {
  const children = [], presentation = [];
  for (const action of actions) {
    const result = apply(action, actionContext(ctx, source, action, capturedAt, correction));
    children.push(result.receipt);
    presentation.push({ tool: action.tool, operation: action.operation, label: result.receipt?.label ?? action.operation,
      change: result.receipt?.after ?? null,
      ...(result.expectedTransaction ? { expectedTransaction: result.expectedTransaction } : {}) });
  }
  return { children, presentation };
}

export function prepareSourceActions(ctx, source, actions) {
  const accepted = [], notes = [], targets = new Set();
  for (const input of actions) {
    if (!input || Object.keys(input).some(k => !['tool', 'operation', 'args', 'span'].includes(k))) fail('bad_input', 'Invalid note action.');
    const text = sourceStatement({ ...ctx, sourceEvidence: { source, actorId: ctx.actorId } }, input.span);
    if (input.tool === 'note') { notes.push({ span: input.span, reasonCode: 'source_note' }); continue; }
    if (!pairs.has(`${input.tool}.${input.operation}`)) fail('bad_input', 'Unsupported note action.');
    const op = getTool(input.tool).validateArgs({ operation: input.operation, ...input.args });
    const reasonCode = unsupported(ctx.db, input);
    if (reasonCode) { notes.push({ span: input.span, reasonCode }); continue; }
    const target = input.args.id ?? input.args.key;
    if (target != null) {
      const key = `${input.tool}:${target}:${input.operation === 'step' ? input.args.index : input.operation}`;
      if (targets.has(key)) fail('bad_input', 'Combine repeated changes to the same item.');
      targets.add(key);
    }
    if (!text.trim()) fail('bad_input', 'Empty source span.');
    accepted.push({ ...structuredClone(input), scopes: operationScopes(op) });
  }
  return { accepted, notes };
}

export function stageUpdate(ctx, { source, actions, capturedAt = null, proposalId = randomUUID(), version = 1 }) {
  context(ctx);
  if (source.format !== 'text' || !Array.isArray(actions) || actions.length > 100) fail('bad_input', 'Use a bounded text source and actions.');
  const file = ctx.db.prepare('SELECT * FROM files WHERE id=?').get(source.fileId);
  if (!file || file.removed_at || file.sha256 !== source.sha256) fail('bad_input', 'Invalid source file.');
  const prior = latest(ctx.db, proposalId);
  if (prior && (prior.actor_id !== ctx.actorId || prior.status !== 'waiting_for_engine' || prior.reason_code !== 'owner_correction' || prior.version !== version || prior.file_id !== source.fileId)) fail('proposal_stale', 'The proposal changed.');
  const correction = prior ? parseJson(prior.review_state)?.correction : null;
  if (prior && capturedAt !== parseJson(prior.proposal).capturedAt) {
    requireEvidence({ ...ctx, ownerText: correction.evidence, conversationKey: null }, capturedAt, { argument: 'source date anchor' });
  }
  const { accepted, notes } = prepareSourceActions(ctx, source, actions);
  let presentation = [], status = 'needs_confirmation', reasonCode = null;
  ctx.db.exec('SAVEPOINT preview_update');
  try { presentation = applySourceActions({ ...ctx, scopes: undefined }, source, accepted, capturedAt, correction).presentation; }
  catch (error) {
    if (error.code !== 'needs_date_anchor') throw error;
    status = 'needs_clarification'; reasonCode = error.code;
  } finally { ctx.db.exec('ROLLBACK TO preview_update'); ctx.db.exec('RELEASE preview_update'); }
  const needed = [...new Set(['write:imports', ...accepted.flatMap(a => a.scopes)])];
  const missing = needed.filter(scope => ctx.scopes && !ctx.scopes.includes(scope));
  const proposal = { kind: 'actions', actions: accepted, notes, capturedAt, fileId: source.fileId, version, proposalId };
  const review = { kind: 'actions', ...(correction ? { correction } : {}), basis: basis(ctx.db, source.fileId, accepted), presentation: { actions: presentation, notes, requiredScopes: needed,
    ...(reasonCode ? { question: 'What date was this note written?' } : {}), ...(missing.length ? { permission: { reasonCode: 'missing_scope', scopes: missing } } : {}) } };
  const now = stamp(ctx);
  return tx(ctx.db, () => {
    context(ctx);
    if (prior) ctx.db.prepare(`UPDATE import_proposals SET status=?,proposal=?,review_state=?,reason_code=?,updated_at=? WHERE id=? AND version=?`)
      .run(status, JSON.stringify(proposal), JSON.stringify(review), reasonCode, now, proposalId, version);
    else ctx.db.prepare(`INSERT INTO import_proposals (id,version,file_id,source_sha256,status,proposal,interpreter_version,reason_code,actor_id,created_at,updated_at,review_state)
      VALUES (?,?,?,?,?,?,'1',?,?,?,?,?)`).run(proposalId, version, source.fileId, source.sha256, status, JSON.stringify(proposal), reasonCode, ctx.actorId, now, now, JSON.stringify(review));
    return output(latest(ctx.db, proposalId));
  });
}

export async function reviewUpdate(ctx, args, row) {
  context(ctx);
  const proposal = parseJson(row.proposal), review = parseJson(row.review_state);
  if (row.version !== args.version || !['needs_confirmation', 'needs_clarification'].includes(row.status)) fail('proposal_stale', 'The proposal changed.');
  if (row.actor_id !== ctx.actorId) fail('forbidden', 'Review this summary as the current owner.');
  for (const scope of review.presentation.requiredScopes) requireScope(ctx, scope);
  if (args.decision === 'correct') return tx(ctx.db, () => {
    context(ctx);
    if (latest(ctx.db, row.id)?.version !== row.version) fail('proposal_stale', 'The proposal changed.');
    const version = row.version + 1, now = stamp(ctx);
    ctx.db.prepare("UPDATE import_proposals SET status='superseded',updated_at=? WHERE id=? AND version=?").run(now, row.id, row.version);
    ctx.db.prepare(`INSERT INTO import_proposals (id,version,file_id,source_sha256,status,proposal,interpreter_version,reason_code,actor_id,approval_evidence,created_at,updated_at,review_state)
      VALUES (?,?,?,?,'waiting_for_engine',?,'1','owner_correction',?,?,?,?,?)`).run(row.id, version, row.file_id, row.source_sha256,
      JSON.stringify({ ...proposal, version }), ctx.actorId, args.evidence, now, now, JSON.stringify({ ...review, correction: { evidence: args.evidence, actorId: ctx.actorId, capturedAt: now } }));
    return { proposalId: row.id, version, status: 'queued', reasonCode: 'owner_correction' };
  });
  if (row.status !== 'needs_confirmation') fail('bad_input', 'Resolve the date anchor first.');
  const file = ctx.db.prepare('SELECT * FROM files WHERE id=?').get(row.file_id);
  if (!file || file.removed_at || file.sha256 !== row.source_sha256) fail('proposal_stale', 'The source changed.');
  const vault = await openVault(ctx.household);
  const bytes = await readStoredFile({ vault, id: file.id, storedPath: file.stored_path, purpose: 'upload' });
  const source = await indexSource({ fileId: file.id, bytes, format: 'text', name: file.name });
  const result = tx(ctx.db, () => {
    context(ctx);
    const current = latest(ctx.db, row.id);
    const savedFile = ctx.db.prepare('SELECT sha256,removed_at FROM files WHERE id=?').get(file.id);
    if (current?.version !== row.version || current.status !== row.status || savedFile?.removed_at || savedFile?.sha256 !== source.sha256 || source.sha256 !== row.source_sha256 ||
      JSON.stringify(review.basis) !== JSON.stringify(basis(ctx.db, source.fileId, proposal.actions))) fail('proposal_stale', 'The proposal changed.');
    const { children } = applySourceActions(ctx, source, proposal.actions, proposal.capturedAt, review.correction);
    const receipt = groupReceipts(ctx, children, { id: row.id });
    const now = stamp(ctx);
    ctx.db.prepare("UPDATE import_proposals SET status='imported',approval_evidence=?,approved_at=?,updated_at=? WHERE id=? AND version=?")
      .run(args.evidence, now, now, row.id, row.version);
    ctx.db.prepare(`INSERT INTO import_batches (id,proposal_id,proposal_version,file_id,status,before_state,after_state,receipt_id,created_at)
      VALUES (?,?,?,?,'committed',?,?,?,?)`).run(randomUUID(), row.id, row.version, file.id, JSON.stringify(review.basis), JSON.stringify(children.filter(Boolean).map(c => c.id)), receipt?.id ?? null, now);
    return { proposalId: row.id, version: row.version, status: 'imported', counts: { actions: children.filter(Boolean).length, notes: proposal.notes.length }, receipt };
  });
  if (proposal.actions.some(a => a.tool === 'answer' && a.operation === 'fact')) result.planningPending = await replanAction(ctx, result.receipt);
  ctx.onReceipt?.(result.receipt);
  return result;
}
