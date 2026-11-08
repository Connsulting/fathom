// AQ1 AC2, AC4 and AC5: Ask answer quality. A prose amount grounds against a signed (outflow)
// transaction row and is sourced to that row (account, date, description); a date matching a row
// date is sourced to that row; a lone unsourced amount is neutralized in place instead of
// regenerating the whole answer; only an answer whose figures are mostly unsourced (two or more,
// and more than half) is regenerated, once, shown as one "Revised to remove N unchecked figures"
// step; the prompt asks for a short, direct answer and explains where spending lives; the tool
// descriptions name card accounts, categories and business P&L.
//
// The live path runs a real fake-mode engine (createEngine) over a real store (createRealStore)
// holding one synthetic card account and its transactions. The engine wrapper sends each call's
// own scripted rounds as request.fake. Every name and amount here is invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealStore, householdOf, CLOCK } from './helpers/real-store.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { callTool, tools as REGISTRY, instructions } from '../src/tools/index.mjs';
import {
  createLiveAnswerer, groundAnswer, buildChatPrompt, PRODUCT_RULES, ANSWER_STYLE,
} from '../src/api/answerer.mjs';

const THREAD = 'ask:0a1b2c3d4e5f';
const CARD = 'acct-synthetic-card';
const CARD_NAME = 'Synthetic rewards card';
const ROOF = { date: '2026-10-03', amount: -2417.38, description: 'Synthetic Roofing Co', category: 'Home improvement' };
const GROCER = { date: '2026-10-05', amount: -64.12, description: 'Synthetic Grocer', category: 'Groceries' };
const ROOF_TEXT = '$2,417.38';
const GROCER_TEXT = '$64.12';
const INVENTED = '$987,654';
const INVENTED_2 = '$876,543';
const UNCHECKED_OPEN = '<span class="fx-checking fx-unchecked" title="Not checked against your data">';
const QUERY = { name: 'transactions', args: { operation: 'search',  accountId: CARD } };
const revised = n => `Revised to remove ${n} unchecked figure${n === 1 ? '' : 's'}`;

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const joined = reply => reply.paragraphs.join('\n');

// An empty real store plus one card account (owner display name set, so its label is fixed) and
// two outflow rows. Amounts are signed: outflows are negative, as the demo ledger and ingest store them.
async function cardStore(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fathom-askq-'));
  const db = await createRealStore(dataDir);
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dataDir, { recursive: true, force: true });
  });
  db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, display_name, sort)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(CARD, 'Example Card Co', '7319', 'Rewards card', null, 'card', 'connected', CARD_NAME, 0);
  const tx = db.prepare('INSERT INTO transactions (account_id, date, amount, description, category) VALUES (?, ?, ?, ?, ?)');
  for (const r of [ROOF, GROCER]) tx.run(CARD, r.date, r.amount, r.description, r.category);
  const root = householdOf(db).root;
  const packs = createLivePacks(db, { dataDir: root });
  packs.refresh();
  // The account label every surface shows, read the way accounts.list reads it.
  const label = (await callTool('accounts', { operation: 'list' }, { db, now: CLOCK })).find(a => a.id === CARD).name;
  return { db, dataDir, root, packs, label };
}

// A real fake-mode engine whose n-th call runs scripts[n] (the last script repeats).
function fakeEngine(scripts) {
  const inner = createEngine({ mode: 'fake' });
  const calls = [];
  const engine = {
    mode: 'fake',
    isOn: () => true,
    call(request) {
      const n = calls.length;
      calls.push(request);
      return inner.call({ ...request, fake: scripts[Math.min(n, scripts.length - 1)] });
    },
  };
  return { engine, calls };
}

async function ask(s, scripts, { onEvent } = {}) {
  const { engine, calls } = fakeEngine(scripts);
  const reply = await createLiveAnswerer({ engine, packs: s.packs, root: s.root }).answer({
    db: s.db, key: THREAD, text: 'Where did my card spending go last month?', ...(onEvent ? { onEvent } : {}),
  });
  return { reply, calls };
}

// The title of the fx-src span around `inner`, or null.
function sourceTitle(html, inner) {
  const m = new RegExp(`<span class="fx-src" data-src="\\d+" title="([^"]*)">${reEsc(inner)}</span>`).exec(html);
  return m ? m[1] : null;
}

function expectRowSource(source, s, what) {
  assert.equal(typeof source, 'string', `${what}: a source label`);
  for (const part of [s.label, ROOF.date, ROOF.description]) {
    assert.ok(source.includes(part), `${what}: "${source}" names ${part}`);
  }
}

/* ---------- (a) signed amounts ---------- */

