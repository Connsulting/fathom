// Decide is dynamic (plan, Decide paragraph): decisions take their status and line from the
// server, a linked rec finishing decides its decision, and war-game figures carry provenance.

import { test, expect, S, resetDemo, plain, gotoRoute, expectH1, recDialog, openRecFromPage, closeDialogWithX, expectPopoverSource, mainNav } from './helpers.mjs';

const WARGAME_SOURCE = 'War-game model, from your plan';

const decision = (id) => {
  const d = S.decisions.find((x) => x.id === id);
  if (!d) throw new Error(`no decision ${id} in demo/scenario.mjs`);
  return d;
};
const deferralDecision = () => S.decisions.find((d) => d.wargame === 'deferral' && d.recId);

function decRow(page, status, d) {
  return page.locator(`article.h-dec.${status}`, { hasText: plain(d.title) });
}

async function openDecided(page) {
  const det = page.locator('details.h-details[data-det="decided"]');
  await expect(det).toHaveCount(1);
  if ((await det.getAttribute('open')) == null) await det.locator('summary').click();
  await expect(det).toHaveAttribute('open', '');
}

// Decide (#/wargame) is the What-if view under the Ask tab.
async function gotoDecide(page) {
  await gotoRoute(page, 'home');
  await mainNav(page).getByRole('link', { name: 'Ask', exact: true }).click();
  await expect(page).toHaveURL(/#\/ask$/);
  await page.getByRole('navigation', { name: 'Ask views' }).getByRole('link', { name: 'What-if', exact: true }).click();
  await expect(page).toHaveURL(/#\/wargame$/);
  await expectH1(page, 'What is open, and what is coming');
}

async function actOnRec(page, recId, action) {
  await gotoRoute(page, 'plan');
  await openRecFromPage(page, recId);
  const dlg = recDialog(page);
  await dlg.locator(`.h-acts.big [data-act="${action}"]`).click();
  const label = { complete: 'Done', reopen: 'New', dismiss: 'Not for us' }[action];
  await expect(dlg.locator('.h-rec-head .h-st')).toHaveText(label);
  await closeDialogWithX(page);
}

async function expectDeferralDecided(page, line) {
  const d = deferralDecision();
  await gotoDecide(page);
  await expect(decRow(page, 'open', d)).toHaveCount(0);
  await openDecided(page);
  const row = decRow(page, 'decided', d);
  await expect(row).toBeVisible();
  await expect(row).toContainText(line);

  await gotoRoute(page, `wargame/${d.wargame}`);
  const lead = page.locator('.h-decided');
  await expect(lead).toBeVisible();
  await expect(lead.locator('.h-kicker')).toHaveText('Decided');
  await expect(lead.locator('p')).toHaveText(line);
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('November Decide: the 2026 salary decision is decided, the deferral is open, 2027 salary is coming up', async ({ page }) => {
  await gotoDecide(page);
  await expect(decRow(page, 'open', deferralDecision())).toBeVisible();
  await expect(decRow(page, 'upcoming', decision('salary27'))).toBeVisible();
  await expect(decRow(page, 'open', decision('salary27'))).toHaveCount(0);
  await openDecided(page);
  await expect(decRow(page, 'decided', decision('salary26'))).toBeVisible();
});

test('completing the deferral rec decides it: Marked done on your plan.', async ({ page }) => {
  await actOnRec(page, deferralDecision().recId, 'complete');
  await expectDeferralDecided(page, 'Marked done on your plan.');
});

test('reopening and dismissing the deferral rec: Set aside on your plan.', async ({ page }) => {
  const recId = deferralDecision().recId;
  await actOnRec(page, recId, 'complete');
  await actOnRec(page, recId, 'reopen');
  await gotoDecide(page);
  await expect(decRow(page, 'open', deferralDecision())).toBeVisible();
  await actOnRec(page, recId, 'dismiss');
  await expectDeferralDecided(page, 'Set aside on your plan.');
});

test('deferral war game: the selected option stats are figures and December cash cites the war-game model', async ({ page }) => {
  await gotoRoute(page, 'wargame/deferral');
  await expectH1(page, plain(S.wargame.deferral.title));
  const selected = page.locator('.h-seg [role="radio"][aria-checked="true"]');
  await expect(selected).toHaveCount(1);
  const opt = S.wargame.deferral.options[Number(await selected.getAttribute('data-i'))];
  const stats = page.locator('.h-def-stats');
  for (const field of ['tax2026', 'tax2027', 'net', 'decCash']) {
    await expect(stats.locator(`.fx-fig[data-fig="wg.deferral.${opt.id}.${field}"]`)).toBeVisible();
  }
  const cash = stats.locator(':scope > div', { hasText: 'December business cash' }).locator('.fx-fig');
  await expect(cash).toHaveAttribute('data-fig', `wg.deferral.${opt.id}.decCash`);
  await cash.click();
  await expectPopoverSource(page, WARGAME_SOURCE);
});

test('salary war game: the selected point note figures cite the war-game model', async ({ page }) => {
  await gotoRoute(page, 'wargame/salary');
  await expectH1(page, plain(S.wargame.salary.title));
  const on = page.locator('g.h-sc-pt.on');
  await expect(on).toHaveCount(1);
  const pt = S.wargame.salary.points[Number(await on.getAttribute('data-i'))];
  const figs = page.locator('.h-wg-note .h-kvs .fx-fig');
  await expect(figs).toHaveCount(2);
  await expect(figs.nth(0)).toHaveAttribute('data-fig', `wg.salary.${pt.id}.x`);
  await expect(figs.nth(1)).toHaveAttribute('data-fig', `wg.salary.${pt.id}.y`);
  await figs.nth(0).click();
  await expectPopoverSource(page, WARGAME_SOURCE);
  await figs.nth(1).click();
  await expectPopoverSource(page, WARGAME_SOURCE);
});
