import { test, expect, resetDemo, gotoRoute, deckTo, REMOTE } from './helpers.mjs';
import { openDb, setSetting } from '../src/store/db.mjs';
import { householdStoreFile, localDataDir, withLocalHousehold } from './local-store.mjs';
import { seedDuplicate } from '../test/helpers/account-merge.mjs';
import { refreshMergedAccounts } from '../src/ingest/account-merge.mjs';

test.skip(REMOTE, 'requires a local synthetic store');

async function seed(request) {
  await resetDemo(request);
  return withLocalHousehold('2032-03-10T12:00:00.000Z', async s => {
    await setSetting(s.db,'clock','2032-03-10');
    const pair=await seedDuplicate(s,{sure:true});
    await refreshMergedAccounts(s.db,{now:'2032-03-10T12:00:00.000Z'});
    return pair;
  });
}
// The household total now, read from the scenario: merged duplicates count once.
const total = async request => (await (await request.get('/api/scenario')).json()).trend.points.at(-1).total;

test('Money offers Merge and Undo restores the duplicate and totals @sm-ac5 @mobile', async ({page,request}) => {
  const pair=await seed(request);
  await gotoRoute(page,'money');
  await expect(page.locator('[data-account-duplicates]')).toContainText('Some accounts may be counted twice');
  await expect(page.getByRole('link',{name:'Review accounts'})).toHaveAttribute('href','#/confirm');
  const q=(await (await request.get('/api/scenario')).json()).live.ingest.items.filter(i=>i.context.repair);
  expect(q).toHaveLength(1);
  const card=page.locator(`[data-item="${q[0].id}"]`);
  await expect(card).toContainText('Same account?');
  const before = await total(request);
  await expect(page.locator('[data-trend-total]')).toBeVisible();
  const answer = page.waitForResponse(r => r.url().endsWith(`/api/confirm/${q[0].id}/answer`));
  await card.getByRole('button',{name:/Merge/}).click();
  expect((await answer).status()).toBe(200);
  await expect(page.locator('[data-account-duplicates]')).toHaveCount(0);
  await expect.poll(() => total(request)).toBe(Math.round((before - 1200) * 100) / 100);
  let sc=await (await request.get('/api/scenario')).json();
  expect(sc.accounts.filter(a=>[pair.keep,pair.own].includes(a.id))).toHaveLength(1);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator('[data-account-duplicates]')).toBeVisible();
  await expect.poll(() => total(request)).toBe(before);
  sc=await (await request.get('/api/scenario')).json();
  expect(sc.accounts.filter(a=>[pair.keep,pair.own].includes(a.id))).toHaveLength(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({path:test.info().outputPath('account-merge-undo.png'),fullPage:true});
});

test('Confirm shares the repair question and Keep both clears the Money warning @sm-ac2 @sm-ac4 @mobile', async ({page,request}) => {
  await seed(request);
  const before = await total(request);
  const sc=await (await request.get('/api/scenario')).json();
  const q=sc.live.ingest.items.find(i=>i.context.repair);
  await gotoRoute(page,'confirm');
  await deckTo(page,sc.live.ingest.items.map(i=>i.id),q.id);
  const card=page.locator(`[data-item="${q.id}"]`);
  await expect(card).toContainText('Same account?');
  await card.getByRole('button',{name:/Keep both/}).click();
  await gotoRoute(page, 'money');
  await expect(page.locator('[data-account-duplicates]')).toHaveCount(0);
  expect(await total(request), 'Keep both leaves both accounts in the total').toBe(before);
});

test('Money retires a stale pair warning and offers review again when evidence returns @sm-ac4 @mobile', async ({page,request}) => {
  const pair=await seed(request);
  await gotoRoute(page,'money');
  await expect(page.locator('[data-account-duplicates]')).toBeVisible();
  const changeKind = async kind => {
    const db=await openDb(await householdStoreFile(localDataDir()));
    try { await db.prepare('UPDATE accounts SET kind=? WHERE id=?').run(kind,pair.own); } finally {await db.close();}
  };
  await changeKind('card');
  await page.reload();
  await expect(page.locator('[data-account-duplicates]')).toHaveCount(0);
  await changeKind('cash');
  await page.reload();
  await expect(page.locator('[data-account-duplicates]')).toBeVisible();
  const sc=await (await request.get('/api/scenario')).json();
  expect(sc.live.ingest.items.filter(i=>i.context.repair)).toHaveLength(1);
});
