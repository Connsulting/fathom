// Auto-resolution: Fathom answers a pending confirm question itself only when stored rows settle it.
// Each rule reads stored rows and returns {option, rule, evidence} or null; a hit is recorded
// through recordAutoAnswer (the normal answer path, own transaction and undo log). Rules:
// cross_format_duplicate (near_duplicate): one posting seen once in each of two formats.
// holder_match (account_owner): the source's holder name is a known household member, from the
// household.names fact or from an answered account with the same holder.
// shared_mask (account_owner, account_kind): every answered account with the same mask at a
// compatible institution agrees. An owner question whose holder names several people, or whose
// holder sources disagree, is never answered by shared_mask: holder ambiguity asks.
// Evidence is {text, basis, ancestors, refs}: basis are the answered items a rule used; ancestors
// add each basis item's own ancestors, so no answer ever supports one it rests on. Items the owner
// declined (undid an auto answer) are never answered again.

import { parseJson } from '../store/db.mjs';
import { getFacts } from '../store/facts.mjs';
import { loadPlanningData, resolveEntities } from '../jobs/planner/data.mjs';
import { sameEmployer, docPayer, docRecipient, employerKeyOf } from '../jobs/planner/payroll.mjs';
import { estimatedTaxYear } from './transaction-payments.mjs';
import { kindOf } from './account-match.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import {
  pendingItems, getItem, recordAutoAnswer, autoInfo, normalizeName, ConfirmError, KIND_OPTIONS,
} from './confirm.mjs';
import { filterSeries, flatMapSeries, mapSeries } from '../shared/series.mjs';

const MAX_PASSES = 10;

// Joiners that make a holder name name more than one person.
const HOLDER_JOINERS = /&|\+|\/|,|\band\b|\bor\b/i;
export const multiHolder = (text) => HOLDER_JOINERS.test(String(text ?? ''));

// Answer every pending item a rule settles, pass after pass until nothing changes (bounded).
// Returns {answered: item ids in answer order}.
export async function autoResolve(db, { now } = {}) {
  const answered = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const declined = new Set((await db.prepare('SELECT item_id FROM confirm_auto_declined').all()).map((r) => r.item_id));
    let progressed = false;
    for (const { id } of await pendingItems(db)) {
      if (declined.has(id)) continue;
      const item = await getItem(db, id);
      if (!item || item.status !== 'pending') continue;
      const hit = await decide(db, item);
      if (!hit) continue;
      try {
        await recordAutoAnswer(db, item.id, hit.option, { rule: hit.rule, evidence: hit.evidence, now });
      } catch (err) {
        if (err instanceof ConfirmError) continue;
        throw err;
      }
      answered.push(item.id);
      progressed = true;
    }
    if (!progressed) break;
  }
  return { answered };
}

async function decide(db, item) {
  if (item.kind === 'tax_year') return await paymentYear(db, item);
  if (item.kind === 'near_duplicate') return await crossFormatDuplicate(db, item);
  if (item.kind === 'account_kind') return await accountKind(db, item);
  if (item.kind === 'employer_relation') return await employerRelation(db, item);
  if (['employer_recipient', 'document_recipient'].includes(item.kind)) return await payrollRecipient(db, item);
  if (item.kind !== 'account_owner') return null;
  const byHolder = await holderMatch(db, item);
  if (byHolder?.ambiguous) return null;
  const byMask = await sharedMask(db, item);
  if (byHolder && byMask && byHolder.option !== byMask.option) return null;
  return byHolder ?? byMask;
}

async function paymentYear(db, item) {
  const year = item.context.sheetYear;
  if (!Number.isInteger(year) || !validOption(item, 'payment_year')) return null;
  const rows = await db.prepare("SELECT id,date,kind,jurisdiction FROM tax_payments WHERE source_slot LIKE ? AND tax_year_basis='sheet_label'").all(`tax:${year}:%`);
  const state = (await getFacts(db))['household.state'];
  if (!rows.length || rows.some(r => !['paid', 'estimate'].includes(r.kind)
    || estimatedTaxYear(r.date, r.jurisdiction === 'state' ? state : r.jurisdiction) === null)) return null;
  return { option: 'payment_year', rule: 'estimated_payment_year', evidence: await evidence(db,
    'Estimated payments use their payment dates. Federal and Virginia fourth installments are due in January for the prior tax year; this inferred year can be undone.',
    [], rows.map(r => ({ table: 'tax_payments', id: r.id }))) };
}

// ---------------------------------------------------------------- shared helpers

const ancestorsOf = async (db, itemId) => (await autoInfo(db, itemId))?.evidence?.ancestors ?? [];
// A support never rests on the item it would answer.
const restsOn = async (db, supportId, itemId) => supportId === itemId || (await ancestorsOf(db, supportId)).includes(itemId);

