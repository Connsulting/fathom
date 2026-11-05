// November demo: completing every needs-you item through the UI flips the brief to the clear
// verdict, and the result persists through the API across a reload.

import { test, expect, resetDemo, needsYouIds, rec, attentionHeadline, clearHeadline, gotoRoute, openRecFromPage, closeDialogWithX, recDialog } from './helpers.mjs';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('the November brief starts at attention with every needs-you item listed', async ({ page }) => {
  await gotoRoute(page, 'brief');
  await expect(page.locator('h1.h-verdict')).toHaveText(attentionHeadline());
  await expect(page.locator('.h-hero')).not.toHaveClass(/\bclear\b/);
  const ids = await page.locator('.h-ny a.h-ny-t').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  expect(ids).toEqual(needsYouIds());
});

test('completing every needs-you item, steps included, turns the brief clear and it survives a reload', async ({ page }) => {
  const expected = needsYouIds();
  expect(expected.length).toBeGreaterThan(0);
  await gotoRoute(page, 'brief');
  await expect(page.locator('h1.h-verdict')).toHaveText(attentionHeadline());

  const completed = [];
  for (let guard = 0; guard <= expected.length; guard++) {
    const links = page.locator('.h-ny a.h-ny-t');
    if ((await links.count()) === 0) break;
    const id = await links.first().getAttribute('data-id');
    await openRecFromPage(page, id, '.h-ny-list');
    const dlg = recDialog(page);

    const tasks = rec(id).tasks || [];
    for (let i = 0; i < tasks.length; i++) {
      const task = dlg.locator(`button.h-task[data-arg="${i}"]`);
      if ((await task.getAttribute('aria-pressed')) !== 'true') {
        await task.click();
        await expect(dlg.locator(`button.h-task[data-arg="${i}"]`)).toHaveAttribute('aria-pressed', 'true');
      }
    }
    if (tasks.length) await expect(dlg.locator('.h-prog span')).toHaveText(`${tasks.length} of ${tasks.length}`);

    await dlg.locator('.h-acts.big [data-act="complete"]').click();
    await expect(dlg.locator('.h-rec-head .h-st')).toHaveText('Done');
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/brief$/);
    await expect(page.locator(`.h-ny a.h-ny-t[data-id="${id}"]`)).toHaveCount(0);
    completed.push(id);
  }
  expect([...completed].sort()).toEqual([...expected].sort());

  const assertClear = async () => {
    await expect(page.locator('h1.h-verdict')).toHaveText(clearHeadline());
    await expect(page.locator('.h-hero')).toHaveClass(/\bclear\b/);
    await expect(page.locator('.h-ny')).toHaveCount(0);
    await expect(page.locator('.h-empty')).toContainText('Nothing needs you right now.');
  };
  await assertClear();
  await page.reload();
  await assertClear();
});
