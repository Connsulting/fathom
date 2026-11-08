import { queueCategoryChecks } from '../categories/store.mjs';
import { queueAccountPairs } from '../ingest/account-merge.mjs';
// Ingest API handlers: file uploads, the file list, retries and the confirm queue. Each takes the
// router ctx ({household, db, config, engine, scheduler, params, body, uploads}, db and engine
// taken from the household) and returns the JSON body or
// throws HttpError. A request that imports a file triggers the plan and confirm-guess jobs through ctx.scheduler. Pipeline, vault and confirm errors map to statuses here with fixed messages, so no
// file name contents or row values reach a response or a log.

import { getSetting } from '../store/db.mjs';
import { openVault, VaultError } from '../ingest/vault.mjs';
import { ingestFiles, retryFile as retryIngest } from '../ingest/pipeline.mjs';
import { answerItem, answerItems, reviseItem, reopenItem, reopenItems, finalReason, getItem, pendingItems, listItems, ConfirmError } from '../ingest/confirm.mjs';
import { autoResolve } from '../ingest/auto.mjs';
import { fileOf } from '../ingest/freshness.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './handlers.mjs';

const UPLOAD_FIELD = 'files';
const LIST_STATUSES = ['pending', 'answered', 'all'];
const CONFIRM_MESSAGE = {
  not_found: 'no such question',
  bad_option: 'answer must be one of the offered options',
  answered: 'that question is already answered',
  stale: 'the value changed since this question was asked',
  not_answered: 'that question is not answered yet',
};
// ConfirmError('final') by reason (D5).
const FINAL_MESSAGE = {
  no_undo: 'This answer was recorded before answers could be changed, so it is final.',
  imported_since: 'A file was imported after this answer, so it is final.',
  changed_since: 'A later change builds on this answer, so it is final.',
  used_since: 'A later import used this answer, so it is final.',
};

const nowIso = () => new Date().toISOString();
const storeMode = db => (getSetting(db, 'mode', null) === 'demo' ? 'demo' : 'real');

