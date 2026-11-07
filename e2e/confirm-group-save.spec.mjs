// Confirm group card on the demo build, save-on-click design. A click on a row option of a grouped
// card (account_owner) saves that row at once through the single-card answer path; nothing is
// preselected; the footer button accepts the best guesses of the rows still unanswered; the deck
// counts answered items; and finishing ends on an "All answered" block whose Back button returns
// to the screen Confirm was opened from.
//
// Tags in the titles: @cfgs-ac1 row save, Saved state and row Undo; @cfgs-ac2 Accept N best
// guesses; @cfgs-ac3 Done, Next open and the finished block; @cfgs-ac4 Back to the origin screen
// and the whole flow at both widths. Every body runs at desktop and phone width.
// Ids, options and guesses come from the API; only the pinned copy is hard-coded.

import { fileURLToPath } from 'node:url';
import { test, expect, resetDemo, gotoRoute, deckFind, deckCard, deckKey, healthConfirm } from './helpers.mjs';

const AGG = 'aggregator-household.csv';
const BANK = 'Chase4455_Activity_20261031.csv';
const POS = 'positions-household.csv';
const fixture = (name) => fileURLToPath(new URL(`../test/fixtures/ingest/household/${name}`, import.meta.url));

const SIZES = [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }]
];

const OWNER = '[data-group="account_owner"]';
const GROUPED = new Set(['account_owner', 'account_kind']);
const isPost = (r, path) => r.request().method() === 'POST' && new URL(r.url()).pathname === path;
const bodyOf = (r) => JSON.parse(r.request().postData() || '{}');
const guessWord = (n) => `${n} best guess${n === 1 ? '' : 'es'}`;

async function pendingItems(request) {
  const res = await request.get('/api/confirm');
  expect(res.status()).toBe(200);
  return (await res.json()).items;
}

async function ingestState(request) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  return (await res.json()).live.ingest;
}

async function allById(request) {
  const res = await request.post('/api/confirm/list', { data: { status: 'all' } });
  expect(res.status()).toBe(200);
  return new Map((await res.json()).items.map((i) => [i.id, i]));
}

async function expectState(request, id, status, answer) {
  const it = (await allById(request)).get(Number(id));
  expect(it, `item ${id}`).toBeTruthy();
  expect(it.status, `item ${id} status`).toBe(status);
  if (answer !== undefined) expect(it.answer ?? null, `item ${id} answer`).toBe(answer);
}

async function uploadHousehold(page) {
  await gotoRoute(page, 'accounts');
  const uploaded = page.waitForResponse((r) => isPost(r, '/api/files'));
  await page.locator('input[type=file][data-upload]').setInputFiles([AGG, BANK, POS].map(fixture));
  const res = await uploaded;
  expect(res.status()).toBe(200);
  expect((await res.json()).files.map((f) => f.status)).toEqual(['imported', 'imported', 'imported']);
}

// Reset, set the width, upload the household. When `keepIds` is given every other pending item is
// answered through the API so the deck holds only those items; keep(item, allPendingBefore) says which
// stay. Returns the pending ingest items left, in deck order.
async function seed(page, request, size, keep) {
  await resetDemo(request);
  await page.setViewportSize(size);
  await uploadHousehold(page);
  if (keep) {
    const all = await pendingItems(request);
    for (let guard = 0; guard < 60; guard++) {
      const other = (await pendingItems(request)).find((i) => !keep(i, all));
      if (!other) break;
      const res = await request.post(`/api/confirm/${other.id}/answer`, { data: { answer: other.options[0].id } });
      expect(res.status(), `answer ${other.id}`).toBe(200);
    }
  }
  return (await ingestState(request)).items;
}

// A single (ungrouped) item to leave open next to the owner group.
const singleOf = (items) => items.find((i) => !GROUPED.has(i.kind));

// Open Confirm with no origin screen: a fresh load straight onto #/confirm.
async function openDirect(page) {
  await page.goto('about:blank');
  await gotoRoute(page, 'confirm');
  await expect(page.locator('.h-deck')).toBeVisible();
}