// Review r1 F2: only a transaction row's amount is read unsigned. A business loss never grounds
// the same amount stated as a profit, and no other tool's negative value is mirrored.
test('a negative value outside transaction amounts does not ground its unsigned form', () => {
  const toolResults = [{ name: 'business', args: { operation: 'pnl', }, result: {
    rows: [{ period: '2026-09', category: 'Net', amount: -2400 }], totals: { '2026-09': -2400 },
  } }];
  const r = groundAnswer('Your profit was $2,400 in September.', { scenario: { fig: {} }, toolResults, data: [] });
  assert.deepEqual(r.violations.map(v => v.text), ['$2,400'], JSON.stringify(r.violations));
  assert.equal(groundAnswer('Your loss was -$2,400.', { scenario: { fig: {} }, toolResults, data: [] }).ok, true);
});

// Review r1 F3: a date under any data key (asOf here), not only "date", is sourced to its row.
test('a prose date matching an asOf date in a same-turn tool result is sourced to that tool', () => {
  const toolResults = [{ name: 'accounts', args: { operation: 'list', }, result: [
    { id: 'acct-synthetic-checking', name: 'Synthetic checking', kind: 'checking', balance: 1500, asOf: '2026-10-07' },
  ] }];
  const r = groundAnswer('Your checking balance is as of October 7.', { scenario: { fig: {} }, toolResults, data: [] });
  const hit = r.literals.find(l => l.text === 'October 7');
  assert.ok(hit, JSON.stringify(r.literals));
  assert.equal(hit.source, 'your accounts');
});


test('groundAnswer grounds an unsigned prose amount on an outflow transaction row', () => {
  const toolResults = [{ name: 'transactions', args: { operation: 'search', }, result: {
    rows: [{ id: 7, accountId: CARD, date: '2026-10-03', amount: -2400, description: 'Synthetic Roofing Co', category: 'Home improvement' }],
    truncated: false, total: 1,
  } }];
  const r = groundAnswer('You paid $2,400.00 for the roof.', { scenario: { fig: {} }, toolResults, data: [] });
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  assert.equal(r.ok, true);
  assert.ok(r.literals.some(l => l.text === '$2,400.00'), JSON.stringify(r.literals));
  // The signed form still grounds too.
  assert.equal(groundAnswer('The change was -$2,400.', { scenario: { fig: {} }, toolResults, data: [] }).ok, true);
});

test('a transaction amount in the answer is sourced to its row: account label, date and description', async t => {
  const s = await cardStore(t);
  const { reply } = await ask(s, [[{ toolCalls: [QUERY] }, { text: `You paid ${ROOF_TEXT} for the roof.` }]]);
  assert.ok(!reply.notice, JSON.stringify(reply));
  assert.deepEqual(reply.provenance.grounding.unverified, []);
  const literal = reply.provenance.literals.find(l => l.text === ROOF_TEXT);
  assert.ok(literal, JSON.stringify(reply.provenance.literals));
  expectRowSource(literal.source, s, 'literal');
  assert.notEqual(literal.source, 'transactions', 'never the raw tool name');
  const title = sourceTitle(joined(reply), ROOF_TEXT);
  assert.ok(title, joined(reply));
  expectRowSource(title, s, 'span title');
});

/* ---------- (b) dates ---------- */

test('a date in the answer that matches a same-turn row date is a literal with that row label; others stay plain', async t => {
  const s = await cardStore(t);
  for (const date of ['October 3', '10/3/2026', 'Oct 3, 2026']) {
    const { reply } = await ask(s, [[{ toolCalls: [QUERY] }, { text: `On ${date} you paid ${ROOF_TEXT} for the roof.` }]]);
    assert.equal(reply.provenance.grounding.ok, true, JSON.stringify(reply.provenance.grounding));
    const literal = reply.provenance.literals.find(l => l.text === date);
    assert.ok(literal, `${date}: ${JSON.stringify(reply.provenance.literals)}`);
    expectRowSource(literal.source, s, date);
    const title = sourceTitle(joined(reply), date);
    assert.ok(title, `${date}: ${joined(reply)}`);
    expectRowSource(title, s, `${date} span`);
  }
  const { reply } = await ask(s, [[{ toolCalls: [QUERY] }, { text: `On October 9 you paid ${ROOF_TEXT} for the roof.` }]]);
  // Review r2 F5: an unmatched date is neutralized in place, like an unsourced amount, but it never
  // counts toward a regeneration on its own.
  assert.equal(reply.provenance.grounding.ok, false, 'an unmatched date is unchecked');
  assert.deepEqual(reply.provenance.grounding.unverified, ['October 9']);
  assert.ok(!reply.provenance.literals.some(l => l.text === 'October 9'), JSON.stringify(reply.provenance.literals));
  assert.ok(joined(reply).includes(`On ${UNCHECKED_OPEN}October 9</span> you paid <span`), joined(reply));
  assert.equal(reply.provenance.grounding.retried, false);
});

