import { test, expect } from '@playwright/test';

// The Memories page (#/memories): what Fathom remembers, as rows with Add, Edit in place, Delete
// with Undo and a filter once the list is long. Every memory here is synthetic.

const reset = async (request) => expect((await request.post('/api/demo/reset', { data: {} })).ok()).toBeTruthy();
const remember = async (request, text) => expect((await request.post('/api/preferences', { data: { text } })).ok()).toBeTruthy();
const list = (page) => page.getByRole('list', { name: 'Memories' });
const row = (page, text) => list(page).locator('li.h-mem-r').filter({ hasText: text });

test('@mobile Settings summarizes memories and links the Memories page', async ({ page, request }) => {
  await reset(request);
  await page.goto('/#/settings');
  await expect(page.locator('.h-set')).toContainText('Fathom does not remember anything yet');
  await remember(request, 'Keep answers short');
  await page.reload();
  await expect(page.locator('.h-set')).toContainText('Fathom remembers 1 thing');
  await expect(page.getByText('Remembered preferences')).toHaveCount(0);
  await page.locator('.h-set').getByRole('link', { name: 'Memories', exact: true }).click();
  await expect(page).toHaveURL(/#\/memories$/);
  await expect(page.locator('h1')).toHaveText('Memories');
  await expect(row(page, 'Keep answers short')).toContainText('Added by you');
  await expect(row(page, 'Keep answers short')).toContainText('Remembered');
});

test('@mobile the Memories page adds, edits in place and cancels an edit', async ({ page, request }) => {
  await reset(request);
  await page.goto('/#/memories');
  await expect(page.getByText('Nothing yet. When you tell Ask to remember something, or add it above, it shows up here.')).toBeVisible();
  const add = page.getByRole('textbox', { name: 'Add a memory', exact: true });
  await add.fill('The budget means the monthly plan');
  await page.locator('form.h-mem-add').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row(page, 'The budget means the monthly plan')).toBeVisible();
  await expect(add).toHaveValue('');

  await row(page, 'The budget means the monthly plan').getByRole('button', { name: 'Edit', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Edit memory', exact: true });
  await expect(field).toBeFocused();
  await field.fill('The budget means the yearly plan');
  await list(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(field).toHaveCount(0);
  await expect(row(page, 'The budget means the yearly plan').getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.reload();
  await expect(row(page, 'The budget means the yearly plan')).toBeVisible();

  await row(page, 'The budget means the yearly plan').getByRole('button', { name: 'Edit', exact: true }).click();
  await field.fill('Something else entirely');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(row(page, 'The budget means the yearly plan')).toBeVisible();
  const scenario = await (await request.get('/api/scenario')).json();
  expect(scenario.preferences.map(p => p.text)).toEqual(['The budget means the yearly plan']);
});

test('@mobile deleting a memory offers Undo, which brings it back', async ({ page, request }) => {
  await reset(request);
  await remember(request, 'Treat the cabin as a second home');
  await page.goto('/#/memories');
  await row(page, 'Treat the cabin as a second home').getByRole('button', { name: 'Delete', exact: true }).click();
  const status = page.getByRole('status').filter({ hasText: 'Memory deleted.' });
  await expect(status).toBeVisible();
  await expect(row(page, 'Treat the cabin as a second home')).toHaveCount(0);
  await status.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page, 'Treat the cabin as a second home')).toBeVisible();
  await expect(status).toHaveCount(0);
  const scenario = await (await request.get('/api/scenario')).json();
  expect(scenario.preferences.map(p => p.text)).toEqual(['Treat the cabin as a second home']);
});

test('@mobile the filter box appears past five memories and filters the list', async ({ page, request }) => {
  await reset(request);
  for (const text of ['Keep answers short', 'Use plain words', 'Round to the nearest hundred', 'Short trips count as travel', 'The budget means the plan'])
    await remember(request, text);
  await page.goto('/#/memories');
  await expect(list(page).locator('li.h-mem-r')).toHaveCount(5);
  await expect(page.getByRole('searchbox', { name: 'Search memories' })).toHaveCount(0);
  await remember(request, 'Gifts come from the fun budget');
  await page.reload();
  const search = page.getByRole('searchbox', { name: 'Search memories' });
  await search.fill('SHORT');
  await expect(search).toBeFocused();
  await expect(list(page).locator('li.h-mem-r:visible')).toHaveCount(2);
  await expect(row(page, 'Keep answers short')).toBeVisible();
  await expect(row(page, 'Short trips count as travel')).toBeVisible();
  await search.fill('no memory says this');
  await expect(list(page).locator('li.h-mem-r:visible')).toHaveCount(0);
  await expect(page.getByText('No memories match that search.')).toBeVisible();
  await search.fill('');
  await expect(list(page).locator('li.h-mem-r:visible')).toHaveCount(6);
});

test('@mobile the search box stays while a query is active after a delete shortens the list', async ({ page, request }) => {
  await reset(request);
  for (const text of ['Keep answers short', 'Use plain words', 'Round to the nearest hundred', 'Short trips count as travel', 'The budget means the plan', 'Gifts come from the fun budget'])
    await remember(request, text);
  await page.goto('/#/memories');
  const search = page.getByRole('searchbox', { name: 'Search memories' });
  await search.fill('gifts');
  await row(page, 'Gifts come from the fun budget').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Memory deleted.')).toBeVisible();
  await expect(search).toBeVisible();
  await search.fill('');
  await expect(list(page).locator('li.h-mem-r:visible')).toHaveCount(5);
});
