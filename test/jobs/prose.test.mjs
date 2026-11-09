// AC5: rec prose. Templates are token-only and pass the grounding guard; model prose is accepted
// only when it is valid JSON of the right shape using allowed tokens and no literal numbers, is
// HTML-escaped, is reused while the grounding is unchanged, and falls back to the template on any
// engine failure. Engines here are the real gateway in fake mode (src/engine createEngine).

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import * as prose from '../../src/jobs/planner/prose.mjs';
import { createEngine, checkGrounding } from '../../src/engine/index.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import { TOKEN } from '../../src/shared/tokens.mjs';
import { scratch, recRow, activeRecIds, parseJson } from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch();
const store = S.store.bind(S);
S.store = opts => store({ ...opts, variant: { ...opts?.variant, facts: { 'household.expectedDate': '2027-02-15', ...opts?.variant?.facts } } });
after(async () => await S.cleanup());
const plan = async (db, engine = null) => planRun(db, { engine, now: NOW });

const VALID = {
  summary: '{n:household} has a window to act on this.',
  why: ['The figures behind this come from your data.', '{n:me} can review it in a few minutes.'],
  qa: [{ q: 'What should I do first?', a: ['Start with the first task on the list.'] }],
};

// Answers every call with reply(request) through a one-shot fake gateway, and records the calls.
function scripted(reply, { costUsd = 0.01 } = {}) {
  const calls = [];
  return {
    calls,
    async call(args) {
      calls.push(args);
      const request = parseJson(args.messages?.[0]?.content, {});
      const engine = createEngine({ mode: 'fake', responses: [{ text: reply(request, args), costUsd }] });
      return await engine.call(args);
    },
  };
}

// Wraps an engine and counts calls.
function counted(engine) {
  const calls = [];
  return { calls, call: args => { calls.push(args); return engine.call(args); } };
}

const proseSrc = async db => Object.fromEntries((await db.prepare('SELECT rec_id, prose_src FROM planner_recs WHERE retired_at IS NULL').all()).map(r => [r.rec_id, r.prose_src]));
const hashes = async db => Object.fromEntries((await db.prepare('SELECT rec_id, grounding_hash FROM planner_recs').all()).map(r => [r.rec_id, r.grounding_hash]));
const allTemplate = async db => Object.values(await proseSrc(db)).every(v => v === 'template');

const STRIP = [
  /\{(?:fk|f|l|p|n):[^{}\s:]+\}/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?/g,
  /\b(?:19|20|21)\d{2}\b/g,
  /\b401\s*\(\s*k\s*\)|\b401k\b|\b(?:403|457)\s*\(\s*b\s*\)|\b529\b|\bW-?[24]\b|\b1099(?:-[A-Za-z]+)?\b|\bForm\s+\d+[A-Za-z-]*|\bSchedule\s+\S+|\bSection\s+\d+\S*/g,
];
const bareDigits = s => STRIP.reduce((t, re) => t.replace(re, ' '), s).match(/\d+/g) || [];

function proseStrings(rec) {
  return [
    ['title', rec.title], ['summary', rec.summary], ['triggerText', rec.triggerText],
    ...rec.why.map((p, i) => [`why[${i}]`, p]),
    ...rec.qa.flatMap((q, i) => [[`qa[${i}].q`, q.q], ...q.a.map((a, j) => [`qa[${i}].a[${j}]`, a])]),
    ...rec.tasks.map((t, i) => [`tasks[${i}]`, t.t]),
    ...rec.cross.map((c, i) => [`cross[${i}]`, c]),
    ...rec.value.map((v, i) => [`value[${i}]`, v.text]),
  ];
}

describe('template prose', () => {
  test('AC5: the prose module exports its three functions', () => {
    for (const fn of ['groundingHash', 'writeProse', 'checkProse']) assert.equal(typeof prose[fn], 'function', fn);
  });

  test('AC5: with no engine every rec gets template prose that is token-only and passes the grounding guard', async () => {
    const db = await S.store();
    const result = await plan(db);
    assert.ok(await allTemplate(db));
    assert.equal(result.counts.prose.template, (await activeRecIds(db)).length);
    const scenario = await buildScenario(db, { clock: NOW });
    const tokenOnly = {};
    for (const k of [...Object.keys(scenario.fig), ...Object.keys(scenario.law), ...Object.keys(scenario.pct), ...Object.keys(scenario.names)]) tokenOnly[k] = 'token';
    for (const id of await activeRecIds(db)) {
      const rec = scenario.recs.find(r => r.id === id);
      for (const [field, text] of proseStrings(rec)) {
        assert.equal(typeof text, 'string', `${id}.${field}`);
        const g = checkGrounding(text, { figures: tokenOnly });
        assert.ok(g.ok, `${id}.${field} passes the guard: ${JSON.stringify(g.violations)} in "${text}"`);
        assert.deepEqual(bareDigits(text), [], `${id}.${field} has no digits outside tokens: "${text}"`);
        for (const [, type, key] of text.matchAll(TOKEN)) {
          const scope = type === 'l' ? scenario.law : type === 'p' ? scenario.pct : type === 'n' ? scenario.names : scenario.fig;
          assert.ok(Object.hasOwn(scope, key), `${id}.${field} token {${type}:${key}} resolves`);
        }
      }
    }
  });

  test('AC5: an engine that is off falls back to the template', async () => {
    const db = await S.store();
    const engine = counted(createEngine({ mode: 'off' }));
    const result = await plan(db, engine);
    assert.equal(result.status, 'ok');
    assert.ok(engine.calls.length > 0, 'the planner asked');
    assert.ok(await allTemplate(db));
  });

  test('AC5: a spent budget (BudgetExceededError at cap 0) falls back to the template', async () => {
    const db = await S.store();
    const engine = counted(createEngine({ mode: 'fake', capUsd: 0, responses: Array.from({ length: 40 }, () => ({ text: JSON.stringify(VALID) })) }));
    const result = await plan(db, engine);
    assert.equal(result.status, 'ok');
    assert.ok(engine.calls.length > 0);
    assert.ok(await allTemplate(db));
    assert.equal(result.costUsd, 0);
  });
});

