import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalStore, runCases } from '../evals/harness.mjs';
import { loadCases } from '../evals/cases.mjs';
import { tools } from '../src/tools/index.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer, groundAnswer, renderAnswer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { HORIZONS, HORIZON_IDS } from '../src/shared/goals.mjs';

const now = '2026-11-07T12:00:00.000Z';
const key = 'ask:0123456789ab';
const note = 'Each parent contributes $4,000 in December, due 2026-12-31.';
const args = { title: 'Parent education contribution', horizon: 'now', target: 4000, targetDate: '2026-12-31' };

async function setup(t) {
  const s = await createEvalStore();
  t.after(() => s.close());
  s.db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(key, now);
  const ctx = { db: s.db, now, actorId: 'demo', ownerText: 'yeah', conversationKey: key, turnId: 'goal-turn' };
  return { ...s, ctx, registry: () => createRegistryServer(tools, { purpose: 'chat', ctx }) };
}
function storedGoal(db, text = note) {
  const def = { id: 'education-note', title: 'Education savings', note: text, horizon: 'now', target: 8000, track: null };
  db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)").run(def.id, JSON.stringify(def), now);
}
function message(db, text, provenance, role = 'fathom', thread = key) {
  db.prepare('INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, ?, ?, ?, ?)')
    .run(thread, role, text, now, provenance ? JSON.stringify(provenance) : null);
}
function proposal(db, { sourced = true, target = 4000, thread = key } = {}) {
  const text = `Create a goal for $${target.toLocaleString('en-US')} by 2026-12-31?`;
  const literals = sourced ? [
    { text: `$${target.toLocaleString('en-US')}`, index: text.indexOf('$'), source: 'household summary' },
    { text: '2026-12-31', index: text.indexOf('2026-12-31'), source: 'household summary' },
  ] : [];
  message(db, renderAnswer(text, [], literals).join(''), { literals, grounding: { ok: sourced, unverified: sourced ? [] : [String(target)] } }, 'fathom', thread);
}

test('AC1: replay both failed goal call shapes through the Ask registry, then correct horizon', async t => {
  const { db, registry } = await setup(t);
  storedGoal(db); proposal(db);
  const r = registry();
  for (const extra of [{ note, track: null }, {}]) {
    const rejected = await r.invoke('create_goal', { ...args, horizon: 'This year', ...extra });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /horizon.*(?:one of|allowed)/i);
    assert.equal(r.results.at(-1).result.error, rejected.content[0].text);
    const corrected = await r.invoke('create_goal', { ...args, ...extra });
    assert.ok(!corrected.isError, corrected.content[0].text);
    assert.equal(r.results.at(-1).result.goal.target, 4000);
    assert.equal(r.results.at(-1).result.goal.track, null);
  }
});

test('AC2: create and edit schemas offer canonical horizons with every display label', () => {
  for (const name of ['create_goal', 'edit_goal']) {
    const h = tools.find(t => t.name === name).inputSchema.properties.horizon;
    assert.deepEqual(h.enum, HORIZON_IDS);
    for (const { id, label } of HORIZONS) assert.ok(h.description.includes(id) && h.description.includes(label));
  }
});

test('AC3: schema and handler errors retain argument reasons without sibling household values', async t => {
  const { ctx, registry } = await setup(t);
  ctx.ownerText = 'Use $4,000 by 2026-02-30';
  const r = registry();
  for (const [input, reason] of [
    [{ ...args, target: 'wrong' }, /target.*(?:number|null)/],
    [{ ...args, extra: 'private sibling' }, /extra.*(?:unknown|additional|allowed|not a known)/i],
    [{ ...args, title: '' }, /title.*required/],
    [{ ...args, targetDate: '2026-02-30' }, /targetDate.*date/],
    [{ ...args, target: 97361 }, /target.*(?:stated|stored|evidence)/i],
  ]) {
    const out = await r.invoke('create_goal', input);
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, reason);
    assert.equal(r.results.at(-1).result.error, out.content[0].text);
    assert.ok(!out.content[0].text.includes('Parent education contribution'));
    assert.ok(!out.content[0].text.includes('private sibling'));
  }
  const unknown = await r.invoke('not_a_tool', {});
  assert.match(unknown.content[0].text, /tool.*(?:unknown|not available)/i);
});