async function evidence(db, text, basis, refs) {
  const ids = [...new Set(basis)].sort((a, b) => a - b);
  const ancestors = [...new Set([...ids, ...await flatMapSeries(ids, async (id) => await ancestorsOf(db, id))])].sort((a, b) => a - b);
  return { text, basis: ids, ancestors, refs };
}

const accountOf = async (db, id) => await db.prepare('SELECT id, inst, mask, name, kind, identity, display_name FROM accounts WHERE id = ?').get(id) ?? null;
const holderOf = async (db, id) => (await db.prepare('SELECT holder FROM account_holders WHERE account_id = ?').get(id))?.holder ?? null;
const describe = async (db, a) => (await accountNaming(db)).label(a);
const bridged = (a) => String(a?.identity ?? '').startsWith('simplefin:');

const OWNER_TEXT = { owner: 'yours', spouse: "your spouse's", joint: 'joint', business: 'a business account' };
const labelOf = (kind, option) => (kind === 'account_owner'
  ? OWNER_TEXT[option] ?? option
  : KIND_OPTIONS.find((o) => o.id === option)?.label ?? option);
const validOption = (item, option) => item.options.some((o) => o.id === option);
const sameItem = async (db, kind, subject) => await db.prepare('SELECT id, status, answer FROM confirm_items WHERE kind = ? AND subject = ?').get(kind, subject) ?? null;

// ---------------------------------------------------------------- cross_format_duplicate

const centsOf = (amount) => Math.round(Number(amount) * 100);
const fileName = async (db, id) => (await db.prepare('SELECT name FROM files WHERE id = ?').get(id))?.name ?? 'an earlier import';

// Rows a file brought in on one account, date and amount: stored ones plus the ones archived as
// duplicates since (a confirmed duplicate, or a posting deduped across formats).
async function fileRowsOn(db, fileId, accountId, date, cents) {
  const live = (await db.prepare('SELECT amount FROM transactions WHERE file_id = ? AND account_id = ? AND date = ?').all(fileId, accountId, date))
    .filter((r) => centsOf(r.amount) === cents).length;
  const archived = (await db.prepare(`SELECT row FROM superseded_rows WHERE table_name = 'transactions' AND file_id = ?
                               AND reason IN ('duplicate_confirmed', 'duplicate_cross_format')`).all(fileId))
    .map((r) => parseJson(r.row, null)).filter((r) => r && r.account_id === accountId && r.date === date && centsOf(r.amount) === cents).length;
  return live + archived;
}

// R1 and R2-1: two live rows on one account, date and amount from two formats, not two different
// reference numbers, and either a key collision pair (one key is the other's alt key) or the only
// row of its kind in each file, so the match is one to one.
async function crossFormatDuplicate(db, item) {
  const keys = String(item.subject).split('|');
  if (keys.length !== 2 || !validOption(item, 'same')) return null;
  const rows = await mapSeries(keys, async (k) => await db.prepare('SELECT * FROM transactions WHERE dedupe_key = ?').get(k));
  if (rows.some((r) => !r)) return null;
  const [a, b] = rows.sort((x, y) => x.id - y.id);
  const cents = centsOf(a.amount);
  if (a.account_id !== b.account_id || a.date !== b.date || centsOf(b.amount) !== cents) return null;
  if (!a.parser || !b.parser || a.parser === b.parser || !a.file_id || !b.file_id || a.file_id === b.file_id) return null;
  if (a.external_id && b.external_id && a.external_id !== b.external_id) return null;
  const bridge = a.parser === 'simplefin' ? a : b.parser === 'simplefin' ? b : null;
  const file = bridge === a ? b : a;
  if (bridge?.external_id && (await db.prepare("SELECT row FROM superseded_rows WHERE table_name='transactions' AND survivor_key=? AND reason='duplicate_cross_format'").all(file.dedupe_key))
    .some(r => { const prior = parseJson(r.row,null); return prior?.parser === 'simplefin' && prior.external_id && prior.external_id !== bridge.external_id; })) return null;
  const collision = a.dedupe_key.startsWith(`${b.dedupe_key}:d:`) || b.dedupe_key.startsWith(`${a.dedupe_key}:d:`);
  if (!collision && (await fileRowsOn(db, a.file_id, a.account_id, a.date, cents) !== 1 || await fileRowsOn(db, b.file_id, b.account_id, b.date, cents) !== 1)) return null;
  const account = await accountOf(db, a.account_id);
  const [fa, fb] = [await fileName(db, a.file_id), await fileName(db, b.file_id)];
  const text = `${account ? await describe(db, account) : 'This account'} shows ${(cents / 100).toFixed(2)} on ${a.date} once in ${fa} ("${a.description ?? ''}") `
    + `and once in ${fb} ("${b.description ?? ''}"): the same posting in two formats.`;
  return {
    option: 'same', rule: 'cross_format_duplicate',
    evidence: await evidence(db, text, [], { accountId: a.account_id, keys: [a.dedupe_key, b.dedupe_key], files: [a.file_id, b.file_id], date: a.date, amount: cents / 100 }),
  };
}

