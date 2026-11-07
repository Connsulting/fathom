import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJev, categoryQuestions, JEV_MODEL } from '../src/categories/jev.mjs';

// Shapes: https://api.typesafe.ai/openapi.json, SystemOneRequest/ChoiceAnswer/Usage, 2026-11-07.
export function response(body, confidence = .93) {
  return { model: JEV_MODEL, answers: Object.fromEntries(Object.entries(body.questions).map(([id,q]) => {
    const options=Object.keys(q.criteria), choice=options[0];
    return [id,{type:'choice',choice,confidence,probabilities:Object.fromEntries(options.map((o,i)=>[o,i===0?.8:.2/(options.length-1)]))}];
  })), usage:{input_tokens:120,output_tokens:12} };
}
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'jev-')); const keyFile=join(dir,'key');
  writeFileSync(keyFile,'synthetic-key',{mode:0o600}); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {keyFile};
}
const questions=()=>categoryQuestions([{description:'TRANSFER Jordan Example 3456 123456789',amount:-42,date:'2032-06-10',account_id:'a',balance:12345,name:'Jordan Example'}],{
  accounts:[{id:'a',kind:'checking',mask:'3456',name:'Private account'}],householdNames:{me:'Jordan Example',spouse:'Taylor Sample'},categories:['Groceries','Business']});

test('batched choice questions whitelist state and redact independently supplied private text', async t=>{
  let req; const entries=[];
  const jev=await createJev({...setup(t),ledger:{record:e=>entries.push(e),monthSpendUsd:()=>0},transport:async (url,opts)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone'); assert.equal(opts.headers.Authorization,'Bearer synthetic-key');
    req=JSON.parse(opts.body); return Response.json(response(req));
  }});
  const out=await jev.choose([...questions(),...questions()]);
  assert.equal(Object.keys(req.questions).length,2); assert.equal(out.length,2);
  assert.equal(req.model,'jev-1.14.0'); assert.deepEqual(Object.keys(req.state.q0).sort(),['accountKind','amount','date','description']);
  const sent=JSON.stringify(req); for(const value of ['Jordan','3456','123456789','Private account','balance']) assert.ok(!sent.includes(value),value);
  assert.deepEqual(Object.keys(req.questions.q0.criteria),['Groceries','Business']);
  assert.equal(out[0].confidence,.93); assert.equal(entries[0].purpose,'categorize'); assert.equal(entries[0].model,JEV_MODEL);
});

test('missing file is off and valid private key is live',async t=>{
  const {keyFile}=setup(t); const off=await createJev({keyFile:keyFile+'-absent'}); assert.equal(off.isOn(),false);
  const live=await createJev({keyFile}); assert.equal(live.isOn(),true);
});

test('caps prevent dispatch, include failed retries, and stop at monthly budget',async t=>{
  const {keyFile}=setup(t); let calls=0; const entries=[];
  const opts={keyFile,transport:async()=>{calls++;return new Response('',{status:503});},sleep:async()=>{},ledger:{record:e=>entries.push(e),monthSpendUsd:()=>0}};
  const zero=await createJev({...opts,maxCostUsd:0}); await assert.rejects(zero.choose(questions()),/jev_budget/); assert.equal(calls,0);
  const monthly=await createJev({...opts,monthlyCapUsd:0}); await assert.rejects(monthly.choose(questions()),/jev_budget/); assert.equal(calls,0);
  const retry=await createJev({...opts,retries:1}); await assert.rejects(retry.choose(questions()),/jev_unavailable/); assert.equal(calls,2); assert.equal(entries.length,2);
  assert.ok(retry.stats().costUsd>0);
  const tiny=await createJev({...opts,maxTokens:1}); await assert.rejects(tiny.choose(questions()),/jev_budget/); assert.equal(calls,2);
});

test('bad response refuses with counts charged and next valid response works',async t=>{
  let bad=true; const jev=await createJev({...setup(t),transport:async(_,o)=>{
    const b=response(JSON.parse(o.body)); if(bad) b.answers.q0.choice='not-an-option'; return Response.json(b);
  }});
  await assert.rejects(jev.choose(questions()),/jev_bad_response/); bad=false;
  assert.equal((await jev.choose(questions()))[0].choice,'Groceries');
});

test('timeout is bounded, charged, and a later valid request remains live',async t=>{
  let hanging=true;
  const jev=await createJev({...setup(t),timeoutMs:5,retries:0,transport:async(_,o)=>{
    if(hanging) return new Promise(()=>{}); return Response.json(response(JSON.parse(o.body)));
  }});
  await assert.rejects(jev.choose(questions()),/jev_unavailable/); hanging=false;
  assert.equal((await jev.choose(questions())).length,1); assert.ok(jev.stats().costUsd>0);
});

test('a cost-derived token cap attempts every question that fits the run budget',async t=>{
  let attempted=0;
  const jev=await createJev({...setup(t),transport:async(_,o)=>{
    const body=JSON.parse(o.body), data=response(body);
    attempted+=Object.keys(body.questions).length;
    data.usage.input_tokens=Buffer.byteLength(o.body)+1024*Object.keys(body.questions).length+4096;
    return Response.json(data);
  }});
  const n=300;
  assert.equal((await jev.choose(Array.from({length:n},()=>questions()[0]))).length,n);
  assert.equal(attempted,n);
  assert.ok(jev.stats().costUsd<=.05);
});

test('outbound pause is rechecked before each batch and retry, then resume permits dispatch',async t=>{
  let enabled=true,calls=0;
  const jev=await createJev({...setup(t),batchSize:1,canSend:()=>enabled,transport:async(_,o)=>{
    calls++;enabled=false;return Response.json(response(JSON.parse(o.body)));
  }});
  await assert.rejects(jev.choose([...questions(),...questions()]),/outbound_paused/);
  assert.equal(calls,1);
  enabled=true;
  assert.equal((await jev.choose(questions())).length,1);
  enabled=false;
  await assert.rejects(jev.choose(questions()),/outbound_paused/);
  assert.equal(calls,2);
});
