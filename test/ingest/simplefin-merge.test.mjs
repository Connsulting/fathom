import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW, aggregatorFile } from '../helpers/ingest.mjs';
import { seedDuplicate, positionsFile } from '../helpers/account-merge.mjs';
import * as S from '../../src/ingest/simplefin.mjs';
import * as P from '../../src/ingest/pipeline.mjs';
import * as C from '../../src/ingest/confirm.mjs';
import * as M from '../../src/ingest/account-merge.mjs';
import { autoResolve } from '../../src/ingest/auto.mjs';
import { buildSeries } from '../../src/jobs/planner/series.mjs';
import { planRun } from '../helpers/plan.mjs';

const withStore = async fn => { const s = await realStore(); try { await fn(s); } finally { s.close(); } };
const acct = { inst: 'Example Brokerage', name: 'Individual Brokerage x6294', mask: '6294', maskSure: true, balance: 1200, balanceDate: '2032-02-29' };
const pending = db => C.pendingItems(db).filter(i => i.context.repair);

test('parser-shaped unknown institutions ask on the same last four; sure, uncertain and new stay distinct', () => withStore(async s => {
  await P.ingestFile(s.db, positionsFile(), s.opts(null));
  const id = s.db.prepare('SELECT id FROM accounts').get().id;
  assert.deepEqual(S.matchAccount(s.db, acct), { candidate: id });
  assert.deepEqual(S.matchAccount(s.db, { ...acct, maskSure: false }), { candidate: id });
  assert.deepEqual(S.matchAccount(s.db, { ...acct, mask: '7777' }), {});
  s.db.prepare("UPDATE accounts SET inst='Example Brokerage', kind='taxable'").run();
  assert.deepEqual(S.matchAccount(s.db, acct), { sure: id });
  assert.deepEqual(S.matchAccount(s.db, { ...acct, maskSure: false }), { candidate: id });
  assert.deepEqual(S.matchAccount(s.db, { ...acct, name: 'Roth IRA x6294' }), {});
}));

test('fresh sync asks for the positions account and autoResolve leaves it pending', () => withStore(async s => {
  await P.ingestFile(s.db, positionsFile(), s.opts(null));
  const options = { config: s.config, key: s.key, now: NOW, clock: '2032-03-10' };
  await S.connectSimplefin(s.db, S.fakeToken(), { ...options, fetch: S.createFakeSimplefin() });
  const fetch = async () => new Response(JSON.stringify({ accounts: [{ id: 'opaque', name: acct.name, org: { name: acct.inst }, currency: 'USD', balance: '1200', 'balance-date': 1961668800, transactions: [] }] }));
  await S.syncSimplefin(s.db, { ...options, fetch });
  autoResolve(s.db, { now: NOW });
  assert.equal(C.pendingItems(s.db).filter(i => i.kind === 'account_match').length, 1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n, 1);
}));

test('repair is idempotent and Keep both survives repeated reads and remains undoable', () => withStore(async s => {
  await seedDuplicate(s);
  assert.equal(M.detectAccountPairs(s.db).length, 1);
  M.queueAccountPairs(s.db, { now: NOW }); M.queueAccountPairs(s.db, { now: NOW });
  assert.equal(pending(s.db).length, 1);
  const q = pending(s.db)[0];
  C.answer(s.db, q.id, 'different', { now: NOW });
  M.queueAccountPairs(s.db); M.queueAccountPairs(s.db);
  assert.equal(pending(s.db).length, 0);
  assert.equal(C.finalReason(s.db, C.getItem(s.db, q.id)), null);
  C.reopenItem(s.db, q.id, { now: NOW });
  assert.equal(pending(s.db).length, 1);
}));

