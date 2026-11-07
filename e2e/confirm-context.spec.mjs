// Confirm context on the demo build: the household fixture (an aggregator export with holder names,
// the checking account's bank export and a positions export) is uploaded through Accounts, then the
// Confirm page shows the owner group card with account detail and same-named accounts, row
// overrides that save on click, Accept best guesses with propagation into Decided for you, Undo on a decided
// answer that is never re-answered, the account type best guess with its evidence, the compare
// table on the remaining possible duplicate, a single card's Use best guess, and the deck Undo of a
// whole group apply.
// Ids, options, guesses, evidence and counts come from the API (GET /api/confirm, GET /api/scenario
// live.ingest, POST /api/confirm/list). Only fixture text (account names, holders, masks, file
// names) and the pinned copy are hard-coded.

import { fileURLToPath } from 'node:url';
import { test, expect, resetDemo, gotoRoute, deckFind } from './helpers.mjs';

const AGG = 'aggregator-household.csv';
const BANK = 'Chase4455_Activity_20261031.csv';
const POS = 'positions-household.csv';
const fixture = (name) => fileURLToPath(new URL(`../test/fixtures/ingest/household/${name}`, import.meta.url));

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPost = (r, path) => r.request().method() === 'POST' && new URL(r.url()).pathname === path;
const evidenceText = (e) => (typeof e === 'string' ? e : String(e?.text ?? ''));
const guessEvidence = (g) => String(g?.evidence ?? g?.reason ?? '');

async function pendingItems(request) {
  const res = await request.get('/api/confirm');
  expect(res.status()).toBe(200);
  return (await res.json()).items;
}
const pendingIds = async (request) => (await pendingItems(request)).map((i) => i.id);

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

async function expectAnswered(request, id, optionId) {
  const it = (await allById(request)).get(id);
  expect(it, `item ${id}`).toBeTruthy();
  expect(it.status, `item ${id} status`).toBe('answered');
  expect(it.answer, `item ${id} answer`).toBe(optionId);
}

async function answerViaApi(request, it, optionId) {
  const res = await request.post(`/api/confirm/${it.id}/answer`, { data: { answer: optionId } });
  expect(res.status(), `answer ${it.id}`).toBe(200);
}

// The pending item of `kind` whose account panel names `name` (first match).
function itemForAccount(ing, kind, name) {
  const it = ing.items.find((i) => i.kind === kind && i.detail?.account?.name === name);
  expect(it, `a pending ${kind} item for ${name}`).toBeTruthy();
  return it;
}

// Upload the three household files in one batch through the Accounts Add files input.
async function uploadHousehold(page) {
  await gotoRoute(page, 'accounts');
  const uploaded = page.waitForResponse((r) => isPost(r, '/api/files'));
  await page.locator('input[type=file][data-upload]').setInputFiles([AGG, BANK, POS].map(fixture));
  const res = await uploaded;
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.files.map((f) => f.status)).toEqual(['imported', 'imported', 'imported']);
  return body;
}

async function openConfirm(page) {
  await gotoRoute(page, 'confirm');
  await expect(page.locator('.h-deck')).toBeVisible();
}

const decidedSection = (page) => page.locator('section.h-cf-decided');

// Decided for you shows a handful of rows; open the rest before looking for a particular one.
async function showAllDecided(page) {
  const more = decidedSection(page).locator('button[data-decided-more]');
  if (await more.count() && /Show all/.test(await more.innerText())) await more.click();
}

