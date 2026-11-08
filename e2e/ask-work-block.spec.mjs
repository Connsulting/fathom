// The work block on Ask answers, at desktop and 390px (every title carries @mobile). While an answer
// is in flight the pending block is a block row ("Working…", "N steps") and nothing else: no answer
// text streams (ST2). The block stays open while working unless the owner toggles it, and the text
// of each tool round arrives in it as a note. A first attempt the answer check replaces is never
// shown and never kept: one "Revised to remove N unchecked figures" step appears instead. The
// finished message keeps the block ("Worked for Ns", "N steps"), collapsed by default, stored with
// the message so a reload shows the same notes and steps.
//
// Tags: @wb-ac1 live behavior, @wb-ac2 the finished and stored block, @wb-ac4 every scenario.
// The demo's fake engine scripts "show your work" questions as three rounds: interim text and a
// tool, interim text and a tool, then the answer. A recorder in the page snapshots the block on
// every mutation, and assertions run on the recorded sequence. To act on the live block at a
// fixed point, a pacer in the page hands the client the real event stream one event at a time and
// can hold delivery between events; it never changes, drops or invents an event.

import { openScope } from '../src/storage/index.mjs';
import { test, expect, REMOTE, resetDemo, gotoRoute, recDialog, rec, plain, ASK_THREAD_URL, askInput } from './helpers.mjs';
import { householdStoreFile, localDataDir } from './local-store.mjs';

// The main demo server's household store (households/<id>/fathom.sqlite under E2E_DATA).
const STORE = async () => await householdStoreFile(localDataDir());

const SHOW = 'Show your work: where does the household stand?';
const QUICK = 'Give me a quick read on where the household stands right now';
// Two invented amounts: the fake engine echoes both next to one grounded count, so two of three
// figures are unchecked and the answer is regenerated once.
const INVENTED = 'Is 4,321 or 5,432 the right amount for this?';
const NOTE1 = 'Let me start with your household summary.';
const NOTE2 = 'Now the details this rests on.';
const STEP_GOALS = 'Looking at your goals';
const STEP_REC = 'Looking at your plan';
const STEP_CHECK = 'Checking every number against your data';
const STEP_REVISED = 'Revised to remove 2 unchecked figures';
const REVISED = /^Revised to remove \d+ unchecked figures?$/;
// Retired by AQ1: no new answer shows these.
const STEP_RETRY = 'Rechecking the numbers';
const DRAFT_TAG = 'Earlier draft, replaced after the number check';

const REC_ID = 'dcfsa';
const REC_TITLE = plain(rec(REC_ID).title);

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/* ---------- in-page pacer and recorder ---------- */