describe('model prose', () => {
  test('AC5: a valid token-only reply is accepted: prose_src model and the summary is the scripted one', async () => {
    const db = await S.store();
    const engine = createEngine({ mode: 'fake', responses: Array.from({ length: 40 }, () => ({ text: JSON.stringify(VALID), costUsd: 0.01 })) });
    const result = await plan(db, engine);
    const src = await proseSrc(db);
    assert.ok(Object.keys(src).length > 0);
    for (const [id, v] of Object.entries(src)) {
      assert.equal(v, 'model', `${id} prose_src`);
      const def = (await recRow(db, id)).def;
      assert.equal(def.summary, VALID.summary);
      assert.deepEqual(def.why, VALID.why);
      assert.deepEqual(def.qa, VALID.qa);
    }
    assert.equal(result.counts.prose.model, Object.keys(src).length);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_key = 'fed-q4-estimate'").get()).n, 0,
      'the planner writes no opening summary message; the dialog shows the accepted summary from the def');
  });

  test('AC5: the engine is asked for a job with the draft, allowed figures and a token allow list', async () => {
    const db = await S.store();
    const engine = scripted(() => JSON.stringify(VALID));
    await plan(db, engine);
    assert.equal(engine.calls.length, (await activeRecIds(db)).length, 'one call per rec');
    const scenario = await buildScenario(db, { clock: NOW });
    for (const args of engine.calls) {
      assert.equal(args.purpose, 'job');
      assert.equal(args.maxTokens, 1500);
      assert.ok(typeof args.system === 'string' && args.system.length > 0);
      assert.equal(args.messages.length, 1);
      assert.equal(args.messages[0].role, 'user');
      const req = JSON.parse(args.messages[0].content);
      for (const k of ['rec', 'figures', 'law', 'pct', 'names', 'draft']) assert.ok(k in req, `request has ${k}`);
      for (const k of ['title', 'triggerText', 'window', 'domain']) assert.ok(k in req.rec, `request rec has ${k}`);
      assert.equal(typeof req.draft.summary, 'string');
      assert.ok(Array.isArray(req.draft.why));
      for (const [key, f] of Object.entries(req.figures)) {
        assert.ok(scenario.fig[key], `allowed figure ${key} exists`);
        assert.equal(f.v, scenario.fig[key].v);
        assert.ok('label' in f && 'kind' in f);
      }
      assert.ok(args.grounding && typeof args.grounding.figures === 'object', 'grounding allow list passed');
    }
  });

  test('AC5: a reply using the rec figure tokens is accepted and the cost is recorded on the run', async () => {
    const db = await S.store();
    const engine = scripted(req => {
      const key = Object.keys(req.figures || {})[0];
      const summary = key ? `You have {f:${key}} to plan around.` : VALID.summary;
      return JSON.stringify({ ...VALID, summary });
    }, { costUsd: 0.02 });
    const result = await plan(db, engine);
    assert.ok(Object.values(await proseSrc(db)).every(v => v === 'model'));
    assert.match((await recRow(db, 'fed-q4-estimate')).def.summary, /^You have \{f:[^}]+\} to plan around\.$/);
    const expected = Math.round(engine.calls.length * 0.02 * 1e6) / 1e6;
    assert.ok(Math.abs(result.costUsd - expected) < 1e-6, `costUsd ${result.costUsd} vs ${expected}`);
    const run = await db.prepare('SELECT cost_usd FROM job_runs WHERE id = ?').get(result.runId);
    assert.ok(Math.abs(run.cost_usd - expected) < 1e-6);
  });

  test('AC5: a reply with a literal number is rejected and the template is used', async () => {
    const db = await S.store();
    const engine = scripted(() => JSON.stringify({ ...VALID, summary: 'Set aside 1234 dollars this month.' }));
    await plan(db, engine);
    assert.ok(engine.calls.length > 0);
    assert.ok(await allTemplate(db));
    assert.doesNotMatch((await recRow(db, 'fed-q4-estimate')).def.summary, /1234/);
  });

  test('AC5: a literal amount equal to an allowed figure is still rejected (R15)', async () => {
    const db = await S.store();
    const engine = scripted(req => {
      const f = Object.values(req.figures || {}).find(x => typeof x.v === 'number' && x.v >= 10);
      const amount = f ? `$${Math.round(f.v).toLocaleString('en-US')}` : 'twelve';
      return JSON.stringify({ ...VALID, summary: `You can still move ${amount} this year.` });
    });
    await plan(db, engine);
    assert.ok(await allTemplate(db));
  });

  test('AC5: an unknown token key is rejected', async () => {
    const db = await S.store();
    const engine = scripted(() => JSON.stringify({ ...VALID, summary: 'Watch {f:not.a.figure} closely.' }));
    await plan(db, engine);
    assert.ok(await allTemplate(db));
  });

  test('AC5: replies that are not JSON or have the wrong shape are rejected', async () => {
    for (const reply of [
      'This is not JSON.',
      JSON.stringify({ ...VALID, why: [] }),
      JSON.stringify({ ...VALID, why: ['a', 'b', 'c', 'd', 'e'] }),
      JSON.stringify({ summary: VALID.summary }),
      JSON.stringify({ ...VALID, qa: [{ q: 'Why?', a: [] }] }),
    ]) {
      const db = await S.store();
      await plan(db, scripted(() => reply));
      assert.ok(await allTemplate(db), `rejected: ${reply.slice(0, 60)}`);
    }
  });

  test('AC5: model text is HTML-escaped before storage', async () => {
    const db = await S.store();
    const engine = scripted(() => JSON.stringify({ ...VALID, summary: '{n:household} should look <script>window.x</script> now.' }));
    await plan(db, engine);
    const summary = (await recRow(db, 'fed-q4-estimate')).def.summary;
    assert.equal((await proseSrc(db))['fed-q4-estimate'], 'model');
    assert.ok(!summary.includes('<script>'), 'raw markup never stored');
    assert.ok(summary.includes('&lt;script&gt;'), 'stored escaped');
    assert.ok(summary.includes('{n:household}'), 'tokens survive escaping');
  });

  test('AC5: a second run with unchanged figures makes no engine call and keeps the model prose', async () => {
    const db = await S.store();
    await plan(db, createEngine({ mode: 'fake', responses: Array.from({ length: 40 }, () => ({ text: JSON.stringify(VALID) })) }));
    const engine = counted(createEngine({ mode: 'fake', responses: [] }));
    const result = await plan(db, engine);
    assert.equal(result.status, 'ok');
    assert.equal(engine.calls.length, 0, 'no engine call');
    assert.ok(Object.values(await proseSrc(db)).every(v => v === 'model'), 'model prose kept');
    assert.equal((await recRow(db, 'fed-q4-estimate')).def.summary, VALID.summary);
    assert.equal(result.counts.prose.kept, (await activeRecIds(db)).length);
  });

  test('AC5: changing a grounding figure regenerates only the affected recs', async () => {
    const db = await S.store();
    await plan(db, scripted(() => JSON.stringify(VALID)));
    const before = await hashes(db);
    await db.prepare("INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind) VALUES ('federal', 2026, '2026-10-31', 1000, 'paid')").run();
    const engine = scripted(() => JSON.stringify({ ...VALID, summary: '{n:me} has a new figure to look at.' }));
    const result = await plan(db, engine);
    const after = await hashes(db);
    const changed = Object.keys(after).filter(id => after[id] !== before[id]).sort();
    assert.ok(changed.includes('fed-q4-estimate'), 'the federal estimate rec is affected');
    for (const id of ['hsa-room', 'new-child', 'va529']) assert.ok(!changed.includes(id), `${id} not affected`);
    assert.equal(engine.calls.length, changed.length, 'one engine call per affected rec');
    assert.equal(result.counts.prose.model, changed.length);
    assert.equal(result.counts.prose.kept, (await activeRecIds(db)).length - changed.length);
    assert.equal((await recRow(db, 'fed-q4-estimate')).def.summary, '{n:me} has a new figure to look at.');
    assert.equal((await recRow(db, 'hsa-room')).def.summary, VALID.summary, 'unaffected prose kept');
  });
});

test('precision improvements never reuse or accept prose that says tax estimates are on hold', async () => {
  const { writeProse } = await import('../../src/jobs/planner/prose.mjs');
  const fields = { summary: 'The estimates are on hold.', why: [], qa: [] };
  const draft = { summary: 'These optional improvements sharpen your estimates.', why: [], qa: [] };
  const hit = { rec: { id: 'missing-data', title: 'Improve precision', mine: [] }, trigger: { id: 'missing-data', template: () => draft }, grounding: [], vars: {} };
  const ctx = { fig: {}, names: {} };
  const engine = { async call() { return { text: JSON.stringify(fields), grounding: { ok: true } }; } };
  const first = await writeProse(hit, ctx, { engine });
  assert.equal(first.fields.summary, draft.summary);
  const second = await writeProse(hit, ctx, { engine, stored: { hash: first.hash, src: 'model', def: fields } });
  assert.equal(second.fields.summary, draft.summary);
  assert.equal(second.kept, false);
});
