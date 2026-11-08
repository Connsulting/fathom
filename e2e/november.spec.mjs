// November demo: completing every needs-you item through the UI empties Plan's needs-you rows and
// flips the brief verdict (now carried by the monthly email preview, since Home leads with goals)
// to clear, and the result persists through the API across a reload.

import { test, expect, resetDemo, needsYouIds, rec, attentionHeadline, clearHeadline, gotoRoute, openRecFromPage, closeDialogWithX, recDialog, fetchScenario } from './helpers.mjs';
import { planOrder } from '../web/horizon/screens/home-model.js';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

// Plan's needs-you rows, as rec ids in page order.
const needsLinks = (page) => page.locator('.h-rows article.h-row.needs .h-row-top a[data-go="rec"]');
const needsCount = (page) => page.locator('.h-stats > div', { hasText: 'need you' }).locator('b');

async function emailVerdict(page) {
  await gotoRoute(page, 'email');
  return page.frameLocator('iframe[title="Brief preview"]').locator('body');
}

test('the November plan starts at attention with every needs-you item listed', async ({ page, request }) => {
  // Plan breaks deadline ties by the priority of the goals a rec serves (links resolve at read time).
  const live = await fetchScenario(request);
  const byId = new Map(live.recs.map((r) => [r.id, r]));
  const expected = planOrder(needsYouIds().map((id) => byId.get(id)), live.goals).map((r) => r.id);
  await gotoRoute(page, 'plan');
  await expect(needsCount(page)).toHaveText(String(expected.length));
  const ids = await needsLinks(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  expect(ids).toEqual(expected);
  await expect(await emailVerdict(page)).toContainText(attentionHeadline());
});

test('completing every needs-you item, steps included, turns the verdict clear and it survives a reload', async ({ page }) => {
  const expected = needsYouIds();
  expect(expected.length).toBeGreaterThan(0);
  await gotoRoute(page, 'plan');
  await expect(needsLinks(page)).toHaveCount(expected.length);

  const completed = [];
  for (let guard = 0; guard <= expected.length; guard++) {
    const links = needsLinks(page);
    if ((await links.count()) === 0) break;
    const id = await links.first().getAttribute('data-id');
    await openRecFromPage(page, id);
    const dlg = recDialog(page);

    const tasks = rec(id).tasks || [];
    // Demo steps are all unobservable, so each is one "I did this" that turns into Undo.
    for (let i = 0; i < tasks.length; i++) {
      const step = dlg.locator(`.h-steps li.h-step[data-step="${i}"]`);
      if (!/\bdone\b/.test((await step.getAttribute('class')) || '')) {
        await step.getByRole('button', { name: 'I did this', exact: true }).click();
        await expect(dlg.locator(`.h-steps li.h-step[data-step="${i}"]`)).toHaveClass(/\bdone\b/);
      }
      await expect(dlg.locator(`.h-steps li.h-step[data-step="${i}"]`).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    }
    if (tasks.length) await expect(dlg.locator('.h-prog span')).toHaveText(`${tasks.length} of ${tasks.length}`);

    await dlg.locator('.h-acts.big [data-act="complete"]').click();
    await expect(dlg.locator('.h-rec-head .h-st')).toHaveText('Done');
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(page.locator(`.h-rows article.h-row.needs a[data-go="rec"][data-id="${id}"]`)).toHaveCount(0);
    completed.push(id);
  }
  expect([...completed].sort()).toEqual([...expected].sort());

  const assertClear = async () => {
    await gotoRoute(page, 'plan');
    await expect(needsCount(page)).toHaveText('0');
    await expect(needsLinks(page)).toHaveCount(0);
    await expect(await emailVerdict(page)).toContainText(clearHeadline());
  };
  await assertClear();
  await page.reload();
  await assertClear();
});
