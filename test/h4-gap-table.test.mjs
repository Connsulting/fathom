// H4 AC1: every figure-gap code and every goal-reason code is disclosed in plain words, keeps the
// partial value, and carries a fix whose target exists.
//
// a. Each GAP_CODES code runs through a scripted Ask on the demo store. The engine wrapper replaces
//    the `household` read tool's handler (household.figures is the stored-figures read; its schema
//    accepts { operation: 'figures', keys: [...] }) so household.figures returns one synthetic
//    envelope worth 1234.5 usd carrying that one gap with a deliberately internal message. The
//    reply's provenance.leftOut discloses it in plain words, the figure keeps its value, and the
//    Ask renderer draws the "What this leaves out" line with one control per fix.
// b. Plain fact labels cover every answer-shape key the catalog gaps name, and the real catalog
//    projections (retirement.access, retirement.bridge, retirement.after_tax, spending.obligations,
//    tax.estimate) on a scratch store with missing facts return no gap message with an internal name.
// c. Every goal-reason code has plain text and a fix whose target exists (a goal form field for that
//    kind, a new goal, an upload kind), rendered as exactly one control. Every reason literal the pace
//    sources emit is in the table.
// Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { tempDb } from './helpers/server.mjs';
import { createRealStore, householdOf, closeRealStore, addFact } from './helpers/real-store.mjs';
import { callTool } from '../src/tools/index.mjs';
import { GAP_CODES, envelope } from '../src/calc/figure.mjs';
import { answerShape } from '../src/jobs/triggers/common.mjs';
import { HOWTO } from '../src/ingest/howto.mjs';
import { TAX_GAP_RULES, taxGap } from '../src/shared/tax-gaps.mjs';
import { FACT_LABELS, FIGURE_GAP_RULES, factFix, plainGap, hasInternalName } from '../src/shared/gap-words.mjs';
import { useKit, messageBodyHtml } from '../web/horizon/screens/ask-blocks.js';
import { GOAL_REASONS, goalReasonFix, goalReasonControl, reasonText } from '../web/horizon/screens/home-model.js';

const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unesc = s => s.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
useKit({ esc, money: n => String(n), registerFigures: () => {} });

const THREAD = 'ask:0123456789ab';
const ANSWER = 'Here is what I found.';
const VALUE = 1234.5;
const FIGURE_KEY = 'h4.synthetic';
const FIGURES_CALL = { name: 'household', args: { operation: 'figures', keys: [FIGURE_KEY] } };