// Review r3 F6: yearless evidence ("April 15" in pack prose) sources a yearless prose date only; a
// prose date that states a year needs evidence with that year.
test('a stated year needs evidence with that year; yearless evidence sources only a yearless date', () => {
  const data = ['Quarterly estimates are due April 15 and June 15.'];
  const g = text => groundAnswer(text, { scenario: { fig: {} }, toolResults: [], data, dataLabels: ['knowledge pack entries'] });
  const bare = g('Your installment is due April 15.');
  assert.equal(bare.literals.find(l => l.text === 'April 15')?.source, 'knowledge pack entries', JSON.stringify(bare.literals));
  const yeared = g('Your installment is due April 15, 2028.');
  assert.deepEqual(yeared.violations.map(v => v.text), ['April 15, 2028'], JSON.stringify(yeared));
  assert.ok(!yeared.literals.some(l => l.text === 'April 15, 2028'));
});

test('unmatched dates never trigger a regeneration; a date in the household data is sourced to it', async t => {
  const s = await cardStore(t);
  const { reply, calls } = await ask(s, [[{ toolCalls: [QUERY] }, { text: `On October 9 and October 11 you paid ${ROOF_TEXT}.` }]]);
  assert.equal(calls.length, 1, 'two unchecked dates alone do not regenerate');
  assert.deepEqual(reply.provenance.grounding.unverified, ['October 9', 'October 11']);
  const summary = await callTool('household', { operation: 'summary', }, { db: s.db, now: CLOCK });
  const [y, m, d] = String(summary.clock).split('-').map(Number);
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1];
  const today = `${month} ${d}, ${y}`;
  const { reply: dated } = await ask(s, [[{ toolCalls: [QUERY] }, { text: `As of ${today} you paid ${ROOF_TEXT}.` }]]);
  const lit = dated.provenance.literals.find(l => l.text === today);
  assert.ok(lit, JSON.stringify(dated.provenance.literals));
  assert.equal(lit.source, 'household summary');
  assert.equal(dated.provenance.grounding.ok, true, JSON.stringify(dated.provenance.grounding));
});

/* ---------- (c) one invented amount: neutralized in place, no regeneration ---------- */

test('one sourced and one invented amount: one engine call, the sourced amount is fx-src, the invented one is unchecked in place', async t => {
  const s = await cardStore(t);
  const text = `You paid ${ROOF_TEXT} for the roof, and about ${INVENTED} more is still open.`;
  const { reply, calls } = await ask(s, [[{ toolCalls: [QUERY] }, { text }]]);
  assert.ok(!reply.notice, JSON.stringify(reply));
  assert.equal(calls.length, 1, 'no regeneration');
  const html = joined(reply);
  const title = sourceTitle(html, ROOF_TEXT);
  assert.ok(title, html);
  assert.ok(title.includes(ROOF.description), title);
  assert.ok(html.includes(`${UNCHECKED_OPEN}${INVENTED}</span>`), html);
  assert.ok(!html.includes('fx-unverified'), html);
  const { grounding, work } = reply.provenance;
  assert.equal(grounding.retried, false);
  assert.equal(grounding.ok, false);
  assert.deepEqual(grounding.unverified, [INVENTED]);
  assert.equal(grounding.revised, undefined);
  assert.equal(work.items.some(x => x.draft), false, JSON.stringify(work.items));
  assert.equal(work.items.some(x => x.k === 'note' && x.text.trim() === text), false, 'the answer is not a work note');
  assert.equal(work.items.some(x => x.k === 'step' && /^Revised/.test(x.label)), false);
});

/* ---------- (d) the regeneration threshold ---------- */