async function openRowDetail(card, id) {
  const det = card.locator(`details[data-row-detail="${id}"]`);
  await expect(det).toHaveCount(1);
  await det.locator('summary').first().click();
  await expect(det).toHaveAttribute('open', /.*/);
  return det;
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('the owner group card lists every pending owner question with account detail and same-named accounts', async ({ page, request }) => {
  const seeded = (await pendingItems(request)).filter((i) => i.kind === 'account_owner').map((i) => i.id);
  expect(seeded.length, 'the demo seeds an owner question').toBeGreaterThanOrEqual(1);
  await uploadHousehold(page);
  const owners = (await pendingItems(request)).filter((i) => i.kind === 'account_owner');
  expect(owners.length, 'owner questions form a group').toBeGreaterThanOrEqual(2);
  for (const id of seeded) expect(owners.map((i) => i.id), 'the seeded owner question is still pending').toContain(id);
  const ing = await ingestState(request);

  await openConfirm(page);
  const card = await deckFind(page, '[data-group="account_owner"]');
  await expect(card.locator('tr[data-row]')).toHaveCount(owners.length);
  for (const it of owners) await expect(card.locator(`tr[data-row="${it.id}"]`)).toBeVisible();

  // Everyday Checking: holder, mask, both source files, the row count and a recent transaction.
  const checking = itemForAccount(ing, 'account_owner', 'Everyday Checking');
  const view = checking.detail.account;
  expect(view.recent.length, 'the checking account has recent transactions').toBeGreaterThanOrEqual(1);
  const det = await openRowDetail(card, checking.id);
  const acct = det.locator('.h-cf-acct').first();
  await expect(acct).toBeVisible();
  await expect(acct.locator('[data-field="holder"]')).toContainText('Avery Example');
  await expect(acct.locator('[data-field="mask"]')).toContainText('4455');
  await expect(acct.locator('[data-field="files"]')).toContainText(AGG);
  await expect(acct.locator('[data-field="files"]')).toContainText(BANK);
  await expect(acct.locator('[data-field="rows"]')).toContainText(new RegExp(`\\b${view.rows.transactions}\\b`));
  await expect(det.locator('.h-cf-recent li').first()).toContainText(view.recent[0].description);

  // An Individual TOD row: its same-named table lists the other Individual TOD accounts and marks
  // the cells that differ.
  const tod = ing.items.find((i) => i.kind === 'account_owner' && i.detail?.account?.name === 'Individual TOD' && i.detail.sameName?.length);
  expect(tod, 'a pending Individual TOD owner question with same-named accounts').toBeTruthy();
  for (const s of tod.detail.sameName) expect(s.name).toBe('Individual TOD');
  const todDet = await openRowDetail(card, tod.id);
  const same = todDet.locator('table.h-cf-same');
  await expect(same).toBeVisible();
  for (const s of tod.detail.sameName) await expect(same.locator(`tr[data-account="${s.id}"]`)).toHaveCount(1);
  await expect(same.locator('td[data-differs="1"]').first()).toBeVisible();
});

test('override one row (saved on click), see propagation in Decided for you, undo it, then accept the best guesses', async ({ page, request }) => {
  await uploadHousehold(page);
  const ing = await ingestState(request);
  const owners = ing.items.filter((i) => i.kind === 'account_owner');
  expect(owners.length).toBeGreaterThanOrEqual(2);

  await openConfirm(page);
  const card = await deckFind(page, '[data-group="account_owner"]');

  // Nothing is preselected: a stored best guess shows its tag but its option is not pressed.
  await expect(card.locator('button[data-row-answer][aria-pressed="true"]')).toHaveCount(0);
  for (const it of owners) {
    if (it.guess?.option == null) continue;
    const g = card.locator(`button[data-row-answer="${it.id}"][data-option="${it.guess.option}"]`);
    await expect(g).toHaveAttribute('data-guess', '1');
    await expect(g).toHaveAttribute('aria-pressed', 'false');
  }

  // Override the Everyday Checking row: the click saves it at once.
  const checking = itemForAccount(ing, 'account_owner', 'Everyday Checking');
  const override = ['owner', 'spouse'].find((o) => o !== String(checking.guess?.option));
  const pick = card.locator(`button[data-row-answer="${checking.id}"][data-option="${override}"]`);
  const answered = page.waitForResponse((r) => isPost(r, `/api/confirm/${checking.id}/answer`));
  await pick.click();
  expect((await answered).status()).toBe(200);
  await expect(pick).toHaveAttribute('aria-pressed', 'true');
  for (const o of checking.options.filter((x) => x.id !== override)) {
    await expect(card.locator(`button[data-row-answer="${checking.id}"][data-option="${o.id}"]`)).not.toHaveAttribute('aria-pressed', 'true');
  }
  await expectAnswered(request, checking.id, override);

  // Rows answered by propagation (no click, answered now) show in Decided for you with evidence.
  const all = await allById(request);
  const auto = owners.filter((i) => i.id !== checking.id && all.get(i.id)?.status === 'answered').map((i) => i.id);
  expect(auto.length, 'the override propagates to at least one other row').toBeGreaterThanOrEqual(1);
  const decided = (await ingestState(request)).decided;
  const section = decidedSection(page);
  await expect(section.getByRole('heading', { name: 'Decided for you' })).toBeVisible();
  await showAllDecided(page);
  for (const id of auto) {
    const d = decided.find((x) => x.id === id);
    expect(d, `item ${id} is listed as decided`).toBeTruthy();
    const li = section.locator(`li[data-decided="${id}"]`);
    await expect(li).toBeVisible();
    await expect(li).toContainText(evidenceText(d.evidence));
    await expect(li).toContainText(d.answerLabel);
  }

  // The deck Undo reopens the override and the answers resting on it.
  const undo = page.locator('button[data-deck="undo"]');
  await expect(undo).toBeEnabled();
  const reopened = page.waitForResponse((r) => isPost(r, '/api/confirm/reopen-many'));
  await undo.click();
  expect((await reopened).status()).toBe(200);
  const left = await pendingIds(request);
  for (const id of [checking.id, ...auto]) expect(left, `item ${id} is pending again`).toContain(id);
  for (const id of auto) await expect(section.locator(`li[data-decided="${id}"]`)).toHaveCount(0);

  // Accept takes the best guess of every unanswered row that has one, and nothing else.
  const guessed = (await ingestState(request)).items.filter((i) => i.kind === 'account_owner' && i.guess?.option != null);
  expect(guessed.length, 'a stored best guess remains').toBeGreaterThanOrEqual(1);
  const apply = card.locator('button[data-group-apply]');
  await expect(apply).toHaveText(`Accept ${guessed.length} best guess${guessed.length === 1 ? '' : 'es'}`);
  const posted = page.waitForResponse((r) => isPost(r, '/api/confirm/answers'));
  await apply.click();
  const res = await posted;
  expect(res.status()).toBe(200);
  const sent = JSON.parse(res.request().postData() || '{}').answers || [];
  expect(Object.fromEntries(sent.map((a) => [String(a.id), String(a.answer)])), 'only the best guesses are submitted').toEqual(Object.fromEntries(guessed.map((i) => [String(i.id), String(i.guess.option)])));
  for (const it of guessed) await expectAnswered(request, it.id, String(it.guess.option));
});

test('Decided for you lists the cross-format duplicates; Undo reopens one and it is never re-answered', async ({ page, request }) => {
  await uploadHousehold(page);
  const ing = await ingestState(request);
  const dups = ing.decided.filter((d) => d.rule === 'cross_format_duplicate');
  expect(dups, 'two cross-format duplicates were answered automatically').toHaveLength(2);

  await openConfirm(page);
  const section = decidedSection(page);
  await expect(section.getByRole('heading', { name: 'Decided for you' })).toBeVisible();
  await showAllDecided(page);
  for (const d of dups) {
    const li = section.locator(`li[data-decided="${d.id}"]`);
    await expect(li).toBeVisible();
    await expect(li).toContainText(d.question);
    await expect(li).toContainText(d.answerLabel);
    await expect(li).toContainText(evidenceText(d.evidence));
    await expect(li).toContainText(AGG);
    await expect(li).toContainText(BANK);
  }

  const [d, other] = dups;
  expect(d.final ?? null, 'the decided answer is not final').toBeNull();
  const undo = section.locator(`button[data-decided-undo="${d.id}"]`);
  await expect(undo).toHaveText('Undo');
  await undo.click();
  await expect(section.locator(`li[data-decided="${d.id}"]`)).toHaveCount(0);
  await expect.poll(() => pendingIds(request), { message: `item ${d.id} is pending again` }).toContain(d.id);
  await expect(section.locator(`li[data-decided="${other.id}"]`)).toBeVisible();

  // Another answer elsewhere runs auto-resolution again; the undone item stays open.
  const pend = await pendingItems(request);
  const elsewhere = pend.find((i) => i.kind === 'tax_year') || pend.find((i) => i.id !== d.id);
  await answerViaApi(request, elsewhere, elsewhere.options[0].id);
  expect(await pendingIds(request), `item ${d.id} is not answered again`).toContain(d.id);
  await expectAnswered(request, other.id, other.answer);
});

test('the account type card shows the Rewards Card best guess with evidence naming the account', async ({ page, request }) => {
  await uploadHousehold(page);
  const ing = await ingestState(request);
  const kinds = ing.items.filter((i) => i.kind === 'account_kind');
  const rewards = itemForAccount(ing, 'account_kind', 'Rewards Card');
  expect(rewards.guess?.option, 'the Rewards Card has a best guess').toBeTruthy();
  const evidence = guessEvidence(rewards.guess);
  expect(evidence).toContain('Rewards Card');

  await openConfirm(page);
  if (kinds.length >= 2) {
    const card = await deckFind(page, '[data-group="account_kind"]');
    const row = card.locator(`tr[data-row="${rewards.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Best guess');
    const guessBtn = card.locator(`button[data-row-answer="${rewards.id}"][data-option="${rewards.guess.option}"]`);
    await expect(guessBtn).toHaveAttribute('data-guess', '1');
    await expect(guessBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(card).toContainText(evidence);
  } else {
    const card = await deckFind(page, `[data-item="${rewards.id}"]`);
    await expect(card.locator(`button[data-guess="1"][data-option="${rewards.guess.option}"] .h-cf-best`)).toHaveText('Best guess');
    await expect(card.locator('.h-cf-guess')).toContainText(evidence);
  }
});

test('the remaining possible duplicate shows both entries side by side and can be answered', async ({ page, request }) => {
  await uploadHousehold(page);
  const ing = await ingestState(request);
  const it = ing.items.find((i) => i.kind === 'near_duplicate' && i.detail?.entries?.some((e) => /Corner Cafe/i.test(String(e.description))));
  expect(it, 'the Corner Cafe pair is still a question').toBeTruthy();
  expect(it.detail.entries).toHaveLength(2);

  await openConfirm(page);
  const card = await deckFind(page, `[data-item="${it.id}"]`);
  const table = card.locator('table.h-cf-compare');
  await expect(table).toBeVisible();
  const date = table.locator('tr[data-field="date"]');
  await expect(date).toHaveAttribute('data-differs', '1');
  await expect(date.locator('td')).toHaveCount(2);
  await expect(table.locator('tr[data-field="amount"]')).not.toHaveAttribute('data-differs', '1');
  await expect(table).toContainText(AGG);
  await expect(table).toContainText(BANK);

  const g = it.guess?.option != null ? String(it.guess.option) : null;
  const choice = g ? card.locator('button[data-take-guess]') : card.locator(`button[data-answer="${it.id}"][data-option="${it.options[0].id}"]`);
  const posted = page.waitForResponse((r) => isPost(r, `/api/confirm/${it.id}/answer`));
  await choice.click();
  expect((await posted).status()).toBe(200);
  await expectAnswered(request, it.id, g ?? it.options[0].id);
});

test('a single card with a best guess tags the option, explains it, and Use best guess answers it', async ({ page, request }) => {
  await uploadHousehold(page);
  let ing = await ingestState(request);
  const rewards = itemForAccount(ing, 'account_kind', 'Rewards Card');
  // Answer the other account type questions so the Rewards Card is a single card.
  for (const it of ing.items.filter((i) => i.kind === 'account_kind' && i.id !== rewards.id)) {
    await answerViaApi(request, it, it.guess?.option != null ? String(it.guess.option) : it.options[0].id);
  }
  ing = await ingestState(request);
  expect(ing.items.filter((i) => i.kind === 'account_kind').map((i) => i.id)).toEqual([rewards.id]);
  const guess = ing.items.find((i) => i.id === rewards.id).guess;
  expect(guess?.option, 'the Rewards Card has a best guess').toBeTruthy();
  const label = rewards.options.find((o) => String(o.id) === String(guess.option))?.label;
  expect(label, 'the guess is one of the options').toBeTruthy();

  // The API answers above bypass the page, and a hash-route goto does not reload it, so reload to drop the stale scenario.
  await page.reload();
  await openConfirm(page);
  const card = await deckFind(page, `[data-item="${rewards.id}"]`);
  const tagged =card.locator('button[data-guess="1"]');
  await expect(tagged).toHaveCount(1);
  await expect(tagged).toHaveAttribute('data-option', String(guess.option));
  await expect(tagged.locator('.h-cf-best')).toHaveText('Best guess');
  await expect(card.locator('.h-cf-guess')).toHaveText(new RegExp(`^Best guess: ${reEsc(label)}`));
  await expect(card.locator('.h-cf-guess')).toContainText(guessEvidence(guess));
  expect((await allById(request)).get(rewards.id)?.status, 'showing a guess answers nothing').toBe('pending');

  const take = card.locator('button[data-take-guess]');
  await expect(take).toHaveText('Use best guess');
  const posted = page.waitForResponse((r) => isPost(r, `/api/confirm/${rewards.id}/answer`));
  await take.click();
  expect((await posted).status()).toBe(200);
  await expectAnswered(request, rewards.id, String(guess.option));
});