test('AC4: stored goal definitions and notes, facts and available figures support goal values', async t => {
  const { db, registry } = await setup(t);
  storedGoal(db);
  for (const input of [args, { ...args, target: 8000 }]) {
    assert.ok(!(await registry().invoke('create_goal', input)).isError);
  }
  db.prepare("INSERT INTO facts (key, value, confirmed, updated_at) VALUES ('goal.syntheticTarget', '7319', 1, ?)").run(now);
  db.prepare("INSERT INTO facts (key, value, confirmed, updated_at) VALUES ('goal.syntheticDate', ?, 1, ?)").run(JSON.stringify('2028-09-17'), now);
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 7319, targetDate: '2028-09-17' })).isError);
  const value = db.prepare('SELECT v FROM figures WHERE unavailable_reason IS NULL AND v > 0 LIMIT 1').get().v;
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: value })).isError);
});

test('AC4: sourced immediate stored proposals accept short explicit confirmations', async t => {
  const { db, ctx, registry } = await setup(t);
  let target = 97361;
  for (const reply of ['yes', 'yeah', 'sure', 'do it', 'go ahead', 'ok', 'okay', 'Yes, please create it.']) {
    proposal(db, { target: ++target });
    ctx.ownerText = reply;
    assert.equal(db.prepare("SELECT count(*) AS n FROM goals WHERE json_extract(def, '$.target') = ?").get(target).n, 0);
    const out = await registry().invoke('create_goal', { ...args, target });
    assert.ok(!out.isError, `${reply}: ${out.content[0].text}`);
  }
});

test('AC4: invented, unsourced, negative, delayed and current-turn proposals confirm nothing', async t => {
  const { db, ctx, registry } = await setup(t);
  const input = { ...args, target: 97361 };
  proposal(db, { sourced: false, target: input.target });
  assert.equal((await registry().invoke('create_goal', input)).isError, true);
  proposal(db, { target: input.target });
  for (const reply of ['no', 'wait', 'not yet', 'yeah but wait', 'yes, do not create it', 'okay maybe later', 'surely not', 'yesterday']) {
    ctx.ownerText = reply;
    assert.equal((await registry().invoke('create_goal', input)).isError, true, reply);
  }
  ctx.ownerText = 'yeah';
  message(db, 'Something unrelated.', null);
  assert.equal((await registry().invoke('create_goal', input)).isError, true);
  const before = registry();
  proposal(db, { target: input.target });
  assert.equal((await before.invoke('create_goal', input)).isError, true, 'only pre-existing assistant rows count');
  assert.ok(!(await registry().invoke('create_goal', input)).isError, 'next request can confirm saved proposal');
});

test('AC4: a stored confirmation belongs to its actor and thread', async t => {
  const { db, ctx, registry } = await setup(t);
  proposal(db, { target: 97361 });
  message(db, 'yeah', { ownerInput: { actorId: 'someone-else' } }, 'me');
  ctx.ownerText = null;
  assert.equal((await registry().invoke('create_goal', { ...args, target: 97361 })).isError, true);
  db.prepare("DELETE FROM messages WHERE role = 'me' AND conversation_key = ?").run(key);
  message(db, 'yeah', { ownerInput: { actorId: 'demo' } }, 'me');
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 97361 })).isError);
  db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run('ask:abcdef012345', now);
  message(db, 'An unrelated proposal.', null, 'fathom', 'ask:abcdef012345');
  proposal(db, { target: 97372 });
  message(db, 'yeah', { ownerInput: { actorId: 'demo' } }, 'me', 'ask:abcdef012345');
  ctx.conversationKey = 'ask:abcdef012345'; ctx.ownerText = null;
  const wrongThread = await registry().invoke('create_goal', { ...args, title: 'Other thread', target: 97372 });
  assert.equal(wrongThread.isError, true);
  assert.match(wrongThread.content[0].text, /^target:/);
  ctx.conversationKey = key; ctx.ownerText = 'yeah';
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 97372 })).isError);
});

