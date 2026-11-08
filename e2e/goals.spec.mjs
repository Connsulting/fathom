// Goals without forms (SX3), on the demo build at desktop and 390px: a new goal is one sentence
// that Ask saves, Fathom sets its target with Undo, and there is no rate input or curve slider;
// Archive and Delete live in the edit view and a done goal archives itself; onboarding Priorities
// still save the curve positions; a rec shows the goal it serves.

import { test, expect, resetDemo, gotoRoute, expectH1, openRecFromPage, recDialog, askOnAsk, plain, S } from './helpers.mjs';

const TAGS = { tag: ['@mobile'] };

const goalCard = (page, title) => page.locator('article.h-goal', { has: page.locator('.h-goal-h b', { hasText: title }) });

// Open the archived goals list unless it is already open (the page remembers it).
async function openArchived(page) {
  const det = page.locator('details.h-garch');
  await expect(det).toHaveCount(1);
  if (!(await det.evaluate((d) => d.open))) await det.locator('summary').click();
}

async function gotoGoals(page) {
  await gotoRoute(page, 'goals');
  await expectH1(page, 'Where you are headed');
}

const saved = (page, path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST' && r.status() === 200);

// The demo store has finished onboarding; serve every scenario as a fresh one on step 2 (the curve).
async function forceOnboarding(page) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: 2 });
    return route.fulfill({ response: res, json: body });
  });
}

