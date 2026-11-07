import { createHash } from 'node:crypto';
import { parseJson, getSetting } from '../store/db.mjs';
import { ask, archive, normalizeName, ConfirmError } from './confirm.mjs';
import { accountMask, accountKind, sameInstitution, compatibleInstitution, compatibleKind, lastFour, conflictingBalances } from './account-match.mjs';
import { dedupeKey } from './dedupe.mjs';
import { refreshFigures } from './pipeline.mjs';
import { buildSeries } from '../jobs/planner/series.mjs';
import { loadPlanningData, resolveEntities } from '../jobs/planner/data.mjs';
import { computeFigures } from '../jobs/planner/figures.mjs';

const OPTIONS = [{ id: 'same', label: 'Merge' }, { id: 'different', label: 'Keep both' }];
const subjectOf = (a, b) => `merge:${a}:${b}`;
const differentPairs = db => db.prepare("SELECT context FROM confirm_items WHERE kind='account_match' AND status='answered' AND answer='different'").all().map(r => parseJson(r.context, {}));
const latest = (db, id) => db.prepare('SELECT amount FROM balances WHERE account_id=? ORDER BY date DESC LIMIT 1').get(id)?.amount;

export function detectAccountPairs(db, { includeAnswered = false } = {}) {
  const connected = db.prepare(`SELECT a.*, m.sf_key, s.snapshot FROM simplefin_accounts m JOIN accounts a ON a.id=m.account_id
    LEFT JOIN simplefin_snapshots s ON s.sf_key=m.sf_key WHERE m.status='mapped' AND a.identity='simplefin:' || m.sf_key ORDER BY a.id`).all();
  const imported = db.prepare("SELECT * FROM accounts WHERE coalesce(identity,'') NOT LIKE 'simplefin:%' ORDER BY id").all();
  const different = includeAnswered ? [] : differentPairs(db);
  const pairs = [];
  for (const own of connected) for (const keep of imported) {
    if (!compatibleInstitution(own.inst, keep.inst) || !compatibleKind(own, keep)) continue;
    const a = accountMask(own), b = accountMask(keep);
    if (a && b && a !== b) continue;
    const sameMask = a && a === b;
    const knownInst = sameInstitution(own.inst, keep.inst);
    const named = normalizeName(own.name) && normalizeName(own.name) === normalizeName(keep.name);
    const x = latest(db, own.id), y = latest(db, keep.id);
    const near = x != null && y != null && Math.abs(x-y) <= Math.max(1, Math.abs(x)*0.05);
    if (!sameMask && !(knownInst && (named || near))) continue;
    if (different.some(p => p.candidateId === keep.id && p.ownId === own.id)) continue;
    const snap = parseJson(own.snapshot, {});
    const reliable = (snap.maskSure === true && snap.mask === a) || lastFour(own.name) === a;
    const sure = sameMask && reliable && /^\d{4}$/.test(keep.mask ?? '') && knownInst
      && accountKind(own) && accountKind(keep) && !conflictingBalances(db, own.id, keep.id);
    pairs.push({ candidateId: keep.id, ownId: own.id, sfKey: own.sf_key, confidence: sure ? 'sure' : 'likely' });
  }
  return pairs.map(p => ({ ...p, confidence: p.confidence === 'sure'
    && pairs.filter(x => x.ownId === p.ownId).length === 1 && pairs.filter(x => x.candidateId === p.candidateId).length === 1 ? 'sure' : 'likely' }));
}

export function queueAccountPairs(db, { now } = {}) {
  const pairs = detectAccountPairs(db);
  const exists = db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND subject=?");
  for (const pair of pairs) {
    const subject = subjectOf(pair.candidateId, pair.ownId);
    if (exists.get(subject)) continue;
    const keep = db.prepare('SELECT name FROM accounts WHERE id=?').get(pair.candidateId);
    const own = db.prepare('SELECT name FROM accounts WHERE id=?').get(pair.ownId);
    ask(db, { kind:'account_match', subject, question:`Same account? ${own.name} from SimpleFIN and ${keep.name} from a file.`,
      options:OPTIONS, context:{ ...pair, repair:true }, now });
  }
  return pairs;
}

export function assertCurrentPair(db, item) {
  if (!item.context?.repair) return;
  const { candidateId, ownId } = item.context;
  if (!detectAccountPairs(db, { includeAnswered:true }).some(p => p.candidateId === candidateId && p.ownId === ownId)) throw new ConfirmError('stale');
}

