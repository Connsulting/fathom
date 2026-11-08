import { moveCategoryRows } from '../categories/store.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { createHash } from 'node:crypto';
import { parseJson, getSetting } from '../store/db.mjs';
import { ask, answerItem, archive, normalizeName, ConfirmError } from './confirm.mjs';
import { accountMask, accountKind, sameInstitution, compatibleInstitution, compatibleKind, lastFour, conflictingBalances } from './account-match.mjs';
import { dedupeKey } from './dedupe.mjs';
import { refreshFigures } from './pipeline.mjs';
import { buildSeries } from '../jobs/planner/series.mjs';
import { loadPlanningData, resolveEntities } from '../jobs/planner/data.mjs';
import { computeFigures } from '../jobs/planner/figures.mjs';

const OPTIONS = [{ id: 'same', label: 'Merge' }, { id: 'different', label: 'Keep both' }];
const subjectOf = (a, b) => `merge:${a}:${b}`;
const differentPairs = async db => (await db.prepare("SELECT context FROM confirm_items WHERE kind='account_match' AND status='answered' AND answer='different'").all()).map(r => parseJson(r.context, {}));
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const utcDay = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const balanceRows = async (db, id) => await db.prepare('SELECT date, amount FROM balances WHERE account_id=? ORDER BY date').all(id);

// Each file balance against the connected account's latest balance on or before that date, within 5 days.
function alignedComparisons(fileRows, connectedRows) {
  const out = [];
  for (const file of fileRows) {
    const fileDay = utcDay(file.date);
    let match = null;
    for (const row of connectedRows) {
      const gap = fileDay - utcDay(row.date);
      if (gap < 0) break;
      if (gap <= 5) match = row;
    }
    if (match) out.push({
      date: file.date,
      equal: Math.round(file.amount * 100) === Math.round(match.amount * 100),
      fileAmount: file.amount,
      connectedAmount: match.amount,
    });
  }
  return out;
}

