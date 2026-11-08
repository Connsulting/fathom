import { queueCategoryChecks } from '../categories/store.mjs';
import { queueAccountPairs } from '../ingest/account-merge.mjs';
// Ingest API handlers: file uploads, the file list, retries and the confirm queue. Each takes the
// router ctx ({household, db, config, engine, scheduler, params, body, uploads}, db and engine
// taken from the household) and returns the JSON body or
// throws HttpError. A request that imports a file triggers the plan and confirm-guess jobs through ctx.scheduler. Pipeline, vault and confirm errors map to statuses here with fixed messages, so no
// file name contents or row values reach a response or a log.

import { getSetting } from '../store/db.mjs';
import { openVault, VaultError } from '../ingest/vault.mjs';
import { ToolError } from '../tools/errors.mjs';
import { ingestFiles, retryFile as retryIngest, triggerJob, triggerPlan, triggerGuesses, triggerFreshness } from '../ingest/pipeline.mjs';
import { answerItem, answerItems, reviseItem, reopenItem, reopenItems, finalReason, getItem, pendingItems, listItems, ConfirmError } from '../ingest/confirm.mjs';
import { autoResolve } from '../ingest/auto.mjs';
import { listImportedFiles } from '../ingest/freshness.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { HttpError } from './http.mjs';
import { scenarioOf } from './scenario.mjs';

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

const schedulerOf = ctx => ctx.scheduler ?? ctx.household?.scheduler ?? ctx.services?.household?.scheduler;

const nowIso = () => new Date().toISOString();
const storeMode = async db => (await getSetting(db, 'mode', null) === 'demo' ? 'demo' : 'real');

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

export { triggerPlan, triggerGuesses, triggerFreshness } from '../ingest/pipeline.mjs';
export const ingestOpts = async ctx => ({ ...ctx, household: ctx.household, actorId: ctx.identity?.id ?? ctx.actorId ?? (await storeMode(ctx.db) === 'demo' ? 'demo' : null), now: nowIso() });

export async function uploadFiles(ctx) {
  await householdVault(ctx);
  const parts = ctx.uploads.filter(p => p.field === UPLOAD_FIELD);
  if (!parts.length) throw new HttpError(400, `the upload has no files in the "${UPLOAD_FIELD}" field`);
  const files = parts.map(p => ({ name: p.name, bytes: p.bytes, mime: p.mime }));
  let results;
  try {
    ({ results } = await ingestFiles(ctx.db, files, await ingestOpts(ctx)));
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    if (err instanceof ToolError) throw new HttpError(err.code === 'forbidden' ? 403 : 409, err.message);
    throw err;
  }
  if (results.some(r => r && r.status === 'imported')) { triggerPlan(ctx); triggerFreshness(ctx); }
  if (results.some(r => r && r.status === 'imported')) triggerGuesses(ctx);
  const scenario = await scenarioOf(ctx);
  return { scenario, files: results, pending: scenario.live.ingest.pending };
}

export const listFiles = async ctx => await listImportedFiles(ctx.db);

