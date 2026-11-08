// UI3 AC2: an Ask transaction figure is labeled with the readable name, and its provenance popover
// keeps the bank's raw text. Registered through the real page kit (window.Fathom.api.registerFigures)
// and opened through api.figPopover, the popover a figure click opens. Synthetic text only.

import { test, expect, resetDemo, gotoRoute } from './helpers.mjs';

const RAW = 'ORIG CO NAME:EXAMPLE PAYROLL ORIG ID:9000000001 CO ENTRY DESCR:NET SEC:CCD';
const NAME = 'Example Payroll payroll (net)';

test('an Ask transaction popover shows the readable name and the raw bank text', { tag: '@ui3-ac2' }, async ({ request, page }) => {
  await resetDemo(request);
  await gotoRoute(page, 'home');
  await page.evaluate(([raw, name]) => {
    window.Fathom.api.registerFigures({ 'blk:ui3:b1:0': { value: -1250, unit: 'usd', label: name, kind: 'a', asOf: '2032-03-01',
      source: 'Checking', gaps: [], provenance: { row: { account: 'Checking', date: '2032-03-01', description: raw, name } },
      detail: [{ k: 'Bank text', v: raw }] } });
    const el = document.createElement('span');
    el.className = 'fx-fig';
    el.setAttribute('data-fig', 'blk:ui3:b1:0');
    el.setAttribute('data-testid', 'ui3-fig');
    el.textContent = '-$1,250';
    document.body.appendChild(el);
    // The same popover a click on a figure inside the page opens.
    window.Fathom.api.figPopover(el);
  }, [RAW, NAME]);
  const pop = page.locator('.fx-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.fx-pop-label')).toHaveText(NAME);
  await expect(pop.locator('.fx-pop-row').filter({ hasText: 'Bank text' }).locator('.fx-pop-v')).toHaveText(RAW);
});
