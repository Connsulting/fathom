// Engine screen: the on/off toggle drives the engine-off strip and Ask answers, and every
// amount on the screen is a figure with provenance (Horizon port item 5).

import { test, expect, S, resetDemo, usd, plain, gotoRoute, expectH1, mainNav, expectPopoverSource, ASK_THREAD_URL, askOnAsk } from './helpers.mjs';

const ENGINE_OFF_NOTICE = 'Engine is off, so answers are paused. Switch it back on to get an answer.';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('turning the engine off pauses answers; turning it on restores them', async ({ page }) => {
  const vis = new Set(S.recs.filter((r) => ((r.statusByDemo && r.statusByDemo.november) || r.status) !== 'hidden').map((r) => r.id));
  const sug = S.ask.suggested;
  const qOff = sug[0];
  const qOn = sug.find((q) => q.id !== qOff.id && (q.refs || []).some((id) => vis.has(id)));
  expect(qOn, 'a second suggested question with a visible ref').toBeTruthy();

  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  await expect(page.locator('.h-engine-off')).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn the engine off', exact: true }).click();
  await expectH1(page, 'Paused');
  await expect(page.locator('.h-engine-off')).toContainText('Engine off. Proactive jobs are paused.');
  await expect(page.locator('.h-engine-off').getByRole('link', { name: 'Engine settings' })).toBeVisible();

  await mainNav(page).getByRole('link', { name: 'Ask', exact: true }).click();
  await expect(page).toHaveURL(/#\/ask$/);
  await expect(page.locator('.h-engine-off')).toBeVisible();
  const id = await askOnAsk(page, plain(qOff.q));
  const answers = page.locator('.h-thread .h-msg.fathom');
  await expect(answers).toHaveCount(1);
  await expect(answers.last()).toContainText(ENGINE_OFF_NOTICE);

  await page.locator('.h-engine-off').getByRole('link', { name: 'Engine settings' }).click();
  await expect(page).toHaveURL(/#\/engine$/);
  await page.getByRole('button', { name: 'Turn the engine on', exact: true }).click();
  await expectH1(page, 'Running');
  await expect(page.locator('.h-engine-off')).toHaveCount(0);

  // The Ask link opens a new conversation; the earlier one continues from its sidebar row.
  await mainNav(page).getByRole('link', { name: 'Ask', exact: true }).click();
  await page.locator(`aside.h-askx-side a.h-askx-row[data-thread="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(answers).toHaveCount(1);
  await askOnAsk(page, plain(qOn.q));
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(answers).toHaveCount(2);
  const last = answers.last();
  await expect(last).not.toContainText(ENGINE_OFF_NOTICE);
  const ref = qOn.refs.find((id) => vis.has(id));
  await expect(last.locator(`.h-refs a[data-go="rec"][data-id="${ref}"]`)).toBeVisible();

  // The state is in the store, not the page.
  await page.reload();
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(page.locator('.h-engine-off')).toHaveCount(0);
  await expect(answers).toHaveCount(2);
});

test('engine amounts are figures; a job cost popover reads Per-run cost estimate', async ({ page }) => {
  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  const sum = page.locator('.h-eng-sum');
  await expect(sum.locator('.fx-fig[data-fig="engine.budget.used"]')).toBeVisible();
  await expect(sum.locator('.fx-fig[data-fig="engine.budget.monthly"]')).toBeVisible();
  await expect(sum.locator('.fx-fig[data-fig="engine.budget.left"]')).toBeVisible();

  const jobs = (S.engine.jobs || []).filter((j) => typeof j.cost === 'number');
  expect(jobs.length).toBeGreaterThan(0);
  for (const j of jobs) {
    const fig = page.locator(`.h-jt .fx-fig[data-fig="engine.job.${j.id}.cost"]`);
    await expect(fig).toBeVisible();
    // figHtml(key, {cents:true}) keeps the Engine screen's cents formatting.
    await expect(fig).toHaveText(usd(j.cost));
  }

  const j = jobs.find((x) => !Number.isInteger(x.cost)) || jobs[0];
  await page.locator(`.h-jt .fx-fig[data-fig="engine.job.${j.id}.cost"]`).click();
  await expectPopoverSource(page, 'Per-run cost estimate');
  // Oracle note 1: the popover shows cents when the value has them.
  await expect(page.locator('.fx-pop .fx-pop-val')).toHaveText(usd(j.cost));
});