export function formatMatchedDates(dates) {
  const parts = dates.map(date => {
    const [y, m, d] = date.split('-').map(Number);
    return { y, text: `${MONTHS[m - 1]} ${d}` };
  });
  const sameYear = parts.every(p => p.y === parts[0]?.y);
  const labels = parts.map(p => sameYear ? p.text : `${p.text}, ${p.y}`);
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

export async function detectAccountPairs(db, { includeAnswered = false } = {}) {
  const connected = await db.prepare(`SELECT a.*, m.sf_key, s.snapshot FROM simplefin_accounts m JOIN accounts a ON a.id=m.account_id
    LEFT JOIN simplefin_snapshots s ON s.sf_key=m.sf_key WHERE m.status='mapped' ORDER BY a.id`).all();
  const imported = await db.prepare(`SELECT * FROM accounts a WHERE NOT EXISTS (
    SELECT 1 FROM simplefin_accounts m WHERE m.status='mapped' AND m.account_id=a.id) ORDER BY a.id`).all();
  const different = includeAnswered ? [] : await differentPairs(db);
  const pairs = [];
  for (const own of connected) for (const keep of imported) {
    if (!compatibleInstitution(own.inst, keep.inst) || !compatibleKind(own, keep)) continue;
    const a = accountMask(own), b = accountMask(keep);
    if (a && b && a !== b) continue;
    const sameMask = a && a === b;
    const knownInst = sameInstitution(own.inst, keep.inst);
    const named = normalizeName(own.name) && normalizeName(own.name) === normalizeName(keep.name);
    const fileRows = await balanceRows(db, keep.id);
    const connectedRows = await balanceRows(db, own.id);
    const comparisons = alignedComparisons(fileRows, connectedRows);
    const equals = comparisons.filter(c => c.equal);
    const unequals = comparisons.filter(c => !c.equal);
    const history = unequals.length === 0 && equals.length >= 2;
    const historySure = unequals.length === 0 && equals.length >= 3;
    const latestFile = fileRows.at(-1);
    const latestAligned = latestFile && comparisons.find(c => c.date === latestFile.date);
    const near = Boolean(latestAligned) && Math.abs(latestAligned.fileAmount - latestAligned.connectedAmount) <= Math.max(1, Math.abs(latestAligned.connectedAmount) * 0.05);
    if (!sameMask && !(knownInst && (named || near)) && !history) continue;
    if (different.some(p => p.candidateId === keep.id && p.ownId === own.id)) continue;
    const snap = parseJson(own.snapshot, {});
    const reliable = (snap.maskSure === true && snap.mask === a) || lastFour(own.name) === a;
    const sure = (sameMask && reliable && /^\d{4}$/.test(keep.mask ?? '') && knownInst
      && accountKind(own) && accountKind(keep) && !await conflictingBalances(db, own.id, keep.id)) || historySure;
    pairs.push({
      candidateId: keep.id, ownId: own.id, sfKey: own.sf_key,
      matchedDates: equals.map(c => c.date),
      confidence: sure ? 'sure' : 'likely',
    });
  }
  return pairs.map(p => ({ ...p, confidence: p.confidence === 'sure'
    && pairs.filter(x => x.ownId === p.ownId).length === 1 && pairs.filter(x => x.candidateId === p.candidateId).length === 1 ? 'sure' : 'likely' }));
}

export async function queueAccountPairs(db, { now = new Date().toISOString() } = {}) {
  const pairs = await detectAccountPairs(db);
  const current = new Set(pairs.map(p => subjectOf(p.candidateId,p.ownId)));
  for (const item of await db.prepare("SELECT id,subject,context FROM confirm_items WHERE kind='account_match' AND status='pending'").all()) {
    if (parseJson(item.context,{})?.repair && !current.has(item.subject))
      await db.prepare("UPDATE confirm_items SET status='answered',answer='superseded',answered_at=? WHERE id=?").run(now,item.id);
  }
  const naming = await accountNaming(db);
  const priorOf = db.prepare("SELECT id,status,answer FROM confirm_items WHERE kind='account_match' AND subject=?");
  for (const pair of pairs) {
    const subject = subjectOf(pair.candidateId, pair.ownId);
    const prior = await priorOf.get(subject);
    if (prior?.status === 'answered' && prior.answer !== 'superseded') continue;
    const keep = naming.byId.get(pair.candidateId);
    const own = naming.byId.get(pair.ownId);
    const evidence = pair.matchedDates?.length ? ` Balances matched on ${formatMatchedDates(pair.matchedDates)}.` : '';
    const question = `Same account? ${accountLabel(own)} from SimpleFIN and ${accountLabel(keep)} from a file.${evidence}`;
    const context = { ...pair, repair:true };
    if (prior?.status === 'pending') {
      await db.prepare('UPDATE confirm_items SET question=? WHERE id=? AND question IS NOT ?').run(question,prior.id,question);
      continue;
    }
    if (prior) {
      await db.prepare("UPDATE confirm_items SET status='pending',answer=NULL,answered_at=NULL,question=?,context=?,created_at=? WHERE id=?")
        .run(question,JSON.stringify(context),now,prior.id);
      await db.prepare('DELETE FROM confirm_guesses WHERE item_id=?').run(prior.id);
    } else await ask(db, { kind:'account_match', subject, question, options:OPTIONS, context, now });
  }
  return pairs;
}

export async function assertCurrentPair(db, item) {
  // A manual merge is the owner's own pairing, so the detector has no say in it.
  if (!item.context?.repair || item.context.manual) return;
  const { candidateId, ownId } = item.context;
  if (!(await detectAccountPairs(db, { includeAnswered:true })).some(p => p.candidateId === candidateId && p.ownId === ownId)) throw new ConfirmError('stale');
}

const keyFor = (table, row, account) => dedupeKey({
  ...(row.parser === 'simplefin' || account.identity?.startsWith('simplefin:') ? { identity:account.identity } : { account }),
  kind: { transactions:'transaction', balances:'balance', positions:'position' }[table],
  date:row.date, amount:row.amount, asOf:row.as_of, symbol:row.symbol, externalId:row.external_id,
  occurrence:row.occurrence ?? 1, extOccurrence:row.extOccurrence ?? 1,
});
const period = async (db, row) => (await db.prepare('SELECT period_to FROM files WHERE id=?').get(row.file_id))?.period_to ?? '';
const newer = async (db, a, b) => await period(db,a) >= await period(db,b);
const matchesRef = (value, id) => value === id || (Array.isArray(value) ? value.some(v => matchesRef(v,id)) : value && typeof value === 'object' && Object.values(value).some(v => matchesRef(v,id)));
const replaceRef = (value, from, to) => value === from ? to : Array.isArray(value) ? [...new Set(value.map(v => replaceRef(v,from,to)))]
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k === from ? to : k,replaceRef(v,from,to)])) : value;

