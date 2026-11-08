import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { setAllocation, FUNDING_SETTING, runWithPrincipal } from '../src/platform/model-budget.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createJev } from '../src/categories/jev.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { loadCategoryInputs, isJevProposal } from '../src/categories/store.mjs';

const messages = [{ role: 'user', content: 'Synthetic prompt' }];
const questions = [{ state: { description: 'Synthetic grocery store' }, instructions: 'Choose a category', options: ['Groceries', 'Business'] }];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fathom-port-test-'));
  const store = createInstance(root, { mode: 'real' });
  const keyFile = join(root, 'synthetic-key'); writeFileSync(keyFile, 'synthetic-token', { mode: 0o600 });
  store.platform.prepare('INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,0)').run(FUNDING_SETTING, '1');
  setAllocation(store.platform, store.householdId, 1);
  t.after(() => { store.db.close(); store.platform.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...store, keyFile };
}
for (const adapter of ['openai', 'ollama', 'jev']) {
  test(`${adapter} runtime reserves before transport and mirrors each purpose once`, async t => {
    const store = fixture(t), { db, platform, householdId, keyFile } = store;
    const modelPorts = {};
    for (const purpose of ['ask', 'title', 'import', 'categorize']) modelPorts[purpose] = adapter === 'jev'
      ? { adapter: purpose === 'categorize' ? 'jev' : 'claude', ...(purpose === 'categorize' ? { keyFile } : {}) }
      : { adapter, model: 'synthetic-model', baseUrl: 'http://localhost:9999', inputUsdPerMillion: 1, outputUsdPerMillion: 2, keyFile };
    let calls = 0;
    const engine = createRuntimeEngine({ db, platform, householdId, config: { engine: 'live', modelPorts }, funded: () => true,
      modelTransport: async (_, o) => {
        calls++;
        const rows = platform.prepare("SELECT * FROM model_rounds WHERE kind='round' AND state='reserved'").all();
        assert.equal(rows.length, 1, 'real reservation exists before transport');
        const b = JSON.parse(o.body); assert.equal(o.headers.Authorization, 'Bearer synthetic-token');
        if (adapter === 'jev') return Response.json({ model: 'jev-1.14.0', answers: { q0: { type: 'choice', choice: 'Groceries', confidence: .9,
          probabilities: { Groceries: .9, Business: .1 } } }, usage: { input_tokens: 20, output_tokens: 4 } });
        const text = b.format?.properties?.q0 || b.response_format?.json_schema?.schema?.properties?.q0
          ? JSON.stringify({ q0: { choice: 'Groceries', confidence: .9, probabilities: { Groceries: .9, Business: .1 } } }) : 'Synthetic answer';
        return Response.json(adapter === 'openai'
          ? { choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 20, completion_tokens: 4 } }
          : { done: true, message: { content: text }, prompt_eval_count: 20, eval_count: 4 });
      } });
    for (const purpose of adapter === 'jev' ? ['categorize'] : ['chat', 'job', 'title', 'extract', 'confirm', 'categorize']) {
      const result = await engine.complete({ purpose, messages, maxTokens: 64, ...(purpose === 'categorize' ? { choices: questions } : {}) });
      assert.equal(result.accounting.tokens.input_tokens, 20);
    }
    const rounds = platform.prepare("SELECT * FROM model_rounds WHERE kind='round'").all();
    assert.equal(rounds.length, calls); assert.ok(rounds.every(r => r.state === 'settled'));
    assert.equal(db.prepare('SELECT count(*) n FROM spend_ledger WHERE round_id IS NOT NULL').get().n, calls);
    setSetting(db, 'cap', { usd: 0 });
    await assert.rejects(engine.complete({ purpose: 'categorize', messages, choices: questions, maxTokens: 64 }), e => e.code === 'budget');
    assert.equal(calls, rounds.length);
    setSetting(db, 'cap', { usd: 1 });
    await assert.rejects(runWithPrincipal({ check: () => false }, () => engine.complete({ purpose: 'categorize', messages, choices: questions, maxTokens: 64 })), e => e.code === 'authorization_revoked');
    assert.equal(calls, rounds.length);
    assert.ok((await engine.complete({ purpose: 'categorize', messages, choices: questions, maxTokens: 64 })).choices.length);
  });
}