// Independent checks for internal names, so the test does not rely on hasInternalName alone.
const FACT_KEY_RE = /\b(accounts|household|obligations|income|tax|retirement|business|sh)\.[A-Za-z]/;
const SNAKE_RE = /\b[a-z]+_[a-z_]+\b/;
function assertPlain(text, what) {
  assert.ok(typeof text === 'string' && text.trim(), `${what}: nonempty text`);
  assert.equal(hasInternalName(text), false, `${what}: hasInternalName rejects nothing in ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, FACT_KEY_RE, `${what}: no fact key in ${JSON.stringify(text)}`);
  assert.doesNotMatch(text, SNAKE_RE, `${what}: no snake_case token in ${JSON.stringify(text)}`);
  for (const code of GAP_CODES) assert.ok(!text.includes(code), `${what}: no gap code ${code} in ${JSON.stringify(text)}`);
}

// A fix's target exists: a keyed Ask has an answer shape, a keyless Ask is prefilled, an upload kind
// has how-to steps.
function assertFixTarget(fix, what) {
  assert.ok(fix && typeof fix.label === 'string' && fix.label.trim(), `${what}: fix has a label`);
  assertPlain(fix.label, `${what} label`);
  if (fix.screen === 'upload') {
    assert.ok(Object.hasOwn(HOWTO, fix.kind), `${what}: upload kind ${fix.kind} exists`);
    return;
  }
  assert.equal(fix.screen, 'ask', `${what}: a figure-gap fix opens Ask or an upload`);
  assert.ok(typeof fix.prompt === 'string' && fix.prompt.trim(), `${what}: Ask is prefilled`);
  if (fix.key !== undefined) assert.doesNotThrow(() => answerShape(fix.key), `${what}: answer shape ${fix.key} exists`);
}

// The data-tax-gap-fix controls in some html, with their parsed fix and label.
function taxControls(html) {
  return [...html.matchAll(/<button[^>]*data-tax-gap-fix="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
    .map(m => ({ fix: JSON.parse(unesc(m[1])), label: unesc(m[2]) }));
}
function goalControls(html) {
  return [...html.matchAll(/<button[^>]*data-goal-fix="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
    .map(m => ({ fix: JSON.parse(unesc(m[1])), label: unesc(m[2]) }));
}
// The "What this leaves out" note of a rendered message body.
function leftOutHtml(html) {
  const m = /<div[^>]*\bdata-left-out\b[^>]*>([\s\S]*?)<\/div>/.exec(html);
  return m ? m[0] : null;
}

/* ---------- a. figure-gap codes through scripted Ask ---------- */

// The pinned figure-gap fixes (plan, Design 1). null: nothing the owner can do.
const EXPECTED_FIX = {
  uncategorized_rows: { screen: 'ask', label: 'Categorize them', prompt: 'Show my uncategorized transactions and help me categorize them.' },
  guessed_rows: { screen: 'ask', label: 'Check the guesses', prompt: 'Show the transactions whose categories are guesses so I can confirm them.' },
  account_no_history: { screen: 'upload', kind: 'bank', label: 'Upload statements' },
  incomplete_month: null,
  unequal_periods: null,
  stale_account: { screen: 'upload', kind: 'aggregator', label: 'Import recent transactions' },
  outside_household_ledger: null,
  missing_fact: null,
  carried_balance: { screen: 'upload', kind: 'bank', label: 'Upload a recent statement' },
  unclassified_category: { screen: 'ask', label: 'Classify them', prompt: 'Help me classify my unclassified spending categories.' },
  no_cost_basis: { screen: 'upload', kind: 'brokerage', label: 'Upload a statement with cost basis' },
};

// One case per code, plus missing_fact with a fact (its fix comes from the fact). Each message is
// deliberately internal so the plain rule text must replace it.
const CASES = [
  ...GAP_CODES.map(code => ({ name: code, gap: { code, message: `Rows flagged ${code} need accounts.planType review.` } })),
  { name: 'missing_fact with a fact', gap: { code: 'missing_fact', message: 'Needs accounts.planType.', fact: 'accounts.planType' } },
  // A missing fact whose message names no fact: rule text, no control.
  { name: 'missing_fact naming no fact', gap: { code: 'missing_fact', message: 'Rows flagged missing_fact need review.' } },
];
// A missing fact with no fact field whose message names one (an older producer) still gets that fact's fix.
const recovered = gap => (gap.code === 'missing_fact' && !gap.fact && /accounts\.planType/.test(gap.message) ? 'accounts.planType' : null);
const NO_FIX = new Set(['incomplete_month', 'unequal_periods', 'outside_household_ledger', 'missing_fact']);

async function demoAsker(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  await seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const engine = await createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  const root = s.dataDir;
  // Asks once: household.figures returns the synthetic figure with `gap`; the engine's results are
  // kept so the test can see the tool result the model saw.
  return async gap => {
    const results = [];
    let n = 0;
    const synthetic = () => [{ key: FIGURE_KEY, ...envelope(VALUE, { unit: 'usd', label: 'Synthetic figure', kind: 'a', asOf: '2026-10-31',
      ref: { tool: 'household', args: FIGURES_CALL.args, path: '0' }, provenance: { calc: 'h4:synthetic' }, gaps: [gap] }) }];
    const wrapped = { ...engine, mode: engine.mode, isOn: () => engine.isOn(), call: async req => {
      const tools = req.tools.map(tool => tool.name !== 'household' ? tool : { ...tool,
        async handler(args, ctx) { return args.operation === 'figures' ? synthetic() : tool.handler(args, ctx); } });
      const fake = n++ === 0 ? [{ toolCalls: [FIGURES_CALL] }, { text: ANSWER }] : [{ text: ANSWER }];
      const res = await engine.call({ ...req, tools, fake });
      results.push(...(res.toolResults || []));
      return res;
    } };
    const reply = await createLiveAnswerer({ engine: wrapped, packs, root, services: { engine: wrapped, config: { dataDir: root } } })
      .answer({ db: s.db, key: THREAD, text: 'What is missing from my figures?' });
    return { reply, results };
  };
}

test('H4-AC1a every figure-gap code through scripted Ask keeps the value, discloses the gap in plain words and offers a fix that exists', async t => {
  assert.deepEqual(Object.keys(FIGURE_GAP_RULES).sort(), [...GAP_CODES].sort(), 'one FIGURE_GAP_RULES entry per gap code');
  for (const code of GAP_CODES) {
    const rule = FIGURE_GAP_RULES[code];
    assertPlain(rule.text, `${code} rule text`);
    assert.doesNotMatch(rule.text, /\d/, `${code} rule text has no digits`);
    assert.deepEqual(rule.fix, EXPECTED_FIX[code], `${code} rule fix`);
    if (rule.fix) assertFixTarget(rule.fix, `${code} rule fix`);
  }
  assert.deepEqual(new Set(GAP_CODES.filter(c => FIGURE_GAP_RULES[c].fix === null)), NO_FIX, 'the codes with no fix');

  const ask = await demoAsker(t);
  for (const { name, gap } of CASES) {
    const { reply, results } = await ask(gap);
    const what = `${name}`;
    assert.ok(Array.isArray(reply.paragraphs) && reply.paragraphs.length, `${what}: the answer is delivered`);
    // The partial value is kept: the figure the model read still carries its value beside the gap.
    const read = results.find(r => r.name === 'household' && r.args?.operation === 'figures' && !r.isError);
    assert.ok(read, `${what}: household.figures ran`);
    assert.equal(read.result[0].value, VALUE, `${what}: the figure keeps its value`);
    assert.deepEqual(read.result[0].gaps.map(g => g.code), [gap.code], `${what}: the figure keeps its gap`);
    assert.ok(reply.provenance.tools.some(x => x.name === 'household' && x.args?.operation === 'figures'), `${what}: the read is in provenance`);

    // Disclosed in plain words.
    const leftOut = reply.provenance.leftOut;
    assert.ok(Array.isArray(leftOut), `${what}: provenance.leftOut is present`);
    assert.deepEqual(leftOut.map(e => e.code), [gap.code], `${what}: one entry for the gap`);
    const entry = leftOut[0];
    assertPlain(entry.text, `${what} leftOut text`);
    assert.equal(entry.text, FIGURE_GAP_RULES[gap.code].text, `${what}: an internal message falls back to the rule text`);
    assert.deepEqual(entry, plainGap(gap), `${what}: the entry is plainGap(gap)`);

    // The fix target exists.
    const expected = gap.fact ? factFix(gap.fact) : recovered(gap) ? factFix(recovered(gap)) : EXPECTED_FIX[gap.code];
    assert.deepEqual(entry.fix, expected, `${what}: fix`);
    if (gap.fact) {
      assert.equal(entry.fix.screen, 'ask');
      assert.equal(entry.fix.key, gap.fact, `${what}: the fact's answer shape`);
    }
    if (entry.fix) assertFixTarget(entry.fix, `${what} fix`);
    else assert.ok(gap.code === 'missing_fact' ? !gap.fact : NO_FIX.has(gap.code), `${what}: no fix only for the NO_FIX codes`);

    // Rendered: the "What this leaves out" note with the plain line and one control per fix.
    const html = messageBodyHtml({ id: 'm1', html: '<p>x</p>', provenance: reply.provenance });
    const note = leftOutHtml(html);
    assert.ok(note, `${what}: the note renders`);
    assert.match(note, /What this leaves out/, `${what}: the note is headed`);
    assert.match(note, new RegExp(`data-left-out-code="${gap.code}"`), `${what}: the line carries its code`);
    assert.ok(note.includes(esc(entry.text)), `${what}: the line carries the plain text`);
    assert.ok(!note.includes(esc(gap.message)), `${what}: the internal message is not shown`);
    const controls = taxControls(note);
    if (entry.fix) {
      assert.equal(controls.length, 1, `${what}: one control`);
      assert.deepEqual(controls[0].fix, entry.fix, `${what}: the control carries the fix`);
      assert.equal(controls[0].label, entry.fix.label, `${what}: the control is labelled`);
    } else {
      assert.equal(controls.length, 0, `${what}: no control without a fix`);
    }
  }
});

