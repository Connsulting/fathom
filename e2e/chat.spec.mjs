// Chat over the data (item 6): every Fathom answer carries a Sources disclosure listing the tools
// it read and the figures it used, grounded answers say so, numbers nothing supports are marked
// unchecked in place (neutral, "Not checked against your data"), and a switched-off engine answers
// with a notice instead of making anything up.
// Demo mode runs the live pipeline with the deterministic fake answer source.

import { test, expect, S, resetDemo, visibleRecs, plain, gotoRoute, expectH1, recDialog, bareDollarNodes, rec, liveStatus, ASK_HELLO, ASK_THREAD_URL, askOnAsk } from './helpers.mjs';

const ENGINE_OFF_NOTICE = 'Engine is off, so answers are paused. Switch it back on to get an answer.';
const GROUNDED = 'Every number is from your data or a tool result.';
const UNVERIFIED = 'Some numbers could not be verified and are marked.';

// An invented amount that appears nowhere in the demo data or any tool result.
const INVENTED_AMOUNT = '$987,654';

const FIG_TOKEN = /\{fk?:([A-Za-z0-9_]+)\}/;

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

function answers(scope) {
  return scope.locator('.h-thread .h-msg.fathom');
}

// Opens the Sources disclosure of one answer and returns it.
async function openSources(msg) {
  const src = msg.locator('details.h-src');
  await expect(src).toHaveCount(1);
  await expect(src.locator('summary')).toHaveText('Sources');
  await src.locator('summary').click();
  await expect(src).toHaveAttribute('open', '');
  return src;
}

function tool(src, name) {
  return src.locator('li.h-src-tool').filter({ has: src.page().locator('code', { hasText: new RegExp(`^${name}$`) }) });
}

// Free text in a rec dialog composer (the Ask page has its own composer, see askOnAsk).
async function askFree(scope, key, text) {
  const input = scope.locator(`form.h-compose[data-free="${key}"] input[name="q"]`);
  await input.fill(text);
  await input.press('Enter');
}

test('an Ask answer to a suggested question shows a figure and Sources listing the tools it used', async ({ page }) => {
  const q = S.ask.suggested.find((x) => (x.a || []).some((p) => FIG_TOKEN.test(p)));
  expect(q, 'a suggested question whose answer uses a figure').toBeTruthy();
  const key = (q.a || []).map((p) => FIG_TOKEN.exec(p)).find(Boolean)[1];

  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  // The fake answer source maps the exact suggested wording to its canned answer.
  await askOnAsk(page, plain(q.q));
  const msg = answers(page).last();
  await expect(answers(page)).toHaveCount(1);
  await expect(msg).not.toHaveClass(/\bnotice\b/);
  await expect(msg.locator(`.h-msg-b .fx-fig[data-fig="${key}"]`).first()).toBeVisible();

  const src = await openSources(msg);
  await expect(src.locator('li.h-src-tool').first()).toBeVisible();
  await expect(tool(src, 'household_summary')).toHaveCount(1);
  await expect(tool(src, 'household_summary').locator('span')).toHaveText('no arguments');
  await expect(tool(src, 'get_figures')).toHaveCount(1);
  await expect(tool(src, 'get_figures').locator('span')).toContainText(key);
  await expect(src.locator(`li.h-src-fig .fx-fig[data-fig="${key}"]`)).toBeVisible();

  // Sources keep the provenance rule: amounts there are figures too.
  expect(await bareDollarNodes(page)).toEqual([]);

  // The answer and its provenance are stored, not page state.
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await page.reload();
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(answers(page)).toHaveCount(1);
  await expect(answers(page).last().locator('details.h-src')).toHaveCount(1);
});

test('a free text question with no canned match gets a grounded answer', async ({ page }) => {
  const text = 'Give me a quick read on where the household stands right now';
  const canned = S.ask.suggested.map((x) => plain(x.q).trim().toLowerCase());
  expect(canned).not.toContain(text.toLowerCase());

  await gotoRoute(page, 'ask');
  await askOnAsk(page, text);
  await expect(page.locator('.h-thread .h-msg.me').last()).toContainText(text);
  const msg = answers(page).last();
  await expect(answers(page)).toHaveCount(1);
  await expect(msg).not.toHaveClass(/\bnotice\b/);
  await expect(msg.locator('.h-msg-b')).toContainText('need you right now');
  await expect(msg.locator('.fx-unverified, .fx-unchecked')).toHaveCount(0);
  // R9: a literal number grounded by a tool result is bound to its source.
  await expect(msg.locator('.h-msg-b .fx-src').first()).toBeVisible();

  const src = await openSources(msg);
  await expect(tool(src, 'household_summary')).toHaveCount(1);
  await expect(src.locator('p.h-src-ok')).toHaveText(GROUNDED);
  await expect(src.locator('p.h-src-warn')).toHaveCount(0);
});