test('two of three figures unsourced regenerates once, shown as one revision step, with a plain reset after it', async t => {
  const s = await cardStore(t);
  const first = `You paid ${ROOF_TEXT}, plus ${INVENTED} and ${INVENTED_2} elsewhere.`;
  const second = `You paid ${ROOF_TEXT} for the roof.`;
  const seen = [];
  const { reply, calls } = await ask(s, [
    [{ toolCalls: [QUERY] }, { text: first }],
    [{ text: second }],
  ], { onEvent: e => seen.push(e) });
  assert.ok(!reply.notice, JSON.stringify(reply));
  assert.equal(calls.length, 2, 'exactly one regeneration');
  assert.deepEqual(reply.provenance.grounding, { ok: true, retried: true, unverified: [], revised: 2 });
  assert.ok(sourceTitle(joined(reply), ROOF_TEXT), joined(reply));

  const { items } = reply.provenance.work;
  assert.equal(items.filter(x => x.k === 'step' && x.label === revised(2)).length, 1, JSON.stringify(items));
  assert.equal(items.filter(x => x.k === 'step' && /^Revised/.test(x.label)).length, 1);
  assert.equal(items.some(x => x.draft), false, 'no draft note');
  assert.equal(items.some(x => x.k === 'note' && x.text.trim() === first), false, 'the first answer is not a work note');

  const at = seen.findIndex(e => e.type === 'progress' && e.label === revised(2));
  const resets = seen.filter(e => e.type === 'reset');
  assert.ok(at > seen.findIndex(e => e.type === 'text'), 'the first answer streamed before the revision step');
  assert.deepEqual(resets, [{ type: 'reset' }], 'one plain reset');
  assert.ok(seen.indexOf(resets[0]) > at, 'the revision step comes before the reset');
  assert.equal(seen.some(e => 'draft' in e), false, 'no event carries a draft flag');
  const after = seen.slice(seen.indexOf(resets[0]) + 1).filter(e => e.type === 'text').map(e => e.text).join('');
  assert.equal(after, second);
});

test('one invented amount among two sourced ones, or two among four, does not regenerate', async t => {
  const s = await cardStore(t);
  for (const text of [
    `You paid ${ROOF_TEXT} and ${GROCER_TEXT}, and ${INVENTED} is still open.`,
    `You paid ${ROOF_TEXT} and ${GROCER_TEXT}, and ${INVENTED} plus ${INVENTED_2} are still open.`,
  ]) {
    const { reply, calls } = await ask(s, [[{ toolCalls: [QUERY] }, { text }], [{ text: 'must not run' }]]);
    assert.equal(calls.length, 1, `no regeneration: ${text}`);
    assert.equal(reply.provenance.grounding.retried, false, text);
    const html = joined(reply);
    assert.ok(html.includes(`${UNCHECKED_OPEN}${INVENTED}</span>`), html);
    assert.ok(sourceTitle(html, ROOF_TEXT) && sourceTitle(html, GROCER_TEXT), html);
    assert.ok(!html.includes('must not run'));
  }
});

/* ---------- (e) the prompt ---------- */

test('the static system prompt carries PRODUCT_RULES, then the answer style and the spending guide', () => {
  const { system } = buildChatPrompt({ packContextText: '{}', summary: { needsYouCount: 3 }, question: 'Synthetic question?' });
  assert.equal(typeof ANSWER_STYLE, 'string');
  assert.equal(typeof instructions, 'string');
  assert.ok(system.includes(PRODUCT_RULES), 'the product rules stay');
  assert.ok(system.includes(ANSWER_STYLE), 'the answer style is in the system prompt');
  assert.ok(system.includes(instructions), 'registry instructions are in the system prompt');
  assert.ok(system.indexOf(ANSWER_STYLE) > system.indexOf(PRODUCT_RULES), 'the style section follows the product rules');
  assert.ok(!PRODUCT_RULES.includes(ANSWER_STYLE), 'a separate section, not folded into PRODUCT_RULES');

  assert.match(ANSWER_STYLE, /direct answer/i);
  assert.match(ANSWER_STYLE, /one or two sentences/i);
  assert.match(ANSWER_STYLE, /150 words/i);
  assert.match(ANSWER_STYLE, /unless[^.]*\bask[^.]*detail/i);
  assert.match(ANSWER_STYLE, /at most one (?:short )?list/i);
  assert.match(ANSWER_STYLE, /caveats?/i);
  assert.match(ANSWER_STYLE, /offer/i);
  assert.match(ANSWER_STYLE, /next (?:useful )?step/i);

  assert.match(instructions, /business.pnl/);
  assert.match(instructions, /transactions.search/);
});

/* ---------- (f) tool descriptions ---------- */

// The registry as of this change: descriptions changed, no tool added or removed.
const TOOL_NAMES = ['accounts', 'act_on_recommendation', 'answer', 'business', 'calculate', 'goals', 'household', 'knowledge', 'recommendations', 'tax', 'transactions', 'undo', 'update_goal', 'update_preferences'];

test('transactions.search names credit cards and categories, business.pnl names business, and no tool is added', () => {
  const byName = new Map(REGISTRY.map(x => [x.name, x]));
  assert.match(byName.get('transactions').description, /credit cards?/i);
  assert.match(byName.get('transactions').description, /categor/i);
  assert.match(byName.get('business').description, /business/i);
  assert.deepEqual(REGISTRY.map(x => x.name), TOOL_NAMES.toSorted());
});