// ---------------------------------------------------------------- holder_match

const tokens = (text) => String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
const NEUTRAL = new Set(['you', 'your spouse']);

// Household members the names fact gives: [{option, name}] for me and spouse.
async function factMembers(db) {
  const row = await db.prepare("SELECT value, src, as_of FROM facts WHERE key = 'household.names'").get();
  const value = row ? parseJson(row.value, null) : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const [key, option] of [['me', 'owner'], ['spouse', 'spouse']]) {
    const name = value[key];
    if (typeof name !== 'string' || !name.trim() || NEUTRAL.has(name.trim().toLowerCase()) || !tokens(name).length) continue;
    out.push({ option, name: name.trim(), src: row.src ?? null, asOf: row.as_of ?? null });
  }
  return out;
}

// A hit, null when the holder settles nothing, or {ambiguous: true} when the holder names several
// people or its sources disagree.
async function holderMatch(db, item) {
  const account = await accountOf(db, item.subject);
  const holder = account ? await holderOf(db, account.id) : null;
  if (!holder) return null;
  if (multiHolder(holder)) return { ambiguous: true };
  const held = new Set(tokens(holder));
  const fromFact = (await factMembers(db)).filter((m) => tokens(m.name).every((t) => held.has(t)));
  const key = normalizeName(holder);
  const learned = await filterSeries((await db.prepare(`SELECT ci.id, ci.answer, ci.subject, h.holder FROM confirm_items ci JOIN account_holders h ON h.account_id = ci.subject
                              WHERE ci.kind = 'account_owner' AND ci.status = 'answered' AND ci.answer IN ('owner', 'spouse') ORDER BY ci.id`)
    .all()), async (r) => r.subject !== account.id && normalizeName(r.holder) === key && !await restsOn(db, r.id, item.id));
  const options = new Set([...fromFact.map((m) => m.option), ...learned.map((r) => r.answer)]);
  if (options.size > 1) return { ambiguous: true };
  if (options.size === 0) return null;
  const [option] = options;
  if (!validOption(item, option)) return null;
  const said = async (r) => {
    const other = await accountOf(db, r.subject);
    const who = await autoInfo(db, r.id) ? 'Fathom answered that' : 'You said';
    return `${who} ${other ? await describe(db, other) : 'another account'} (also held by "${holder}") is ${labelOf('account_owner', r.answer)}.`;
  };
  const text = [`The source names the holder "${holder}".`,
    ...fromFact.map((m) => `Your household names list ${m.name} as ${m.option === 'owner' ? 'you' : 'your spouse'}.`),
    ...learned.map(said)].join(' ');
  return {
    option, rule: 'holder_match',
    evidence: await evidence(db, text, learned.map((r) => r.id), {
      accountId: account.id, holder,
      ...(fromFact.length ? { fact: { key: 'household.names', src: fromFact[0].src, asOf: fromFact[0].asOf } } : {}),
      accounts: learned.map((r) => r.subject),
    }),
  };
}

// ---------------------------------------------------------------- shared_mask

// Pairs an answered account_match said are different accounts.
async function differentPairs(db) {
  const pairs = new Set();
  for (const r of await db.prepare("SELECT context FROM confirm_items WHERE kind = 'account_match' AND status = 'answered' AND answer = 'different'").all()) {
    const { candidateId, ownId } = parseJson(r.context, {}) ?? {};
    if (typeof candidateId === 'string' && typeof ownId === 'string') pairs.add(`${candidateId}|${ownId}`).add(`${ownId}|${candidateId}`);
  }
  return pairs;
}

