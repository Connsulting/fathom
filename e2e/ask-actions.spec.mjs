import { test, expect } from '@playwright/test';

test('@mobile @ax-ac6 Ask from a recommendation records the expected date and Undo restores the window', async ({ page, request }, info) => {
  const reset = await request.post('/api/demo/reset', { data: {} });
  expect(reset.ok()).toBeTruthy();
  await page.goto('/#/rec/babyprep');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const before = await (await request.get('/api/scenario')).json();
  const recBefore = before.recs.find(r => r.id === 'babyprep');
  const input = dialog.locator('form.h-compose input[name="q"]');
  await input.fill('Set the expected date to 2027-03-19');
  await input.press('Enter');
  const receipt = dialog.locator('.h-action-receipt');
  await expect(receipt).toContainText('2027-03-19');
  await expect(receipt).toContainText('Not set');
  const after = await (await request.get('/api/scenario')).json();
  const recAfter = after.recs.find(r => r.id === 'babyprep');
  expect(recAfter.window.close).toBe('2027-03-19');
  expect(recAfter.window.days).not.toBe(recBefore.window.days);
  await expect(dialog).toContainText(recAfter.window.label);
  await page.reload();
  await expect(page.getByRole('dialog').locator('.h-action-receipt')).toContainText('2027-03-19');
  await page.screenshot({ path: info.outputPath('ask-actions.png'), fullPage: false, animations: 'disabled', timeout: 15000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.h-action-receipt')).toContainText('Undone');
  const undone = await (await request.get('/api/scenario')).json();
  expect(undone.recs.find(r => r.id === 'babyprep').window).toEqual(recBefore.window);
  await page.getByRole('dialog').getByRole('link', { name: 'Open in Ask' }).click();
  await expect(page.locator('section.h-askx-main .h-action-receipt')).toContainText('Undone');
});

test('@mobile @ax-ac8 Ask remembers a preference and Settings edits and deletes it', async ({ page, request }) => {
  expect((await request.post('/api/demo/reset', { data: {} })).ok()).toBeTruthy();
  await page.goto('/#/ask');
  const input = page.locator('form.h-askx-compose textarea[name="q"]').first();
  await input.fill('Remember: keep answers short');
  await input.press('Enter');
  await expect(page.locator('.h-action-receipt')).toContainText('keep answers short');
  await page.goto('/#/settings');
  const preference = page.getByRole('textbox', { name: 'Household preference', exact: true });
  await expect(preference).toHaveValue('keep answers short');
  await preference.fill('Elective spending excludes mortgage, income tax and transfers');
  await preference.locator('xpath=ancestor::form').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(preference).toHaveValue('Elective spending excludes mortgage, income tax and transfers');
  await page.reload();
  await expect(preference).toHaveValue('Elective spending excludes mortgage, income tax and transfers');
  await preference.locator('xpath=ancestor::form').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(preference).toHaveCount(0);
});

test('@mobile @ax-ac5 key creation offers separate action permissions', async ({ page, request }) => {
  expect((await request.post('/api/demo/reset', { data: {} })).ok()).toBeTruthy();
  await page.goto('/#/connect');
  await expect(page.getByRole('switch', { name: 'Record household facts' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Check recommendation steps' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Create and edit goals' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Remember preferences' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Key name' }).fill('Synthetic goal agent');
  await page.getByRole('switch', { name: 'Create and edit goals' }).click();
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New key for Synthetic goal agent' })).toBeVisible();
  const keys = await (await request.get('/api/keys')).json();
  expect(keys.keys.find(k => k.name === 'Synthetic goal agent').scopes).toEqual(['read', 'write:goals']);
});
