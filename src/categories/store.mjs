import { JEV_MODEL } from './jev.mjs';
import { confidenceBand, jevEvidence } from './policy.mjs';
import { spendingInputs } from '../calc/targets.mjs';
import { getSetting, parseJson } from '../store/db.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { ask, ConfirmError } from '../ingest/confirm.mjs';
import { resolveCategories, BUCKETS, DEFAULT_CATEGORY, importedCategory, knownCategory, normalizeMerchant, sourceBucket, spendingAccount } from './resolve.mjs';

export const CATEGORY_THRESHOLD = 100;
export const CATEGORY_LIMIT = 10;
const labels = { household:'Household spending',business:'Business',income:'Income',transfer:'Transfer',tax:'Tax',saving:'Saving or investing',excluded:'Excluded' };
const nowOf = now => now ?? new Date().toISOString();
export const isJevProposal = g => (g?.model===JEV_MODEL || g?.modelPort===true) && typeof g.category==='string'
  && Number.isFinite(g.confidence) && g.confidence>=0 && g.confidence<=1;
export function loadCategoryInputs(db) {
  const named = parseJson(db.prepare("SELECT value FROM facts WHERE key='accounts.businessEntity' AND (src IS NULL OR src!='planner')").get()?.value,{});
  const naming=accountNaming(db);
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort,id').all().map(a=>({...a,...naming.hint(a.id),business:typeof named?.[a.id]==='string' && !!named[a.id].trim()}));
  const transactions = db.prepare(`SELECT t.*, i.category AS imported_category, i.parser AS category_parser,
    i.file_id AS category_file_id, i.locator AS category_locator, coalesce(i.updated_at,f.uploaded_at,t.date) AS category_at,
    EXISTS (SELECT 1 FROM confirm_items q JOIN confirm_auto_declined d ON d.item_id=q.id
      WHERE q.kind='transaction_category' AND q.subject=cast(t.id AS TEXT)) AS category_declined
    FROM transactions t LEFT JOIN transaction_category_imports i ON i.transaction_id=t.id
    LEFT JOIN files f ON f.id=t.file_id ORDER BY t.date,t.id`).all();
  return { accounts,transactions,
    corrections:db.prepare(`SELECT c.*, a.evidence AS auto_evidence FROM transaction_category_corrections c
      LEFT JOIN confirm_items i ON i.kind='transaction_category' AND i.subject=cast(c.transaction_id AS TEXT)
      LEFT JOIN confirm_auto a ON a.item_id=i.id`).all().map(r=>({...r,auto:parseJson(r.auto_evidence,null)})),
    merchantRules:db.prepare('SELECT * FROM category_merchant_rules').all(), sourceRules:db.prepare(`SELECT r.*, a.evidence AS auto_evidence FROM category_source_rules r
      LEFT JOIN confirm_items i ON i.kind='category_mapping' AND i.subject=json_array(r.parser,r.category)
      LEFT JOIN confirm_auto a ON a.item_id=i.id`).all().map(r=>({...r,auto:parseJson(r.auto_evidence,null)})),
    guesses:db.prepare('SELECT * FROM transaction_category_guesses').all().map(r=>{
      const p=parseJson(r.category,null);
      return {...r,category:p?.category??null,confidence:p?.confidence,probabilities:p?.probabilities,modelPort:p?.modelPort};
    }) };
}
function checks(db,{clock = getSetting(db,'clock',new Date().toISOString().slice(0,10)),threshold = CATEGORY_THRESHOLD,policy,accountIds}={}) {
  const input=loadCategoryInputs(db);
  input.transactions=input.transactions.filter(t=>t.date<=clock);
  const {windowTransactionIds}=spendingInputs({...input,clock});
  const resolutions=resolveCategories({...input,transferSourceIds:windowTransactionIds}), accounts=new Map(input.accounts.map(a=>[a.id,a]));
  const figureRows=new Set(windowTransactionIds);
  const answered=new Set(db.prepare("SELECT subject FROM confirm_items WHERE kind='transaction_category' AND status='answered'").all().map(i=>i.subject));
  const mapped=new Set(input.sourceRules.map(r=>JSON.stringify([r.parser,r.category])));
  const unknown=new Map(), list=[], guesses=new Map(input.guesses.map(g=>[g.transaction_id,g]));
  for(const t of input.transactions) {
    const c=resolutions.get(t.id), imported=importedCategory(t), key=JSON.stringify([imported.parser,imported.category]);
    if(imported.category && !knownCategory(imported.parser,imported.category) && !mapped.has(key)) {
      const prior=unknown.get(key);
      if(prior) { prior.count++; if(Math.abs(t.amount)>Math.abs(prior.amount)) prior.amount=t.amount; }
      else unknown.set(key,{kind:'category_mapping',subject:key,parser:imported.parser,category:imported.category,count:1,amount:t.amount});
      continue;
    }
    if(answered.has(String(t.id))) continue;
    const stored=guesses.get(t.id);
    const proposal=isJevProposal(stored) && confidenceBand(stored.confidence,policy)!=='uncategorized' ? stored : null;
    if(!proposal && (!figureRows.has(t.id) || !spendingAccount(accounts.get(t.account_id)) || !['guess','uncategorized'].includes(c.layer) || Math.abs(t.amount)<threshold || t.amount===0)) continue;
    if(proposal && !['guess','uncategorized'].includes(c.layer)) continue;
    const guess=proposal?.category ?? DEFAULT_CATEGORY[c.bucket];
    list.push({kind:'transaction_category',subject:String(t.id),transactionId:t.id,amount:t.amount,date:t.date,
      description:t.description,account:accountLabel(accounts.get(t.account_id)),category:c.category,bucket:c.bucket,layer:c.layer,
      merchant:normalizeMerchant(t.description),guess,...(proposal ? {jev:{category:proposal.category,confidence:proposal.confidence,probabilities:proposal.probabilities}} : {})});
  }
  const order=(a,b)=>Math.abs(b.amount)-Math.abs(a.amount) || a.subject.localeCompare(b.subject);
  const selected = accountIds === undefined ? input.transactions : input.transactions.filter(t => accountIds.includes(t.account_id));
  const selectedIds = new Set(selected.map(t => t.id));
  const selectedMappings = new Set(selected.map(t => { const c = importedCategory(t); return JSON.stringify([c.parser,c.category]); }));
  const ranked=[...list,...unknown.values()].filter(c => accountIds === undefined || selectedIds.has(c.transactionId) || (c.kind === 'category_mapping' && selectedMappings.has(c.subject))).sort(order);
  return [...ranked.filter(c=>c.jev),...ranked.filter(c=>!c.jev).slice(0,CATEGORY_LIMIT)].sort(order);
}
export function categoryNames(input) {
  return [...new Set([...input.transactions.flatMap(t=>{
    const c=importedCategory(t); return sourceBucket(c.parser,c.category) ? [c.category] : [];
  }),...input.corrections.map(r=>r.category),...input.sourceRules.map(r=>r.category),...input.merchantRules.map(r=>r.category)])].sort();
}
export function categoryOptions(input) {
  const standing=Object.values(DEFAULT_CATEGORY), extra=new Set([...categoryNames(input),...input.guesses.filter(isJevProposal).map(g=>g.category)]);
  const names=[...standing,...[...extra].filter(c=>!standing.includes(c)).sort()];
  return names.flatMap(category=>[{id:category,label:category},{id:'always:'+category,label:category}]);
}
export function queueCategoryChecks(db,options={}) {
  const candidates=checks(db,options), active=new Set(candidates.map(c=>JSON.stringify([c.kind,c.subject])));
  for(const r of db.prepare("SELECT i.id,i.kind,i.subject FROM confirm_items i WHERE i.status='pending' AND i.kind IN ('transaction_category','category_mapping') AND NOT EXISTS (SELECT 1 FROM confirm_auto_declined d WHERE d.item_id=i.id)").all()) {
    if(!active.has(JSON.stringify([r.kind,r.subject]))) db.prepare('DELETE FROM confirm_items WHERE id=?').run(r.id);
  }
  const now=nowOf(options.now);
  const choices=categoryOptions(loadCategoryInputs(db)), serializedChoices=JSON.stringify(choices);
  db.prepare("UPDATE confirm_items SET options=? WHERE kind='transaction_category' AND status='pending' AND options!=?")
    .run(serializedChoices,serializedChoices);
  for(const c of candidates) {
    const question=c.kind==='category_mapping' ? `Treat ${c.category} as ...` : 'Check this transaction category';
    const opts=c.kind==='category_mapping' ? BUCKETS.map(id=>({id,label:labels[id]})) : choices;
    const prior=db.prepare('SELECT id,status FROM confirm_items WHERE kind=? AND subject=?').get(c.kind,c.subject);
    if(prior?.status==='answered') continue;
    if(prior) db.prepare('UPDATE confirm_items SET context=?,options=? WHERE id=? AND (context!=? OR options!=?)')
      .run(JSON.stringify(c),JSON.stringify(opts),prior.id,JSON.stringify(c),JSON.stringify(opts));
    else ask(db,{kind:c.kind,subject:c.subject,question,options:opts,context:c,now});
  }
  return candidates;
}
export function applyCategoryAnswer(db,item,optionId,{now}={}) {
  const at=nowOf(now), c=item.context;
  if(item.kind==='category_mapping') {
    if(!BUCKETS.includes(optionId)) throw new ConfirmError('bad_option');
    db.prepare(`INSERT INTO category_source_rules (parser,category,bucket,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(parser,category) DO UPDATE SET bucket=excluded.bucket,updated_at=excluded.updated_at`).run(c.parser,c.category,optionId,at);
    return {};
  }
  const always=optionId.startsWith('always:'), category=always ? optionId.slice(7) : optionId;
  const mapped=[...new Set(db.prepare('SELECT bucket FROM category_source_rules WHERE category=?').all(category).map(r=>r.bucket))];
  const bucket=sourceBucket('aggregator',category) ?? (mapped.length===1?mapped[0]:null);
  if(!bucket) throw new ConfirmError('bad_option');
  const t=db.prepare('SELECT * FROM transactions WHERE id=?').get(c.transactionId);
  if(!t) throw new ConfirmError('stale');
  db.prepare(`INSERT INTO transaction_category_corrections VALUES (?,?,?,?) ON CONFLICT(transaction_id)
    DO UPDATE SET category=excluded.category,bucket=excluded.bucket,updated_at=excluded.updated_at`).run(t.id,category,bucket,at);
  const merchant=normalizeMerchant(t.description);
  if(always && merchant) db.prepare(`INSERT INTO category_merchant_rules VALUES (?,?,?,?) ON CONFLICT(merchant)
    DO UPDATE SET category=excluded.category,bucket=excluded.bucket,updated_at=excluded.updated_at`).run(merchant,category,bucket,at);
  return {};
}
export function categoryDetail(db,item) {
  const c=item.context;
  if(item.kind==='category_mapping') return {type:'values',values:[{label:'Source',value:c.parser==='demo-seed' ? 'Demo ledger' : 'Budgeting export'},{label:'Category',value:c.category},{label:'Transactions',value:c.count}]};
  const t=db.prepare('SELECT * FROM transactions WHERE id=?').get(c.transactionId);
  const a=t && db.prepare('SELECT * FROM accounts WHERE id=?').get(t.account_id);
  return {type:'values',values:[{label:'Account',value:a ? accountNaming(db).label(a) : c.account},{label:'Date',value:t?.date ?? c.date},
    {label:'Transaction',value:t?.description ?? c.description},{label:'Amount',value:t?.amount ?? c.amount},
    {label:'Category',value:c.category},{label:'Best guess',value:c.guess}]};
}
export function categoryGuess(item) {
  if(item.kind!=='transaction_category' || item.status==='answered') return null;
  const id=item.context.guess, option=item.options.find(o=>o.id===id && !o.id.startsWith('always:'));
  if(option && item.context.jev) return {option:option.id,label:option.label,source:'engine',confidence:item.context.jev.confidence,evidence:jevEvidence(item.context.jev.confidence)};
  return option ? {option:option.id,label:option.label,source:'rule',evidence:item.context.layer==='guess'
    ? 'Stored model suggestion; this category is a guess.' : 'Uncategorized transaction; this is a provisional spending category.'} : null;
}