export async function mergeAccounts(db, item, { now = new Date().toISOString() } = {}) {
  await assertCurrentPair(db, item);
  const { candidateId: keepId, ownId } = item.context;
  const keep = await db.prepare('SELECT * FROM accounts WHERE id=?').get(keepId);
  const own = await db.prepare('SELECT * FROM accounts WHERE id=?').get(ownId);
  const movedKeys = new Map();
  const removedKeys = new Set();
  const fileSlots = new Map();
  for (const r of await db.prepare("SELECT * FROM transactions WHERE account_id=? AND coalesce(parser,'')!='simplefin' ORDER BY id").all(keepId)) {
    const slot = `${r.date}|${Math.round(r.amount*100)}`;
    if (!fileSlots.has(slot)) fileSlots.set(slot, []);
    fileSlots.get(slot).push(r);
  }
  const extCounts = new Map();
  const movedTransactions = [];
  for (const row of await db.prepare('SELECT * FROM transactions WHERE account_id=? ORDER BY id').all(ownId)) {
    if (row.external_id) {
      const ext = `${row.file_id}|${row.external_id}|${Math.round(row.amount*100)}`;
      row.extOccurrence = (extCounts.get(ext) ?? 0)+1; extCounts.set(ext,row.extOccurrence);
    }
    let key = keyFor('transactions', row, keep);
    let duplicate = await db.prepare('SELECT * FROM transactions WHERE dedupe_key=?').get(key);
    if (duplicate && row.parser !== 'simplefin' && normalizeName(duplicate.description) !== normalizeName(row.description) && duplicate.parser === row.parser) {
      key += ':d:' + createHash('sha256').update(normalizeName(row.description)).digest('hex').slice(0,16);
      duplicate = await db.prepare('SELECT * FROM transactions WHERE dedupe_key=?').get(key);
    }
    if (!duplicate && row.parser === 'simplefin') duplicate = fileSlots.get(`${row.date}|${Math.round(row.amount*100)}`)?.shift();
    movedKeys.set(row.dedupe_key, duplicate?.dedupe_key ?? key);
    if (duplicate) {
      await archive(db,'transactions',{ ...row,account_id:keepId,dedupe_key:key },{ by:duplicate.file_id,reason:'duplicate_cross_format',survivorKey:duplicate.dedupe_key,now });
      removedKeys.add(row.dedupe_key);
      await moveCategoryRows(db,row.id,duplicate.id);
      await db.prepare('DELETE FROM transactions WHERE id=?').run(row.id);
    } else {
      await db.prepare('UPDATE transactions SET account_id=?,dedupe_key=? WHERE id=?').run(keepId,key,row.id);
      movedTransactions.push(row.id);
    }
  }
  for (const table of ['balances','positions']) for (const row of await db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY id`).all(ownId)) {
    const key = keyFor(table,row,keep);
    const target = table === 'balances' ? await db.prepare('SELECT * FROM balances WHERE account_id=? AND date=?').get(keepId,row.date)
      : await db.prepare('SELECT * FROM positions WHERE account_id=? AND as_of=? AND symbol IS ?').get(keepId,row.as_of,row.symbol);
    movedKeys.set(row.dedupe_key,target?.dedupe_key ?? key);
    if (target) {
      const equal = table === 'balances' ? Math.round(row.amount*100) === Math.round(target.amount*100)
        : ['quantity','price','value','cost_basis'].every(k => row[k] === target[k]);
      if (!equal && await newer(db,row,target)) {
        await archive(db,table,target,{ by:row.file_id,reason:'revised',now });
        const cols = table === 'balances' ? ['amount','file_id','parser','locator'] : ['quantity','price','value','cost_basis','name','file_id','parser','locator'];
        await db.prepare(`UPDATE ${table} SET ${cols.map(c=>`${c}=?`).join(',')},dedupe_key=? WHERE id=?`).run(...cols.map(c=>row[c]),key,target.id);
      } else await archive(db,table,{ ...row,account_id:keepId,dedupe_key:key },{ by:target.file_id,reason:equal?'duplicate_cross_format':'older_snapshot',now });
      await db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    } else await db.prepare(`UPDATE ${table} SET account_id=?,dedupe_key=? WHERE id=?`).run(keepId,key,row.id);
  }
  for (const r of await db.prepare('SELECT * FROM superseded_rows ORDER BY id').all()) {
    const row = parseJson(r.row,null);
    if (row?.account_id === ownId) {
      const key = keyFor(r.table_name,row,keep);
      await db.prepare('UPDATE superseded_rows SET row=?,dedupe_key=?,survivor_key=? WHERE id=?')
        .run(JSON.stringify({ ...row,account_id:keepId,dedupe_key:key }),key,movedKeys.get(r.survivor_key) ?? r.survivor_key,r.id);
    } else if (movedKeys.has(r.survivor_key)) await db.prepare('UPDATE superseded_rows SET survivor_key=? WHERE id=?').run(movedKeys.get(r.survivor_key),r.id);
  }
  for (const [table,col] of [['goals','def'],['recs','def']]) for (const r of await db.prepare(`SELECT id,${col} FROM ${table}`).all()) {
    let value = parseJson(r[col],{});
    if (!matchesRef(value,ownId) && (!own.fig_key || !matchesRef(value,own.fig_key))) continue;
    value = replaceRef(value,ownId,keepId);
    if (own.fig_key) value = replaceRef(value,own.fig_key,keep.fig_key ?? `acct.${keepId}.balance`);
    await db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(JSON.stringify(value),r.id);
  }
  for (const { snapshot } of await mappedSnapshots(db, ownId)) await fillIdentity(db, keepId, parseJson(snapshot, null));
  await db.prepare('UPDATE simplefin_accounts SET account_id=? WHERE account_id=?').run(keepId,ownId);
  await db.prepare('UPDATE simplefin_accounts SET candidate_id=? WHERE candidate_id=?').run(keepId,ownId);
  if (!await db.prepare('SELECT 1 FROM account_holders WHERE account_id=?').get(keepId)) await db.prepare('UPDATE account_holders SET account_id=? WHERE account_id=?').run(keepId,ownId);
  for (const q of await db.prepare("SELECT * FROM confirm_items WHERE status='pending' AND id!=?").all(item.id)) {
    const ctx = parseJson(q.context,{});
    if (q.subject === ownId || matchesRef(ctx,ownId) || (ctx.keys ?? []).some(k => removedKeys.has(k))) await db.prepare('DELETE FROM confirm_items WHERE id=?').run(q.id);
  }
  if (own.mirror === 'connected') await db.prepare("UPDATE accounts SET mirror='connected' WHERE id=?").run(keepId);
  // The survivor's figure key is set inside the logged merge, so undo clears it again.
  const valued = await db.prepare('SELECT 1 FROM balances WHERE account_id=?1 UNION ALL SELECT 1 FROM positions WHERE account_id=?1 LIMIT 1').get(keepId);
  if (!keep.fig_key && (own.fig_key || valued)) await db.prepare('UPDATE accounts SET fig_key=? WHERE id=?').run(`acct.${keepId}.balance`,keepId);
  await db.prepare('UPDATE expected_transactions SET account_id=? WHERE account_id=?').run(keepId, ownId);
  await db.prepare('DELETE FROM accounts WHERE id=?').run(ownId);
  for (const id of movedTransactions) {
    const a = await db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
    const others = await db.prepare(`SELECT * FROM transactions WHERE account_id=? AND id!=? AND round(amount*100)=?
      AND date BETWEEN date(?,'-3 days') AND date(?,'+3 days') AND file_id IS NOT ? ORDER BY id`).all(keepId,a.id,Math.round(a.amount*100),a.date,a.date,a.file_id);
    for (const b of others) {
      const keys=[a.dedupe_key,b.dedupe_key].sort();
      if (await db.prepare("SELECT 1 FROM confirm_items WHERE kind='near_duplicate' AND subject=?").get(keys.join('|'))) continue;
      await ask(db,{kind:'near_duplicate',subject:keys.join('|'),question:'Two imports show the same amount on this account within three days. Are they the same transaction?',
        options:[{id:'same',label:'Same transaction, keep one'},{id:'different',label:'Different, keep both'}],context:{accountId:keepId,keys},now});
    }
  }

}

const mappedSnapshots = async (db, accountId) => await db.prepare(`SELECT m.sf_key, s.snapshot FROM simplefin_accounts m
  JOIN simplefin_snapshots s ON s.sf_key=m.sf_key WHERE m.account_id=? AND m.status='mapped' ORDER BY m.sf_key`).all(accountId);

// Fill a missing institution or last 4 from a SimpleFIN snapshot. A value already set (a person's
// own last 4 included) is never replaced, and a last 4 is taken only when the bridge is sure of it
// or the account name ends in it. Returns whether anything changed.
async function fillIdentity(db, accountId, snap) {
  if (!snap || typeof snap !== 'object') return false;
  const row = await db.prepare('SELECT inst, mask FROM accounts WHERE id=?').get(accountId);
  if (!row) return false;
  const inst = !row.inst && typeof snap.inst === 'string' && snap.inst.trim() ? snap.inst : null;
  const reliable = /^\d{4}$/.test(snap.mask ?? '') && (snap.maskSure === true || lastFour(snap.name) === snap.mask);
  const mask = row.mask == null && reliable ? snap.mask : null;
  if (!inst && !mask) return false;
  await db.prepare('UPDATE accounts SET inst=coalesce(?,inst), mask=coalesce(?,mask) WHERE id=?').run(inst, mask, accountId);
  return true;
}

// Survivors of merges made before the carry-over existed: fill what fillIdentity would have.
// Idempotent. Returns the number of accounts changed.
export async function backfillMergedIdentity(db) {
  const rows = await db.prepare(`SELECT DISTINCT a.id FROM accounts a JOIN simplefin_accounts m ON m.account_id=a.id AND m.status='mapped'
    WHERE coalesce(a.identity,'') NOT LIKE 'simplefin:%' AND (coalesce(a.inst,'')='' OR a.mask IS NULL) ORDER BY a.id`).all();
  let changed = 0;
  for (const { id } of rows) {
    let any = false;
    for (const { snapshot } of await mappedSnapshots(db, id)) if (await fillIdentity(db, id, parseJson(snapshot, null))) any = true;
    if (any) changed += 1;
  }
  return changed;
}

// A merge survivor keeps its imported identity and is mirrored as connected, so only the identity
// says which account is the feed itself.
const isConnected = a => String(a.identity ?? '').startsWith('simplefin:');

// Which of two accounts a manual merge keeps. The connected one is removed so the other takes its
// feed and rows, the way a detected merge does. Two connected accounts are two feeds, and two
// imported accounts would come back with the next import of the removed one; both are refused.
export async function mergePlan(db, openId, otherId) {
  const open = await db.prepare('SELECT * FROM accounts WHERE id=?').get(openId);
  const other = await db.prepare('SELECT * FROM accounts WHERE id=?').get(otherId);
  if (isConnected(open) && isConnected(other)) return { keepId: openId, ownId: otherId, refused: 'Both accounts are connected through SimpleFIN, so they cannot be merged.' };
  // Two imported accounts cannot be merged: the removed one is recreated by the next import of its
  // file, because imports find accounts by their own identity.
  if (!isConnected(open) && !isConnected(other)) return { keepId: openId, ownId: otherId, refused: 'Two imported accounts cannot be merged yet, because the next import of the removed one would bring it back. Merge an imported account with its connected copy.' };
  const [keep, own] = isConnected(open) ? [other, open] : [open, other];
  const count = async (sql) => (await db.prepare(sql).get(own.id)).n;
  const moves = {
    transactions: await count('SELECT count(*) n FROM transactions WHERE account_id=?'),
    balances: await count('SELECT count(*) n FROM balances WHERE account_id=?'),
    positions: await count('SELECT count(*) n FROM positions WHERE account_id=?'),
    sources: await count(`SELECT count(DISTINCT file_id) n FROM (SELECT file_id FROM transactions WHERE account_id=?1
      UNION ALL SELECT file_id FROM balances WHERE account_id=?1 UNION ALL SELECT file_id FROM positions WHERE account_id=?1)`),
  };
  return { keepId: keep.id, ownId: own.id, moves };
}

// Merge two accounts the owner picked, through the same account_match answer and undo log as a
// detected pair: reset or create the item for the pair, then answer it "same". Undo is reopening
// the item. Returns answerItem's {item, factsChanged} and the survivor id.
export async function manualMerge(db, openId, otherId, { now = new Date().toISOString() } = {}) {
  const plan = await mergePlan(db, openId, otherId);
  if (plan.refused) throw new ConfirmError('stale');
  const { keepId, ownId } = plan;
  const subject = subjectOf(keepId, ownId);
  const sfKey = (await db.prepare("SELECT sf_key FROM simplefin_accounts WHERE account_id=? AND status='mapped' ORDER BY sf_key").get(ownId))?.sf_key;
  const context = { candidateId: keepId, ownId, ...(sfKey ? { sfKey } : {}), confidence: 'manual', repair: true, manual: true };
  const naming = await accountNaming(db);
  const question = `Merge ${accountLabel(naming.byId.get(ownId))} into ${accountLabel(naming.byId.get(keepId))}?`;
  const prior = await db.prepare("SELECT * FROM confirm_items WHERE kind='account_match' AND subject=?").get(subject);
  let id;
  if (prior) {
    await db.prepare("UPDATE confirm_items SET status='pending',answer=NULL,answered_at=NULL,question=?,context=?,created_at=? WHERE id=?")
      .run(question, JSON.stringify(context), now, prior.id);
    id = prior.id;
  } else id = (await ask(db, { kind:'account_match', subject, question, options:OPTIONS, context, now })).id;
  try {
    return { ...await answerItem(db, id, 'same', { now }), survivorId: keepId };
  } catch (err) {
    // The answer rolled back; put the item back the way it was so no stray question is left.
    if (prior) await db.prepare('UPDATE confirm_items SET status=?,answer=?,answered_at=?,question=?,context=?,created_at=? WHERE id=?')
      .run(prior.status, prior.answer, prior.answered_at, prior.question, prior.context, prior.created_at, prior.id);
    else await db.prepare('DELETE FROM confirm_items WHERE id=?').run(id);
    throw err;
  }
}

export async function refreshMergedAccounts(db, { now = new Date().toISOString() } = {}) {
  // Only accounts that have a figure: refreshing one without would give it a key the merge undo
  // cannot take back.
  const ids = (await db.prepare('SELECT id FROM accounts WHERE fig_key IS NOT NULL').all()).map(a=>a.id);
  await refreshFigures({db,now,emptySnapshots:new Map()},ids);
  for (const r of await db.prepare("SELECT key FROM figures WHERE key LIKE 'acct.%.balance'").all())
    if (!await db.prepare('SELECT 1 FROM accounts WHERE fig_key=?').get(r.key)) await db.prepare('DELETE FROM figures WHERE key=?').run(r.key);
  const clock = await getSetting(db,'clock',null) ?? now.slice(0,10);
  const series = await buildSeries(db,clock);
  await db.prepare("INSERT INTO content (key,value,src,updated_at) VALUES ('series',?,'balances',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,src=excluded.src,updated_at=excluded.updated_at").run(JSON.stringify(series),now);
  const facts=Object.fromEntries((await db.prepare('SELECT key,value FROM facts').all()).map(r=>[r.key,parseJson(r.value,null)]));
  const data = await loadPlanningData(db,clock);
  const computed = computeFigures(data,facts,{clock,owner:facts,entities:resolveEntities(data,facts)});
  for (const row of await db.prepare("SELECT key FROM figures WHERE key LIKE 'cash.%'").all()) {
    if (!computed.figures[row.key]) await db.prepare('UPDATE figures SET unavailable_reason=? WHERE key=?').run('Account data changed; confirm account types to recompute.',row.key);
  }
  for (const [key,f] of Object.entries(computed.figures).filter(([key])=>key.startsWith('cash.'))) {
    const source = computed.sources[f.src];
    if (source) await db.prepare('INSERT OR IGNORE INTO sources (id,label,as_of,kind) VALUES (?,?,?,?)').run(f.src,source.label,source.asOf ?? clock,source.kind);
    await db.prepare("INSERT INTO figures (key,v,src,kind,label,file_id,parser,locator,updated_at) VALUES (?,?,?,?,?,?, 'planner',?,?) ON CONFLICT(key) DO UPDATE SET v=excluded.v,src=excluded.src,kind=excluded.kind,label=excluded.label,file_id=excluded.file_id,parser=excluded.parser,locator=excluded.locator,updated_at=excluded.updated_at,unavailable_reason=NULL")
      .run(key,f.v,f.src,f.kind,f.label,f.fileId,JSON.stringify(f.locator),now);
  }
}
