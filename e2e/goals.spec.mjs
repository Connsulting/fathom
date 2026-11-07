// Item 20: goals and the tradeoff curve are owner-editable data. On the demo build, at desktop and
// 390px: add a goal through the inline form (and with N), edit it, archive and restore it, delete
// it; curve sliders persist across a reload; onboarding Priorities save to the same positions; an
// "add a goal" ask shows a save card that adds the goal; a rec shows the goal it serves.

import { test, expect, resetDemo, gotoRoute, expectH1, openRecFromPage, recDialog, askOnAsk, plain, S } from './helpers.mjs';

const TAGS = { tag: ['@mobile'] };

const goalCard = (page, title) => page.locator('article.h-goal', { has: page.locator('.h-goal-h b', { hasText: title }) });

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

  test('add, edit, archive, restore and delete a goal', async ({ page }, info) => {
    await gotoGoals(page);
    await page.getByRole('button', { name: 'Goal', exact: true }).click();
    const form = page.locator('form.h-gform');
    await expect(form).toBeVisible();
    // Title is required.
    await form.getByRole('button', { name: 'Save goal' }).click();
    await expect(form.locator('.h-gerr')).toHaveText('Write the goal in your own words.');

    const title = 'A cabin by the lake <b>{f:portfolio}</b>';
    await form.getByLabel('Your goal, in your own words').fill(title);
    await form.getByLabel(/A short note/).fill('Somewhere quiet.');
    await form.getByRole('button', { name: 'Next few years' }).click();
    await form.getByLabel(/Target amount/).fill('250000');
    await form.getByLabel(/Target date/).fill('2029-06-30');
    await form.getByLabel(/Track with/).selectOption('accounts');
    const firstAcct = form.locator('.h-gacct input[type=checkbox]').first();
    await firstAcct.check();
    const post = saved(page, '/api/goals');
    await form.getByRole('button', { name: 'Save goal' }).click();
    await post;
    await expect(form).toHaveCount(0);

    const card = goalCard(page, 'A cabin by the lake');
    await expect(card).toHaveCount(1);
    // Owner text renders literally: no markup, no token.
    await expect(card.locator('.h-goal-h b')).toHaveText(title);
    await expect(card.locator('.h-goal-h b b, .h-goal-h b .fx-fig')).toHaveCount(0);
    await expect(page.locator('.h-gcol', { hasText: 'Next few years' }).first().locator('article.h-goal', { hasText: 'A cabin by the lake' })).toHaveCount(1);
    await expect(card).toContainText('By Jun 2029');
    // Both a tracked value and a target: a bar, with the target's provenance "you".
    await expect(card.locator('.h-prog svg')).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    const source = page.locator('.fx-pop .fx-pop-row', { hasText: 'Source' }).locator('.fx-pop-v');
    await expect(async () => {
      if (!(await page.locator('.fx-pop').count())) await card.locator('.h-prog .fx-fig').last().click();
      await expect(source).toHaveText('You typed this', { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: info.outputPath('goals-added.png'), fullPage: true });

    // Edit: drop the target, so the card asks for one.
    await card.getByRole('button', { name: 'Edit' }).click();
    await expect(form.getByLabel('Your goal, in your own words')).toHaveValue(title);
    await form.getByLabel(/Target amount/).fill('');
    const put = saved(page, '/api/goals/' + (await card.getAttribute('data-goal-id')));
    await form.getByRole('button', { name: 'Save changes' }).click();
    await put;
    // No supported kind fits this goal, so instead of a suggested number it asks for one.
    await expect(card.locator('.h-sugg.ask')).toContainText('What amount would make this real?');
    await expect(card.locator('.h-prog svg')).toHaveCount(0);

    // Persisted across a reload.
    await page.reload();
    await expect(goalCard(page, 'A cabin by the lake')).toHaveCount(1);

    // Archive moves it under the archived disclosure; restore brings it back.
    await goalCard(page, 'A cabin by the lake').getByRole('button', { name: 'Archive' }).click();
    const arch = page.locator('details.h-garch');
    await expect(arch.locator('summary')).toHaveText('1 archived goal');
    await arch.locator('summary').click();
    await arch.getByRole('button', { name: 'Restore' }).click();
    await expect(page.locator('details.h-garch')).toHaveCount(0);

    // Delete asks first.
    const again = goalCard(page, 'A cabin by the lake');
    await again.getByRole('button', { name: 'Delete' }).click();
    await expect(again).toContainText('Delete for good?');
    await again.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(goalCard(page, 'A cabin by the lake')).toHaveCount(0);
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

  test('curve sliders persist across a reload', async ({ page }) => {
    await gotoGoals(page);
    const slider = page.locator('input[data-curve="ret_life"]');
    await slider.scrollIntoViewIfNeeded();
    const post = saved(page, '/api/curve');
    await slider.fill('82');
    await post;
    await page.reload();
    await expect(page.locator('input[data-curve="ret_life"]')).toHaveValue('82');
  });

  test('onboarding Priorities save the owner positions', async ({ page }) => {
    await forceOnboarding(page);
    await page.goto('/#/onboarding/2');
    await expectH1(page, 'Where on the curve');
    const slider = page.locator('input[data-prio="tax_cash"]');
    const post = saved(page, '/api/curve');
    await slider.fill('15');
    await post;
    await page.unroute('**/api/**');
    await page.reload();
    await gotoGoals(page);
    await expect(page.locator('input[data-curve="tax_cash"]')).toHaveValue('15');
  });

  test('"add a goal" in Ask shows a save card that adds the goal', async ({ page }, info) => {
    await gotoRoute(page, 'ask');
    await askOnAsk(page, 'Add a goal: sabbatical fund of $30k, next few years');
    const card = page.locator('.h-goal-proposal');
    await expect(card).toContainText('sabbatical fund of $30k, next few years');
    await expect(card).toContainText('Next few years');
    await page.screenshot({ path: info.outputPath('ask-goal-card.png'), fullPage: true });
    const post = saved(page, '/api/goals');
    await card.getByRole('button', { name: 'Save' }).click();
    await post;
    await expect(card.locator('.h-proposal-done')).toHaveText('Saved');
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