test('H4-AC1a plainGap keeps a plain message, uses tax rules for a tax code, and gap-words stays a leaf', () => {
  const plainMessage = 'An account has not updated in a while.';
  assert.deepEqual(plainGap({ code: 'stale_account', message: plainMessage }),
    { code: 'stale_account', text: plainMessage, fix: EXPECTED_FIX.stale_account });
  const fromTax = plainGap({ code: 'missing_fact', taxCode: 'filing_status_assumed', message: 'Needs household.filingStatus.' });
  assert.equal(fromTax.code, 'missing_fact');
  assert.equal(fromTax.text, taxGap('filing_status_assumed').message, 'an internal tax message falls back to the tax rule text');
  assert.deepEqual(fromTax.fix, TAX_GAP_RULES.filing_status_assumed.fix);
  const keptTax = plainGap({ code: 'missing_fact', taxCode: 'filing_status_assumed', message: 'Filing status was assumed.' });
  assert.equal(keptTax.text, 'Filing status was assumed.');
  // A stored tax gap keeps its employer and its own action instead of a rebuilt generic one.
  const withEmployer = plainGap({ code: 'missing_fact', taxCode: 'paystub_ytd_missing', employer: 'Cedar Labs', message: 'Needs income.payrollYtd.' });
  assert.match(withEmployer.fix.prompt, /Cedar Labs/, 'the prompt names the employer');
  assert.match(withEmployer.text, /Cedar Labs/, 'the text names the employer');
  const own = { screen: 'ask', key: 'income.payrollYtd', label: 'Enter year-to-date pay', prompt: 'Record my year-to-date gross pay for Birch Studio.' };
  assert.deepEqual(plainGap({ code: 'missing_fact', taxCode: 'paystub_ytd_missing', action: own, message: 'x' }).fix, own, 'the gap action wins');

  for (const s of ['Needs accounts.planType.', 'missing_fact', 'Rows flagged uncategorized_rows.', 'See obligations.mortgage.balance'])
    assert.equal(hasInternalName(s), true, `internal: ${s}`);
  for (const s of ['Your plan type is missing.', 'The mortgage rate is missing; tell Fathom only this term.', "The children's birth dates are missing."])
    assert.equal(hasInternalName(s), false, `plain: ${s}`);

  const src = readFileSync(new URL('../src/shared/gap-words.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[0]);
  for (const line of imports) {
    assert.doesNotMatch(line, /answerShape/, `gap-words.mjs does not import answerShape: ${line}`);
    assert.doesNotMatch(line, /\/api\/|jobs\/triggers/, `gap-words.mjs imports nothing from src/api or the triggers: ${line}`);
  }
});

/* ---------- b. fact labels and real catalog projections ---------- */

const PINNED_LABEL_KEYS = ['accounts.planType', 'accounts.separationDate', 'accounts.rothBasis', 'accounts.rothFirstContributionYear',
  'household.birthYears', 'household.ownerBirthDate', 'household.spouseBirthDate', 'household.retireAge',
  'household.dependentBirthDates', 'household.dependentAges', 'obligations.childcareChangeDate', 'obligations.childcare',
  'obligations.mortgage', 'obligations.mortgage.balance', 'obligations.mortgage.rate', 'obligations.mortgage.monthlyPayment',
  'obligations.mortgage.escrowMonthly'];

// The key itself, or the nearest dotted prefix, with an answer shape.
function shapeKey(key) {
  const parts = key.split('.');
  while (parts.length >= 2) {
    const k = parts.join('.');
    try { answerShape(k); return k; } catch { parts.pop(); }
  }
  return null;
}

test('H4-AC1b every fact label is plain and has an answer shape (or its base key does)', () => {
  for (const key of PINNED_LABEL_KEYS) assert.ok(Object.hasOwn(FACT_LABELS, key), `FACT_LABELS has ${key}`);
  assert.equal(FACT_LABELS['accounts.planType'], 'its plan type');
  assert.equal(FACT_LABELS['household.retireAge'], 'a retirement age');
  assert.equal(FACT_LABELS['obligations.mortgage.rate'], 'the mortgage rate');
  for (const [key, label] of Object.entries(FACT_LABELS)) {
    assertPlain(label, `FACT_LABELS ${key}`);
    const base = shapeKey(key);
    assert.ok(base, `${key} or its base key has an answer shape`);
    const fix = factFix(key);
    assert.equal(fix.screen, 'ask', `factFix(${key}) opens Ask`);
    assert.equal(fix.key, base, `factFix(${key}) asks for ${base}`);
    assertFixTarget(fix, `factFix(${key})`);
  }
});

// A scratch store with retirement accounts and no birth, plan, retirement-age, dependent or full
// mortgage facts, so the catalog reads report what is missing.
async function missingFactsStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'h4-gaps-'));
  const db = await createRealStore(dir, { clock: '2026-11-05' });
  t.after(async () => { await closeRealStore(db); rmSync(dir, { recursive: true, force: true }); });
  const ctx = { db, dataDir: householdOf(db).root, clock: '2026-11-05', now: new Date('2026-11-05T12:00:00Z'), channel: 'mcp' };
  const account = async (id, kind, owner) => await db.prepare("INSERT INTO accounts(id,inst,name,kind,owner,parser) VALUES (?, 'Synthetic Bank', ?, ?, ?, 'aggregator')")
    .run(id, id, kind, owner);
  await account('checking', 'checking', 'Household');
  for (const [id, kind] of [['plan', 'retirement'], ['rothacct', 'roth'], ['broker', 'taxable'], ['mortgage', 'loan']]) {
    await account(id, kind, 'owner');
    await db.prepare('INSERT INTO balances(account_id,date,amount) VALUES (?,?,?)').run(id, '2026-10-31', 10000);
  }
  let n = 0;
  for (let m = 1; m <= 10; m++) {
    const date = `2026-${String(m).padStart(2, '0')}-10`;
    for (const [amount, category, description] of [[-300, 'Mortgage', 'Mortgage'], [-100, 'Groceries', 'Market'], [-200, 'Childcare', 'Daycare'], [1000, 'Income', 'Salary']]) {
      await db.prepare('INSERT INTO transactions(account_id,date,amount,category,description,parser,dedupe_key) VALUES (?,?,?,?,?,?,?)')
        .run('checking', date, amount, category, description, 'aggregator', `h4-${++n}`);
    }
  }
  // A mortgage with only its payment known: the other terms are missing.
  await addFact(db, 'obligations.mortgage', { monthlyPayment: 300 });
  return ctx;
}

