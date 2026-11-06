// Advisor workflow (item 24), desktop and 390px: send a rec to the advisor from the Plan, record a
// veto from the rec page (the rec is dismissed, the note shows as literal text), record a
// confirmation from the Advisor screen, change the check-in (persists across reload), and prepare
// a review packet that downloads and is listed for re-download.

import { test, expect, S, resetDemo, plain, gotoRoute, expectH1, recDialog, openRecFromPage, bareDollarNodes } from './helpers.mjs';

const SENT = 'hsa'; // in motion, never sent to the advisor in the demo
const WAITING = ['deferral', 'dcfsa', 'backdoor', 'spouseentity', 'filingplan'];
const NOTE = '<b>Not now</b> & {f:hsa_room} later';

const title = (id) => plain(S.recs.find((r) => r.id === id).title);
const advisorName = () => plain(S.names.advisor);
const waitingList = (page) => page.locator('ul.h-advws > li');

async function noSideScroll(page, where) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(w.doc, `horizontal scroll on ${where}`).toBeLessThanOrEqual(w.inner);
}

test.describe('advisor workflow', { tag: '@mobile' }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('send, veto, confirm, check-in and packet', async ({ page }) => {
    test.setTimeout(120_000); // one long flow: five writes, a reload and two downloads
    // The Advisor screen reads the seeded tables.
    await gotoRoute(page, 'advisor');
    await expectH1(page, advisorName());
    await expect(page.locator('.h-next')).toContainText('Thu, Dec 10, 2026, 2:00 PM');
    await expect(page.locator('.h-next')).toContainText('30 min');
    await expect(waitingList(page)).toHaveCount(WAITING.length);
    await noSideScroll(page, '#/advisor');

    // Send from the Plan row.
    await gotoRoute(page, 'plan');
    const row = page.locator('article.h-row', { has: page.locator(`a[data-id="${SENT}"]`) });
    await row.locator(`button[data-adv-send="${SENT}"]`).click();
    await expect(row.locator('.h-adv')).toHaveText('Waiting on advisor');
    await expect(row.locator(`button[data-adv-send="${SENT}"]`)).toHaveCount(0);

    // Record a veto on the rec page.
    await openRecFromPage(page, SENT);
    const dlg = recDialog(page);
    await expect(dlg.locator('.h-advbox')).toContainText('Waiting on advisor review');
    await dlg.getByRole('button', { name: 'Record verdict' }).click();
    const form = dlg.locator('form.h-advf');
    await form.getByLabel('Vetoed').check();
    await form.getByLabel("The advisor's note").fill(NOTE);
    await form.getByLabel('Date of the review').fill('2026-11-04');
    await noSideScroll(page, 'the verdict form');
    await form.getByRole('button', { name: 'Save verdict' }).click();
    await expect(dlg.locator('.h-advbox')).toContainText('Advisor vetoed');
    await expect(dlg.locator('.h-advbox p').first()).toHaveText(NOTE);
    await expect(dlg.locator('.h-advbox b')).toHaveCount(0);
    await expect(dlg.locator('.h-rec-head .h-st')).toHaveText('Not for us');
    await dlg.getByRole('button', { name: 'Close', exact: true }).click();

    // The Advisor screen lists it as reviewed; confirm one waiting rec from there.
    await gotoRoute(page, 'advisor');
    const vetoed = page.locator('ul.h-rvs > li', { hasText: title(SENT) });
    await expect(vetoed).toContainText('Vetoed');
    await expect(vetoed).toContainText(NOTE);
    await expect(vetoed).toContainText('Nov 4, 2026');
    const first = waitingList(page).filter({ hasText: title(WAITING[0]) });
    await first.getByRole('button', { name: 'Record verdict' }).click();
    const f2 = first.locator('form.h-advf');
    await f2.getByLabel('Confirmed').check();
    await f2.getByLabel("The advisor's note").fill('Invoice half in December.');
    await f2.getByRole('button', { name: 'Save verdict' }).click();
    await expect(waitingList(page)).toHaveCount(WAITING.length - 1);
    await expect(page.locator('ul.h-rvs > li', { hasText: title(WAITING[0]) })).toContainText('Confirmed');

    // Check-in: change and persist.
    await page.getByRole('button', { name: 'Change check-in' }).click();
    const ci = page.locator('form.h-advci');
    await ci.getByLabel('Date').fill('2026-12-17');
    await ci.getByLabel('Time').fill('10:30');
    await ci.getByLabel('Length, minutes').fill('45');
    await noSideScroll(page, 'the check-in form');
    await ci.getByRole('button', { name: 'Save check-in' }).click();
    await expect(page.locator('.h-next')).toContainText('Thu, Dec 17, 2026, 10:30 AM');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.h-next')).toContainText('Thu, Dec 17, 2026, 10:30 AM');
    await expect(page.locator('.h-next')).toContainText('45 min');

    // Packet: prepare, download, re-download from the list.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Prepare packet' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^advisor-packet-\d{4}-\d{2}-\d{2}\.html$/);
    const html = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
    expect(html).toContain('Advisor review packet');
    for (const id of WAITING.slice(1)) expect(html).toContain(`id="rec-${id}"`);
    expect(html).not.toContain(`id="rec-${WAITING[0]}"`);
    expect(html).not.toMatch(/<script/i);
    const listed = page.locator('ul.h-advpk > li');
    await expect(listed).toHaveCount(1);
    const [again] = await Promise.all([page.waitForEvent('download'), listed.locator('a').click()]);
    expect(again.suggestedFilename()).toBe(dl.suggestedFilename());
    expect(await bareDollarNodes(page)).toEqual([]);
    await noSideScroll(page, '#/advisor after the flow');
  });
});
