// Confirm deck on the demo build: the nav badge, the Year banner with Start, the card anatomy,
// the screen keys (pick, guess, next, prev, undo, leave), revisiting and changing an answer,
// Fathom's stored guess, keys ignored in text inputs, the All caught up state and touch swipes.
// Ids, kinds, options and labels come from GET /api/confirm; answers are verified through
// POST /api/confirm/list. Nothing is hard-coded beyond the pinned copy.

import { test, expect, resetDemo, gotoRoute, quickChecks, aboutMinutes, yearBanner, bannerStart, deckCard, deckProgress, deckCurrentId, deckTo } from './helpers.mjs';

// Kind labels shown in the card kicker (Horizon's labels for the confirm kinds).
const KIND = {
  account_owner: 'Account owner',
  account_kind: 'Account type',
  entity_alias: 'Business name',
  tax_year: 'Tax year',
  fact_check: 'Check a value',
  near_duplicate: 'Possible duplicate',
  employer_relation: 'Employer'
};

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const confirmPost = (r, id, verb) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/confirm/${id}/${verb}`;
const navConfirm = (page) => page.locator('.h-nav a[data-go="confirm"]');
const option = (page, id, optionId) => page.locator(`button[data-answer="${id}"][data-option="${optionId}"]`);
const caughtUp = (page) => page.locator('.h-empty', { hasText: 'All caught up' });

async function pending(request) {
  const res = await request.get('/api/confirm');
  expect(res.status()).toBe(200);
  const { items } = await res.json();
  return [...items].sort((a, b) => a.id - b.id);
}

async function allItems(request) {
  const res = await request.post('/api/confirm/list', { data: { status: 'all' } });
  expect(res.status()).toBe(200);
  return (await res.json()).items;
}

async function itemById(request, id) {
  const found = (await allItems(request)).filter((i) => i.id === id);
  expect(found, `exactly one item ${id}`).toHaveLength(1);
  return found[0];
}

async function expectPending(request, id) {
  const it = await itemById(request, id);
  expect(it.status, `item ${id} status`).toBe('pending');
  expect(it.answer ?? null).toBeNull();
}

async function expectAnswered(request, id, optionId) {
  const it = await itemById(request, id);
  expect(it.status, `item ${id} status`).toBe('answered');
  expect(it.answer).toBe(optionId);
}

async function answerAllViaApi(request) {
  for (let guard = 0; guard < 100; guard++) {
    const left = await pending(request);
    if (!left.length) return;
    const it = left[0];
    const res = await request.post(`/api/confirm/${it.id}/answer`, { data: { answer: it.options[0].id } });
    expect(res.status(), `answer ${it.id}`).toBe(200);
  }
  throw new Error('pending items did not drain');
}

// Keys go to the document, never to a focused control.
async function blur(page) {
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
}

// Press a key that answers item `id`, wait for the POST, and wait for the deck to move off it.
async function pressToAnswer(page, key, id) {
  const posted = page.waitForResponse((r) => confirmPost(r, id, 'answer'));
  await page.keyboard.press(key);
  const res = await posted;
  expect(res.status(), `answer ${id} with ${key}`).toBe(200);
  await expect(page.locator(`article.h-deck-card.cur[data-item="${id}"]`)).toHaveCount(0);
  return res;
}

async function openDeck(page, request) {
  const items = await pending(request);
  expect(items.length, 'the demo seeds at least 4 pending items').toBeGreaterThanOrEqual(4);
  await gotoRoute(page, 'confirm');
  await expect(page.locator('.h-deck')).toBeVisible();
  await expect(deckProgress(page)).toHaveText(`1 of ${items.length}`);
  await blur(page);
  return { items, order: items.map((i) => i.id), n: items.length };
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('the Confirm nav link shows the pending count and drops the badge at zero', async ({ page, request }) => {
  const items = await pending(request);
  expect(items.length).toBeGreaterThanOrEqual(4);
  await gotoRoute(page, 'brief');
  await expect(navConfirm(page)).toHaveCount(1);
  await expect(navConfirm(page)).toContainText('Confirm');
  await expect(navConfirm(page).locator('.h-nav-n')).toHaveText(String(items.length));

  await answerAllViaApi(request);
  await page.reload();
  await expect(page.locator('header.h-top')).toBeVisible();
  await expect(navConfirm(page)).toHaveCount(1);
  await expect(navConfirm(page).locator('.h-nav-n')).toHaveCount(0);
});

test('the Year banner shows quick checks and minutes, and Start opens the deck', async ({ page, request }) => {
  const items = await pending(request);
  const n = items.length;
  await gotoRoute(page, 'brief');
  const banner = yearBanner(page);
  await expect(banner).toHaveCount(1);
  await expect(banner.locator('b').first()).toContainText(quickChecks(n));
  await expect(banner).toContainText(aboutMinutes(n));
  await expect(bannerStart(page)).toBeVisible();
  await bannerStart(page).click();
  await expect(page).toHaveURL(/#\/confirm$/);
  await expect(page.locator('.h-deck')).toBeVisible();
  await expect(deckCard(page)).toHaveAttribute('data-item', String(items[0].id));
  await expect(deckProgress(page)).toHaveText(`1 of ${n}`);
});

test('card anatomy: kicker, question, numbered options, progress, Undo, peeks, Prev, Next and hint', async ({ page, request }) => {
  const { items, n } = await openDeck(page, request);
  const first = items[0];
  const sc = await (await request.get('/api/scenario')).json();
  const live = sc.live.ingest.items.find((i) => i.id === first.id);
  expect(live, 'the scenario lists the first pending item').toBeTruthy();

  const card = deckCard(page);
  await expect(card).toHaveAttribute('data-item', String(first.id));
  const kicker = card.locator('.h-cf-k');
  const kind = KIND[first.kind];
  expect(kind, `a label for kind ${first.kind}`).toBeTruthy();
  await expect(kicker).toHaveText(new RegExp(`^${reEsc(kind)}`));
  if (live.fileName) await expect(kicker.locator('span')).toHaveText(live.fileName);
  await expect(card.locator('.h-cf-q')).toHaveText(first.question);

  for (const [i, o] of first.options.entries()) {
    const b = option(page, first.id, o.id);
    await expect(b).toBeVisible();
    await expect(b).toHaveText(new RegExp(`^${i + 1} · ${reEsc(o.label)}`));
  }
  await expect(card.locator('button[data-answer]')).toHaveCount(first.options.length);

  await expect(deckProgress(page)).toHaveText(`1 of ${n}`);
  await expect(page.locator('.h-deck-bar')).toHaveCount(1);
  await expect(page.locator('button[data-deck="undo"]')).toBeDisabled();
  const peeks = page.locator('.h-deck-peek');
  await expect(peeks).toHaveCount(Math.min(2, n - 1));
  for (let i = 0; i < Math.min(2, n - 1); i++) await expect(peeks.nth(i)).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('button[data-deck="prev"]')).toContainText('Prev');
  await expect(page.locator('button[data-deck="next"]')).toContainText('Next');
  await expect(page.locator('.h-deck-hint')).toBeVisible();
});

test('number keys 1 to 3 answer with that option and advance', async ({ page, request }) => {
  const { items, order } = await openDeck(page, request);
  // Assign the most demanding key first so every key gets a card with enough options.
  const used = new Set();
  const plan = {};
  for (const key of [3, 2, 1]) {
    const it = items.find((i) => !used.has(i.id) && i.options.length >= key);
    expect(it, `a pending card with at least ${key} options`).toBeTruthy();
    used.add(it.id);
    plan[key] = it;
  }
  for (const key of [1, 2, 3]) {
    const it = plan[key];
    await deckTo(page, order, it.id);
    await pressToAnswer(page, String(key), it.id);
    await expectAnswered(request, it.id, it.options[key - 1].id);
  }
});

test('j, k and the arrow keys move between cards without answering', async ({ page, request }) => {
  const { order, n } = await openDeck(page, request);
  const steps = [['j', 2], ['ArrowRight', 3], ['k', 2], ['ArrowLeft', 1]];
  for (const [key, pos] of steps) {
    await page.keyboard.press(key);
    await expect(deckProgress(page)).toHaveText(`${pos} of ${n}`);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(order[pos - 1]));
  }
  expect((await pending(request)).map((i) => i.id)).toEqual(order);
});

test('z, u and the Undo button reopen the last answer and return to its card', async ({ page, request }) => {
  const { items, order } = await openDeck(page, request);
  const first = items[0];
  const undo = page.locator('button[data-deck="undo"]');

  for (const key of ['z', 'u']) {
    await deckTo(page, order, first.id);
    await pressToAnswer(page, '1', first.id);
    await expectAnswered(request, first.id, first.options[0].id);
    await expect(undo).toBeEnabled();
    const reopened = page.waitForResponse((r) => confirmPost(r, first.id, 'reopen'));
    await page.keyboard.press(key);
    expect((await reopened).status(), `reopen with ${key}`).toBe(200);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(first.id));
    await expectPending(request, first.id);
  }

  await pressToAnswer(page, '1', first.id);
  await expectAnswered(request, first.id, first.options[0].id);
  const reopened = page.waitForResponse((r) => confirmPost(r, first.id, 'reopen'));
  await undo.click();
  expect((await reopened).status()).toBe(200);
  await expect(deckCard(page)).toHaveAttribute('data-item', String(first.id));
  await expectPending(request, first.id);
  await expect(undo).toBeDisabled();
});

test('revisiting an answered card shows the choice, and another key revises it', async ({ page, request }) => {
  const { items } = await openDeck(page, request);
  const first = items[0];
  expect(first.options.length).toBeGreaterThanOrEqual(2);
  await pressToAnswer(page, '1', first.id);
  await expectAnswered(request, first.id, first.options[0].id);

  await page.keyboard.press('k');
  await expect(deckCard(page)).toHaveAttribute('data-item', String(first.id));
  await expect(option(page, first.id, first.options[0].id)).toHaveAttribute('aria-pressed', 'true');
  for (const o of first.options.slice(1)) await expect(option(page, first.id, o.id)).not.toHaveAttribute('aria-pressed', 'true');

  const posted = page.waitForResponse((r) => confirmPost(r, first.id, 'answer'));
  await page.keyboard.press('2');
  const res = await posted;
  expect(res.status()).toBe(200);
  expect(JSON.parse(res.request().postData() || '{}')).toMatchObject({ answer: first.options[1].id, revise: true });

  await expectAnswered(request, first.id, first.options[1].id);
  const same = (await allItems(request)).filter((i) => i.kind === first.kind && i.subject === first.subject);
  expect(same, 'one answered state for the item').toHaveLength(1);
});

test("Fathom's guess shows with its reason, never answers by itself, and Enter accepts it", async ({ page, request }) => {
  const { items, order, n } = await openDeck(page, request);

  // Walk the deck to find the one card carrying the stored guess.
  const guessed = [];
  for (let i = 0; i < n; i++) {
    await expect(deckProgress(page)).toHaveText(`${i + 1} of ${n}`);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(order[i]));
    if (await deckCard(page).locator('[data-guess="1"]').count()) guessed.push(order[i]);
    if (i < n - 1) await page.keyboard.press('j');
  }
  expect(guessed, 'exactly one card shows a guess').toHaveLength(1);
  const g = items.find((i) => i.id === guessed[0]);

  await deckTo(page, order, g.id);
  const guessBtn = deckCard(page).locator('[data-guess="1"]');
  await expect(guessBtn).toHaveCount(1);
  const guessOption = await guessBtn.getAttribute('data-option');
  const label = g.options.find((o) => o.id === guessOption)?.label;
  expect(label, 'the guess is one of the item options').toBeTruthy();
  await expect(deckCard(page).locator('.h-cf-guess')).toHaveText(new RegExp(`^Fathom's guess: ${reEsc(label)}`));
  await expect(deckCard(page).locator('.h-cf-why')).toHaveText(/\S/);
  await expectPending(request, g.id);

  await page.reload();
  await expect(page.locator('.h-deck')).toBeVisible();
  await expectPending(request, g.id);

  // Another card: a number key still picks any option (here the highest key the card allows).
  const other = items.find((i) => i.id !== g.id);
  await blur(page);
  await deckTo(page, order, other.id);
  const key = Math.min(9, other.options.length);
  await pressToAnswer(page, String(key), other.id);
  await expectAnswered(request, other.id, other.options[key - 1].id);

  // The guessed card: Enter accepts the guess and advances.
  await deckTo(page, order, g.id);
  await blur(page);
  await pressToAnswer(page, 'Enter', g.id);
  await expectAnswered(request, g.id, guessOption);
});