function gapsIn(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value.gaps)) for (const g of value.gaps) if (g && GAP_CODES.includes(g.code)) out.push(g);
  for (const child of Object.values(value)) gapsIn(child, out);
  return out;
}

test('H4-AC1b real catalog projections with missing facts return plain gap messages that name their fact', async t => {
  const ctx = await missingFactsStore(t);
  const rate = v => ({ value: v, source: 'owner', evidence: `${Math.round(v * 100)} percent` });
  const reads = {
    access: [await callTool('retirement', { operation: 'access' }, ctx)],
    retirement: [await callTool('retirement', { operation: 'bridge' }, ctx),
      await callTool('retirement', { operation: 'after_tax', ordinaryRate: rate(0.2), capitalGainsRate: rate(0.15), stateRate: rate(0.05) }, ctx)],
    obligations: [await callTool('spending', { operation: 'obligations' }, ctx)],
    tax: [await callTool('tax', { operation: 'estimate' }, ctx)],
  };
  const facts = new Set();
  for (const [group, results] of Object.entries(reads)) {
    const gaps = results.flatMap(r => gapsIn(r));
    const missing = gaps.filter(g => g.code === 'missing_fact');
    assert.ok(missing.length > 0, `${group}: the scratch store produces missing-fact gaps`);
    for (const g of gaps) {
      assertPlain(g.message, `${group} gap message`);
      if (g.fact !== undefined) {
        facts.add(g.fact);
        assert.ok(Object.hasOwn(FACT_LABELS, g.fact), `${group}: gap fact ${g.fact} has a plain label`);
        assert.ok(shapeKey(g.fact), `${group}: gap fact ${g.fact} has an answer shape`);
      }
      const plain = plainGap(g);
      assertPlain(plain.text, `${group} plainGap text`);
      if (g.fact !== undefined) assert.deepEqual(plain.fix, factFix(g.fact), `${group}: a gap with a fact gets its fact's fix`);
    }
  }
  // The fact moved out of the message and onto the gap.
  const access = gapsIn(reads.access[0]);
  assert.ok(access.some(g => g.fact === 'accounts.planType'), 'access: the plan type gap names accounts.planType');
  const bridge = gapsIn(reads.retirement[0]);
  assert.ok(bridge.some(g => g.fact === 'household.retireAge'), 'bridge: the retirement age gap names household.retireAge');
  const obligations = gapsIn(reads.obligations[0]);
  assert.ok(obligations.some(g => g.fact === 'obligations.mortgage'), 'obligations: a mortgage term gap names obligations.mortgage');
  assert.ok(obligations.some(g => g.fact === 'household.dependentBirthDates'), "obligations: the children's dates gap names household.dependentBirthDates");
  const tax = gapsIn(reads.tax[0]);
  assert.ok(tax.some(g => g.message === 'No current planning figure is stored for this.' && g.fact === undefined), 'tax: a missing planning figure is plain and has no fact');
  assert.ok(facts.size > 0, 'some catalog gap names its fact');
});