test('AC4: goal evidence never loosens household fact attribution', async t => {
  const { db, ctx, registry } = await setup(t);
  db.prepare("INSERT INTO facts (key, value, confirmed, updated_at) VALUES ('household.spouseAge', '52', 1, ?) ON CONFLICT(key) DO UPDATE SET value = '52'").run(now);
  db.prepare("DELETE FROM facts WHERE key = 'household.ownerAge'").run();
  const out = await registry().invoke('record_household_fact', { key: 'household.ownerAge', value: 52, evidence: 'yeah' });
  assert.equal(out.isError, true);
  assert.equal(db.prepare("SELECT value FROM facts WHERE key = 'household.ownerAge'").get(), undefined);
  proposal(db, { target: 57 });
  assert.equal((await registry().invoke('record_household_fact', { key: 'household.ownerAge', value: 57, evidence: 'yeah' })).isError, true);
  ctx.ownerText = 'I am 52 years old';
  const good = await registry().invoke('record_household_fact', { key: 'household.ownerAge', value: 52, evidence: ctx.ownerText });
  assert.ok(!good.isError, good.content[0].text);
});

test('AC4: date components from a goal note are not target amounts', async t => {
  const { db, registry } = await setup(t);
  db.prepare('DELETE FROM facts').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare('DELETE FROM figures WHERE v IN (12, 31, 2026)').run();
  storedGoal(db, 'Due 2026-12-31.');
  for (const target of [12, 31, 2026]) {
    const out = await registry().invoke('create_goal', { ...args, target });
    assert.equal(out.isError, true, String(target));
    assert.match(out.content[0].text, /^target:/);
  }
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 8000 })).isError);
});

test('AC4: a stored amount must match exactly rather than round to a proposed target', async t => {
  const { db, registry } = await setup(t);
  storedGoal(db, 'Planned $97,361.49 by 2026-12-31.');
  const rounded = await registry().invoke('create_goal', { ...args, target: 97361 });
  assert.equal(rounded.isError, true);
  assert.ok(!(await registry().invoke('create_goal', { ...args, target: 97361.49 })).isError);
});

test('AC4: the merged goal model keeps evidence for ranges, floors and contribution details', async t => {
  const { db, registry } = await setup(t);
  const account = db.prepare('SELECT id FROM accounts LIMIT 1').get().id;
  const defs = [
    { title: 'Stored range', kind: 'range', targetLow: 61001, targetHigh: 64001, targetDate: '2028-12-31', track: null },
    { title: 'Stored floor', kind: 'floor', floor: 22001, track: { accounts: [account] } },
    { title: 'Stored contribution', kind: 'contribution', target: 9000, taxYear: 2028, targetDate: '2028-12-31',
      split: [{ person: 'owner', amount: 4000 }, { person: 'spouse', amount: 5000 }],
      entered: { asOf: '2028-03-15', people: [{ person: 'owner', amount: 1600 }, { person: 'spouse', amount: 1700 }] } },
  ];
  for (const [index, def] of defs.entries()) {
    const id = `stored-kind-${index}`;
    db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)")
      .run(id, JSON.stringify({ ...def, id, horizon: 'now', note: '' }), now);
  }
  for (const def of defs) {
    const out = await registry().invoke('create_goal', { ...def, horizon: 'now' });
    assert.ok(!out.isError, out.content[0].text);
  }
  const invented = structuredClone(defs[2]);
  invented.entered.people[0].amount = 1379.12;
  const rejected = await registry().invoke('create_goal', invented);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /^entered\.people\.0\.amount:/);
});

