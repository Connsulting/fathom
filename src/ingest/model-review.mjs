import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { tx, parseJson } from '../store/db.mjs';
import { ToolError } from '../tools/errors.mjs';
import { requireActor, requireScope, saveReceipt, groupReceipts } from '../actions/receipts.mjs';
import { requireImportReviewEvidence } from '../actions/evidence.mjs';
import { LimitError } from './format.mjs';
import { indexSource } from './model-source.mjs';
import { openVault, readStoredFile } from './vault.mjs';
import { validateImport, importEffect, importPlan } from './model-validation.mjs';
import { applyLayout, layoutContext, layoutDigest, layoutDelta } from './model-layout.mjs';
import { persistImport, retryFile } from './pipeline.mjs';
import { currentPrincipal } from '../platform/model-budget.mjs';
import { interpretFile } from './model-parse.mjs';
import { applySourceActions } from './model-updates.mjs';
import { importSnapshot, importChanges, importCategoryState } from './model-undo.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { triggerPlan, triggerGuesses, triggerFreshness } from './pipeline.mjs';
import { BACKGROUND_ACTOR } from './file-status.mjs';
import { txWith } from '../store/db.mjs';
import { filterSeries, flatMapSeries, mapSeries } from '../shared/series.mjs';

const stamp = ctx => new Date(typeof ctx.now === 'function' ? ctx.now() : ctx.now ?? Date.now()).toISOString();
async function context(ctx) {
  if (!ctx.household || ctx.household.db !== ctx.db || typeof ctx.household.isCurrent !== 'function') throw new TypeError('Captured household context required');
  if (!await ctx.household.isCurrent()) stale(['household']);
  const principal = currentPrincipal();
  if (principal && await principal.check() !== true) throw new ToolError('forbidden', 'The signed-in owner is no longer authorized.');
  return await requireActor(ctx);
}
function scopes(ctx, proposal) {
  const required = ['write:imports'];
  if (proposal?.rows.some(r => r.target === 'fact')) required.push('write:facts');
  for (const scope of required) if (ctx.scopes && !ctx.scopes.includes(scope)) throw new ToolError('forbidden', `Permission denied: import review needs ${scope}.`);
}
function stale(diff = []) {
  const error = new ToolError('proposal_stale', 'The proposal changed. Review its current summary.');
  error.diff = diff; throw error;
}
const out = row => ({ proposalId: row.id, version: row.version, status: row.status, reasonCode: row.reason_code, ...parseJson(row.review_state, {})?.presentation });
const latest = async (db, id) => await db.prepare('SELECT * FROM import_proposals WHERE id = ? ORDER BY version DESC LIMIT 1').get(id);