// Wraps fetch for event-stream requests: the body is re-chunked to one SSE event per read, with a
// task boundary between events (so the page paints each one), and delivery waits while
// window.__wbHold is true.
async function installPacer(page) {
  await page.addInitScript(() => {
    window.__wbHold = false;
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      const h = init && init.headers;
      const accept = h ? (h.accept || h.Accept || (typeof h.get === 'function' ? h.get('accept') : '')) : '';
      if (!/text\/event-stream/.test(accept || '') || !/text\/event-stream/.test(res.headers.get('content-type') || '') || !res.body) return res;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      let buf = '';
      let done = false;
      const body = new ReadableStream({
        async pull(ctl) {
          await new Promise((r) => setTimeout(r, 0));
          while (window.__wbHold) await new Promise((r) => setTimeout(r, 20));
          for (;;) {
            const at = buf.indexOf('\n\n');
            if (at >= 0) {
              const ev = buf.slice(0, at + 2);
              buf = buf.slice(at + 2);
              ctl.enqueue(enc.encode(ev));
              return;
            }
            if (done) {
              if (buf) ctl.enqueue(enc.encode(buf));
              buf = '';
              ctl.close();
              return;
            }
            const { value, done: end } = await reader.read();
            if (end) done = true;
            else buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
          }
        },
        cancel(reason) { return reader.cancel(reason); }
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  });
}

// Snapshots the live block inside `scope` on every mutation (deduplicated). holdWhen, a function
// source over a snapshot, sets window.__wbHold the first time it is true (window.__wbHeld keeps
// that snapshot) so the test can act on the live block at that point.
async function record(page, scope, holdWhen = null) {
  await page.evaluate(({ scope, holdWhen }) => {
    const hold = holdWhen ? new Function('s', 'seen', `return (${holdWhen})(s, seen);`) : null;
    const log = { snaps: [], held: null, seen: [] };
    window.__wbLog = log;
    window.__wbHeld = null;
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const look = () => {
      const root = document.querySelector(scope);
      const pend = root && root.querySelector('.h-askx-pend');
      if (!pend) {
        const last = log.snaps[log.snaps.length - 1];
        if (last && last.pend) log.snaps.push({ pend: false, steps: [], notes: [], stream: '', open: null, body: false });
        return;
      }
      const work = pend.querySelector('.h-work');
      const row = pend.querySelector('button.h-work-row');
      const body = pend.querySelector('.h-work-body');
      const s = {
        pend: true,
        work: !!work,
        live: !!(work && work.classList.contains('live')),
        dataWork: row ? row.getAttribute('data-work') : null,
        open: row ? row.getAttribute('aria-expanded') : null,
        body: !!body,
        label: txt(row && row.querySelector('.h-work-l')),
        n: row && row.querySelector('.h-work-n') ? txt(row.querySelector('.h-work-n')) : null,
        spin: !!(row && row.querySelector('i.h-work-spin')),
        steps: body ? [...body.querySelectorAll('.h-work-items li.step span')].map(txt) : [],
        on: body ? [...body.querySelectorAll('.h-work-items li.step')].findIndex((li) => li.classList.contains('on')) : -1,
        notes: body ? [...body.querySelectorAll('.h-work-items li.note')].map((li) => ({
          t: txt(li.querySelector('.h-work-note')),
          draft: li.classList.contains('draft') || !!li.querySelector('.draft'),
          tag: txt(li.querySelector('.h-work-tag'))
        })) : [],
        stream: txt(pend.querySelector('.h-askx-stream')),
        area: txt(pend.querySelector('.h-askx-live')),
        oldSteps: !!pend.querySelector('.h-askx-steps, .h-askx-wait')
      };
      const key = JSON.stringify(s);
      if (log.lastKey === key) return;
      log.lastKey = key;
      log.snaps.push(s);
      for (const n of s.notes) if (!log.seen.includes(n.t)) log.seen.push(n.t);
      if (hold && log.held == null && hold(s, log.seen)) {
        log.held = log.snaps.length - 1;
        window.__wbHold = true;
        window.__wbHeld = s;
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'class'] });
    look();
  }, { scope, holdWhen: holdWhen ? holdWhen.toString() : null });
}

const wbLog = (page) => page.evaluate(() => window.__wbLog);
const release = (page) => page.evaluate(() => { window.__wbHold = false; });

// Letters and digits only: a note may render markdown or numbers differently from the model text.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// No answer text ever streams into the pending block (ST2).
function expectNoStream(snaps) {
  for (const s of snaps) if (s.pend) expect(s.stream, `no streamed text: ${JSON.stringify(s)}`).toBe('');
}

// The old pending markup is gone, and every live snapshot shows the block with a live row.
function expectLiveRows(snaps) {
  const live = snaps.filter((s) => s.pend);
  expect(live.length, 'the pending block was recorded').toBeGreaterThan(0);
  for (const s of live) {
    expect(s.work && s.live, JSON.stringify(s)).toBe(true);
    expect(s.oldSteps, 'no .h-askx-steps or .h-askx-wait in the pending block').toBe(false);
    expect(s.dataWork).toBe('live');
    expect(s.spin, 'the live row has a spinner').toBe(true);
    expect(s.label).toMatch(/^Working/);
    expect(s.body).toBe(s.open === 'true');
    if (s.body) {
      const k = s.steps.length;
      expect(s.n, JSON.stringify(s)).toBe(k === 0 ? null : k === 1 ? '1 step' : `${k} steps`);
    }
  }
}

// Before the owner touches the row the live block is open the whole time: nothing streams to
// collapse it for.
function expectOpenWhileWorking(snaps, upTo = snaps.length) {
  const live = snaps.slice(0, upTo).filter((s) => s.pend);
  expect(live.length, 'the pending block was recorded').toBeGreaterThan(0);
  for (const s of live) expect(s.open, JSON.stringify(s)).toBe('true');
}

/* ---------- page helpers ---------- */

const askMain = (page) => page.locator('section.h-askx-main');
const conv = (page) => recDialog(page).locator('section.h-conv');
const dialogInput = (page) => recDialog(page).locator(`form.h-compose[data-free="rec:${REC_ID}"] input[name="q"]`);

async function sendOnAsk(page, text) {
  await page.evaluate(() => document.fonts.ready);
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

async function openRec(page) {
  await gotoRoute(page, `rec/${REC_ID}`);
  await expect(recDialog(page)).toBeVisible();
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(REC_TITLE);
}

async function sendInDialog(page, text) {
  const input = dialogInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

async function threadJson(request, id) {
  const res = await request.get(`/api/threads/${id}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function lastAnswer(request, id) {
  const { messages } = await threadJson(request, id);
  const m = messages.filter((x) => x.role === 'fathom').pop();
  expect(m, 'a stored answer').toBeTruthy();
  return m;
}

// Reads a finished message's block (opening and closing it leaves it as found).
async function readFinished(msg) {
  const work = msg.locator('.h-work');
  await expect(work).toHaveCount(1);
  const row = work.locator('button.h-work-row');
  const open = (await row.getAttribute('aria-expanded')) === 'true';
  if (!open) await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const items = msg.locator('.h-work-body .h-work-items');
  await expect(items).toHaveCount(1);
  const out = await items.evaluate((ol) => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    return {
      steps: [...ol.querySelectorAll('li.step span')].map(txt),
      notes: [...ol.querySelectorAll('li.note')].map((li) => ({ t: txt(li.querySelector('.h-work-note')), draft: li.classList.contains('draft') || !!li.querySelector('.draft'), tag: txt(li.querySelector('.h-work-tag')) })),
      order: [...ol.children].map((li) => (li.classList.contains('note') ? 'note' : li.classList.contains('step') ? 'step' : '?'))
    };
  });
  out.n = (await row.locator('.h-work-n').count()) ? (await row.locator('.h-work-n').textContent()).trim() : null;
  out.label = (await row.locator('.h-work-l').textContent()).trim();
  if (!open) {
    await msg.locator('.h-work button.h-work-row').click();
    await expect(msg.locator('.h-work button.h-work-row')).toHaveAttribute('aria-expanded', 'false');
  }
  return out;
}

// A finished block: right after the who line, before the body, collapsed, "Worked for Ns", no
// spinner, and the row's step count matching its step items.
async function expectFinished(msg, stored) {
  const work = msg.locator('.h-work');
  await expect(work).toHaveCount(1);
  await expect(work).not.toHaveClass(/\blive\b/);
  const row = work.locator('button.h-work-row');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toHaveAttribute('data-work', stored.id);
  await expect(work.locator('.h-work-body')).toHaveCount(0);
  await expect(row.locator('i.h-work-spin')).toHaveCount(0);
  await expect(row.locator('.h-work-l')).toHaveText(/^Worked for [1-9]\d*s$/);
  const order = await msg.evaluate((el) => [...el.children].map((c) => c.className.split(/\s+/)[0]));
  const at = order.indexOf('h-work');
  expect(order[at - 1], JSON.stringify(order)).toBe('h-msg-who');
  expect(order[at + 1], JSON.stringify(order)).toBe('h-msg-b');
  const got = await readFinished(msg);
  const k = got.steps.length;
  expect(got.n).toBe(k === 0 ? null : k === 1 ? '1 step' : `${k} steps`);
  // The page shows what is stored with the message.
  const items = stored.provenance && stored.provenance.work && stored.provenance.work.items;
  expect(Array.isArray(items), 'provenance.work.items is stored').toBe(true);
  expect(got.steps).toEqual(items.filter((x) => x.k === 'step').map((x) => x.label));
  expect(got.notes.map((x) => norm(x.t))).toEqual(items.filter((x) => x.k === 'note').map((x) => norm(x.text)));
  expect(got.order).toEqual(items.map((x) => x.k));
  return got;
}

function expectShowYourWork(got, secondStep) {
  const notes = got.notes.map((x) => x.t);
  expect(notes.indexOf(NOTE1), JSON.stringify(got)).toBeGreaterThanOrEqual(0);
  expect(notes.indexOf(NOTE2), JSON.stringify(got)).toBeGreaterThan(notes.indexOf(NOTE1));
  expect(got.notes.some((x) => x.draft)).toBe(false);
  expect(got.steps).toEqual(['Looking at your household', secondStep, STEP_CHECK]);
}

// At phone width: no horizontal page scroll, the row's text on one line and not clipped, and an
// open block inside the viewport.
async function expectPhoneFit(page, work) {
  const vw = page.viewportSize().width;
  if (vw > 500) return;
  const m = await work.evaluate((el) => {
    const row = el.querySelector('button.h-work-row');
    const range = document.createRange();
    range.selectNodeContents(row);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const tops = rects.map((r) => r.top);
    const spans = [...row.querySelectorAll('.h-work-l, .h-work-n')].map((s) => ({ sw: s.scrollWidth, cw: s.clientWidth, rects: s.getClientRects().length }));
    const box = el.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      spread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
      line: parseFloat(getComputedStyle(row).lineHeight) || parseFloat(getComputedStyle(row).fontSize) * 1.2,
      rowClip: row.scrollWidth - row.clientWidth,
      spans,
      left: box.left,
      right: box.right
    };
  });
  const ctx = JSON.stringify(m);
  expect(m.overflow, ctx).toBeLessThanOrEqual(0);
  expect(m.spread, `the row stays on one line: ${ctx}`).toBeLessThan(m.line / 2);
  expect(m.rowClip, ctx).toBeLessThanOrEqual(0);
  for (const s of m.spans) {
    expect(s.sw, `a row label is not clipped: ${ctx}`).toBeLessThanOrEqual(s.cw + 1);
    expect(s.rects, ctx).toBeLessThanOrEqual(1);
  }
  expect(m.left, ctx).toBeGreaterThanOrEqual(-1);
  expect(m.right, ctx).toBeLessThanOrEqual(vw + 1);
}

// Held once both notes are in (the block open, nothing streaming): the block shows steps then
// notes in order; click closes and reopens it, Enter and Space toggle it, and focus stays on the row.
async function actOnHeldLive(page, scope) {
  await expect.poll(() => page.evaluate(() => !!window.__wbHeld), { timeout: 30_000 }).toBe(true);
  const work = scope.locator('.h-askx-pend .h-work.live');
  const row = work.locator('button.h-work-row[data-work="live"]');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const body = work.locator('.h-work-body');
  await expect(body).toHaveCount(1);
  await expect(scope.locator('.h-askx-pend .h-askx-stream')).toHaveCount(0);
  const notes = body.locator('li.note .h-work-note');
  await expect(notes).toHaveText([NOTE1, NOTE2]);
  const kinds = await body.locator('.h-work-items > li').evaluateAll((els) => els.map((li) => (li.classList.contains('note') ? 'note' : 'step')));
  expect(kinds[0], 'the start step comes first').toBe('step');
  expect(kinds.filter((x) => x === 'note')).toHaveLength(2);
  await expectPhoneFit(page, work);

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toHaveCount(0);
  await expectPhoneFit(page, work);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toHaveCount(1);

  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.matches('button.h-work-row[data-work="live"]'))).toBe(true);
  await page.keyboard.press(' ');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(work.locator('.h-work-body li.note')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.activeElement && document.activeElement.matches('button.h-work-row[data-work="live"]'))).toBe(true);
  // The owner's choice wins for the rest of the answer: leave it open and let the answer finish.
}

// Notes show only while the block is open, so count the distinct notes seen in earlier snapshots.
const bothNotes = (s, seen) => s.pend && seen.length >= 2;

/* ---------- 1: Ask page, new conversation ---------- */

test('@mobile @wb-ac1 @wb-ac2 @wb-ac4 Ask page: the work block shows live and open, keeps every interim text, and stays with the answer after reload', async ({ page, request }) => {
  test.setTimeout(120_000);
  await installPacer(page);
  await gotoRoute(page, 'ask');
  await record(page, 'section.h-askx-main', bothNotes);
  await sendOnAsk(page, SHOW);

  await actOnHeldLive(page, askMain(page));
  await release(page);
  await expect(page).toHaveURL(ASK_THREAD_URL, { timeout: 30_000 });
  const id = ASK_THREAD_URL.exec(page.url())[1];
  const answer = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(askMain(page).locator('.h-msg.fathom')).toHaveCount(1, { timeout: 30_000 });
  await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);

  const { snaps, held } = await wbLog(page);
  expectLiveRows(snaps);
  expectOpenWhileWorking(snaps, held);
  expectNoStream(snaps);
  const seenNotes = [...new Set(snaps.flatMap((s) => s.notes.map((n) => n.t)))];
  expect(seenNotes).toEqual([NOTE1, NOTE2]);
  // The steps shown live keep their order and the pulse sits on the last one.
  for (const s of snaps.filter((x) => x.body && x.steps.length)) expect(s.on).toBe(s.steps.length - 1);

  // Nothing streamed before the final answer remains in the answer.
  const said = norm(await answer.locator('.h-msg-b').textContent());
  expect(said.length).toBeGreaterThan(0);
  for (const t of [NOTE1, NOTE2]) expect(said).not.toContain(norm(t));

  const stored = await lastAnswer(request, id);
  const got = await expectFinished(answer, stored);
  expectShowYourWork(got, STEP_GOALS);
  await expectPhoneFit(page, answer.locator('.h-work'));

  await page.reload();
  const again = page.locator('section.h-askx-main .h-askx-msgs .h-msg.fathom').last();
  await expect(again).toBeVisible();
  const after = await expectFinished(again, stored);
  expect(after.steps).toEqual(got.steps);
  expect(after.notes).toEqual(got.notes);
  expect(after.n).toBe(got.n);
});

/* ---------- 2: the same question in a rec dialog ---------- */

test('@mobile @wb-ac1 @wb-ac2 @wb-ac4 rec dialog: the scripted question shows the same live block, and the dialog and the Ask thread show the same finished block', async ({ page, request }) => {
  test.setTimeout(120_000);
  await installPacer(page);
  await openRec(page);
  await record(page, '.h-dlg section.h-conv', bothNotes);
  await sendInDialog(page, SHOW);

  await actOnHeldLive(page, conv(page));
  await release(page);
  await expect(conv(page).locator('.h-msg.fathom')).toHaveCount(1, { timeout: 30_000 });
  await expect(conv(page).locator('.h-askx-pend')).toHaveCount(0);

  const { snaps, held } = await wbLog(page);
  expectLiveRows(snaps);
  expectOpenWhileWorking(snaps, held);
  expectNoStream(snaps);
  expect([...new Set(snaps.flatMap((s) => s.notes.map((n) => n.t)))]).toEqual([NOTE1, NOTE2]);

  const open = recDialog(page).locator('a.h-conv-open');
  await expect(open).toHaveAttribute('href', /#\/ask\/[a-f0-9]{12}$/);
  const id = /#\/ask\/([a-f0-9]{12})$/.exec(await open.getAttribute('href'))[1];
  const stored = await lastAnswer(request, id);
  const inDialog = conv(page).locator('.h-msg.fathom').last();
  for (const t of [NOTE1, NOTE2]) expect(norm(await inDialog.locator('.h-msg-b').textContent())).not.toContain(norm(t));
  const fromDialog = await expectFinished(inDialog, stored);
  expectShowYourWork(fromDialog, STEP_REC);
  await expectPhoneFit(page, inDialog.locator('.h-work'));

  await open.click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  const onAsk = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(onAsk).toBeVisible();
  const fromAsk = await expectFinished(onAsk, stored);
  expect(fromAsk).toEqual(fromDialog);

  await page.reload();
  const again = page.locator('section.h-askx-main .h-askx-msgs .h-msg.fathom').last();
  await expect(again).toBeVisible();
  expect(await expectFinished(again, stored)).toEqual(fromDialog);
});

/* ---------- 3: a plain question ---------- */

test('@mobile @wb-ac2 @wb-ac4 a plain question shows a work block with steps only and no notes', async ({ page, request }) => {
  await gotoRoute(page, 'ask');
  await record(page, 'section.h-askx-main');
  await sendOnAsk(page, QUICK);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const id = ASK_THREAD_URL.exec(page.url())[1];
  const answer = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);

  const { snaps } = await wbLog(page);
  expectLiveRows(snaps);
  expectOpenWhileWorking(snaps);
  expectNoStream(snaps);
  expect(snaps.some((s) => s.notes.length), 'no note rows while it worked').toBe(false);
  expect(snaps.some((s) => s.steps.includes('Looking at your household'))).toBe(true);

  const stored = await lastAnswer(request, id);
  const got = await expectFinished(answer, stored);
  expect(got.notes).toEqual([]);
  expect(got.steps.length).toBeGreaterThan(0);
  expect(got.steps[0]).toBe('Looking at your household');
  expect(stored.provenance.work.items.every((x) => x.k === 'step')).toBe(true);
  await expectPhoneFit(page, answer.locator('.h-work'));
});

/* ---------- 4: the regeneration ---------- */

test('@mobile @wb-ac1 @wb-ac2 @wb-ac4 a forced regeneration shows one revision step, never shows the first attempt, and keeps no draft', async ({ page, request }) => {
  test.setTimeout(120_000);
  // One event per task, so each step is its own snapshot.
  await installPacer(page);
  await gotoRoute(page, 'ask');
  await record(page, 'section.h-askx-main');
  await sendOnAsk(page, INVENTED);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const id = ASK_THREAD_URL.exec(page.url())[1];
  const answer = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);
  await expect(askMain(page).locator('.h-msg.fathom')).toHaveCount(1);

  const { snaps } = await wbLog(page);
  expectLiveRows(snaps);
  expectOpenWhileWorking(snaps);
  expectNoStream(snaps);
  // The revision step showed in the open block, and the first attempt's amounts never showed.
  expect(snaps.some((s) => s.pend && s.steps.includes(STEP_REVISED)), 'the revision step showed while in flight').toBe(true);
  for (const s of snaps) if (s.pend) expect(norm(s.area), `no draft text in the pending block: ${JSON.stringify(s)}`).not.toMatch(/4321|5432/);
  // No draft note, no draft tag, and no retired retry step, at any point.
  expect(snaps.some((s) => s.notes.some((n) => n.draft || n.tag)), 'no draft note while in flight').toBe(false);
  expect(snaps.some((s) => s.steps.includes(STEP_RETRY))).toBe(false);
  expect(snaps.every((s) => s.steps.filter((x) => REVISED.test(x)).length <= 1), 'one revision step').toBe(true);

  const stored = await lastAnswer(request, id);
  const got = await expectFinished(answer, stored);
  expect(got.notes).toEqual([]);
  expect(got.steps.filter((x) => x === STEP_REVISED)).toHaveLength(1);
  expect(got.steps.filter((x) => REVISED.test(x))).toHaveLength(1);
  expect(got.steps).not.toContain(STEP_RETRY);
  expect(stored.provenance.work.items.some((x) => x.draft)).toBe(false);
  expect(stored.provenance.grounding.revised).toBe(2);
  await expect(answer.getByText(DRAFT_TAG)).toHaveCount(0);
  // The fake engine repeats its answer, so both amounts stay unchecked in place.
  for (const n of ['4,321', '5,432']) {
    await expect(answer.locator('.h-msg-b .fx-unchecked').filter({ hasText: n })).toHaveCount(1);
  }

  await page.reload();
  const again = page.locator('section.h-askx-main .h-askx-msgs .h-msg.fathom').last();
  await expect(again).toBeVisible();
  const after = await expectFinished(again, stored);
  expect(after.notes).toEqual(got.notes);
  expect(after.steps).toEqual(got.steps);
  await expectPhoneFit(page, again.locator('.h-work'));
});

/* ---------- 5: click and keyboard on a finished block ---------- */

test('@mobile @wb-ac2 @wb-ac4 a finished block toggles by click, Enter and Space, and focus stays on its row across redraws', async ({ page, request }) => {
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text: SHOW } });
  expect(res.status()).toBe(200);
  const { thread } = await res.json();
  const stored = await lastAnswer(request, thread.id);
  await gotoRoute(page, `ask/${thread.id}`);
  const msg = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(msg).toBeVisible();
  const work = msg.locator('.h-work');
  const row = work.locator('button.h-work-row');
  const body = work.locator('.h-work-body');
  const sel = `button.h-work-row[data-work="${stored.id}"]`;
  const focused = () => page.evaluate((s) => !!(document.activeElement && document.activeElement.matches(s)), sel);
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toHaveCount(0);

  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toHaveCount(1);
  await expect(body.locator('li.note .h-work-note')).toHaveText([NOTE1, NOTE2]);
  await expect.poll(focused).toBe(true);

  await page.keyboard.press(' ');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toHaveCount(0);
  await expect.poll(focused).toBe(true);

  await page.keyboard.press(' ');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(focused).toBe(true);
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(focused).toBe(true);

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(body).toHaveCount(1);
  await expectPhoneFit(page, work);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(body).toHaveCount(0);
});

/* ---------- 6: a message stored before the work block ---------- */

test('@mobile @wb-ac4 a message stored without work renders no block', async ({ page, request }) => {
  test.skip(REMOTE, 'edits the local demo store; BASE_URL targets a remote server');
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text: QUICK } });
  expect(res.status()).toBe(200);
  const { thread } = await res.json();
  const stored = await lastAnswer(request, thread.id);
  expect(stored.provenance && stored.provenance.work, 'a new answer stores its work').toBeTruthy();
  // Strip the work from the stored row, as a message from before this change has none.
  const db = await openScope({ path: await STORE(), journal: null, busyTimeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    await db.prepare("UPDATE messages SET provenance = json_remove(provenance, '$.work') WHERE id = ?").run(Number(String(stored.id).replace(/^m/, '')));
  } finally {
    await db.close();
  }
  const old = await lastAnswer(request, thread.id);
  expect(old.provenance.work).toBeUndefined();

  await gotoRoute(page, `ask/${thread.id}`);
  const msg = askMain(page).locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(msg).toBeVisible();
  await expect(msg.locator('details.h-src')).toHaveCount(1);
  await expect(msg.locator('.h-work')).toHaveCount(0);
  await expect(page.locator('.h-work')).toHaveCount(0);
});