// The household vault, opened before anything is read or stored: a missing or invalid platform key
// or a missing data key is 409 with the vault's message (naming FATHOM_PLATFORM_KEY_FILE).
export async function householdVault(ctx) {
  try {
    return await openVault(ctx.household);
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const safeCode = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && IDENT.test(v)) || 'unknown';

// Fire and forget: a trigger failure logs a code and never fails the request.
function triggerJob(ctx, jobId) {
  if (!ctx.scheduler) return;
  const failed = err => console.error(`fathom: ${jobId} trigger failed`, safeCode(err));
  try {
    const p = ctx.scheduler.trigger(jobId, 'ingest');
    if (p && typeof p.then === 'function') p.then(null, failed);
  } catch (err) {
    failed(err);
  }
}
export const triggerPlan = ctx => triggerJob(ctx, 'plan');
export const triggerGuesses = ctx => triggerJob(ctx, 'confirm-guess');
export const triggerFreshness = ctx => triggerJob(ctx, 'freshness');

export const ingestOpts = ctx => ({ household: ctx.household, engine: ctx.engine, config: ctx.config, now: nowIso() });

export async function uploadFiles(ctx) {
  await householdVault(ctx);
  const parts = ctx.uploads.filter(p => p.field === UPLOAD_FIELD);
  if (!parts.length) throw new HttpError(400, `the upload has no files in the "${UPLOAD_FIELD}" field`);
  const files = parts.map(p => ({ name: p.name, bytes: p.bytes, mime: p.mime }));
  let results;
  try {
    ({ results } = await ingestFiles(ctx.db, files, ingestOpts(ctx)));
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (results.some(r => r && r.status === 'imported')) { triggerPlan(ctx); triggerFreshness(ctx); }
  if (results.some(r => r && r.status === 'imported')) triggerGuesses(ctx);
  const scenario = scenarioOf(ctx);
  return { scenario, files: results, pending: scenario.live.ingest.pending };
}

export function listFiles(ctx) {
  const rows = ctx.db.prepare('SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files WHERE removed_at IS NULL ORDER BY uploaded_at DESC, rowid DESC').all();
  return { files: rows.map(fileOf) };
}

export async function retryFile(ctx) {
  const { id } = ctx.params;
  await householdVault(ctx);
  let file;
  try {
    file = await retryIngest(ctx.db, id, ingestOpts(ctx));
  } catch (err) {
    if (err && err.status === 404) throw new HttpError(404, `no file ${id}`);
    if (err && err.status === 409) throw new HttpError(409, 'that file is not waiting for a mapping or extraction');
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (file && file.status === 'imported') { triggerPlan(ctx); triggerFreshness(ctx); }
  if (file && file.status === 'imported') triggerGuesses(ctx);
  return { scenario: scenarioOf(ctx), file };
}

// One confirm item by id, pending or answered, so a client can check whether an answer landed.
export function getConfirm(ctx) {
  const item = getItem(ctx.db, itemId(ctx.params.id));
  if (!item) throw new HttpError(404, 'no such question');
  return { item: { ...item, final: finalReason(ctx.db, item) } };
}

export function listPendingConfirm(ctx) {
  queueAccountPairs(ctx.db);
  queueCategoryChecks(ctx.db);
  return { items: pendingItems(ctx.db) };
}

export function listConfirm(ctx) {
  queueAccountPairs(ctx.db);
  queueCategoryChecks(ctx.db);
  const { status = 'pending' } = ctx.body;
  if (!LIST_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${LIST_STATUSES.join(', ')}`);
  return { items: listItems(ctx.db, { status }) };
}

const itemId = raw => {
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(404, 'no such question');
  return Number(raw);
};

// Run a confirm action, then auto-resolution over what the answer settled, and answer
// {scenario, item} (or {scenario, items}) with item.final, refreshing pack state when facts
// changed. ConfirmErrors map to their fixed messages.
function confirmAction(ctx, fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    if (err instanceof ConfirmError && err.code === 'final' && Object.hasOwn(FINAL_MESSAGE, err.reason)) {
      throw new HttpError(err.status, FINAL_MESSAGE[err.reason]);
    }
    if (err instanceof ConfirmError && Object.hasOwn(CONFIRM_MESSAGE, err.code)) {
      throw new HttpError(err.status, CONFIRM_MESSAGE[err.code], undefined, err.code);
    }
    throw err;
  }
  resolveAfterAnswer(ctx);
  if (out.factsChanged) {
    try { refreshPackState(ctx.db, { dataDir: ctx.household.root }); } catch (err) { console.error('fathom: pack refresh failed', err && err.name); }
  }
  const withFinal = item => {
    const now = getItem(ctx.db, item.id) || item;
    return { ...now, final: finalReason(ctx.db, now) };
  };
  if (Array.isArray(out.items)) return { scenario: scenarioOf(ctx), items: out.items.map(withFinal) };
  return { scenario: scenarioOf(ctx), item: out.item ? withFinal(out.item) : null };
}

// Auto-resolution after the confirm transaction committed: a failure logs a code and never fails
// the request.
function resolveAfterAnswer(ctx) {
  try {
    autoResolve(ctx.db, { now: nowIso() });
  } catch (err) {
    console.error('fathom: auto-resolve failed', safeCode(err));
  }
}

// After a confirm answer (or a stale refusal) on a real store, the plan job is scheduled through
// the scheduler's debounce: one run 30 s after the last answer of a burst, or right away once the
// pending queue is empty. The run's job_runs trigger is 'confirm'. Never fails the request.
export function schedulePlan(ctx) {
  if (!ctx.scheduler || typeof ctx.scheduler.soon !== 'function' || storeMode(ctx.db) === 'demo') return;
  try {
    const left = ctx.db.prepare("SELECT count(*) AS n FROM confirm_items WHERE status = 'pending'").get().n;
    ctx.scheduler.soon('plan', 'confirm', { immediate: left === 0 });
  } catch (err) {
    console.error('fathom: plan trigger failed', safeCode(err));
  }
}

// A confirm action with its follow-ups: auto-resolution, the plan schedule and, for an account
// question, a freshness run. Shared by the account dialog's owner, kind and merge edits.
export function afterAnswer(ctx, fn) {
  try {
    const out = confirmAction(ctx, fn);
    schedulePlan(ctx);
    const items = out.item ? [out.item] : (out.items || []);
    if (items.some(i => i && /account_/.test(String(i.kind || '')))) triggerFreshness(ctx);
    return out;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'stale') schedulePlan(ctx);
    throw err;
  }
}

// {answer} answers a pending item; {answer, revise: true} revises an answered one.
export function answerConfirm(ctx) {
  const id = itemId(ctx.params.id);
  const optionId = ctx.body.answer;
  if (typeof optionId !== 'string' || !optionId) throw new HttpError(400, 'answer must be an option id');
  const revise = ctx.body.revise === true;
  const out = afterAnswer(ctx, () => (revise ? reviseItem : answerItem)(ctx.db, id, optionId, { now: nowIso() }));
  // A SimpleFIN account waits on its match question: the answer lets the next sync import it.
  if (out.item && out.item.kind === 'account_match' && !out.item.context?.repair) triggerJob(ctx, 'simplefin-sync');
  return out;
}

export function reopenConfirm(ctx) {
  const id = itemId(ctx.params.id);
  return afterAnswer(ctx, () => reopenItem(ctx.db, id, { now: nowIso() }));
}

// A body item id: a positive integer, as a number or digits.
const bodyId = raw => {
  if (Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
};
const MAX_BATCH = 500;

// {answers: [{id, answer}]} answers every listed pending item in one transaction (a group card).
export function answerConfirmBatch(ctx) {
  const list = ctx.body.answers;
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH) throw new HttpError(400, 'answers must be a list of {id, answer}');
  const answers = list.map(a => {
    const id = bodyId(a && a.id);
    const option = a && a.answer;
    if (id === null || typeof option !== 'string' || !option) throw new HttpError(400, 'answers must be a list of {id, answer}');
    return { id, option };
  });
  const out = afterAnswer(ctx, () => answerItems(ctx.db, answers, { now: nowIso() }));
  if (out.items.some(i => i.kind === 'account_match' && !i.context?.repair)) triggerJob(ctx, 'simplefin-sync');
  return out;
}

// {ids: [...]} reopens every listed answered item in one transaction (undo of a group card).
export function reopenConfirmBatch(ctx) {
  const raw = ctx.body.ids;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BATCH) throw new HttpError(400, 'ids must be a list of question ids');
  const ids = raw.map(bodyId);
  if (ids.some(id => id === null)) throw new HttpError(400, 'ids must be a list of question ids');
  return afterAnswer(ctx, () => reopenItems(ctx.db, ids, { now: nowIso() }));
}