export async function prepareImport(ctx, { file, layout = null, fake, reinterpret = false }) {
  await context(ctx); scopes(ctx);
  const stored = await ctx.db.prepare('SELECT sha256,removed_at FROM files WHERE id=?').get(file.fileId);
  if (!stored) throw new ToolError('not_found', 'No such source file.');
  if (stored.removed_at) throw new ToolError('bad_input', 'The source file was removed.');
  const prior = await ctx.db.prepare('SELECT * FROM import_proposals WHERE file_id=? ORDER BY version DESC,rowid DESC LIMIT 1').get(file.fileId);
  const mappings = await ctx.db.prepare("SELECT 1 FROM column_mappings WHERE approval_status='approved' LIMIT 1").get();
  let source;
  if (prior || mappings || layout || file.format === 'pdf') {
    try { source = await indexSource(file); } catch (error) {
      if (error instanceof LimitError) throw error;
      return { status: 'unsupported', reasonCode: 'unsupported_format' };
    }
    await context(ctx);
    if (source.sha256 !== stored.sha256) stale(['source']);
    if (source.status !== 'indexed') return { status: 'needs_source_text' };
  }
  if (prior && !reinterpret) {
    if (prior.source_sha256 !== source.sha256) stale(['source']);
    if (prior.status === 'rejected') {
      const review = parseJson(prior.review_state, {}), proposal = parseJson(prior.proposal);
      if (review.kind === 'actions') {
        const { stageUpdate } = await import('./model-updates.mjs');
        return await stageUpdate(ctx, { source, actions: proposal.actions.map(({ scopes, ...action }) => action), capturedAt: proposal.capturedAt });
      }
      return await stageImport({ ...ctx, capturedAt: review.capturedAt }, { source, proposal: { ...proposal, version: prior.version + 1 }, layout: review.layout, reinterpret: review.reinterpret });
    }
    if (['needs_confirmation', 'needs_clarification'].includes(prior.status)) {
      const review = parseJson(prior.review_state, {}), proposal = parseJson(prior.proposal);
      if (prior.actor_id !== ctx.actorId || !isDeepStrictEqual(review.effect, importEffect(await validateImport({ ...ctx, reinterpret: review.reinterpret, capturedAt: review.capturedAt }, proposal, source)))) return await txWith(ctx, async (ctx) => {
        await ctx.db.prepare("UPDATE import_proposals SET status='superseded',updated_at=? WHERE id=? AND version=?").run(stamp(ctx), prior.id, prior.version);
        return await stageImport(ctx, { source, proposal: { ...proposal, version: prior.version + 1 }, layout: review.layout,
          delta: review.presentation.delta, preserved: review.presentation.preserved, previousMapping: review.previousMapping,
          reasonCode: ['layout_mismatch', 'unsupported_currency'].includes(prior.reason_code) ? prior.reason_code : null, reinterpret: review.reinterpret });
      });
    }
    if (prior.status !== 'waiting_for_engine') return out(prior);
  }
  const correcting = prior?.status === 'waiting_for_engine' && prior.reason_code === 'owner_correction';
  if (correcting) {
    const review = parseJson(prior.review_state, {});
    reinterpret = review.reinterpret === true;
    ctx = { ...ctx, capturedAt: review.capturedAt ?? parseJson(prior.proposal)?.capturedAt ?? null };
  }
  const reused = reinterpret || correcting || !source ? { candidateCount: 0 } : await reuseApprovedMapping(ctx, { source, layout });
  if (reused.status === 'imported') return reused;
  if (layout || reused.suggestedLayout || reused.candidateCount) {
    const selected = layout ?? reused.suggestedLayout;
    let proposal, usableLayout = selected;
    try { proposal = applyLayout(source, selected); } catch {
      usableLayout = null;
      proposal = { version: 1, fileId: source.fileId, sha256: source.sha256, proposalId: randomUUID(), interpreterVersion: '1', mappingId: null, mappingVersion: null,
        rows: [], coverage: source.regions.map(regionId => ({ regionId, refs: source.inventory[regionId].refs, disposition: 'unresolved' })), completeness: 'incomplete' };
    }
    return await stageImport(ctx, { source, proposal, layout: usableLayout, delta: reused.delta, preserved: reused.preserved, previousMapping: reused.previousMapping, reasonCode: reused.reasonCode });
  }
  const interpreted = await interpretFile({ ctx, file, fake, correction: correcting ? prior.approval_evidence : null });
  if (!interpreted.valid || interpreted.status !== 'needs_confirmation' && interpreted.status !== 'needs_clarification') return { status: interpreted.status, reasonCode: interpreted.reasonCode };
  try {
    if (correcting) Object.assign(interpreted.proposal, { proposalId: prior.id, version: prior.version });
    if (reinterpret && prior) Object.assign(interpreted.proposal, { proposalId: prior.id, version: prior.version + 1 });
    return await stageImport(ctx, { source: interpreted.source, proposal: interpreted.proposal, layout: interpreted.layout, reinterpret });
  }
  catch (error) {
    if (!(error instanceof ToolError) || error.code !== 'bad_input') throw error;
    return await stageImport(ctx, { source: interpreted.source, proposal: interpreted.proposal, reasonCode: 'layout_mismatch', reinterpret });
  }
}