test('merge keeps stable references, history and metadata, corrects net worth, and Undo restores after planning', () => withStore(async s => {
  const pair = await seedDuplicate(s, { sure: true });
  s.db.prepare("INSERT INTO goals (id,def,origin) VALUES ('synthetic-goal',?,'owner')").run(JSON.stringify({ title: 'Reserve', track: { accounts: [pair.keep] } }));
  const beforeAccounts = s.db.prepare('SELECT * FROM accounts ORDER BY id').all();
  const beforeTx = s.db.prepare('SELECT * FROM transactions ORDER BY id').all();
  const beforeBal = s.db.prepare('SELECT * FROM balances ORDER BY id').all();
  assert.equal(buildSeries(s.db, '2032-03-10').net.points.at(-1).v, 2400);
  M.queueAccountPairs(s.db, { now: NOW });
  const q = pending(s.db)[0]; C.answer(s.db, q.id, 'same', { now: NOW });
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n, 1);
  const keep = s.db.prepare('SELECT * FROM accounts').get();
  assert.equal(keep.id, pair.keep); assert.equal(keep.owner, 'You'); assert.equal(keep.kind, 'cash');
  assert.equal(JSON.parse(s.db.prepare("SELECT def FROM goals WHERE id='synthetic-goal'").get().def).track.accounts[0], pair.keep);
  assert.equal(s.db.prepare('SELECT account_id FROM simplefin_accounts').get().account_id, pair.keep);
  assert.equal(s.db.prepare('SELECT count(*) n FROM transactions').get().n, 1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM balances').get().n, 2);
  assert.equal(buildSeries(s.db, '2032-03-10').net.points.at(-1).v, 1200);
  assert.equal(JSON.parse(s.db.prepare("SELECT value FROM content WHERE key='series'").get().value).net.points.at(-1).v, 1200);
  assert.equal(C.pendingItems(s.db).filter(i => i.subject === pair.own).length, 0);
  await planRun(s.db, { now: '2032-03-10', dataDir: s.dataDir });
  C.reopenItem(s.db, q.id, { now: NOW });
  assert.equal(buildSeries(s.db, '2032-03-10').net.points.at(-1).v, 2400);
  const restored = s.db.prepare('SELECT * FROM accounts ORDER BY id').all();
  assert.deepEqual(restored.map(a => [a.id,a.name,a.owner,a.kind,a.mirror]), beforeAccounts.map(a => [a.id,a.name,a.owner,a.kind,a.mirror]));
  assert.deepEqual(s.db.prepare('SELECT * FROM transactions ORDER BY id').all(), beforeTx);
  assert.deepEqual(s.db.prepare('SELECT * FROM balances ORDER BY id').all(), beforeBal);
}));

test('sure repair excludes unknown institution, unreliable mask, conflicts and ambiguous candidates', () => withStore(async s => {
  const p = await seedDuplicate(s, { sure: true });
  assert.equal(M.detectAccountPairs(s.db)[0].confidence, 'sure');
  s.db.prepare('UPDATE simplefin_snapshots SET snapshot = json_set(snapshot,\'$.maskSure\',json(\'false\'),\'$.name\',\'Opaque account\')').run();
  s.db.prepare("UPDATE accounts SET name='Opaque account' WHERE id=?").run(p.own);
  assert.equal(M.detectAccountPairs(s.db)[0].confidence, 'likely');
  s.db.prepare("UPDATE accounts SET inst=NULL WHERE id=?").run(p.keep);
  assert.equal(M.detectAccountPairs(s.db)[0].confidence, 'likely');
  s.db.prepare("UPDATE accounts SET inst='Example Bank',kind='card' WHERE id=?").run(p.keep);
  assert.equal(M.detectAccountPairs(s.db).length, 0);
}));

test('merge reimports positions into the surviving account and keeps distinct historical postings', () => withStore(async s => {
  const p = await seedDuplicate(s);
  M.queueAccountPairs(s.db, { now: NOW });
  C.answer(s.db, pending(s.db)[0].id, 'same', { now: NOW });
  await P.ingestFile(s.db, positionsFile(), s.opts(null));
  await P.ingestFile(s.db, { ...positionsFile(), name: 'positions-2032-02-29-copy.csv', bytes: Buffer.from(Buffer.from(positionsFile().bytes).toString()+'\n') }, s.opts(null));
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n, 1);
  assert.equal(s.db.prepare('SELECT account_id FROM positions').get().account_id, p.keep);
}));