/* ---------- c. goal-reason codes through goal rendering ---------- */

// The goal edit form's data-gf fields by kind (web/horizon/design.js goalFormHtml kindFieldsHtml).
const FIELDS = {
  balance: ['target', 'targetDate', 'track'],
  range: ['targetLow', 'targetHigh', 'targetDate', 'track'],
  floor: ['floor', 'track'],
  contribution: ['target', 'taxYear', 'targetDate', 'dest', 'shareOwner', 'shareSpouse', 'enteredTotal', 'enteredAsOf'],
};

const ownerGoal = kind => ({ id: `g-h4-${kind}`, origin: 'owner', kind, title: `Synthetic ${kind} goal`, status: 'open' });
const SEED = { id: 'g-h4-seed', origin: 'seed', kind: 'balance', title: 'Synthetic cushion', status: 'open' };

// The texts the Home card already shows, kept as they are.
const KEPT_TEXT = {
  stale_data: 'The data behind it is past its update cadence.',
  unknown_freshness: 'How current the data is cannot be told yet.',
  undated_actual: 'The tracked value has no date.',
  projected_actual: 'The tracked value is a projection, not a reading.',
  missing_actual: 'Nothing tracks this goal yet.',
  missing_plan_start: 'The plan has no starting point to measure from.',
  invalid_plan_dates: 'The target date is not after the plan start.',
  non_increasing_path: 'The target is not above where the plan started.',
  no_target: 'This goal has no target amount and date.',
  missing_actual_history: 'No monthly readings exist yet.',
  missing_household_savings_plan: 'No household savings plan by month is stored yet.',
  missing_meter_inputs: 'The figures this needs are not stored yet.',
  missing_month_actual: 'No reading for this month.',
  missing_contributions: 'No contributions are recorded or entered yet.',
  kind_not_charted: 'This kind of goal has no monthly chart.',
};

