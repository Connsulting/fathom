// Year end (item 25): the expected documents checklist built from stored facts, accounts and
// documents, marking an item not needed with a reason, and downloading the accountant packet zip.
// Titles carry @mobile so each test also runs at 390px.

import { readFile } from 'node:fs/promises';
import { test, expect, resetDemo, gotoRoute, expectH1, SMOKE_REAL } from './helpers.mjs';
import { readZip } from '../src/yearend/zip.mjs';

test.skip(SMOKE_REAL, 'writes to the store');

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

const item = (page, key) => page.locator(`[data-ye-item="${key}"]`);
const group = (page, s) => page.locator(`[data-ye-group="${s}"]`);

test('the checklist lists expected, received and unmatched documents with sources @mobile', async ({ page }, info) => {
  await gotoRoute(page, 'yearend');
  await expectH1(page, 'The packet for your accountant');
  await expect(page.getByText('Tax year 2026.', { exact: false })).toBeVisible();
  const w2 = group(page, 'expected').locator('[data-ye-item="w2:brightline"]');
  await expect(w2).toContainText('W-2 from Brightline');
  await expect(w2).toContainText('Brightline payroll. By January 31');
  const got = group(page, 'have').locator('[data-ye-item="1098:mortgage"]');
  await expect(got).toContainText('1098 mortgage interest');
  await expect(got).toContainText('1098-2026-mortgage-payoff.pdf');
  await expect(got).toContainText('stored Oct 14, 2026');
  const other = page.locator('section', { hasText: 'Received, not on the list' });
  await expect(other).toContainText('property-tax-receipt-2026.pdf');
  await expect(page.locator('.h-col-side').getByRole('link', { name: 'Invoice now or in January?' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width, 'no horizontal page scroll').toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath('yearend.png'), fullPage: true });
});

test('marking a document not needed keeps the reason across reload and can be undone @mobile', async ({ page }) => {
  await gotoRoute(page, 'yearend');
  await item(page, '1099-nec').getByRole('button', { name: 'Not needed', exact: true }).click();
  const form = page.locator('form[data-ye-form="1099-nec"]');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form, 'an empty reason is not saved').toBeVisible();
  await form.locator('input[name="reason"]').fill('No reportable client payments this year');
  await form.getByRole('button', { name: 'Save' }).click();
  const skipped = group(page, 'skipped').locator('[data-ye-item="1099-nec"]');
  await expect(skipped).toContainText('Not needed: No reportable client payments this year');
  await page.reload();
  await expect(group(page, 'skipped').locator('[data-ye-item="1099-nec"]')).toContainText('No reportable client payments this year');
  await group(page, 'skipped').locator('[data-ye-item="1099-nec"]').getByRole('button', { name: 'Needed after all' }).click();
  await expect(group(page, 'expected').locator('[data-ye-item="1099-nec"]')).toBeVisible();
});

test('inferred documents show the reason and evidence, and Undo survives reload @mobile', async ({ page }) => {
  await gotoRoute(page, 'yearend');
  const inferred = item(page, '1099-k');
  await expect(inferred).toContainText('Inferred not needed: No payment-processor deposits in stored 2026 history.');
  await inferred.locator('[data-ye-evidence] summary').click();
  await expect(inferred.locator('[data-ye-evidence]')).toContainText('transactions row');
  await expect(inferred.locator('[data-ye-evidence]')).toContainText('ledger:row');
  await inferred.getByRole('button', { name: 'Needed after all' }).click();
  await expect(group(page, 'expected').locator('[data-ye-item="1099-k"]')).toBeVisible();
  await page.reload();
  await expect(group(page, 'expected').locator('[data-ye-item="1099-k"]')).toBeVisible();
  await expect(item(page, '1099-k').locator('[data-ye-evidence]')).toHaveCount(0);
});

test('assembling the packet downloads a zip of the index and every received document @mobile', async ({ page }, info) => {
  await gotoRoute(page, 'yearend');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Assemble packet' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('tax-packet-2026.zip');
  const path = info.outputPath('packet.zip');
  await download.saveAs(path);
  const entries = readZip(await readFile(path));
  expect(entries.map((e) => e.name)).toEqual(['index.html', 'documents/01-1098-Harbor-Bank-2026.txt', 'documents/02-Document-County-treasurer-2026.txt']);
  const html = entries[0].data.toString('utf8');
  expect(html).toContain('Tax packet for 2026');
  expect(html).toContain('Tax payments for 2026');
  await expect(page.locator('.h-packet')).toContainText('Last assembled', { timeout: 10_000 });
  await expect(page.getByRole('link', { name: 'Assemble again' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('yearend-after.png'), fullPage: true });
});