const keyFor = (table, row, identity) => dedupeKey({ identity,
  kind: { transactions:'transaction', balances:'balance', positions:'position' }[table],
  date:row.date, amount:row.amount, asOf:row.as_of, symbol:row.symbol, externalId:row.external_id,
  occurrence:row.occurrence ?? 1, extOccurrence:row.extOccurrence ?? 1,
});
const period = (db, row) => db.prepare('SELECT period_to FROM files WHERE id=?').get(row.file_id)?.period_to ?? '';
const newer = (db, a, b) => period(db,a) >= period(db,b);
const matchesRef = (value, id) => value === id || (Array.isArray(value) ? value.some(v => matchesRef(v,id)) : value && typeof value === 'object' && Object.values(value).some(v => matchesRef(v,id)));
const replaceRef = (value, from, to) => value === from ? to : Array.isArray(value) ? [...new Set(value.map(v => replaceRef(v,from,to)))]
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k === from ? to : k,replaceRef(v,from,to)])) : value;

export function mergeAccounts(db, item, { now = new Date().toISOString() } = {}) {
  assertCurrentPair(db, item);
  const { candidateId: keepId, ownId } = item.context;
  const keep = db.prepare('SELECT * FROM accounts WHERE id=?').get(keepId);
  const own = db.prepare('SELECT * FROM accounts WHERE id=?').get(ownId);
  const identity = keep.identity;
  const movedKeys = new Map();
  const removedKeys = new Set();
  const fileSlots = new Map();
  for (const r of db.prepare("SELECT * FROM transactions WHERE account_id=? AND coalesce(parser,'')!='simplefin' ORDER BY id").all(keepId)) {
    const slot = `${r.date}|${Math.round(r.amount*100)}`;
    if (!fileSlots.has(slot)) fileSlots.set(slot, []);
    fileSlots.get(slot).push(r);
  }
  const extCounts = new Map();
  for (const row of db.prepare('SELECT * FROM transactions WHERE account_id=? ORDER BY id').all(ownId)) {
    if (row.external_id) {
      const ext = `${row.file_id}|${row.external_id}|${Math.round(row.amount*100)}`;
      row.extOccurrence = (extCounts.get(ext) ?? 0)+1; extCounts.set(ext,row.extOccurrence);
    }
    let key = keyFor('transactions', row, identity);
    let duplicate = db.prepare('SELECT * FROM transactions WHERE dedupe_key=?').get(key);
    if (duplicate && row.parser !== 'simplefin' && normalizeName(duplicate.description) !== normalizeName(row.description) && duplicate.parser === row.parser) {
      key += ':d:' + createHash('sha256').update(normalizeName(row.description)).digest('hex').slice(0,16);
      duplicate = db.prepare('SELECT * FROM transactions WHERE dedupe_key=?').get(key);
    }
    if (!duplicate && row.parser === 'simplefin') duplicate = fileSlots.get(`${row.date}|${Math.round(row.amount*100)}`)?.shift();
    movedKeys.set(row.dedupe_key, duplicate?.dedupe_key ?? key);
    if (duplicate) {
      archive(db,'transactions',{ ...row,account_id:keepId,dedupe_key:key },{ by:duplicate.file_id,reason:'duplicate_cross_format',survivorKey:duplicate.dedupe_key,now });
      removedKeys.add(row.dedupe_key);
      db.prepare('DELETE FROM transactions WHERE id=?').run(row.id);
    } else db.prepare('UPDATE transactions SET account_id=?,dedupe_key=? WHERE id=?').run(keepId,key,row.id);
  }
  for (const table of ['balances','positions']) for (const row of db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY id`).all(ownId)) {
    const key = keyFor(table,row,identity);
    const target = table === 'balances' ? db.prepare('SELECT * FROM balances WHERE account_id=? AND date=?').get(keepId,row.date)
      : db.prepare('SELECT * FROM positions WHERE account_id=? AND as_of=? AND symbol IS ?').get(keepId,row.as_of,row.symbol);
    movedKeys.set(row.dedupe_key,target?.dedupe_key ?? key);
    if (target) {
      const equal = table === 'balances' ? Math.round(row.amount*100) === Math.round(target.amount*100)
        : ['quantity','price','value','cost_basis'].every(k => row[k] === target[k]);
      if (!equal && newer(db,row,target)) {
        archive(db,table,target,{ by:row.file_id,reason:'revised',now });
        const cols = table === 'balances' ? ['amount','file_id','parser','locator'] : ['quantity','price','value','cost_basis','name','file_id','parser','locator'];
        db.prepare(`UPDATE ${table} SET ${cols.map(c=>`${c}=?`).join(',')},dedupe_key=? WHERE id=?`).run(...cols.map(c=>row[c]),key,target.id);
      } else archive(db,table,{ ...row,account_id:keepId,dedupe_key:key },{ by:target.file_id,reason:equal?'duplicate_cross_format':'older_snapshot',now });
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    } else db.prepare(`UPDATE ${table} SET account_id=?,dedupe_key=? WHERE id=?`).run(keepId,key,row.id);
  }
  for (const r of db.prepare('SELECT * FROM superseded_rows ORDER BY id').all()) {
    const row = parseJson(r.row,null);
    if (row?.account_id === ownId) {
      const key = keyFor(r.table_name,row,identity);
      db.prepare('UPDATE superseded_rows SET row=?,dedupe_key=?,survivor_key=? WHERE id=?')
        .run(JSON.stringify({ ...row,account_id:keepId,dedupe_key:key }),key,movedKeys.get(r.survivor_key) ?? r.survivor_key,r.id);
    } else if (movedKeys.has(r.survivor_key)) db.prepare('UPDATE superseded_rows SET survivor_key=? WHERE id=?').run(movedKeys.get(r.survivor_key),r.id);
  }
  for (const [table,col] of [['goals','def'],['recs','def']]) for (const r of db.prepare(`SELECT id,${col} FROM ${table}`).all()) {
    let value = parseJson(r[col],{});
    if (!matchesRef(value,ownId) && !matchesRef(value,own.fig_key)) continue;
    value = replaceRef(value,ownId,keepId);
    if (own.fig_key) value = replaceRef(value,own.fig_key,keep.fig_key ?? `acct.${keepId}.balance`);
    db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(JSON.stringify(value),r.id);
  }
  db.prepare('UPDATE simplefin_accounts SET account_id=? WHERE account_id=?').run(keepId,ownId);
  db.prepare('UPDATE simplefin_accounts SET candidate_id=? WHERE candidate_id=?').run(keepId,ownId);
  if (!db.prepare('SELECT 1 FROM account_holders WHERE account_id=?').get(keepId)) db.prepare('UPDATE account_holders SET account_id=? WHERE account_id=?').run(keepId,ownId);
  for (const q of db.prepare("SELECT * FROM confirm_items WHERE status='pending' AND id!=?").all(item.id)) {
    const ctx = parseJson(q.context,{});
    if (q.subject === ownId || matchesRef(ctx,ownId) || (ctx.keys ?? []).some(k => removedKeys.has(k))) db.prepare('DELETE FROM confirm_items WHERE id=?').run(q.id);
  }
  db.prepare("UPDATE accounts SET mirror='connected' WHERE id=?").run(keepId);
  db.prepare('DELETE FROM accounts WHERE id=?').run(ownId);
  const txs = db.prepare('SELECT * FROM transactions WHERE account_id=? ORDER BY id').all(keepId);
  for (let i=0;i<txs.length;i++) for (let j=i+1;j<txs.length;j++) {
    const a=txs[i],b=txs[j];
    if (a.file_id === b.file_id || Math.round(a.amount*100)!==Math.round(b.amount*100) || Math.abs(Date.parse(a.date)-Date.parse(b.date))>3*86400000) continue;
    const keys=[a.dedupe_key,b.dedupe_key].sort();
    ask(db,{kind:'near_duplicate',subject:keys.join('|'),question:'Two imports show the same amount on this account within three days. Are they the same transaction?',
      options:[{id:'same',label:'Same transaction, keep one'},{id:'different',label:'Different, keep both'}],context:{accountId:keepId,keys},now});
  }
}

export function refreshMergedAccounts(db, { now = new Date().toISOString() } = {}) {
  const ids = db.prepare('SELECT id FROM accounts').all().map(a=>a.id);
  refreshFigures({db,now,emptySnapshots:new Map()},ids);
  for (const r of db.prepare("SELECT key FROM figures WHERE key LIKE 'acct.%.balance'").all())
    if (!db.prepare('SELECT 1 FROM accounts WHERE fig_key=?').get(r.key)) db.prepare('DELETE FROM figures WHERE key=?').run(r.key);
  const clock = getSetting(db,'clock',null) ?? now.slice(0,10);
  const series = buildSeries(db,clock);
  db.prepare("INSERT INTO content (key,value,src,updated_at) VALUES ('series',?,'balances',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,src=excluded.src,updated_at=excluded.updated_at").run(JSON.stringify(series),now);
  const facts=Object.fromEntries(db.prepare('SELECT key,value FROM facts').all().map(r=>[r.key,parseJson(r.value,null)]));
  const data = loadPlanningData(db,clock);
  const computed = computeFigures(data,facts,{clock,owner:facts,entities:resolveEntities(data,facts)});
  for (const [key,f] of Object.entries(computed.figures).filter(([key])=>key.startsWith('cash.'))) {
    const source = computed.sources[f.src];
    if (source) db.prepare('INSERT OR IGNORE INTO sources (id,label,as_of,kind) VALUES (?,?,?,?)').run(f.src,source.label,source.asOf ?? clock,source.kind);
    db.prepare("INSERT INTO figures (key,v,src,kind,label,file_id,parser,locator,updated_at) VALUES (?,?,?,?,?,?, 'planner',?,?) ON CONFLICT(key) DO UPDATE SET v=excluded.v,src=excluded.src,kind=excluded.kind,label=excluded.label,file_id=excluded.file_id,parser=excluded.parser,locator=excluded.locator,updated_at=excluded.updated_at")
      .run(key,f.v,f.src,f.kind,f.label,f.fileId,JSON.stringify(f.locator),now);
  }
}
