// The Ask proposal card and its receipt read as plain language (PX1): a proposal to set aside a
// recommendation goes through the real answerer and handlers, then renders through chat.js. The
// card and the confirmed receipt name the rec by its title and the status as the UI says it, and
// show no id, enum code or argument line. All household values here are synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createEvalStore } from '../evals/harness.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import * as handlers from '../src/api/handlers.mjs';

const now = '2026-11-07T12:00:00.000Z';
const REC = 'px1-dependent-care';
const TITLE = 'Enroll in a dependent care FSA for next year';
const SENTENCE = `Set aside the recommendation "${TITLE}" as Not for us.`;

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('/shared/')) return next(new URL(`../src/shared/${specifier.slice('/shared/'.length)}`, import.meta.url).href, context);
  return next(specifier, context);
} });
const chat = await import('../web/horizon/screens/chat.js');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
chat.bind({ esc, T: esc, X: esc, arr: v => (Array.isArray(v) ? v : []), root: null, ui: { det: {} }, href: () => '#',
  api: { s: { goals: [] }, rec: () => null, txt: s => s, threads: () => [], conversation: () => [] } });

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const plain = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39);/g, m => ENTITIES[m]).replace(/\s+/g, ' ').trim();

function scriptedEngine(turns) {
  const transport = createEngine({ mode: 'fake' });
  const queue = [...turns];
  return { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: 'Dependent care', toolResults: [] });
    return transport.call({ ...request, fake: queue.shift() ?? [{ text: 'Nothing else to change.' }] });
  } };
}

async function proposed(t) {
  const s = await createEvalStore();
  t.after(async () => await s.close());
  await s.db.prepare('INSERT INTO recs (id, def, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(REC, JSON.stringify({ id: REC, title: TITLE, summary: 'A synthetic rec.', tasks: [] }), 'proposed', now);
  const engine = scriptedEngine([[
    { toolCalls: [{ name: 'act_on_recommendation', args: { operation: 'status', id: REC, status: 'dismissed', propose: true } }] },
    { text: 'I can set that recommendation aside. Confirm below.' },
  ]]);
  const ctx = { db: s.db, config: {}, answerer: createLiveAnswerer({ engine, root: s.root, services: { engine, config: { dataDir: s.root } } }) };
  const first = await handlers.threadCreate({ ...ctx, body: { text: 'Set aside the dependent care recommendation.' } });
  return { db: s.db, ctx, first };
}

function noCodes(text) {
  assert.ok(!/\bid:/.test(text), `no "id:" in ${text}`);
  assert.ok(!/\bstatus:/.test(text), `no "status:" in ${text}`);
  assert.ok(!text.includes(REC), `no rec id in ${text}`);
  assert.ok(!/\bdismissed\b/.test(text), `no status code in ${text}`);
  assert.ok(!/act on recommendation/i.test(text), `no tool name in ${text}`);
}

test('AC3 the card for a dismissed recommendation shows its title and Not for us, and the receipt matches', async t => {
  const { db, ctx, first } = await proposed(t);
  const pending = first.message.provenance.pendingAction;
  assert.ok(pending, 'the reply carries the proposal');
  assert.equal(pending.description, SENTENCE, 'the server stored the description with the proposal');

  const card = plain(chat.pendingActionHtml(first.message));
  assert.ok(card.includes(SENTENCE), card);
  assert.ok(card.includes(TITLE) && card.includes('Not for us'), card);
  assert.ok(card.includes('Confirm') && card.includes('Not now'), 'Confirm and Not now stay');
  noCodes(card);

  const out = await handlers.proposalDecide({ ...ctx, params: { id: first.thread.id, messageId: first.message.id }, body: { decision: 'confirm' } });
  assert.equal((await db.prepare('SELECT status FROM recs WHERE id = ?').get(REC)).status, 'dismissed', 'the change ran');
  assert.equal(out.message.provenance.actions?.length, 1, 'one receipt');
  const receipt = plain(chat.workHtml(out.message));
  assert.ok(receipt.includes(SENTENCE), receipt);
  assert.ok(receipt.includes('Undo'), 'Undo stays');
  noCodes(receipt);

  // The thread as served later renders the same receipt, and the resolved card keeps its sentence.
  const served = await handlers.threadGet({ ...ctx, params: { id: first.thread.id } });
  const card2 = served.messages.find(m => m.id === first.message.id);
  assert.ok(plain(chat.pendingActionHtml(card2)).includes(SENTENCE));
  assert.ok(plain(chat.pendingActionHtml(card2)).includes('Confirmed'));
  assert.ok(plain(chat.workHtml(served.messages.find(m => m.id === out.message.id))).includes(SENTENCE));
});

test('AC3 a stored proposal from before descriptions renders a readable sentence, never argument lines', async t => {
  const { db, ctx, first } = await proposed(t);
  const id = Number(first.message.id.slice(1));
  const row = await db.prepare('SELECT provenance FROM messages WHERE id = ?').get(id);
  const provenance = JSON.parse(row.provenance);
  delete provenance.pendingAction.description;
  delete provenance.pendingAction.details;
  await db.prepare('UPDATE messages SET provenance = ? WHERE id = ?').run(JSON.stringify(provenance), id);
  const served = await handlers.threadGet({ ...ctx, params: { id: first.thread.id } });
  const card = plain(chat.pendingActionHtml(served.messages.find(m => m.id === first.message.id)));
  assert.ok(card.includes(SENTENCE), card);
  noCodes(card);
  // Even with no description at all, the browser shows no argument lines.
  const bare = plain(chat.pendingActionHtml({ id: 'm9', role: 'fathom', provenance: { pendingAction: { tool: 'act_on_recommendation', operation: 'status', args: { id: REC, status: 'dismissed' } } } }));
  noCodes(bare);
});

test('AC3 detail lines render escaped with their labels', () => {
  const html = chat.pendingActionHtml({ id: 'm3', role: 'fathom', provenance: { pendingAction: { tool: 'update_goal', operation: 'edit', args: { id: 'g1' },
    description: 'Update the goal "<b>Cushion</b>".', details: [{ label: 'Timeframe', value: 'Long range (was This year)' }, { label: 'bad' }] } } });
  assert.ok(!html.includes('<b>Cushion</b>') && html.includes('&lt;b&gt;Cushion&lt;/b&gt;'), 'escaped');
  assert.ok(plain(html).includes('Timeframe: Long range (was This year)'));
  assert.ok(!plain(html).includes('bad'), 'a malformed detail line is dropped');
  assert.ok(!plain(html).includes('g1'));
});