test('configured categorization retains model identity and cannot inherit calibrated auto-apply', async t => {
  const { db, platform, householdId } = fixture(t);
  db.exec("INSERT INTO accounts (id,kind,name) VALUES ('a','checking','Synthetic account')");
  for (const [description, category] of [['Historical market', 'Groceries'], ['Historical service', 'Business'], ['Synthetic pending', null]])
    db.prepare("INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES ('a','2032-01-01',-20,?,?,'aggregator')").run(description, category);
  const engine = createRuntimeEngine({ db, platform, householdId, config: { engine: 'live', modelPorts: {
    categorize: { adapter: 'ollama', model: 'synthetic-local', baseUrl: 'http://localhost:9999', inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } }, funded: () => true,
    modelTransport: async () => Response.json({ done: true, message: { content: '{"q0":{"choice":"Groceries","confidence":1,"probabilities":{"Groceries":1,"Business":0}}}' }, prompt_eval_count: 20, eval_count: 20 }) });
  const categorizer = await createJev({ complete: engine.complete });
  const result = await guessCategories(db, categorizer, {policy:{autoApply:.5,review:0}});
  assert.equal(result.applied, 0); assert.equal(result.guessed, 1);
  const guess = loadCategoryInputs(db).guesses[0]; assert.equal(guess.model, 'synthetic-local'); assert.ok(isJevProposal(guess));
  assert.equal(db.prepare('SELECT count(*) n FROM transaction_category_corrections').get().n, 0);
  const before = db.prepare('SELECT count(*) n FROM spend_ledger').get().n;
  await guessCategories(db, categorizer);
  assert.equal(db.prepare('SELECT count(*) n FROM spend_ledger').get().n, before, 'accepted attempts are not repeatedly purchased');
});

test('a missing categorizer credential cannot consume another purpose credential', async t => {
  const { db, platform, householdId, keyFile } = fixture(t);
  const previous = process.env.FATHOM_CLAUDE_CREDENTIAL_FILE;
  process.env.FATHOM_CLAUDE_CREDENTIAL_FILE = keyFile;
  t.after(() => { if (previous === undefined) delete process.env.FATHOM_CLAUDE_CREDENTIAL_FILE; else process.env.FATHOM_CLAUDE_CREDENTIAL_FILE = previous; });
  let calls = 0;
  const engine = createRuntimeEngine({ db, platform, householdId, config: { engine: 'live', claudeCredentialFile: keyFile }, funded: () => true,
    modelTransport: async () => { calls++; return Response.json({}); } });
  await engine.init();
  assert.equal(engine.credentialState, 'loaded');
  await assert.rejects(engine.complete({ purpose: 'categorize', messages, choices: questions, maxTokens: 64 }), e => e.code === 'authentication');
  assert.equal(calls, 0);
  assert.equal(platform.prepare("SELECT count(*) n FROM model_rounds WHERE kind='round'").get().n, 0);
});

test('a default categorizer retry reserves a fresh response and cannot dispatch after pause', async t => {
  const { db, platform, householdId, keyFile } = fixture(t);
  let calls = 0, enabled = true;
  const engine = createRuntimeEngine({ db, platform, householdId, config: { engine: 'live', typesafeKeyFile: keyFile }, funded: () => true, allowed: () => enabled,
    modelTransport: async () => { calls++; return calls===1 ? new Response('', {status:429,headers:{'retry-after':'1'}})
      : Response.json({model:'jev-1.14.0',answers:{q0:{type:'choice',choice:'Groceries',confidence:.9,probabilities:{Groceries:.9,Business:.1}}},usage:{input_tokens:20,output_tokens:4}}); } });
  const sleeps = [];
  const categorizer = await createJev({ complete: engine.complete, sleep: async ms => { sleeps.push(ms); enabled = false; } });
  await assert.rejects(categorizer.choose(questions), e => e.name === 'EngineOffError' && e.code === undefined);
  assert.equal(calls, 1); assert.deepEqual(sleeps,[1000]);
  assert.equal(platform.prepare("SELECT count(*) n FROM model_rounds WHERE kind='round' AND state='settled' AND cost_usd=0").get().n,1);
  enabled = true;
  assert.equal((await categorizer.choose(questions))[0].choice,'Groceries');
  assert.equal(calls,2); assert.equal(db.prepare('SELECT count(*) n FROM spend_ledger').get().n,2);
});

import { buildScenario } from '../src/scenario/build.mjs';
import { bind as bindEngineScreen, render as renderEngineScreen } from '../web/horizon/screens/engine.js';
test('product engine screen uses neutral labels while the ledger retains provider identity', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO spend_ledger (ts,yyyymm,purpose,cost_usd,model,tokens) VALUES (?,?,?,? ,?,?)")
    .run(new Date().toISOString(), new Date().toISOString().slice(0,7),'chat',.001,'synthetic-provider-model','{}');
  const scenario = buildScenario(db);
  const esc = s => String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;');
  bindEngineScreen({ api:{s:scenario,engineOn:()=>true,canAdmin:()=>true},arr:v=>Array.isArray(v)?v:[],T:esc,esc,figHtml:()=>'',shell:s=>s,
    section:(_title,body)=>body,pageHead:()=>'' });
  const html = renderEngineScreen();
  assert.ok(html.includes('Configured')); assert.ok(html.includes('Model service'));
  assert.ok(!html.includes('synthetic-provider-model')); assert.ok(!html.includes('claude-'));
  assert.equal(db.prepare('SELECT model FROM spend_ledger').get().model,'synthetic-provider-model');
});