export async function retryFile(ctx) {
  const { id } = ctx.params;
  await householdVault(ctx);
  let file;
  try {
    file = await retryIngest(ctx.db, id, { ...await ingestOpts(ctx), mode: ctx.body?.mode ?? 'retry' });
  } catch (err) {
    if (err && err.status === 400) throw new HttpError(400, err.message);
    if (err && err.status === 404) throw new HttpError(404, `no file ${id}`);
    if (err && err.status === 409) throw new HttpError(409, 'that file is not eligible for the requested import mode');
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (file && file.status === 'imported') { triggerPlan(ctx); triggerFreshness(ctx); }
  if (file && file.status === 'imported') triggerGuesses(ctx);
  return { scenario: await scenarioOf(ctx), file };
}

// One confirm item by id, pending or answered, so a client can check whether an answer landed.
export async function getConfirm(ctx) {
  const item = await getItem(ctx.db, itemId(ctx.params.id));
  if (!item) throw new HttpError(404, 'no such question');
  return { item: { ...item, final: await finalReason(ctx.db, item) } };
}

export async function listPendingConfirm(ctx) {
  await queueAccountPairs(ctx.db);
  await queueCategoryChecks(ctx.db);
  return { items: await pendingItems(ctx.db) };
}

export async function listConfirm(ctx) {
  await queueAccountPairs(ctx.db);
  await queueCategoryChecks(ctx.db);
  const { status = 'pending' } = ctx.body;
  if (!LIST_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${LIST_STATUSES.join(', ')}`);
  return { items: await listItems(ctx.db, { status }) };
}

const itemId = raw => {
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(404, 'no such question');
  return Number(raw);
};

// Run a confirm action, then auto-resolution over what the answer settled, and answer
// {scenario, item} (or {scenario, items}) with item.final, refreshing pack state when facts
// changed. ConfirmErrors map to their fixed messages.
async function confirmAction(ctx, fn) {
  let out;
  try {
    out = await fn();
  } catch (err) {
    if (err instanceof ConfirmError && err.code === 'final' && Object.hasOwn(FINAL_MESSAGE, err.reason)) {
      throw Object.assign(new HttpError(err.status, FINAL_MESSAGE[err.reason]), { reason: err.reason });
    }
    if (err instanceof ConfirmError && Object.hasOwn(CONFIRM_MESSAGE, err.code)) {
      throw new HttpError(err.status, CONFIRM_MESSAGE[err.code], undefined, err.code);
    }
    throw err;
  }
  await resolveAfterAnswer(ctx);
  if (out.factsChanged) {
    try { await refreshPackState(ctx.db, { dataDir: ctx.household?.root ?? ctx.services?.household?.root }); } catch (err) { console.error('fathom: pack refresh failed', err && err.name); }
  }
  const withFinal = async item => {
    const now = await getItem(ctx.db, item.id) || item;
    return { ...now, final: await finalReason(ctx.db, now) };
  };
  if (Array.isArray(out.items)) return { scenario: await scenarioOf(ctx), items: out.items.map(withFinal) };
  return { scenario: await scenarioOf(ctx), item: out.item ? await withFinal(out.item) : null };
}

// Auto-resolution after the confirm transaction committed: a failure logs a code and never fails
// the request.
async function resolveAfterAnswer(ctx) {
  try {
    await autoResolve(ctx.db, { now: nowIso() });
  } catch (err) {
    console.error('fathom: auto-resolve failed', safeCode(err));
  }
}

// After a confirm answer (or a stale refusal) on a real store, the plan job is scheduled through
// the scheduler's debounce: one run 30 s after the last answer of a burst, or right away once the
// pending queue is empty. The run's job_runs trigger is 'confirm'. Never fails the request.
export async function schedulePlan(ctx) {
  const scheduler = schedulerOf(ctx);
  if (!scheduler || typeof scheduler.soon !== 'function' || await storeMode(ctx.db) === 'demo') return;
  try {
    const left = (await ctx.db.prepare("SELECT count(*) AS n FROM confirm_items WHERE status = 'pending'").get()).n;
    scheduler.soon('plan', 'confirm', { immediate: left === 0 });
  } catch (err) {
    console.error('fathom: plan trigger failed', safeCode(err));
  }
}

// A confirm action with its follow-ups: auto-resolution, the plan schedule and, for an account
// question, a freshness run. Shared by the account dialog's owner, kind and merge edits.
export async function afterAnswer(ctx, fn) {
  try {
    const out = await confirmAction(ctx, fn);
    await schedulePlan(ctx);
    const items = out.item ? [out.item] : (out.items || []);
    if (items.some(i => i && /account_/.test(String(i.kind || '')))) triggerFreshness(ctx);
    return out;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'stale') await schedulePlan(ctx);
    throw err;
  }
}

// {answer} answers a pending item; {answer, revise: true} revises an answered one.
export async function answerConfirm(ctx) {
  const id = itemId(ctx.params.id);
  const optionId = ctx.body.answer;
  if (typeof optionId !== 'string' || !optionId) throw new HttpError(400, 'answer must be an option id');
  const revise = ctx.body.revise === true;
  const out = await saveConfirmAnswers(ctx, [{ id, answer: optionId }], { revise });
  return { scenario: out.scenario, item: out.items[0] };
}

export async function reopenConfirm(ctx) {
  const id = itemId(ctx.params.id);
  const out = await saveConfirmReopen(ctx, [id]);
  return { scenario: out.scenario, item: out.items[0] };
}

// A body item id: a positive integer, as a number or digits.
const bodyId = raw => {
  if (Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
};
const MAX_BATCH = 500;

// {answers: [{id, answer}]} answers every listed pending item in one transaction (a group card).
export async function saveConfirmAnswers(ctx, list, { revise = false } = {}) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_BATCH || (revise && list.length !== 1)) throw new HttpError(400, 'answers must be a list of {id, answer}; revise takes one item');
  const answers = list.map(a => {
    const id = bodyId(a && a.id);
    const option = a && a.answer;
    if (id === null || typeof option !== 'string' || !option) throw new HttpError(400, 'answers must be a list of {id, answer}');
    return { id, option };
  });
  const out = await afterAnswer(ctx, async () => revise
    ? (async () => { const result = await reviseItem(ctx.db, answers[0].id, answers[0].option, { now: nowIso() }); return { items: [result.item], factsChanged: result.factsChanged }; })()
    : await answerItems(ctx.db, answers, { now: nowIso() }));
  if (out.items.some(i => i.kind === 'account_match' && !i.context?.repair)) triggerJob(ctx, 'simplefin-sync');
  return out;
}
export async function answerConfirmBatch(ctx) {
  return await saveConfirmAnswers(ctx, ctx.body.answers);
}

export async function saveConfirmReopen(ctx, raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BATCH) throw new HttpError(400, 'ids must be a list of question ids');
  const ids = raw.map(bodyId);
  if (ids.some(id => id === null)) throw new HttpError(400, 'ids must be a list of question ids');
  return await afterAnswer(ctx, async () => await reopenItems(ctx.db, ids, { now: nowIso() }));
}
export async function reopenConfirmBatch(ctx) {
  return await saveConfirmReopen(ctx, ctx.body.ids);
}