const finished = (page) => page.locator('.h-deck', { hasText: 'All answered' });
const homeBtn = (page) => page.locator('[data-deck-home]');
const nextBtn = (page) => page.locator('button[data-deck="next"]');
const doneBtn = (page) => page.locator('button[data-deck="done"]');
const apply = (page) => page.locator('button[data-group-apply]');
const counter = (page) => page.locator('[data-deck-answered]');
const bar = (page) => page.getByRole('progressbar', { name: 'Answered' });
const rowOf = (page, id) => page.locator(`tr[data-row="${id}"]`);
const optBtn = (page, id, opt) => page.locator(`button[data-row-answer="${id}"][data-option="${opt}"]`);
const rowState = (page, id) => rowOf(page, id).locator('p.h-cf-rstate');
const rowUndo = (page, id) => page.locator(`[data-row-undo="${id}"]`);
const pressedIn = (page, id) => rowOf(page, id).locator('button[data-row-answer][aria-pressed="true"]');

const guessOf = (it) => (it.guess?.option != null ? String(it.guess.option) : null);
const altOf = (it, not) => String(it.options.find((o) => String(o.id) !== String(not)).id);

// Click an option on a group row and wait for the single-card answer POST.
async function clickRow(page, it, opt, revise = false) {
  const posted = page.waitForResponse((r) => isPost(r, `/api/confirm/${it.id}/answer`));
  await optBtn(page, it.id, opt).click();
  const res = await posted;
  expect(res.status()).toBe(200);
  const body = bodyOf(res);
  expect(String(body.answer)).toBe(String(opt));
  if (revise) expect(body.revise).toBe(true);
  await expect(pressedIn(page, it.id)).toHaveCount(1);
  await expect(optBtn(page, it.id, opt)).toHaveAttribute('aria-pressed', 'true');
  await expect(rowState(page, it.id)).toContainText('Saved');
  await expect(rowUndo(page, it.id)).toBeVisible();
}

// Click the first option of every row on the current group card that is not answered yet.
async function answerRows(card) {
  // Rows answered by propagation leave the table, so look for the next unanswered row each time.
  const open = card.locator('tr[data-row]:not(:has(button[data-row-answer][aria-pressed="true"]))');
  for (let guard = 0; guard < 20 && await open.count(); guard++) {
    const row = open.first();
    const id = await row.getAttribute('data-row');
    await row.locator('button[data-row-answer]').first().click();
    // Wait for the saved state (not the optimistic press) so the next click never races a
    // propagation that is about to remove a row (that would be a 409 from the server).
    await expect(card.page().locator(`tr[data-row="${id}"] p.h-cf-rstate`)).toContainText('Saved');
  }
}

// Walk the deck until the finished block shows: group cards by row clicks, single cards by their
// first option, Next or Done to move on.
async function finishDeck(page) {
  for (let i = 0; i < 80; i++) {
    await expect(deckCard(page).or(homeBtn(page)).first()).toBeVisible();
    if (await homeBtn(page).count()) return;
    const card = deckCard(page);
    if (await card.getAttribute('data-group')) {
      await answerRows(card);
      await page.locator('button[data-deck="next"],button[data-deck="done"]').first().click();
      continue;
    }
    const id = await card.getAttribute('data-item');
    if (await card.locator('button[data-answer][aria-pressed="true"]').count()) {
      await page.locator('button[data-deck="next"],button[data-deck="done"]').first().click();
    } else {
      await card.locator('button[data-answer]').first().click();
    }
    await expect.poll(async () => ((await homeBtn(page).count()) ? 'finished' : await deckCard(page).getAttribute('data-item')), { message: 'the deck moves on' }).not.toBe(id);
  }
  throw new Error('the deck did not finish');
}