test('repair HTTP answers do not sync; repeated scenario reads leave Keep both and Merge undoable', () => withStore(async s => {
  const {serveAppFixture}=await import('../helpers/server.mjs');
  const p=await seedDuplicate(s,{sure:true});
  const jobs=[];
  const app=await serveAppFixture({db:s.db,config:s.config,authenticated:true,scheduler:{trigger:(id)=>{jobs.push(id);},soon:()=>true}});
  try {
    const first=await app.request({path:'/api/confirm'});
    const q=first.json.items.find(i=>i.context.repair);
    assert.ok(q);
    const keep=await app.postJson(`/api/confirm/${q.id}/answer`,{answer:'different'});
    assert.equal(keep.status,200); assert.equal(keep.json.item.final,null);
    await app.getScenario(); await app.getScenario();
    assert.equal((await app.postJson(`/api/confirm/${q.id}/reopen`)).status,200);
    const merge=await app.postJson(`/api/confirm/${q.id}/answer`,{answer:'same'});
    assert.equal(merge.status,200); assert.equal(merge.json.item.final,null);
    assert.equal(jobs.includes('simplefin-sync'),false);
    assert.equal(merge.json.scenario.series.net.points.at(-1).v,1200);
    const undo=await app.postJson(`/api/confirm/${q.id}/reopen`);
    assert.equal(undo.status,200); assert.equal(undo.json.scenario.series.net.points.at(-1).v,2400);
    assert.ok(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(p.own));
  } finally {await app.close();}
}));

test('reverse-order resync remembers removed external ids and keeps history', () => withStore(async s => {
  const opts={config:s.config,key:s.key,now:NOW,clock:'2032-03-10'};
  const bridge={id:'opaque',conn_id:'synthetic',name:'Synthetic checking x6294',balance:'1200','balance-date':Date.parse('2032-02-29T12:00:00Z')/1000,currency:'USD',transactions:[
    {id:'bridge-posting',posted:Date.parse('2032-02-29T12:00:00Z')/1000,amount:'-10',description:'Bridge posting'},
    {id:'bridge-posting-2',posted:Date.parse('2032-02-29T12:00:00Z')/1000,amount:'-10',description:'Other posting'},
    {id:'old-bridge',posted:Date.parse('2032-01-15T12:00:00Z')/1000,amount:'-7',description:'Historical posting'},
  ]};
  const body={connections:[{conn_id:'synthetic',name:'Example Bank'}],accounts:[bridge]};
  const key=S.normalizeAccountSet(body).accounts[0].key;
  const p=await seedDuplicate(s,{sure:true,sfKey:key});
  await S.connectSimplefin(s.db,S.fakeToken(),{...opts,fetch:S.createFakeSimplefin()});
  await S.syncSimplefin(s.db,{...opts,fetch:async()=>new Response(JSON.stringify(body))});
  const q=pending(s.db)[0]; assert.ok(q);
  C.answer(s.db,q.id,'same',{now:NOW});
  assert.equal(s.db.prepare('SELECT count(*) n FROM transactions').get().n,3);
  bridge.transactions.reverse();
  await S.syncSimplefin(s.db,{...opts,fetch:async()=>new Response(JSON.stringify(body))});
  assert.equal(s.db.prepare('SELECT count(*) n FROM transactions').get().n,3);
  assert.equal(s.db.prepare('SELECT account_id FROM transactions WHERE description=?').get('Historical posting').account_id,p.keep);
}));