test.describe('goals', TAGS, () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  test('a new goal is one sentence: Ask saves it and Fathom sets its target, with Undo', async ({ page }, info) => {
    await gotoGoals(page);
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    const form = page.locator('form.h-gform');
    await expect(form).toBeVisible();
    // One sentence and nothing else to decide.
    await expect(form.locator('input, select, textarea')).toHaveCount(1);
    await expect(form.getByLabel('Your goal, in one sentence')).toBeVisible();
    await page.screenshot({ path: info.outputPath('goals-new-sentence.png'), fullPage: true });
    await form.getByRole('button', { name: 'Add goal' }).click();
    await expect(form.locator('.h-gerr')).toHaveText('Write the goal in one sentence.');

    await form.getByLabel('Your goal, in one sentence').fill('A cash cushion for the next few years');
    await form.getByRole('button', { name: 'Add goal' }).click();
    await expect(page).toHaveURL(/#\/ask/);
    const receipt = page.locator('.h-action-receipt');
    await expect(receipt).toContainText('A cash cushion for the next few years');
    await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();

    await gotoGoals(page);
    const card = goalCard(page, 'A cash cushion for the next few years');
    await expect(card).toHaveCount(1);
    await expect(page.locator('.h-gcol', { hasText: 'Next few years' }).first().locator('article.h-goal', { hasText: 'A cash cushion for the next few years' })).toHaveCount(1);
    // Fathom set the target: it says so, with Undo, and no rate input or curve slider anywhere.
    await expect(card.locator('p.h-gset')).toHaveText('Fathom set this target. Undo');
    await expect(page.locator('input[data-sugg-rate], input[data-curve], input[type="range"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(Accept|Accept all|Dismiss)$/ })).toHaveCount(0);
    const id = await card.getAttribute('data-goal-id');
    await page.waitForLoadState('networkidle');
    const source = page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v');
    await expect(async () => {
      if (!(await page.locator('.fx-pop').count())) await card.locator(`.fx-fig[data-fig="goal.${id}.target"]`).first().click();
      await expect(source).toHaveText('Suggested target calculator', { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath('goals-adopted.png'), fullPage: true });

    // Undo takes the target back and it stays gone.
    const undo = saved(page, `/api/goals/${id}/suggestion`);
    await card.locator('p.h-gset').getByRole('button', { name: 'Undo' }).click();
    await undo;
    await expect(card.locator('p.h-gset')).toHaveCount(0);
    await expect(card.locator('p.h-gnone')).toContainText('No target yet.');
    await page.reload();
    await expect(goalCard(page, 'A cash cushion for the next few years').locator('p.h-gset')).toHaveCount(0);
  });

  test('Archive and Delete live in the edit view; a done goal archives itself', async ({ page, request }) => {
    const res = await request.post('/api/goals', { headers: { 'content-type': 'application/json' }, data: { title: 'A cabin by the lake <b>{f:portfolio}</b>', horizon: '1-3y' } });
    expect(res.status()).toBe(200);
    const title = 'A cabin by the lake';
    await gotoGoals(page);
    const card = goalCard(page, title);
    // Owner text renders literally: no markup, no token.
    await expect(card.locator('.h-goal-h b')).toHaveText('A cabin by the lake <b>{f:portfolio}</b>');
    await expect(card.getByRole('button', { name: 'Archive' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // Archive from the edit view; restore from the archived list.
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.locator('form.h-gform');
    await expect(form.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
    await form.getByRole('button', { name: 'Archive' }).click();
    await expect(form).toHaveCount(0);
    const arch = page.locator('details.h-garch');
    await expect(arch.locator('summary')).toHaveText('1 archived goal');
    await openArchived(page);
    await arch.getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('details.h-garch')).toHaveCount(0);

    // Mark done archives it; it reads Done there, and Reopen brings it back.
    await goalCard(page, title).getByRole('button', { name: 'Mark done' }).click();
    await expect(page.locator('details.h-garch summary')).toHaveText('1 archived goal');
    await openArchived(page);
    await expect(goalCard(page, title).locator('.h-goal-h span')).toHaveText('Done');
    await page.locator('details.h-garch').getByRole('button', { name: 'Reopen' }).click();
    await expect(page.locator('details.h-garch')).toHaveCount(0);

    // Delete asks first, in the edit view.
    await goalCard(page, title).getByRole('button', { name: 'Edit', exact: true }).click();
    await form.getByRole('button', { name: 'Delete' }).click();
    await expect(form).toContainText('Delete for good?');
    await form.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(goalCard(page, title)).toHaveCount(0);
  });

  test('N on Goals and the switcher action open the new goal form', async ({ page }) => {
    await gotoGoals(page);
    await page.keyboard.press('n');
    await expect(page.locator('form.h-gform')).toBeVisible();
    await expect(page.locator('form.h-gform [data-gf="title"]')).toBeFocused();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('form.h-gform')).toHaveCount(0);

    await gotoRoute(page, 'plan');
    await page.keyboard.press('Control+k');
    await page.locator('.h-qs-in').fill('New goal');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/goals$/);
    await expect(page.locator('form.h-gform')).toBeVisible();
  });

  // SX5 cut the Curve step: its old link lands on Tell us and no page shows curve sliders.
  test('onboarding has no Priorities step and no curve sliders', async ({ page }) => {
    await forceOnboarding(page);
    await page.goto('/#/onboarding/2');
    await expectH1(page, 'Dump everything in');
    await expect(page.locator('input[data-prio]')).toHaveCount(0);
    await page.unroute('**/api/**');
    await gotoGoals(page);
    await expect(page.locator('input[data-curve]')).toHaveCount(0);
  });

  test('@mobile @ax-ac1 add a goal in Ask saves it with a receipt', async ({ page }) => {
    await gotoRoute(page, 'ask');
    await askOnAsk(page, 'Add a goal: sabbatical fund of $30k, next few years');
    const receipt = page.locator('.h-action-receipt');
    await expect(receipt).toContainText('sabbatical fund of $30k');
    await expect(receipt.getByRole('button', { name: 'Undo' })).toBeVisible();
    await gotoGoals(page);
    await expect(goalCard(page, 'sabbatical fund')).toHaveCount(1);
  });

  test('a rec shows the goal it serves', async ({ page }, info) => {
    const kids = S.goals.find((g) => g.id === 'kids');
    await gotoRoute(page, 'plan');
    const row = page.locator('article.h-row', { has: page.locator('a[data-id="va529"]') });
    await expect(row.locator('.h-serves')).toHaveText(`Serves: ${plain(kids.title)}`);
    await openRecFromPage(page, 'va529');
    await expect(recDialog(page).locator('.h-rec-head .h-serves')).toHaveText(`Serves: ${plain(kids.title)}`);
    await page.screenshot({ path: info.outputPath('rec-serves.png') });
    await recDialog(page).locator('.h-serves a').click();
    await expect(page).toHaveURL(/#\/goals$/);
  });
});