for (const [label, size] of SIZES) {
  test.describe(`confirm group card at ${label} width`, () => {
    // Long multi-step flows: triple the default timeout so a loaded CI host does not cut them off.
    test.slow();
    test(`@cfgs-ac1 @cfgs-ac2 @cfgs-ac3 @cfgs-ac4 [${label}] rows save on click, Undo and revise work, Accept saves the rest, finishing returns Home`, async ({ page, request }) => {
      const items = await seed(page, request, size);
      const owners = items.filter((i) => i.kind === 'account_owner');
      const guessable = owners.filter((i) => guessOf(i));
      expect(owners.length, 'owner questions form a group').toBeGreaterThanOrEqual(2);
      expect(guessable.length, 'an owner row carries a best guess').toBeGreaterThanOrEqual(1);
      const total = (await ingestState(request)).items.length;
      await openDirect(page);
      const card = await deckFind(page, OWNER);

      // Nothing is preselected; the guess shows its tag; the counter counts items.
      await expect(card.locator('button[data-row-answer][aria-pressed="true"]')).toHaveCount(0);
      for (const it of guessable) await expect(card.locator(`button[data-row-answer="${it.id}"][data-option="${guessOf(it)}"][data-guess="1"] .h-cf-best`)).toHaveText('Best guess');
      await expect(counter(page)).toHaveText(`0 of ${total} answered`);
      await expect(bar(page)).toHaveAttribute('aria-valuemax', String(total));
      await expect(bar(page)).toHaveAttribute('aria-valuenow', '0');
      await expect(apply(page)).toHaveText(`Accept ${guessWord(guessable.length)}`);

      // One click saves that row only and the card stays.
      // Save two rows by click, preferring rows without a guess so the guessed row is left for Accept.
      const byGuess = [...owners].sort((x, y) => Number(!!guessOf(x)) - Number(!!guessOf(y)));
      const [a, b] = byGuess;
      const aOpt = String(a.options[0].id);
      await clickRow(page, a, aOpt);
      await expect(card).toBeVisible();
      await expectState(request, a.id, 'answered', aOpt);
      // Rows the server answered by propagation leave the table (they show under Decided for you);
      // every other row stays unanswered and unpressed.
      for (const it of owners.filter((o) => o.id !== a.id)) {
        if ((await allById(request)).get(it.id).status === 'answered') await expect(rowOf(page, it.id)).toHaveCount(0);
        else await expect(pressedIn(page, it.id)).toHaveCount(0);
      }
      await expect(counter(page)).toHaveText(/^[1-9]\d* of \d+ answered$/);
      await expect(bar(page)).toHaveAttribute('aria-valuenow', /^[1-9]\d*$/);
      const afterOne = await counter(page).textContent();

      // The row Undo reopens only that item.
      const reopened = page.waitForResponse((r) => isPost(r, `/api/confirm/${a.id}/reopen`));
      await rowUndo(page, a.id).click();
      expect((await reopened).status()).toBe(200);
      await expect(pressedIn(page, a.id)).toHaveCount(0);
      await expectState(request, a.id, 'pending');
      await expect(counter(page)).toHaveText(`0 of ${total} answered`);
      expect(afterOne).not.toBe(`0 of ${total} answered`);

      // Save b with one option, then revise it to another.
      const bOpt = String(b.options[0].id);
      const bAlt = altOf(b, bOpt);
      await clickRow(page, b, bOpt);
      await expectState(request, b.id, 'answered', bOpt);
      await clickRow(page, b, bAlt, true);
      await expectState(request, b.id, 'answered', bAlt);

      // Accept counts only the unanswered rows that have a guess and posts exactly those.
      const left = (await ingestState(request)).items.filter((i) => i.kind === 'account_owner' && guessOf(i));
      if (left.length) {
        await expect(apply(page)).toHaveText(`Accept ${guessWord(left.length)}`);
        const posted = page.waitForResponse((r) => isPost(r, '/api/confirm/answers'));
        await apply(page).click();
        const res = await posted;
        expect(res.status()).toBe(200);
        const sent = Object.fromEntries((bodyOf(res).answers || []).map((x) => [String(x.id), String(x.answer)]));
        expect(sent, 'only the remaining guesses').toEqual(Object.fromEntries(left.map((i) => [String(i.id), guessOf(i)])));
        expect(Object.keys(sent)).not.toContain(String(b.id));
        for (const it of left) await expectState(request, it.id, 'answered', guessOf(it));
      }
      await expect(apply(page)).toHaveCount(0);

      // Finish the rest, then Back returns Home (a direct load has no origin).
      await finishDeck(page);
      await expect(finished(page)).toBeVisible();
      await expect(homeBtn(page)).toHaveText('Back to Home');
      await homeBtn(page).click();
      await expect(page).toHaveURL(/#\/home$/);
    });

    test(`@cfgs-ac2 [${label}] Enter accepts the same remaining best guesses`, async ({ page, request }) => {
      const items = await seed(page, request, size);
      const guessable = items.filter((i) => i.kind === 'account_owner' && guessOf(i));
      const owners = items.filter((i) => i.kind === 'account_owner');
      expect(guessable.length).toBeGreaterThanOrEqual(1);
      // Save a row other than the guessed one by click, then Enter accepts what is still guessable.
      const a = owners.find((i) => !guessOf(i)) ?? owners.find((i) => i.id !== guessable[0].id);
      const rest = guessable.filter((i) => i.id !== a.id);
      expect(rest.length, 'a guessed row stays for Enter').toBeGreaterThanOrEqual(1);
      await openDirect(page);
      await deckFind(page, OWNER);
      await clickRow(page, a, String(a.options[0].id));
      await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
      await expect(apply(page)).toHaveText(`Accept ${guessWord(rest.length)}`);
      const posted = page.waitForResponse((r) => isPost(r, '/api/confirm/answers'));
      await page.keyboard.press('Enter');
      const res = await posted;
      const sent = Object.fromEntries((bodyOf(res).answers || []).map((x) => [String(x.id), String(x.answer)]));
      expect(sent).toEqual(Object.fromEntries(rest.map((i) => [String(i.id), guessOf(i)])));
      await expectState(request, a.id, 'answered', String(a.options[0].id));
      expect(Object.keys(sent)).not.toContain(String(a.id));
    });

    test(`@cfgs-ac2 @cfgs-ac3 [${label}] answering every group row turns Next into Done and Done shows the finished block`, async ({ page, request }) => {
      const items = await seed(page, request, size, (i) => i.kind === 'account_owner');
      expect(items.every((i) => i.kind === 'account_owner') && items.length >= 2, 'only the owner group is open').toBe(true);
      await openDirect(page);
      const card = await deckFind(page, OWNER);
      // The group is the last and only open card, so the button is Done from the start.
      await expect(doneBtn(page)).toBeEnabled();
      await answerRows(card);
      await expect(apply(page)).toHaveCount(0);
      await expect(doneBtn(page)).toBeEnabled();
      await expect(doneBtn(page)).toHaveText(/^Done/);
      await doneBtn(page).click();
      await expect(finished(page)).toBeVisible();
      await expect(homeBtn(page)).toHaveText('Back to Home');
      for (const it of items) await expectState(request, it.id, 'answered');
    });

    test(`@cfgs-ac3 [${label}] answering the last open single card finishes the deck and Prev still works`, async ({ page, request }) => {
      const left = await seed(page, request, size, (i, all) => i.id === singleOf(all)?.id);
      const first = left[0];
      expect(left.length, 'one single question is open').toBe(1);
      expect(GROUPED.has(first.kind)).toBe(false);
      await openDirect(page);
      const card = page.locator(`article.h-deck-card.cur[data-item="${first.id}"]`);
      await expect(card).toBeVisible();
      await expect(nextBtn(page).or(doneBtn(page)).first()).toBeEnabled();
      await card.locator(`button[data-answer="${first.id}"][data-option="${first.options[0].id}"]`).click();
      await expect(finished(page)).toBeVisible();
      await expect(homeBtn(page)).toHaveText('Back to Home');
      await expectState(request, first.id, 'answered', String(first.options[0].id));
      const prev = page.locator('button[data-deck="prev"]');
      await expect(prev).toBeEnabled();
      await prev.click();
      await expect(page.locator(`article.h-deck-card.cur[data-item="${first.id}"]`)).toBeVisible();
    });

    test(`@cfgs-ac3 [${label}] on the last card with earlier cards open Next reads Next open and wraps to the first open card`, async ({ page, request }) => {
      const left = await seed(page, request, size, (i, all) => i.id === singleOf(all)?.id || i.kind === 'account_owner');
      expect(left.length, 'the owner group and one single card are open').toBeGreaterThanOrEqual(3);
      await openDirect(page);
      const prev = page.locator('button[data-deck="prev"]');
      for (let i = 0; i < 6 && await prev.isEnabled(); i++) await prev.click();
      await expect(prev).toBeDisabled();
      const firstKey = await deckKey(page);
      for (let i = 0; i < 6 && !/^Next open/.test((await nextBtn(page).textContent()) || ''); i++) {
        const at = await deckKey(page);
        await nextBtn(page).click();
        await expect.poll(() => deckKey(page)).not.toBe(at);
      }
      await expect(nextBtn(page)).toHaveText(/^Next open/);
      await expect(nextBtn(page)).toBeEnabled();
      await nextBtn(page).click();
      await expect.poll(() => deckKey(page)).toBe(firstKey);
    });

    test(`@cfgs-ac3 [${label}] on the last card as the only open one Done ends on an honest finished block and Prev returns to it`, async ({ page, request }) => {
      const left = await seed(page, request, size, (i, all) => i.id === singleOf(all)?.id || i.kind === 'account_owner');
      expect(left.length, 'the owner group and one single card are open').toBeGreaterThanOrEqual(3);
      await openDirect(page);
      const prev = page.locator('button[data-deck="prev"]');
      for (let i = 0; i < 6 && await prev.isEnabled(); i++) await prev.click();
      await expect(prev).toBeDisabled();
      // Answer the first card; the other, last card stays open.
      const firstKey = await deckKey(page);
      const card = deckCard(page);
      if (await card.getAttribute('data-group')) {
        await answerRows(card);
        await nextBtn(page).click();
      } else {
        await card.locator('button[data-answer]').first().click();
      }
      await expect.poll(() => deckKey(page)).not.toBe(firstKey);
      const lastKey = await deckKey(page);
      await expect(doneBtn(page)).toBeEnabled();
      await expect(doneBtn(page)).toHaveText(/^Done/);
      await doneBtn(page).click();
      await expect(page.locator('.h-deck', { hasText: /\d+ questions? still open/ })).toBeVisible();
      await expect(page.locator('.h-deck', { hasText: 'All answered' })).toHaveCount(0);
      await expect(homeBtn(page)).toHaveText('Back to Home');
      await prev.click();
      await expect.poll(() => deckKey(page)).toBe(lastKey);
    });

    test(`@cfgs-ac4 [${label}] opened from Home, Back returns Home`, async ({ page, request }) => {
      const left = await seed(page, request, size, (i, all) => i.id === singleOf(all)?.id);
      expect(left).toHaveLength(1);
      await page.reload();
      await gotoRoute(page, 'home');
      await healthConfirm(page).click();
      await expect(page).toHaveURL(/#\/confirm$/);
      await finishDeck(page);
      await expect(homeBtn(page)).toHaveText('Back to Home');
      await homeBtn(page).click();
      await expect(page).toHaveURL(/#\/home$/);
    });

    test(`@cfgs-ac4 [${label}] opened from Accounts, Back returns to Accounts`, async ({ page, request }) => {
      const left = await seed(page, request, size, (i, all) => i.id === singleOf(all)?.id);
      expect(left).toHaveLength(1);
      await page.reload();
      await gotoRoute(page, 'accounts');
      await page.locator('a[data-go="confirm"]').first().click();
      await expect(page).toHaveURL(/#\/confirm$/);
      await finishDeck(page);
      await expect(homeBtn(page)).toHaveText('Back to Accounts');
      await homeBtn(page).click();
      await expect(page).toHaveURL(/#\/accounts$/);
    });
  });
}