test('deck keys are ignored while focus is in a text input', async ({ page, request }) => {
  const { order, n } = await openDeck(page, request);
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/confirm/')) posts.push(new URL(r.url()).pathname);
  });
  await page.evaluate(() => {
    const el = document.createElement('input');
    el.type = 'text';
    el.id = 'e2e-probe';
    el.setAttribute('aria-label', 'Probe');
    document.body.appendChild(el);
  });
  const probe = page.locator('#e2e-probe');
  await probe.focus();
  await page.keyboard.type('1j');
  await page.keyboard.press('ArrowRight');
  await expect(probe).toHaveValue('1j');
  await expect(deckProgress(page)).toHaveText(`1 of ${n}`);
  await expect(deckCard(page)).toHaveAttribute('data-item', String(order[0]));

  // Liveness: with focus back on the document the same key moves the deck.
  await blur(page);
  await page.keyboard.press('j');
  await expect(deckProgress(page)).toHaveText(`2 of ${n}`);
  expect(posts).toEqual([]);
  expect((await pending(request)).map((i) => i.id)).toEqual(order);
});

test('Escape leaves the deck for the Year page', async ({ page, request }) => {
  await openDeck(page, request);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/brief$/);
  await expect(yearBanner(page)).toBeVisible();
});

test('answering every card from the keyboard ends at All caught up and clears the badge', async ({ page, request }) => {
  const { n } = await openDeck(page, request);
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await deckCurrentId(page);
    await pressToAnswer(page, '1', last);
  }
  await expect(caughtUp(page)).toBeVisible();
  await expect(deckCard(page)).toHaveCount(0);
  await expect(navConfirm(page).locator('.h-nav-n')).toHaveCount(0);
  expect(await pending(request)).toEqual([]);

  // Prev from the empty state returns to the last card.
  await page.keyboard.press('k');
  await expect(deckCard(page)).toHaveAttribute('data-item', String(last));
});

