import { actionTx, parseJson } from '../store/db.mjs';
import { validateDisplayName } from '../shared/account-label.mjs';
import { HttpError } from '../api/http.mjs';
import { setAccountAnswer, undoAccountAnswer, OWNER_OPTIONS, KIND_OPTIONS } from '../ingest/confirm.mjs';
import { queueAccountPairs, mergePlan, manualMerge } from '../ingest/account-merge.mjs';

const accountTransaction = async (db, fn) => await actionTx(db, fn);

export async function accountOf(db, id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'missing account');
  const row = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'no such account');
  return row;
}

export async function renameAccount(db, id, displayName) {
  await accountOf(db, id);
  if (displayName === undefined) throw new HttpError(400, 'display name is required');
  const res = validateDisplayName(displayName);
  if (!res.ok) throw new HttpError(400, res.error);
  await accountTransaction(db, async (db) => await db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(res.value, id));
  return await accountOf(db, id);
}

export async function setAccountMask(db, id, mask) {
  const row = await accountOf(db, id);
  if (typeof mask !== 'string' || !/^\d{4}$/.test(mask)) throw new HttpError(400, 'last 4 must be exactly four digits');
  if ((row.mask != null && row.mask !== '') || String(row.identity ?? '').startsWith('simplefin:')) {
    throw new HttpError(409, 'this account already has its last 4');
  }
  await accountTransaction(db, async (db) => {
    await db.prepare('UPDATE accounts SET mask = ? WHERE id = ?').run(mask, id);
    await queueAccountPairs(db);
  });
  return { set: mask };
}

export async function restoreAccountMask(db, id, undo) {
  const row = await accountOf(db, id);
  if (!undo || typeof undo !== 'object' || Array.isArray(undo) || typeof undo.set !== 'string' || !/^\d{4}$/.test(undo.set)) {
    throw new HttpError(400, 'undo must be the before value an edit returned');
  }
  if (row.mask !== undo.set || String(row.identity ?? '').startsWith('simplefin:')) {
    throw new HttpError(409, 'the last 4 changed since, so it cannot be undone');
  }
  const answered = (await db.prepare("SELECT context FROM confirm_items WHERE kind = 'account_match' AND status = 'answered' AND answer IS NOT 'superseded'").all())
    .some(i => { const c = parseJson(i.context, {}) || {}; return c.candidateId === id || c.ownId === id; });
  if (answered) throw new HttpError(409, 'a later answer builds on this last 4, so it is final');
  await accountTransaction(db, async (db) => {
    await db.prepare('UPDATE accounts SET mask = NULL WHERE id = ?').run(id);
    await queueAccountPairs(db);
  });
}

export async function writeAccountAnswer(db, id, field, body, { now } = {}) {
  await accountOf(db, id);
  const kind = field === 'owner' ? 'account_owner' : 'account_kind';
  const options = field === 'owner' ? OWNER_OPTIONS : KIND_OPTIONS;
  if (Object.hasOwn(body, 'undo')) {
    const undo = body.undo;
    if (!undo || typeof undo !== 'object' || Array.isArray(undo) || (undo.answer != null && typeof undo.answer !== 'string')) {
      throw new HttpError(400, 'undo must be the before value an edit returned');
    }
    return { ...await undoAccountAnswer(db, kind, id, undo, { now }), before: null };
  }
  if (typeof body[field] !== 'string' || !options.some(o => o.id === body[field])) {
    throw new HttpError(400, `${field} must be one of ${options.map(o => o.id).join(', ')}`);
  }
  return await setAccountAnswer(db, kind, id, body[field], { now });
}

export async function mergeAccountPair(db, id, withId, { now } = {}) {
  await accountOf(db, id);
  if (typeof withId !== 'string' || !withId) throw new HttpError(400, 'withId must name the other account');
  if (withId === id) throw new HttpError(400, 'an account cannot be merged with itself');
  await accountOf(db, withId);
  const plan = await mergePlan(db, id, withId);
  if (plan.refused) throw new HttpError(409, plan.refused);
  return await accountTransaction(db, async (db) => await manualMerge(db, id, withId, { now }));
}
