// AQ1 AC6: one answer per Ask turn. On demo data a new question carrying one owner amount (the fake
// engine echoes it next to the household summary count, which grounds) gets exactly one Fathom
// answer: the amount sits in place as a neutral unchecked figure, there is no regeneration, the
// finished work block reads "Worked for Ns" with steps only, no draft note or "Earlier draft" text,
// and the answer is not repeated inside the block. While it streams, the streamed text never
// leaves the screen without a step saying why. Runs at desktop and at 390x844 (@mobile).

import { test, expect, resetDemo, gotoRoute, ASK_THREAD_URL, askInput } from './helpers.mjs';

const QUESTION = 'Can we afford 4,321 a month for a new car?';
const AMOUNT = '4,321';
const UNCHECKED_TITLE = 'Not checked against your data';
const REVISED = /^Revised to remove \d+ unchecked figures?$/;

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

const askMain = (page) => page.locator('section.h-askx-main');
// Letters and digits only: rendered markup and streamed text differ in spacing and punctuation.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Snapshots the pending block on every mutation (deduplicated): the streamed text, the step count
// on the row, and the steps and notes when the block is open.
async function recordLive(page) {
  await page.evaluate(() => {
    const log = { snaps: [], lastKey: null };
    window.__aqLog = log;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const look = () => {
      const pend = document.querySelector('section.h-askx-main .h-askx-pend');
      if (!pend) {
        const last = log.snaps[log.snaps.length - 1];
        if (last && last.pend) log.snaps.push({ pend: false, stream: '', steps: [], notes: [], n: null, open: null });
        return;
      }
      const row = pend.querySelector('button.h-work-row');
      const body = pend.querySelector('.h-work-body');
      const s = {
        pend: true,
        open: row ? row.getAttribute('aria-expanded') : null,
        n: row && row.querySelector('.h-work-n') ? txt(row.querySelector('.h-work-n')) : null,
        steps: body ? [...body.querySelectorAll('.h-work-items li.step span')].map(txt) : [],
        notes: body ? [...body.querySelectorAll('.h-work-items li.note')].map((li) => ({
          t: txt(li.querySelector('.h-work-note')),
          draft: li.classList.contains('draft') || !!li.querySelector('.h-work-tag')
        })) : [],
        stream: txt(pend.querySelector('.h-askx-stream'))
      };
      const key = JSON.stringify(s);
      if (log.lastKey === key) return;
      log.lastKey = key;
      log.snaps.push(s);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'class'] });
    look();
  });
}

// Every time the streamed text is removed while the answer is pending, the same snapshot shows why
// in the open block: the text as an interim note, or a revision step. Returns how many removals.
function expectNoSilentClear(snaps) {
  let clears = 0;
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const cur = snaps[i];
    if (!prev.pend || !cur.pend) continue;
    const was = norm(prev.stream);
    if (!was || norm(cur.stream).startsWith(was)) continue;
    clears++;
    const ctx = JSON.stringify({ prev, cur });
    expect(cur.open, `the block is open when streamed text leaves: ${ctx}`).toBe('true');
    const noted = norm(cur.notes.map((x) => x.t).join(' ')).includes(was);
    expect(noted || cur.steps.some((x) => REVISED.test(x)), `a note or a step accounts for the removed text: ${ctx}`).toBe(true);
  }
  return clears;
}

test('@mobile @aq-ac6 an echoed owner amount gets one answer, a finished work block with steps only, and the amount unchecked in place', async ({ page, request }) => {
  test.setTimeout(120_000);
  await gotoRoute(page, 'ask');
  await page.evaluate(() => document.fonts.ready);
  await recordLive(page);
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(QUESTION);
  await input.press('Enter');

  await expect(page).toHaveURL(ASK_THREAD_URL, { timeout: 30_000 });
  const id = ASK_THREAD_URL.exec(page.url())[1];
  const answers = askMain(page).locator('.h-askx-msgs .h-msg.fathom');
  await expect(answers).toHaveCount(1, { timeout: 30_000 });
  await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);
  const answer = answers.last();
  await expect(answer).not.toHaveClass(/\bnotice\b/);

  // Exactly one answer for the turn, stored and shown.
  const res = await request.get(`/api/threads/${id}`);
  expect(res.status()).toBe(200);
  const { messages } = await res.json();
  expect(messages.map((m) => m.role)).toEqual(['me', 'fathom']);
  const stored = messages[1];
  expect(stored.provenance.grounding.retried).toBe(false);
  expect(stored.provenance.grounding.revised).toBeUndefined();
  expect(stored.provenance.grounding.unverified).toEqual([AMOUNT]);

  // The echoed amount is a neutral unchecked figure in place.
  const unchecked = answer.locator('.h-msg-b .fx-unchecked');
  await expect(unchecked.filter({ hasText: AMOUNT })).toHaveCount(1);
  await expect(unchecked.first()).toHaveAttribute('title', UNCHECKED_TITLE);
  await expect(unchecked.first()).toHaveClass(/\bfx-checking\b/);
  await expect(answer.locator('.fx-unverified')).toHaveCount(0);

  // A finished block: "Worked for Ns", no spinner, steps only.
  const work = answer.locator('.h-work');
  await expect(work).toHaveCount(1);
  await expect(work).not.toHaveClass(/\blive\b/);
  const row = work.locator('button.h-work-row');
  await expect(row.locator('.h-work-l')).toHaveText(/^Worked for [1-9]\d*s$/);
  await expect(row.locator('i.h-work-spin')).toHaveCount(0);
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const items = work.locator('.h-work-body .h-work-items');
  await expect(items).toHaveCount(1);
  await expect(items.locator('li.step').first()).toBeVisible();
  await expect(page.locator('li.note.draft')).toHaveCount(0);
  await expect(page.getByText('Earlier draft')).toHaveCount(0);
  await expect(items.locator('li.step', { hasText: REVISED })).toHaveCount(0);

  // The answer is not repeated inside the block.
  const said = norm(await answer.locator('.h-msg-b').textContent());
  expect(said.length).toBeGreaterThan(0);
  expect(norm(await items.textContent())).not.toContain(said);
  const workItems = stored.provenance.work.items;
  expect(workItems.some((x) => x.draft)).toBe(false);
  expect(workItems.some((x) => x.k === 'note' && norm(x.text) === said)).toBe(false);

  // Live: the answer streamed and nothing streamed left the screen silently; with one unchecked
  // figure nothing was cleared at all.
  const { snaps } = await page.evaluate(() => window.__aqLog);
  expect(snaps.some((s) => s.pend && s.stream), 'the answer streamed').toBe(true);
  expect(snaps.some((s) => s.notes.some((n) => n.draft)), 'no draft note while in flight').toBe(false);
  expect(expectNoSilentClear(snaps), 'no streamed text was cleared').toBe(0);

  // At phone width the page does not scroll sideways.
  const vw = page.viewportSize().width;
  if (vw <= 500) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
