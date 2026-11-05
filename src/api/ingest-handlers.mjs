// Ingest API handlers: file uploads, the file list, retries and the confirm queue. Each takes the
// router ctx ({db, config, engine, scheduler, params, body, readUpload}) and returns the JSON body or
// throws HttpError. A request that imports a file triggers the plan and confirm-guess jobs through ctx.scheduler. Pipeline, vault and confirm errors map to statuses here with fixed messages, so no
// file name contents or row values reach a response or a log.

import { getSetting } from '../store/db.mjs';
import { loadDataKey, VaultError } from '../ingest/vault.mjs';
import { ingestFiles, retryFile as retryIngest } from '../ingest/pipeline.mjs';
import { answerItem, reviseItem, reopenItem, finalReason, pendingItems, listItems, ConfirmError } from '../ingest/confirm.mjs';
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

// The data key for this store: demo stores use a generated key under $FATHOM_DATA/files, real
// stores need FATHOM_DATA_KEY_FILE (409 with the vault's message, before anything is stored).
async function dataKey(ctx) {
  try {
    return await loadDataKey({ dataDir: ctx.config.dataDir, keyFile: ctx.config.dataKeyFile, mode: storeMode(ctx.db) });
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
const triggerPlan = ctx => triggerJob(ctx, 'plan');
const triggerGuesses = ctx => triggerJob(ctx, 'confirm-guess');

const ingestOpts = (ctx, key) => ({ engine: ctx.engine, config: ctx.config, now: nowIso(), key });

export async function uploadFiles(ctx) {
  const key = await dataKey(ctx);
  const parts = (await ctx.readUpload()).filter(p => p.field === UPLOAD_FIELD);
  if (!parts.length) throw new HttpError(400, `the upload has no files in the "${UPLOAD_FIELD}" field`);
  const files = parts.map(p => ({ name: p.name, bytes: p.bytes, mime: p.mime }));
  let results;
  try {
    ({ results } = await ingestFiles(ctx.db, files, ingestOpts(ctx, key)));
  } catch (err) {
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (results.some(r => r && r.status === 'imported')) triggerPlan(ctx);
  if (results.some(r => r && r.status === 'imported')) triggerGuesses(ctx);
  const scenario = scenarioOf(ctx);
  return { scenario, files: results, pending: scenario.live.ingest.pending };
}

export function listFiles(ctx) {
  const rows = ctx.db.prepare('SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files ORDER BY uploaded_at DESC, rowid DESC').all();
  return { files: rows.map(fileOf) };
}

export async function retryFile(ctx) {
  const { id } = ctx.params;
  const key = await dataKey(ctx);
  let file;
  try {
    file = await retryIngest(ctx.db, id, ingestOpts(ctx, key));
  } catch (err) {
    if (err && err.status === 404) throw new HttpError(404, `no file ${id}`);
    if (err && err.status === 409) throw new HttpError(409, 'that file is not waiting for a mapping or extraction');
    if (err instanceof VaultError) throw new HttpError(409, err.message);
    throw err;
  }
  if (file && file.status === 'imported') triggerPlan(ctx);
  if (file && file.status === 'imported') triggerGuesses(ctx);
  return { scenario: scenarioOf(ctx), file };
}

export function listPendingConfirm(ctx) {
  return { items: pendingItems(ctx.db) };
}

export function listConfirm(ctx) {
  const { status = 'pending' } = ctx.body;
  if (!LIST_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${LIST_STATUSES.join(', ')}`);
  return { items: listItems(ctx.db, { status }) };
}

const itemId = raw => {
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(404, 'no such question');
  return Number(raw);
};

// Run a confirm action and answer {scenario, item} with item.final, refreshing pack state when
// facts changed. ConfirmErrors map to their fixed messages.
function confirmAction(ctx, fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    if (err instanceof ConfirmError && err.code === 'final' && Object.hasOwn(FINAL_MESSAGE, err.reason)) {
      throw new HttpError(err.status, FINAL_MESSAGE[err.reason]);
    }
    if (err instanceof ConfirmError && Object.hasOwn(CONFIRM_MESSAGE, err.code)) {
      throw new HttpError(err.status, CONFIRM_MESSAGE[err.code]);
    }
    throw err;
  }
  if (out.factsChanged) {
    try { refreshPackState(ctx.db, { dataDir: ctx.config && ctx.config.dataDir }); } catch (err) { console.error('fathom: pack refresh failed', err && err.name); }
  }
  return { scenario: scenarioOf(ctx), item: { ...out.item, final: finalReason(ctx.db, out.item) } };
}

// {answer} answers a pending item; {answer, revise: true} revises an answered one.
export function answerConfirm(ctx) {
  const id = itemId(ctx.params.id);
  const optionId = ctx.body.answer;
  if (typeof optionId !== 'string' || !optionId) throw new HttpError(400, 'answer must be an option id');
  const revise = ctx.body.revise === true;
  return confirmAction(ctx, () => (revise ? reviseItem : answerItem)(ctx.db, id, optionId, { now: nowIso() }));
}

export function reopenConfirm(ctx) {
  const id = itemId(ctx.params.id);
  return confirmAction(ctx, () => reopenItem(ctx.db, id, { now: nowIso() }));
}