test.describe('confirm deck on a phone', { tag: ['@mobile', '@mobile-only'] }, () => {
  const transformOf = (page) => deckCard(page).evaluate((el) => getComputedStyle(el).transform);

  // A one-finger horizontal drag on the current card through CDP touch events. It starts at the
  // card's horizontal center, on the question line so no option button sits under the finger.
  // With `follow`, it waits before lifting the finger until the card is visibly displaced.
  async function drag(page, cdp, dx, { follow = false, steps = 10 } = {}) {
    const cb = await deckCard(page).boundingBox();
    const qb = await deckCard(page).locator('.h-cf-q').boundingBox();
    const x = Math.round(cb.x + cb.width / 2);
    const y = Math.round(qb.y + qb.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x + (dx * i) / steps), y, id: 1 }] });
    }
    if (follow) {
      await expect.poll(() => transformOf(page), { message: 'the card follows the finger' }).not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  test('swipes move between cards, a short drag springs back, and nothing is answered', async ({ page, request }) => {
    expect(page.viewportSize()?.width).toBe(390);
    const { order, n } = await openDeck(page, request);
    const posts = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/confirm/')) posts.push(new URL(r.url()).pathname);
    });
    const cdp = await page.context().newCDPSession(page);

    await drag(page, cdp, 150, { follow: true });
    await expect(deckProgress(page)).toHaveText(`2 of ${n}`);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(order[1]));

    await drag(page, cdp, -150);
    await expect(deckProgress(page)).toHaveText(`1 of ${n}`);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(order[0]));

    await drag(page, cdp, 20);
    await expect(deckProgress(page)).toHaveText(`1 of ${n}`);
    await expect(deckCard(page)).toHaveAttribute('data-item', String(order[0]));
    await expect.poll(() => transformOf(page), { message: 'the card springs back' }).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

    expect(posts).toEqual([]);
    expect((await pending(request)).map((i) => i.id)).toEqual(order);

    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(widths.doc, 'no horizontal page scroll on #/confirm').toBeLessThanOrEqual(widths.inner);
  });
});
