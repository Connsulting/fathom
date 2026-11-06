// Recommendation action words: Doing it / Done / Later / Not for us on the brief's Needs-you rows and
// in the rec dialog, and what each does to the stored status. Rec ids and windows come from
// demo/scenario.mjs; stored statuses are read back through GET /api/scenario.

import { test, expect, resetDemo, visibleRecs, liveStatus, rec, gotoRoute, openRecFromPage, closeDialogWithX, recDialog } from './helpers.mjs';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

const idsWith = (status) => visibleRecs().filter((r) => liveStatus(r) === status).map((r) => r.id);
const proposedIds = () => idsWith('proposed');
// Recs already in motion in the November demo (they were stored as accepted or doing before the
// vocabulary merged); the one inside its 30 day window is also on the Needs-you list.
const doingIds = () => idsWith('doing');
const briefRow = (page, id) => page.locator('.h-ny-list article.h-ny', { has: page.locator(`a[data-id="${id}"]`) });
const labels = (loc) => loc.locator('button').allTextContents().then((t) => t.map((s) => s.trim()));

async function statusOf(request, id) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  return (await res.json()).recs.find((x) => x.id === id)?.status;
}

test('every Needs-you row on the brief offers Doing it, Done, Later and Not for us', async ({ page }) => {
  const ids = proposedIds();
  expect(ids.length).toBeGreaterThan(0);
  await gotoRoute(page, 'brief');
  for (const id of ids) {
    expect(await labels(briefRow(page, id).locator('.h-acts')), id).toEqual(['Doing it', 'Done', 'Later', 'Not for us']);
  }
  const doingNeeds = doingIds().filter((id) => Number(rec(id).window?.days ?? 9999) <= 30);
  expect(doingNeeds.length).toBeGreaterThan(0);
  for (const id of doingNeeds) expect(await labels(briefRow(page, id).locator('.h-acts')), id).toEqual(['Done', 'Later', 'Not for us']);
  const body = await page.locator('main').innerText();
  for (const old of ['Accept', 'Snooze', 'Dismiss']) expect(body).not.toContain(old);
});

test('Doing it on a brief row stores doing and the row then offers Done, Later and Not for us', async ({ page, request }) => {
  const id = proposedIds()[0];
  await gotoRoute(page, 'brief');
  await briefRow(page, id).locator('[data-act="start"]').click();
  await expect.poll(() => statusOf(request, id)).toBe('doing');
  if (Number(rec(id).window?.days ?? 9999) <= 30) {
    // A rec inside its window stays on the Needs-you list while it is being done.
    expect(await labels(briefRow(page, id).locator('.h-acts'))).toEqual(['Done', 'Later', 'Not for us']);
    await expect(briefRow(page, id).locator('.h-meta')).toContainText('Doing it');
  } else {
    await expect(briefRow(page, id)).toHaveCount(0);
  }
});

test('Done, Later and Not for us on brief rows store done, snoozed and dismissed', async ({ page, request }) => {
  const [a, b] = proposedIds();
  const c = doingIds().find((id) => Number(rec(id).window?.days ?? 9999) <= 30);
  expect(c, 'the demo needs a proposed pair and a doing rec inside its window').toBeTruthy();
  await gotoRoute(page, 'brief');
  await briefRow(page, a).locator('[data-act="complete"]').click();
  await expect.poll(() => statusOf(request, a)).toBe('done');
  await expect(briefRow(page, a)).toHaveCount(0);
  await briefRow(page, b).locator('[data-act="snooze"]').click();
  await expect.poll(() => statusOf(request, b)).toBe('snoozed');
  await expect(briefRow(page, b)).toHaveCount(0);
  await briefRow(page, c).locator('[data-act="dismiss"]').click();
  await expect.poll(() => statusOf(request, c)).toBe('dismissed');
  await expect(briefRow(page, c)).toHaveCount(0);
});

test('the rec dialog reads Doing it, Done, Later and Not for us and the status label follows each action', async ({ page, request }) => {
  const [a, b] = proposedIds();
  const [c, d] = doingIds();
  const buttons = (dlg) => labels(dlg.locator('.h-acts.big'));
  const status = (dlg) => dlg.locator('.h-rec-head .h-st');

  await gotoRoute(page, 'plan');
  await openRecFromPage(page, a);
  let dlg = recDialog(page);
  const open = await buttons(dlg);
  expect(open).toHaveLength(4);
  expect([open[0], open[1], open[3]]).toEqual(['Doing it', 'Done', 'Not for us']);
  expect(open[2]).toMatch(/^Later, until /);
  await dlg.locator('.h-acts.big [data-act="start"]').click();
  await expect(status(dlg)).toHaveText('Doing it');
  expect(await statusOf(request, a)).toBe('doing');
  const doing = await buttons(dlg);
  expect([doing[0], doing[doing.length - 1]]).toEqual(['Done', 'Not for us']);
  expect(doing[1]).toMatch(/^Later, until /);
  await dlg.locator('.h-acts.big [data-act="complete"]').click();
  await expect(status(dlg)).toHaveText('Done');
  expect(await buttons(dlg)).toEqual(['Reopen']);
  await closeDialogWithX(page);

  await openRecFromPage(page, b);
  dlg = recDialog(page);
  await dlg.locator('.h-acts.big [data-act="snooze"]').click();
  await expect(status(dlg)).toHaveText(/^Later, until /);
  expect(await statusOf(request, b)).toBe('snoozed');
  expect(await buttons(dlg)).toEqual(['Wake now']);
  await closeDialogWithX(page);

  await openRecFromPage(page, c);
  dlg = recDialog(page);
  await dlg.locator('.h-acts.big [data-act="dismiss"]').click();
  await expect(status(dlg)).toHaveText('Not for us');
  expect(await statusOf(request, c)).toBe('dismissed');
  expect(await buttons(dlg)).toEqual(['Restore']);
  await closeDialogWithX(page);

  await openRecFromPage(page, d);
  dlg = recDialog(page);
  await dlg.locator('.h-acts.big [data-act="complete"]').click();
  await expect(status(dlg)).toHaveText('Done');
});

test('the keys are Doing it D, Done E, Later L and Not for us Shift+X', async ({ page, request }) => {
  const id = proposedIds()[0];
  await gotoRoute(page, 'brief');
  await openRecFromPage(page, id, '.h-ny-list');
  const dlg = recDialog(page);
  const hints = await dlg.locator('.h-acts.big [data-act]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-act'), e.getAttribute('title')]));
  expect(Object.fromEntries(hints)).toMatchObject({
    start: expect.stringContaining('Doing it (D)'),
    complete: expect.stringContaining('(E)'),
    dismiss: expect.stringContaining('Not for us (Shift+X)'),
  });
  expect(hints.find(([act]) => act === 'snooze')[1]).toContain('(L)');
  await page.keyboard.press('d');
  await expect.poll(() => statusOf(request, id)).toBe('doing');
});

test('recs that were already in motion in the demo read Doing it, never Accepted', async ({ page }) => {
  await gotoRoute(page, 'plan');
  const rows = page.locator('article.h-row.doing');
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(rows.first().locator('.h-st')).toHaveText('Doing it');
  await expect(page.locator('main')).not.toContainText('Accepted');
});