test('connect, sync and later positions upload expose repair through the real HTTP boundary', () => withStore(async s => {
  const {serveAppFixture}=await import('../helpers/server.mjs');
  const {offEngine}=await import('../helpers/ingest.mjs');
  const opts={config:s.config,key:s.key,now:NOW,clock:'2032-03-10'};
  await S.connectSimplefin(s.db,S.fakeToken(),{...opts,fetch:S.createFakeSimplefin()});
  const body={accounts:[{id:'synthetic-brokerage',name:acct.name,org:{name:acct.inst},balance:'1200','balance-date':Date.parse('2032-02-29T12:00:00Z')/1000,currency:'USD',transactions:[]}]};
  await S.syncSimplefin(s.db,{...opts,fetch:async()=>new Response(JSON.stringify(body))});
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
  const app=await serveAppFixture({db:s.db,config:s.config,authenticated:true,engine:await offEngine()});
  try {
    const f=positionsFile(),form=new FormData();form.append('files',new Blob([f.bytes],{type:'text/csv'}),f.name);
    const res=await fetch(`${app.baseUrl}/api/files`,{method:'POST',headers:app.headers,body:form});
    assert.equal(res.status,200);
    const list=await app.request({path:'/api/confirm'});
    assert.equal(list.json.items.filter(i=>i.kind==='account_match'&&i.context.repair).length,1);
    const scenario=await app.getScenario();
    assert.equal(scenario.accounts.length,2);
    assert.equal(scenario.live.ingest.items.filter(i=>i.context.repair).length,1);
  } finally {await app.close();}
}));

test('a file routed into the redundant bridge account reimports without resurrecting rows after merge', () => withStore(async s => {
  await seedDuplicate(s,{sure:true});
  const f=aggregatorFile('alias.csv',[{date:'2032-02-12',amount:'17',inst:'Example Bank N.A.',account:'Synthetic checking',number:'0006294',description:'Distinct file posting'}]);
  await P.ingestFile(s.db,f,s.opts(null));
  M.queueAccountPairs(s.db,{now:NOW});
  C.answer(s.db,pending(s.db)[0].id,'same',{now:NOW});
  const before=s.db.prepare('SELECT count(*) n FROM transactions').get().n;
  await P.ingestFile(s.db,{...f,bytes:Buffer.from(Buffer.from(f.bytes).toString()+'\n')},s.opts(null));
  assert.equal(s.db.prepare('SELECT count(*) n FROM transactions').get().n,before);
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
}));

test('balance contradictions, name-only masks and multiple candidates remain owner questions', () => withStore(async s => {
  const p=await seedDuplicate(s,{sure:true,conflict:true});
  assert.equal(M.detectAccountPairs(s.db)[0].confidence,'likely');
  s.db.prepare('UPDATE balances SET amount=1200 WHERE account_id=? AND date=?').run(p.own,'2032-02-29');
  s.db.prepare('UPDATE accounts SET mask=NULL,name=? WHERE id=?').run('Synthetic checking x6294',p.keep);
  assert.equal(M.detectAccountPairs(s.db)[0].confidence,'likely');
  s.db.prepare("UPDATE accounts SET mask='6294' WHERE id=?").run(p.keep);
  s.db.prepare("INSERT INTO accounts (id,identity,inst,mask,name,kind,mirror) VALUES ('synthetic-other','synthetic:other','Example Bank','6294','Other checking','cash','manual')").run();
  assert.deepEqual(M.detectAccountPairs(s.db).map(p=>p.confidence),['likely','likely']);
}));

test('stale repair answers refuse without changing the store; valid repairs remain answerable', () => withStore(async s => {
  const p=await seedDuplicate(s,{sure:true});
  M.queueAccountPairs(s.db,{now:NOW}); const q=pending(s.db)[0];
  s.db.prepare("UPDATE accounts SET mask='5837' WHERE id=?").run(p.own);
  assert.throws(()=>C.answer(s.db,q.id,'same'),e=>e.code==='stale');
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,2);
  s.db.prepare("UPDATE accounts SET mask='6294' WHERE id=?").run(p.own);
  C.answer(s.db,q.id,'different',{now:NOW});
  s.db.prepare("UPDATE accounts SET kind='card' WHERE id=?").run(p.own);
  assert.throws(()=>C.reviseItem(s.db,q.id,'same',{now:NOW}),e=>e.code==='stale');
  s.db.prepare("UPDATE accounts SET kind='cash' WHERE id=?").run(p.own);
  C.reviseItem(s.db,q.id,'same',{now:NOW});
  assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,1);
}));