// The pinned fixes (plan, Design 6), each on the goal kind it naturally belongs to.
const goalFix = (kind, field, label) => ({ screen: 'goal', field, label, id: ownerGoal(kind).id });
const GOAL_FIX = {
  stale_data: ['balance', { screen: 'upload', kind: 'aggregator', label: 'Import recent data' }],
  unknown_freshness: ['balance', goalFix('balance', 'track', 'Track a dated account')],
  undated_actual: ['balance', goalFix('balance', 'track', 'Track a dated account')],
  projected_actual: ['balance', goalFix('balance', 'track', 'Track an actual balance')],
  missing_actual: ['balance', goalFix('balance', 'track', 'Choose what tracks it')],
  missing_plan_start: ['balance', goalFix('balance', 'track', 'Choose what tracks it')],
  invalid_plan_dates: ['balance', goalFix('balance', 'targetDate', 'Fix the target date')],
  non_increasing_path: ['balance', goalFix('balance', 'target', 'Raise the target')],
  no_target: ['balance', goalFix('balance', 'target', 'Set a target')],
  missing_actual_history: ['balance', { screen: 'upload', kind: 'bank', label: 'Upload past statements' }],
  missing_household_savings_plan: ['balance', { screen: 'goal-new', label: 'Add a savings goal' }],
  missing_meter_inputs: ['balance', { screen: 'upload', kind: 'paystub', label: 'Upload a paystub' }],
  missing_month_actual: ['balance', { screen: 'upload', kind: 'bank', label: 'Upload that statement' }],
  missing_contributions: ['contribution', goalFix('contribution', 'enteredTotal', 'Enter what was contributed')],
  kind_not_charted: ['floor', null],
  no_spending_history: ['balance', { screen: 'upload', kind: 'aggregator', label: 'Import more spending' }],
};