import { ask, getItem, KIND_OPTIONS } from '../src/ingest/confirm.mjs';
import { resolvePending } from '../src/resolve/index.mjs';
import { bestGuess } from '../src/ingest/bestguess.mjs';
test('alternative fixed-choice confidences stay reviewable and cannot auto-apply account changes', async t => {
  const { db } = fixture(t);
  for (const [id, model] of [['alternative','synthetic-local'],['calibrated','jev-1.14.0']]) {
    db.prepare("INSERT INTO accounts (id,name) VALUES (?,'Synthetic account')").run(id);
    const item=ask(db,{kind:'account_kind',subject:id,question:'Account kind?',options:KIND_OPTIONS});
    db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?)').run(item.id,'cash',JSON.stringify({confidence:1,probabilities:{cash:1},modelPort:true}),model,'2032-01-01');
    assert.equal(bestGuess(db,getItem(db,item.id),{})?.evidence,"Fathom's categorization");
    await resolvePending(db,{isOn:()=>false},{now:'2032-01-01T00:00:00Z',packDirs:[],allowed:()=>true,funded:()=>true});
    assert.equal(getItem(db,item.id).status,id==='alternative'?'pending':'answered');
    assert.equal(db.prepare('SELECT kind FROM accounts WHERE id=?').get(id).kind,id==='alternative'?null:'cash');
  }
});

import { startModelEmulator } from './helpers/model-emulator.mjs';
import { createScheduler, defaultHandlers } from '../src/jobs/scheduler.mjs';
for (const mode of ['live','fake']) test(`scheduled Confirm resolution continues without optional categorizer credentials in ${mode} mode`, async t => {
  const { db, platform, householdId, keyFile, root } = fixture(t);
  const emulator=await startModelEmulator(); t.after(()=>emulator.close());
  db.exec("INSERT INTO accounts (id,name) VALUES ('pending-kind','Synthetic account')");
  const item=ask(db,{kind:'account_kind',subject:'pending-kind',question:'Account kind?',options:KIND_OPTIONS});
  const text=JSON.stringify({answers:[{item:item.id,option:'cash',basis:'account_name',refs:['accounts:pending-kind']}]});
  emulator.script([{text}]);
  let categoryCalls=0, jobCalls=0;
  const config={engine:mode,claudeCredentialFile:keyFile,clock:'2032-01-01'};
  const engine=createRuntimeEngine({db,platform,householdId,config,funded:()=>true,testTransport:{baseURL:emulator.baseURL},
    modelTransport:async()=>{categoryCalls++;assert.fail('the optional categorizer is off');}});
  await engine.init();
  const off=await createJev({complete:engine.complete,enabled:false});
  assert.equal((await guessCategories(db,off)).skipped,'provider_off');
  const call=engine.call;
  engine.call=req=>{jobCalls++;return call({...req,...(mode==='fake'?{fake:[{text,costUsd:.001}]}:{})});};
  const handlers=defaultHandlers({});
  const scheduler=createScheduler({db,config,engine,handlers:{'confirm-guess':handlers['confirm-guess']},
    household:()=>({root,outbound:{enabled:()=>true},funded:()=>true}),now:()=>new Date('2032-01-01'),log:{log(){}}});
  try {await scheduler.runNow('confirm-guess');} finally {await scheduler.stop();}
  assert.equal(categoryCalls,0); assert.equal(jobCalls,1);
  assert.equal(getItem(db,item.id).status,'answered');
  assert.equal(db.prepare("SELECT kind FROM accounts WHERE id='pending-kind'").get().kind,'cash');
});

test('credential status distinguishes a missing primary key from an available categorize or import purpose', async t => {
  const {db,platform,householdId,keyFile}=fixture(t);
  const engine=createRuntimeEngine({db,platform,householdId,config:{engine:'live',typesafeKeyFile:keyFile,
    modelPorts:{import:{adapter:'ollama',model:'synthetic-model',baseUrl:'http://localhost:9999',inputUsdPerMillion:0,outputUsdPerMillion:0}}},funded:()=>true});
  await engine.init();
  assert.equal(engine.credentialState,'failed'); assert.equal(engine.status().credentialState,'failed');
  assert.equal(engine.credentialStateFor('categorize'),'loaded'); assert.equal(engine.credentialStateFor('extract'),'loaded');
});