export async function stageImport(ctx, { source, proposal, layout = null, delta = [], preserved = {}, previousMapping = null, reasonCode = null, reinterpret = false }) {
  const actor = await context(ctx);
  scopes(ctx);
  const file = await ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(source.fileId);
  if (!file || file.sha256 !== source.sha256) stale(['source']);
  if (file.removed_at) throw new ToolError('bad_input', 'The source file was removed.');
  const existing = await latest(ctx.db, proposal.proposalId);
  const correction = existing?.status === 'waiting_for_engine' && existing.reason_code === 'owner_correction';
  const refreshed = (['superseded', 'rejected'].includes(existing?.status) || reinterpret && existing?.status === 'imported') && proposal.version === existing.version + 1;
  if (existing && !correction && !refreshed) {
    if (existing.source_sha256 !== source.sha256 || !isDeepStrictEqual(parseJson(existing.proposal), proposal)) stale(['proposal']);
    return out(existing);
  }
  if (correction && (existing.actor_id !== actor || existing.version !== proposal.version || existing.source_sha256 !== source.sha256)) stale(['correction']);
  proposal = structuredClone(proposal);
  let validation = await validateImport({ ...ctx, reinterpret }, proposal, source);
  let structural = null;
  if (layout) {
    const mapped = applyLayout(source, layout);
    if (!['rows', 'coverage', 'controls', 'completeness'].every(k => isDeepStrictEqual(mapped[k], k === 'controls' ? proposal[k] ?? [] : proposal[k]))) throw new ToolError('bad_input', 'The layout does not describe this proposal.');
    structural = { ...layoutContext(source, layout), bindings: validation.bindings };
    proposal.mappingId = layoutDigest(structural);
    const old = await ctx.db.prepare('SELECT mapping_version FROM column_mappings WHERE signature = ?').get(proposal.mappingId);
    proposal.mappingVersion = old?.mapping_version ?? (previousMapping ? previousMapping.version + 1 : 1);
  } else { proposal.mappingId = null; proposal.mappingVersion = null; }
  validation = await validateImport({ ...ctx, reinterpret }, proposal, source);
  const review = { capturedAt: ctx.capturedAt ?? null, reinterpret, effect: importEffect(validation), sourceFormat: source.format, layout, structural, previousMapping,
    ...(correction ? { correction: parseJson(existing.review_state).correction } : {}),
    presentation: { summary: validation.summary, counts: validation.counts, errors: validation.errors, delta, preserved } };
  const now = stamp(ctx), status = validation.valid && !reasonCode ? 'needs_confirmation' : 'needs_clarification';
  if (correction) {
    await ctx.db.prepare(`UPDATE import_proposals SET status=?,proposal=?,mapping_id=?,mapping_version=?,reason_code=?,updated_at=?,review_state=? WHERE id=? AND version=?`)
      .run(status, JSON.stringify(proposal), proposal.mappingId, proposal.mappingVersion, reasonCode ?? (validation.valid ? null : validation.errors[0]), now, JSON.stringify(review), proposal.proposalId, proposal.version);
    return out(await latest(ctx.db, proposal.proposalId));
  }
  await ctx.db.prepare(`INSERT INTO import_proposals (id,version,file_id,source_sha256,status,proposal,interpreter_version,mapping_id,mapping_version,
    reason_code,actor_id,created_at,updated_at,review_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(proposal.proposalId, proposal.version, source.fileId, source.sha256, status, JSON.stringify(proposal), proposal.interpreterVersion,
      proposal.mappingId, proposal.mappingVersion, reasonCode ?? (validation.valid ? null : validation.errors[0]), actor, now, now, JSON.stringify(review));
  return out(await latest(ctx.db, proposal.proposalId));
}

async function readSource(ctx, row) {
  const stored = await ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(row.file_id);
  if (!stored || stored.sha256 !== row.source_sha256) stale(['source']);
  const vault = await openVault(ctx.household);
  const bytes = await readStoredFile({ vault, id: stored.id, storedPath: stored.stored_path, purpose: 'upload' });
  const extension = parseJson(row.review_state)?.sourceFormat;
  const source = await indexSource({ fileId: stored.id, bytes, format: extension, name: stored.name });
  if (source.sha256 !== row.source_sha256) stale(['source']);
  return { source, file: { name: stored.name, mime: stored.mime, bytes } };
}

async function commit(ctx, row, proposal, source, file, review, validation, { automatic = false, evidence = null } = {}) {
  const actor = await context(ctx), db = ctx.db, now = stamp(ctx);
  const current = await latest(db, row.id);
  if (current?.version !== row.version || current.status !== row.status) stale(['proposal']);
  const effect = importEffect(validation), diff = layoutDelta(review.effect, effect);
  if (diff.length) stale(diff);
  if (!validation.valid || row.status !== 'needs_confirmation') throw new ToolError('bad_input', 'Resolve the proposal validation issues first.');
  const snapshot = await importSnapshot(db);
  scopes(ctx, proposal);
  const requiredScopes = [...new Set(['write:imports', ...(validation.rows.some(r => r.kind === 'fact') ? ['write:facts'] : []), ...(validation.actions ?? []).flatMap(a => a.scopes)])];
  requiredScopes.forEach(scope => requireScope(ctx,scope));
  const before = { proposalId: row.id, version: row.version, status: row.status, mappingApproved: Boolean(proposal.mappingId && await db.prepare("SELECT 1 FROM column_mappings WHERE signature=? AND approval_status='approved'").get(proposal.mappingId)) };
  const result = (await persistImport(db, source.fileId, file, importPlan(structuredClone(validation.rows), { reinterpret: review.reinterpret }), { now })).result;
  const actionChildren = (await applySourceActions({ ...ctx, now }, source, validation.actions ?? [], review.capturedAt, review.correction)).children;
  result.counts.actions = actionChildren.filter(Boolean).length;
  result.counts.notes = validation.notes?.length ?? 0;
  await db.prepare('UPDATE files SET counts=? WHERE id=?').run(JSON.stringify(result.counts), source.fileId);
  const actionFacts = new Set((await mapSeries(actionChildren.filter(Boolean), async child => (await db.prepare('SELECT entity_id FROM action_receipts WHERE id=? AND kind=?').get(child.id,'fact'))?.entity_id)).filter(Boolean));
  if (review.reinterpret) await db.prepare("UPDATE import_proposals SET status='superseded' WHERE file_id=? AND status='imported'").run(source.fileId);
  if (review.layout && !automatic) {
    if (review.previousMapping) {
      const parent = await db.prepare('SELECT structural_context FROM column_mappings WHERE signature=?').get(review.previousMapping.id);
      const previous = parseJson(parent?.structural_context);
      if (previous && isDeepStrictEqual(previous.headers, review.structural.headers) && isDeepStrictEqual(previous.bindings, review.structural.bindings)) {
        await db.prepare("UPDATE column_mappings SET approval_status='invalidated' WHERE signature=? AND mapping_version=?").run(review.previousMapping.id, review.previousMapping.version);
      }
    }
    await db.prepare(`INSERT INTO column_mappings (signature,mapping,src,created_at,uses,schema_version,mapping_version,
    approval_status,approved_by,approved_at,structural_context,header_signature) VALUES (?,?, 'owner',?,0,1,?,'approved',?,?,?,?)
    ON CONFLICT(signature) DO UPDATE SET mapping=excluded.mapping,mapping_version=excluded.mapping_version,approval_status='approved',
    approved_by=excluded.approved_by,approved_at=excluded.approved_at,structural_context=excluded.structural_context,header_signature=excluded.header_signature`)
      .run(proposal.mappingId, JSON.stringify(review.layout), now, proposal.mappingVersion, actor, now, JSON.stringify(review.structural), layoutDigest(review.structural.headers));
  }
  if (automatic) await db.prepare('UPDATE column_mappings SET uses=uses+1 WHERE signature=?').run(proposal.mappingId);
  await db.prepare("UPDATE import_proposals SET status='imported',actor_id=?,approval_evidence=?,approved_at=?,updated_at=? WHERE id=? AND version=?")
    .run(actor, evidence, now, now, row.id, row.version);
  const afterSnapshot = await importSnapshot(db);
  const factReceipts = await flatMapSeries(snapshot.facts.filter(old => !actionFacts.has(old.key)), async old => {
    const current = afterSnapshot.facts.find(r => r.key === old.key);
    const child = await saveReceipt({ ...ctx, now }, { scope: 'write:facts', kind: 'fact', id: old.key, label: 'Imported fact', before: old, after: current ?? null });
    return child ? [child] : [];
  });
  for (const current of afterSnapshot.facts.filter(r => !actionFacts.has(r.key) && !snapshot.facts.some(old => old.key === r.key))) factReceipts.push(await saveReceipt({ ...ctx, now }, { scope: 'write:facts', kind: 'fact', id: current.key, label: 'Imported fact', before: null, after: current }));
  const changes = (await importChanges(db, snapshot, afterSnapshot)).filter(c => c.table !== 'facts');
  const batchReceipt = await saveReceipt({ ...ctx, now }, { scope: requiredScopes.includes('write:facts') ? 'write:facts' : 'write:imports', kind: 'model_import', id: row.id, label: 'Reviewed import', before,
    after: { status: 'imported', counts: result.counts, scopes: requiredScopes, changes, categories: await importCategoryState(db,changes),
      mapping: proposal.mappingId ? { id: proposal.mappingId, version: proposal.mappingVersion } : null } });
  const receipt = requiredScopes.length > 1 || factReceipts.length || actionChildren.some(Boolean) ? await groupReceipts({ ...ctx, now }, [batchReceipt, ...factReceipts, ...actionChildren], { id: row.id, label: 'Reviewed import' }) : batchReceipt;
  await db.prepare(`INSERT INTO import_batches (id,proposal_id,proposal_version,file_id,status,before_state,after_state,receipt_id,created_at)
    VALUES (?,?,?,?,'committed',?,?,?,?)`).run(randomUUID(), row.id, row.version, row.file_id, JSON.stringify({ effect: review.effect, changes: await importChanges(db, snapshot, afterSnapshot) }), JSON.stringify(effect), receipt?.id ?? null, now);
  return { proposalId: row.id, version: row.version, status: 'imported', counts: result.counts, receipt, confirmationRequired: false };
}

export const IMPORT_READING_MESSAGE = 'Fathom is reading your file. The result will appear in Files and Confirm.';

export async function reviewImport(ctx, args) {
  if (ctx.channel === 'ask' && args?.decision === 'correct' && typeof ctx.queueAfterTools !== 'function') {
    throw new ToolError('bad_input', 'This import correction needs the Ask round-end queue.');
  }
  const result = await review(ctx, args);
  if (result.status !== 'queued') return result;
  const row = await latest(ctx.db, result.proposalId);
  const run = async () => ({ ...result, ...await retryFile(ctx.db, row.file_id, { ...ctx, mode: 'retry', now: stamp(ctx) }) });
  if (ctx.channel !== 'ask') return run();
  ctx.queueAfterTools(run);
  return { ...result, message: IMPORT_READING_MESSAGE };
}

async function review(ctx, args) {
  await context(ctx); scopes(ctx);
  if (!args || Object.keys(args).some(k => !['proposalId', 'version', 'decision', 'evidence'].includes(k)) || typeof args.proposalId !== 'string' ||
    !Number.isSafeInteger(args.version) || args.version <= 0 || !['approve', 'correct'].includes(args.decision)) throw new ToolError('bad_input', 'Invalid import review.');
  requireImportReviewEvidence(ctx, args.evidence, { approve: args.decision === 'approve' });
  const row = await latest(ctx.db, args.proposalId);
  if (!row) throw new ToolError('not_found', 'No such proposal.');
  const proposal = parseJson(row.proposal), review = parseJson(row.review_state);
  if (review?.kind === 'actions') {
    const { reviewUpdate } = await import('./model-updates.mjs');
    return reviewUpdate(ctx, args, row);
  }
  scopes(ctx, proposal);
  if (row.version !== args.version || ['imported', 'superseded', 'rejected', 'approved'].includes(row.status)) stale(['proposal']);
  if (!['needs_confirmation', 'needs_clarification'].includes(row.status)) throw new ToolError('bad_input', 'The revised proposal is waiting for interpretation.');
  // A background pass staged it: answer stale so the client's retry restages it under this owner.
  if (review && row.actor_id === BACKGROUND_ACTOR && ctx.actorId !== BACKGROUND_ACTOR) stale(['actor']);
  if (!review || row.actor_id !== ctx.actorId) throw new ToolError('forbidden', 'Review the summary as the current signed-in owner.');
  if (args.decision === 'correct') return await txWith(ctx, async (ctx) => {
    await context(ctx);
    if ((await latest(ctx.db, row.id))?.version !== row.version) stale(['proposal']);
    const now = stamp(ctx), version = row.version + 1;
    await ctx.db.prepare("UPDATE import_proposals SET status='superseded',updated_at=? WHERE id=? AND version=?").run(now, row.id, row.version);
    await ctx.db.prepare(`INSERT INTO import_proposals (id,version,file_id,source_sha256,status,proposal,interpreter_version,mapping_id,mapping_version,
      reason_code,actor_id,approval_evidence,created_at,updated_at,review_state) VALUES (?,?,?,?,'waiting_for_engine',?,?,?,?, 'owner_correction',?,?,?,?,?)`)
      .run(row.id, version, row.file_id, row.source_sha256, JSON.stringify({ ...proposal, version }), row.interpreter_version, row.mapping_id, row.mapping_version,
        ctx.actorId, args.evidence, now, now, JSON.stringify({ ...review, correction: { actorId: ctx.actorId, evidence: args.evidence, fromVersion: row.version } }));
    return { proposalId: row.id, version, status: 'queued', reasonCode: 'owner_correction' };
  });
  const { source, file } = await readSource(ctx, row);
  const result = await txWith(ctx, async (ctx) => await commit(ctx, row, proposal, source, file, review, await validateImport({ ...ctx, reinterpret: review.reinterpret, capturedAt: review.capturedAt }, proposal, source), { evidence: args.evidence }));
  try { await refreshPackState(ctx.db, { dataDir: ctx.household.root, now: stamp(ctx) }); } catch (error) { console.error('fathom: pack refresh failed', error?.name ?? 'error'); }
  triggerPlan(ctx); triggerGuesses(ctx); triggerFreshness(ctx);
  ctx.onReceipt?.(result.receipt);
  return result;
}

async function mappingCandidates(ctx, source) {
  const pool = await ctx.db.prepare("SELECT * FROM column_mappings WHERE approval_status='approved' AND schema_version=1 AND structural_context IS NOT NULL AND header_signature IS NOT NULL ORDER BY rowid DESC").all();
  const exact = new Map();
  const query = ctx.db.prepare("SELECT * FROM column_mappings WHERE header_signature=? AND approval_status='approved' AND schema_version=1");
  for (const mapping of pool) {
    const headers = layoutContext(source, parseJson(mapping.mapping)).headers;
    for (const found of await query.all(layoutDigest(headers))) exact.set(found.signature, found);
  }
  if (exact.size) return [...exact.values()];
  const scored = pool.map(mapping => {
    const before = parseJson(mapping.structural_context), after = layoutContext(source, parseJson(mapping.mapping));
    const labels = before.headers.flatMap(h => h.columns.map(c => c.label));
    const current = after.headers.flatMap(h => h.columns.map(c => c.label));
    const overlap = labels.filter(label => current.includes(label)).length;
    return { mapping, score: overlap >= Math.max(2, Math.ceil(labels.length / 2)) ? overlap / Math.max(labels.length, current.length) : 0 };
  });
  const best = Math.max(0, ...scored.map(c => c.score));
  return scored.filter(c => c.score > 0 && c.score === best).map(c => c.mapping);
}

export async function reuseApprovedMapping(ctx, { source, layout = null }) {
  await context(ctx); scopes(ctx);
  let candidates = await mappingCandidates(ctx, source);
  const bound = await filterSeries(candidates, async mapping => {
    try {
      const validation = await validateImport(ctx, applyLayout(source, layout ?? parseJson(mapping.mapping)), source);
      return isDeepStrictEqual(parseJson(mapping.structural_context).bindings, validation.bindings);
    } catch { return false; }
  });
  if (bound.length) candidates = bound;
  if (!layout) {
    const applicable = await filterSeries(candidates, async mapping => {
      try {
        const candidate = parseJson(mapping.mapping), validation = await validateImport(ctx, applyLayout(source, candidate), source);
        return validation.valid && isDeepStrictEqual(parseJson(mapping.structural_context), { ...layoutContext(source, candidate), bindings: validation.bindings });
      } catch { return false; }
    });
    if (applicable.length === 1) layout = parseJson(applicable[0].mapping);
    else if (candidates.length === 1) layout = parseJson(candidates[0].mapping);
    else return { status: 'needs_clarification', candidateCount: candidates.length, confirmationRequired: true,
      delta: [{ field: 'layout', reason: 'no_unique_approved_layout' }], preserved: { candidates: candidates.map(m => ({ id: m.signature, version: m.mapping_version, ...parseJson(m.structural_context) })) } };
  }
  let proposal, validation;
  try { proposal = applyLayout(source, layout); validation = await validateImport(ctx, proposal, source); } catch { validation = { valid: false, bindings: [] }; }
  const structural = { ...layoutContext(source, layout), bindings: validation.bindings };
  const matches = candidates.filter(c => isDeepStrictEqual(parseJson(c.structural_context), structural));
  if (matches.length !== 1 || !validation.valid) return { status: 'needs_clarification', confirmationRequired: true,
    reasonCode: layout.currency !== 'USD' ? 'unsupported_currency' : null,
    candidateCount: candidates.length, suggestedLayout: layout,
    delta: candidates.length === 1 ? layoutDelta(parseJson(candidates[0].structural_context), structural) : [{ field: 'layout', reason: 'no_unique_approved_layout' }],
    preserved: candidates.length === 1 ? { layout: parseJson(candidates[0].mapping), bindings: parseJson(candidates[0].structural_context).bindings } : {},
    previousMapping: candidates.length === 1 ? { id: candidates[0].signature, version: candidates[0].mapping_version } : null,
    errors: validation.errors ?? ['invalid_layout'] };
  const match = matches[0];
  proposal.mappingId = match.signature; proposal.mappingVersion = match.mapping_version;
  const staged = await stageImport(ctx, { source, proposal, layout });
  const row = await latest(ctx.db, staged.proposalId), review = parseJson(row.review_state);
  const loaded = await readSource(ctx, row);
  return await txWith(ctx, async (ctx) => {
    const approved = await ctx.db.prepare('SELECT * FROM column_mappings WHERE signature=?').get(match.signature);
    if (approved?.approval_status !== 'approved' || approved.mapping_version !== match.mapping_version) stale(['mapping']);
    return await commit(ctx, row, parseJson(row.proposal), loaded.source, loaded.file, review, await validateImport(ctx, parseJson(row.proposal), loaded.source), { automatic: true });
  });
}