test('a free text question naming an invented amount marks it unchecked in place', async ({ page }) => {
  const text = `Can I put ${INVENTED_AMOUNT} in my HSA?`;

  await gotoRoute(page, 'ask');
  await askOnAsk(page, text);
  const msg = answers(page).last();
  await expect(answers(page)).toHaveCount(1);
  await expect(msg).not.toHaveClass(/\bnotice\b/);
  const marked = msg.locator('.h-msg-b .fx-unchecked');
  await expect(marked.first()).toBeVisible();
  await expect(marked.filter({ hasText: '987,654' })).toHaveCount(1);
  await expect(marked.first()).toHaveAttribute('title', 'Not checked against your data');
  await expect(marked.first()).toHaveClass(/\bfx-checking\b/);
  await expect(msg.locator('.fx-unverified')).toHaveCount(0);

  const src = await openSources(msg);
  await expect(src.locator('p.h-src-warn')).toHaveText(UNVERIFIED);
  await expect(src.locator('p.h-src-ok')).toHaveCount(0);
});

test('a rec conversation answer shows Sources naming the recommendation it read', async ({ page }) => {
  const r = visibleRecs().find((x) => (x.qa || []).length);
  expect(r, 'a visible rec with suggested questions').toBeTruthy();

  await gotoRoute(page, `rec/${r.id}`);
  const dlg = recDialog(page);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(plain(r.title));
  await dlg.locator(`button.h-chip[data-askrec="${r.id}"]`).first().click();
  const msg = answers(dlg).last();
  await expect(answers(dlg)).toHaveCount(1);
  await expect(msg).not.toHaveClass(/\bnotice\b/);

  const src = await openSources(msg);
  await expect(tool(src, 'get_recommendation')).toHaveCount(1);
  await expect(tool(src, 'get_recommendation').locator('span')).toContainText(r.id);
});

test('with the engine switched off an ask gets the notice message', async ({ page }) => {
  const q = S.ask.suggested[0];

  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  await page.getByRole('button', { name: 'Turn the engine off', exact: true }).click();
  await expectH1(page, 'Paused');

  await gotoRoute(page, 'ask');
  await askOnAsk(page, plain(q.q));
  await expect(answers(page)).toHaveCount(1);
  const msg = answers(page).last();
  await expect(msg).toHaveClass(/\bnotice\b/);
  await expect(page.locator('.h-thread .h-msg.fathom.notice')).toHaveCount(1);
  await expect(msg).toContainText(ENGINE_OFF_NOTICE);

  await expect(page).toHaveURL(ASK_THREAD_URL);
  await page.reload();
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(page.locator('.h-thread .h-msg.fathom.notice')).toHaveCount(1);
});

// B2: chat never writes. An explicit command in a rec conversation comes back as a confirm card
// inside the Fathom message; the rec changes only when the owner clicks Confirm, and the card then
// shows Done in place of the button.
async function recStatusOf(request, id) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  const sc = await res.json();
  return sc.recs.find((x) => x.id === id).status;
}

test('B2: "dismiss this" in a rec conversation proposes; Confirm dismisses the rec and the card shows Done', async ({ page, request }) => {
  const id = 'dcfsa';
  const r = rec(id);
  expect(liveStatus(r), 'a proposed rec to dismiss').toBe('proposed');

  await gotoRoute(page, `rec/${id}`);
  const dlg = recDialog(page);
  await expect(dlg.locator('#h-dlg-t')).toHaveText(plain(r.title));
  await askFree(dlg, `rec:${id}`, 'dismiss this');
  await expect(answers(dlg)).toHaveCount(1);
  const msg = answers(dlg).last();
  await expect(msg).not.toHaveClass(/\bnotice\b/);

  const confirm = msg.locator(`button.h-propose[data-propose-rec="${id}"][data-propose-action="dismiss"]`);
  await expect(confirm).toHaveCount(1);
  await expect(confirm).toHaveText('Confirm');
  await expect(msg).toContainText('Not for us');
  await expect(msg).toContainText(plain(r.title));

  // Nothing is written until the owner confirms.
  expect(await recStatusOf(request, id)).toBe('proposed');
  await expect(dlg.locator('.h-rec-head .h-st')).not.toHaveText('Not for us');

  await confirm.click();
  await expect(dlg.locator('.h-rec-head .h-st')).toHaveText('Not for us');
  await expect.poll(() => recStatusOf(request, id)).toBe('dismissed');
  const done = answers(dlg).last();
  await expect(done.locator('button.h-propose')).toHaveCount(0);
  await expect(done).toContainText('Done');

  // The card state follows the stored rec status, so it survives a reload.
  await page.reload();
  const again = answers(recDialog(page)).last();
  await expect(again.locator('button.h-propose')).toHaveCount(0);
  await expect(again).toContainText('Done');
});
