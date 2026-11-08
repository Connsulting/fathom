// Note actions on Files: a stored note proposes its actions in one sentence, applies them on
// "Looks right" with a shared Undo, and an unanchored note asks for its date in plain words. Every
// value is synthetic; the actions go through the real staging service.

import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';
import { withLocalHousehold } from './local-store.mjs';
import { indexSource } from '../src/ingest/model-source.mjs';
import { ingestFile } from '../src/ingest/pipeline.mjs';
import { stageUpdate } from '../src/ingest/model-updates.mjs';

test.skip(REMOTE, 'requires a local synthetic store');

const NOW = '2032-03-10T12:00:00.000Z';
const NOTE = 'Payroll true-up done, the payroll provider pays next Tuesday.';
const REC = 'synthetic-payroll';

const pathOf = (r) => new URL(r.url()).pathname;
// 'Mar 9, 2032' from '2032-03-09', computed here independently of the app.
const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

test.beforeEach(async ({ request }) => { await resetDemo(request); });
test.afterEach(async ({ request }) => { await resetDemo(request); });

// A synthetic recommendation with one step, the note stored while the engine is off (it waits),
// and a proposal of a step check plus an expected payment spanning the whole note.
async function seed({ anchored = true } = {}) {
  return withLocalHousehold(NOW, async (s) => {
    await s.db.prepare('INSERT INTO recs (id,def,status,updated_at) VALUES (?,?,?,?)')
      .run(REC, JSON.stringify({ id: REC, title: 'Synthetic payroll check', tasks: [{ t: 'Synthetic payroll true-up' }] }), 'proposed', NOW);
    const bytes = Buffer.from(NOTE), name = 'synthetic-payroll-note.txt';
    const file = await ingestFile(s.db, { name, bytes, mime: 'text/plain' },
      { ...s.opts(null), household: { ...s.household, engine: { isOn: () => false } }, actorId: 'demo' });
    const source = await indexSource({ fileId: file.fileId, bytes, format: 'text', name });
    const span = { fileId: source.fileId, sha256: source.sha256, byteStart: 0, byteEnd: bytes.length };
    const expected = { tool: 'answer', operation: 'expected_transaction', span, args: {
      subject: 'payroll provider', direction: 'inflow', dueDate: '2032-03-09', datePrecision: 'day', amount: null,
      evidence: NOTE, relativeDate: 'next Tuesday',
    } };
    const step = { tool: 'act_on_recommendation', operation: 'step', span, args: { id: REC, index: 0, checked: true } };
    const ctx = { db: s.db, household: s.household, actorId: 'demo', now: NOW, scheduler: { trigger() {} } };
    const staged = await stageUpdate(ctx, { source, actions: [step, expected], ...(anchored ? { capturedAt: '2032-03-02T14:00:00Z' } : {}) });
    return { fileId: file.fileId, fileStatus: file.status, ...staged };
  });
}

const expectedCount = async (fileId) => withLocalHousehold(NOW, async (s) => (await s.db.prepare('SELECT count(*) n FROM expected_transactions WHERE file_id=?').get(fileId)).n);

test('a note proposes its actions in one sentence, approves in plain words, and Undo reverts it', async ({ page, request }) => {
  const seeded = await seed();
  expect(seeded.fileStatus).toBe('waiting_for_engine');
  expect(seeded.status).toBe('needs_confirmation');
  const sc = await (await request.get('/api/scenario')).json();
  const waiting = sc.live.ingest.waiting.find((f) => f.id === seeded.fileId);
  expect(waiting.proposal.kind).toBe('actions');
  const payment = waiting.proposal.actions.find((a) => a.kind === 'expected');
  expect(payment.dueDate).toBe('2032-03-09');
  expect(payment.phrase).toBe('next Tuesday');
  expect(payment.timezone).toBeTruthy();

  await gotoRoute(page, 'add');
  const r = page.locator(`[data-proposal-file="${seeded.fileId}"]`);
  await expect(r.locator('[data-proposal-status]')).toHaveText('Ready for review');
  const summary = r.locator('[data-proposal-summary]');
  await expect(summary).toContainText('Synthetic payroll true-up marked done');
  await expect(summary).toContainText(`expected incoming payment from payroll provider on ${day(payment.dueDate)} (from "next Tuesday", ${payment.timezone}), amount unknown`);

  const reviewed = page.waitForResponse((res) => pathOf(res) === `/api/import-proposals/${seeded.proposalId}/review`);
  await r.locator('[data-proposal-approve]').click();
  const done = await reviewed;
  expect(done.status()).toBe(200);
  const body = await done.json();
  expect(body.status).toBe('imported');
  const note = page.locator('[data-review-note]').first();
  await expect(note).toContainText('Applied 2 changes.');
  expect(await expectedCount(seeded.fileId)).toBe(1);

  const undone = page.waitForResponse((res) => pathOf(res) === `/api/actions/${body.receipt.id}/undo`);
  await note.locator('[data-review-undo]').click();
  expect((await undone).status()).toBe(200);
  await expect(page.locator('[data-review-note]').first()).toContainText('Undone.');
  expect(await expectedCount(seeded.fileId)).toBe(0);
});

test('an unanchored note asks for its date and accepts a plain answer', async ({ page }) => {
  const seeded = await seed({ anchored: false });
  expect(seeded.status).toBe('needs_clarification');

  await gotoRoute(page, 'add');
  const r = page.locator(`[data-proposal-file="${seeded.fileId}"]`);
  await expect(r.locator('[data-proposal-question]')).toHaveText('What date was this note written?');
  await expect(r.locator('[data-proposal-approve]')).toHaveCount(0);
  const box = r.locator('textarea[data-proposal-text]');
  await expect(box).toBeVisible();
  await box.fill('It was written on March 2, 2032');

  const reviewed = page.waitForResponse((res) => pathOf(res) === `/api/import-proposals/${seeded.proposalId}/review`);
  await r.locator('[data-proposal-correct]').click();
  const done = await reviewed;
  expect(done.status()).toBe(200);
  expect((await done.json()).status).toBe('waiting_for_engine');
  await expect(r.locator('[data-proposal-status]')).toHaveText('Waiting for the engine');
});