// Explicit moves happen before the parent delete, so generic undo restores the parent first.
export function moveCategoryRows(db,dropId,keepId) {
  for(const table of ['transaction_category_corrections','transaction_category_imports','transaction_category_guesses']) {
    const drop=db.prepare(`SELECT * FROM ${table} WHERE transaction_id=?`).get(dropId);
    if(!drop) continue;
    if(table==='transaction_category_corrections' && db.prepare(`SELECT 1 FROM confirm_items i JOIN confirm_auto a ON a.item_id=i.id
      WHERE i.kind='transaction_category' AND i.subject=?`).get(String(dropId))) {
      db.prepare('DELETE FROM transaction_category_corrections WHERE transaction_id=?').run(dropId);
      continue;
    }
    const keep=db.prepare(`SELECT * FROM ${table} WHERE transaction_id=?`).get(keepId);
    if(keep && keep.updated_at<=drop.updated_at) db.prepare(`DELETE FROM ${table} WHERE transaction_id=?`).run(keepId);
    if(!keep || keep.updated_at<=drop.updated_at) {
      db.prepare(`DELETE FROM ${table} WHERE transaction_id=?`).run(dropId);
      const moved={...drop,transaction_id:keepId}, columns=Object.keys(moved);
      db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>moved[k]));
    }
    else db.prepare(`DELETE FROM ${table} WHERE transaction_id=?`).run(dropId);
  }
  const drop=db.prepare('SELECT * FROM transactions WHERE id=?').get(dropId), keep=db.prepare('SELECT * FROM transactions WHERE id=?').get(keepId);
  if(drop?.category && !keep?.category && !db.prepare('SELECT 1 FROM transaction_category_imports WHERE transaction_id=?').get(keepId)) {
    db.prepare('INSERT INTO transaction_category_imports VALUES (?,?,?,?,?,?,?,?,?)').run(keepId,drop.dedupe_key ?? `transaction:${dropId}`,drop.category,drop.parser ?? '',drop.file_id,drop.locator,drop.date,drop.description,drop.date);
  }
}
export function categoryCoverage(db,options={}) {
  const input=loadCategoryInputs(db), resolved=resolveCategories(input);
  const layers=Object.fromEntries(['correction','import','structural','merchant','guess','uncategorized'].map(k=>[k,0]));
  const buckets=Object.fromEntries(BUCKETS.map(k=>[k,0]));
  const ids = new Set(input.transactions.filter(t => options.accountIds === undefined || options.accountIds.includes(t.account_id)).map(t => t.id));
  for(const [id,c] of resolved) { if (!ids.has(id)) continue; layers[c.layer]++; buckets[c.bucket]++; }
  return {rows:ids.size,layers,buckets,uncategorized:layers.uncategorized,queueSize:checks(db,options).length};
}