function assertGoalFixTarget(fix, goal, what) {
  assert.ok(fix && typeof fix.label === 'string' && fix.label.trim(), `${what}: fix has a label`);
  assertPlain(fix.label, `${what} label`);
  if (fix.screen === 'goal') {
    assert.equal(goal.origin, 'owner', `${what}: only an owner goal opens its edit form`);
    assert.equal(fix.id, goal.id, `${what}: the fix names the goal`);
    assert.ok(FIELDS[goal.kind].includes(fix.field), `${what}: the ${goal.kind} edit form has field ${fix.field}`);
  } else if (fix.screen === 'goal-new') {
    // Valid with a label.
  } else if (fix.screen === 'upload') {
    assert.ok(Object.hasOwn(HOWTO, fix.kind), `${what}: upload kind ${fix.kind} exists`);
  } else {
    assert.equal(fix.screen, 'ask', `${what}: a goal fix opens the goal, a new goal, an upload or Ask`);
    assert.equal(fix.key, undefined, `${what}: a goal Ask fix is keyless`);
    assert.ok(typeof fix.prompt === 'string' && fix.prompt.startsWith(`Change my goal "${goal.title}": `), `${what}: Ask is prefilled for the goal: ${fix.prompt}`);
  }
}

function assertOneControl(fix, what) {
  const html = goalReasonControl(fix, esc);
  const all = [...taxControls(html), ...goalControls(html)];
  assert.equal(all.length, 1, `${what}: exactly one control in ${html}`);
  assert.deepEqual(all[0].fix, fix, `${what}: the control carries the fix`);
  assert.equal(all[0].label, fix.label, `${what}: the control is labelled`);
  if (fix.screen === 'goal' || fix.screen === 'goal-new') assert.equal(goalControls(html).length, 1, `${what}: a goal fix is a data-goal-fix button`);
  else assert.equal(taxControls(html).length, 1, `${what}: an Ask or upload fix is a data-tax-gap-fix button`);
}

// Every reason literal the pace sources emit: snake_case literals on reason lines of the pace
// calculators, the returns of dataState (its value becomes a reason), and the missing codes of the
// target calculator.
function emittedReasons() {
  const out = new Set();
  const literals = code => [...code.replace(/\/\/.*$/gm, '').matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)].map(m => m[1]);
  for (const file of ['../src/calc/pace.mjs', '../src/pace/build.mjs']) {
    for (const line of readFileSync(new URL(file, import.meta.url), 'utf8').split('\n')) {
      if (/\breason\b/.test(line.replace(/\/\/.*$/, ''))) for (const code of literals(line)) out.add(code);
    }
  }
  const pace = readFileSync(new URL('../src/calc/pace.mjs', import.meta.url), 'utf8');
  const dataState = /export function dataState\b[\s\S]*?\n}\n/.exec(pace);
  assert.ok(dataState, 'pace.mjs defines dataState');
  for (const code of literals(dataState[0])) out.add(code);
  for (const m of readFileSync(new URL('../src/calc/targets.mjs', import.meta.url), 'utf8').matchAll(/missing\.push\('([a-z_]+)'\)/g)) out.add(m[1]);
  return out;
}