async function sharedMask(db, item) {
  const account = await accountOf(db, item.subject);
  if (!account || !/^\d{4}$/.test(account.mask ?? '') || bridged(account)) return null;
  const inst = normalizeName(account.inst);
  const holder = normalizeName(await holderOf(db, account.id));
  const different = await differentPairs(db);
  const siblings = await filterSeries((await db.prepare('SELECT id, inst, mask, name, kind, identity, display_name FROM accounts WHERE mask = ? AND id != ? ORDER BY id').all(account.mask, account.id))
    .filter((s) => !bridged(s) && (!inst || !normalizeName(s.inst) || normalizeName(s.inst) === inst) && !different.has(`${account.id}|${s.id}`)), async (s) => { const h = normalizeName(await holderOf(db, s.id)); return !holder || !h || h === holder; });
  const supports = [];
  for (const s of siblings) {
    const q = await sameItem(db, item.kind, s.id);
    if (q) {
      if (q.status !== 'answered' || q.answer === 'superseded' || await restsOn(db, q.id, item.id)) continue;
      supports.push({ account: s, option: q.answer, itemId: q.id, how: await autoInfo(db, q.id) ? 'Fathom answered that it is' : 'you said it is' });
    } else if (item.kind === 'account_kind' && s.kind) {
      supports.push({ account: s, option: s.kind, itemId: null, how: 'its source lists it as' });
    }
  }
  const options = new Set(supports.map((s) => s.option));
  if (options.size !== 1) return null;
  const [option] = options;
  if (!validOption(item, option)) return null;
  const text = (await mapSeries(supports, async (s) => `${await describe(db, s.account)} also ends in ${account.mask}, and ${s.how} ${labelOf(item.kind, s.option)}.`)).join(' ');
  return {
    option, rule: 'shared_mask',
    evidence: await evidence(db, text, supports.filter((s) => s.itemId != null).map((s) => s.itemId), { accountId: account.id, mask: account.mask, accounts: supports.map((s) => s.account.id) }),
  };
}

async function accountKind(db, item) {
  const account = await accountOf(db, item.subject);
  const option = account && kindOf(account.name);
  const shared = await sharedMask(db, item);
  if (!option || !validOption(item, option)) return shared;
  if (shared) return shared.option === option ? shared : null;
  return { option, rule: 'account_name', evidence: await evidence(db,
    `The account is named "${account.name}"${account.inst ? ` at ${account.inst}` : ''}.`, [], { accountId: account.id }) };
}

async function employerRelation(db, item) {
  const name = item.context.employer;
  if (!normalizeName(name)) return null;
  const facts = await getFacts(db), data = await loadPlanningData(db, new Date().toISOString().slice(0, 10));
  const entities = resolveEntities(data, facts).filter(e => e.classified);
  const matches = entities.filter(e => sameEmployer(data, e.name, name));
  const learned = await filterSeries((await db.prepare("SELECT id,subject,answer,context FROM confirm_items WHERE kind='employer_relation' AND status='answered' AND answer IN ('household','outside')")
    .all()), async r => !await restsOn(db, r.id, item.id) && sameEmployer(data, parseJson(r.context, {}).employer, name));
  const choices = new Set(learned.map(r => r.answer));
  if (matches.length === 1) choices.add('household');
  if (matches.length > 1 || choices.size > 1) return null;
  if (!choices.size) return null;
  const [option] = choices;
  return { option, rule: 'employer_match', evidence: await evidence(db,
    matches.length ? `The employer "${name}" matches your business "${matches[0].name}" or its saved alias.`
      : `You already identified "${name}" as ${option === 'outside' ? 'an outside employer' : 'your own business'}.`,
    learned.map(r => r.id), { employer: name, entities: matches.map(e => e.name) }) };
}

async function payrollRecipient(db, item) {
  const data = await loadPlanningData(db, new Date().toISOString().slice(0, 10));
  const docs = data.documents.filter(d => ['w2', 'paystub'].includes(d.docType)).filter(d => item.kind === 'employer_recipient'
    ? employerKeyOf(d.fields.employerName) === item.subject
    : (!item.fileId || d.fileId === item.fileId) && String(item.subject).startsWith(docPayer(d) + ':'));
  if (!docs.length) return null;
  const members = await factMembers(db);
  const recipients = docs.map(doc => {
    const name = normalizeName(doc.fields.employeeName);
    const matches = name ? members.filter(m => normalizeName(m.name) === name) : [];
    const linked = docRecipient(data, doc);
    if (linked.blocked) return null;
    const stored = linked.person;
    if (matches.length === 1) return stored && stored !== matches[0].option ? null : matches[0].option;
    if (name) return null;
    return stored ?? null;
  });
  if (recipients.some(r => !r) || new Set(recipients).size !== 1) return null;
  const option = recipients[0];
  if (!validOption(item, option)) return null;
  const basis = (await filterSeries(data.confirm, async i => i.status === 'answered' && ['employer_recipient', 'document_recipient'].includes(i.kind)
    && !await restsOn(db, i.id, item.id) && docs.some(d => i.kind === 'employer_recipient'
      ? i.subject === employerKeyOf(d.fields.employerName) : i.subject === `${docPayer(d)}:doc:${d.fileId}`))).map(i => i.id);
  return { option, rule: 'payroll_recipient', evidence: await evidence(db,
    `The payroll documents name ${option === 'owner' ? 'you' : 'your spouse'} as the recipient, matching your household names or saved payroll links.`,
    basis, { documents: docs.map(d => d.id) }) };
}