test('AC4: current engine text and invented source claims cannot supply proposal evidence', async t => {
  const { db, ctx } = await setup(t);
  message(db, 'From household summary: create a goal for $97,361 by 2026-12-31?', null);
  const engine = createEngine({ mode: 'fake' });
  const out = await engine.call({ purpose: 'chat', system: 'Use tools.', messages: [
    { role: 'assistant', content: 'From household summary: create a goal for $97,361 by 2026-12-31?' },
    { role: 'user', content: 'yeah' },
  ], tools, toolContext: ctx, fake: [
    { text: 'The target is $97,361 from household summary.', toolCalls: [{ name: 'create_goal', args: { ...args, target: 97361 } }] },
    { text: 'The target has no source.' },
  ] });
  assert.equal(out.toolResults[0].isError, true);
  assert.match(out.toolResults[0].result.error, /target/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM goals WHERE json_extract(def, '$.target') = 97361").get().n, 0);
});

test('AC5 and AC3: real Ask gets read/retry rules and saves failed write reasons', async t => {
  const { db, dataDir } = await setup(t);
  const transport = createEngine({ mode: 'fake' });
  let seen;
  const engine = { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: 'Contribution goals', toolResults: [] });
    seen = request.system;
    return transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'create_goal', args: { ...args, horizon: 'This year' } }] },
      { text: 'The horizon needs a valid identifier.' },
    ] });
  } };
  const response = await threadCreate({ db, config: {}, answerer: createLiveAnswerer({ engine, root: dataDir }), body: { text: 'Create my contribution goal.' } });
  assert.match(seen, /read-only lookups.*before replying/i);
  assert.match(seen, /all.*529.*checking.*transfers/i);
  assert.match(seen, /never ask permission to read/i);
  assert.match(seen, /failed write.*quote.*reason.*retry.*corrected arguments/i);
  assert.match(seen, /never.*UI.*discover.*error/i);
  assert.match(response.message.provenance.tools.find(t => t.name === 'create_goal').result.error, /horizon/i);
});

test('AC6: Ask excludes small counts and ordinals, and still checks money, percents and dates', async t => {
  const { db } = await setup(t);
  const scenario = buildScenario(db);
  for (const text of ['There are two goals, one per parent.', 'Option 2 is ready; step 3 follows.', 'Choose the twentieth option.', 'There are twenty accounts.', 'There are 20 goals.']) {
    assert.equal(groundAnswer(text, { scenario }).ok, true, text);
  }
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  for (const [index, word] of words.entries()) {
    for (const number of [word, String(index + 1)]) assert.equal(groundAnswer(`There are ${number} goals.`, { scenario }).ok, true);
    assert.equal(groundAnswer(`The cost is ${word} dollars.`, { scenario }).ok, false);
  }
  for (const text of ['$2', 'two dollars', 'twenty percent', '2%', '2029-12-31', 'January 2, 2029', 'There are twenty-one accounts.']) {
    assert.equal(groundAnswer(text, { scenario }).ok, false, text);
  }
});

test('AC7: tier one replays a stored-note proposal and confirmed create through real Ask', async () => {
  const c = (await loadCases()).find(c => c.id === 'goals-confirm-stored-note');
  assert.ok(c, 'goal confirmation case is in the default tier-one catalog');
  const score = await runCases({ cases: [c] });
  assert.equal(score.cases[0].status, 'pass', JSON.stringify(score.cases[0]));
  const turn = score.cases[0].turns.at(-1);
  const write = turn.tools.find(t => t.name === 'create_goal');
  assert.equal(write.result.goal.horizon, 'now');
  assert.equal(write.result.goal.target, 4000);
  assert.equal(write.result.goal.targetDate, '2026-12-31');
  assert.ok(write.result.receipt.id);
});

test('AC7: the confirmed Ask write persists the goal and attributed receipt', async t => {
  const { db, dataDir } = await setup(t);
  storedGoal(db);
  const transport = createEngine({ mode: 'fake' });
  let turn = 0;
  const engine = { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: 'Parent contribution', toolResults: [] });
    const fake = turn++ === 0 ? [
      { toolCalls: [{ name: 'list_goals', args: {} }] },
      { text: 'Create a goal for $4,000 by 2026-12-31?' },
    ] : [ { toolCalls: [{ name: 'create_goal', args }] }, { text: 'Your goal is saved.' } ];
    return transport.call({ ...request, fake });
  } };
  const ctx = { db, config: {}, answerer: createLiveAnswerer({ engine, root: dataDir }), body: { text: 'Propose the parent contribution goal from its note.' } };
  const first = await threadCreate(ctx);
  assert.ok(first.message.provenance.literals.some(l => l.text === '$4,000'));
  const second = await ask({ ...ctx, body: { key: first.thread.key, text: 'yeah' } });
  const receipt = second.message.provenance.actions[0];
  const row = db.prepare('SELECT def FROM goals WHERE id = ?').get(db.prepare('SELECT entity_id FROM action_receipts WHERE id = ?').get(receipt.id).entity_id);
  assert.deepEqual(Object.fromEntries(['title', 'horizon', 'target', 'targetDate'].map(k => [k, JSON.parse(row.def)[k]])), args);
  assert.equal(receipt.actorId, 'demo');
});