test('H4-AC1c every goal-reason code has plain text and a fix whose target exists, rendered as one control', () => {
  for (const code of Object.keys(GOAL_FIX)) assert.ok(Object.hasOwn(GOAL_REASONS, code), `GOAL_REASONS has ${code}`);
  for (const [code, text] of Object.entries(KEPT_TEXT)) {
    assert.equal(GOAL_REASONS[code].text, text, `${code} keeps its text`);
    assert.equal(reasonText(code), text, `reasonText(${code}) is unchanged`);
  }
  assert.equal(reasonText('no_such_reason'), 'Not enough data yet');

  for (const [code, rule] of Object.entries(GOAL_REASONS)) {
    assertPlain(rule.text, `${code} text`);
    assert.equal(reasonText(code), rule.text, `reasonText(${code}) reads the table`);
  }

  // The pinned fixes on their natural goal kinds.
  for (const [code, [kind, expected]] of Object.entries(GOAL_FIX)) {
    const goal = ownerGoal(kind);
    const fix = goalReasonFix(code, goal);
    assert.deepEqual(fix, expected, `${code} on a ${kind} goal`);
    if (fix) {
      assertGoalFixTarget(fix, goal, code);
      assertOneControl(fix, code);
    }
  }

  // Every code on every kind of owner goal: a fix whose target exists; null only for kind_not_charted.
  for (const code of Object.keys(GOAL_REASONS)) {
    for (const kind of Object.keys(FIELDS)) {
      const goal = ownerGoal(kind);
      const fix = goalReasonFix(code, goal);
      const what = `${code} on a ${kind} goal`;
      if (code === 'kind_not_charted') { assert.equal(fix, null, `${what}: no fix`); continue; }
      assert.ok(fix, `${what}: has a fix`);
      assertGoalFixTarget(fix, goal, what);
      assertOneControl(fix, what);
    }
  }

  // Kind remaps: a field the kind lacks moves to the kind's own field, else the fix is an Ask.
  assert.deepEqual(goalReasonFix('no_target', ownerGoal('range')), goalFix('range', 'targetLow', 'Set a target'));
  assert.deepEqual(goalReasonFix('no_target', ownerGoal('floor')), goalFix('floor', 'floor', 'Set a target'));
  assert.deepEqual(goalReasonFix('missing_actual', ownerGoal('contribution')), goalFix('contribution', 'dest', 'Choose what tracks it'));
  assert.deepEqual(goalReasonFix('invalid_plan_dates', ownerGoal('floor')),
    { screen: 'ask', label: 'Fix the target date', prompt: 'Change my goal "Synthetic floor goal": fix the target date.' });

  // A goal that came with the demo cannot be edited (src/goals/write.mjs checkGoal), so a goal field
  // fix on it offers no control rather than one that cannot work.
  assert.equal(goalReasonFix('missing_actual', SEED), null, 'no edit control on a seed goal');
  assert.equal(goalReasonControl(goalReasonFix('missing_actual', SEED), esc), '');
  // A split contribution goal with no entered total shows per-person amounts, so the fix names one.
  const split = { ...ownerGoal('contribution'), split: [{ person: 'spouse', amount: 1 }] };
  assert.equal(goalReasonFix('missing_contributions', split).field, 'enteredSpouse');
  assert.equal(goalReasonFix('missing_contributions', { ...split, entered: { total: 5 } }).field, 'enteredTotal');
  assert.deepEqual(goalReasonFix('stale_data', SEED), GOAL_FIX.stale_data[1], 'an upload fix does not depend on the goal');
  assert.equal(goalReasonControl(null, esc), '', 'no control without a fix');

  // Every reason the pace sources emit is in the table.
  const emitted = emittedReasons();
  assert.ok(emitted.size >= Object.keys(GOAL_FIX).length - 1, `the scan finds the reason literals: ${[...emitted].join(', ')}`);
  for (const code of emitted) assert.ok(Object.hasOwn(GOAL_REASONS, code), `emitted reason ${code} is in GOAL_REASONS`);
});

test('H4-AC1 a message with only leftOut still renders, and an older message without it is unchanged', () => {
  const fix = EXPECTED_FIX.stale_account;
  const html = messageBodyHtml({ id: 'm2', html: '<p>x</p>', provenance: { leftOut: [{ code: 'stale_account', text: 'An account has not updated in a while.', fix }] } });
  assert.ok(html.startsWith('<p>x</p>'), 'the answer comes first');
  const note = leftOutHtml(html);
  assert.ok(note, 'the note renders with no blocks or notes');
  assert.match(note, /role="note"/);
  assert.deepEqual(taxControls(note).map(c => c.fix), [fix]);
  assert.equal(messageBodyHtml({ id: 'm3', html: '<p>x</p>', provenance: { blocks: [], blockNotes: [] } }), '<p>x</p>');
  assert.equal(messageBodyHtml({ id: 'm4', html: '<p>x</p>', provenance: { leftOut: [] } }), '<p>x</p>');
});
