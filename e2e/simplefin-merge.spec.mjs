import { resolve } from 'node:path';
import { test, expect, resetDemo, gotoRoute, deckTo, REMOTE } from './helpers.mjs';
import { openDb, setSetting, DB_FILE } from '../src/store/db.mjs';
import { dataKeyFor } from '../src/ingest/simplefin.mjs';
import { seedDuplicate } from '../test/helpers/account-merge.mjs';
import { refreshMergedAccounts } from '../src/ingest/account-merge.mjs';

test.skip(REMOTE, 'requires a local synthetic store');

async function seed(request) {
  await resetDemo(request);
  const dataDir = resolve(process.env.E2E_DATA || '.e2e-data');
  const db = openDb(resolve(dataDir,DB_FILE));
  try {
    setSetting(db,'clock','2032-03-10');
    const config = {dataDir};
    const key = await dataKeyFor(db,config);
    const s={db,config,key,opts:(engine,extra={})=>({config,key,engine,now:'2032-03-10T12:00:00.000Z',...extra})};
    const pair=await seedDuplicate(s,{sure:true});
    refreshMergedAccounts(db,{now:'2032-03-10T12:00:00.000Z'});
    return pair;
  } finally {db.close();}
}
const series = page => page.locator('[data-series="net"] .h-spark-h b');

test('Money offers Merge and Undo restores the duplicate and totals @sm-ac5 @mobile', async ({page,request}) => {
  const pair=await seed(request);
  await gotoRoute(page,'money');
  await expect(page.locator('[data-account-duplicates]')).toContainText('Some accounts may be counted twice');
  await expect(page.getByRole('link',{name:'Review accounts'})).toHaveAttribute('href','#/confirm');
  const q=(await (await request.get('/api/scenario')).json()).live.ingest.items.filter(i=>i.context.repair);
  expect(q).toHaveLength(1);
  const card=page.locator(`[data-item="${q[0].id}"]`);
  await expect(card).toContainText('Same account?');
  await expect(series(page)).toContainText('2.4');
  const answer = page.waitForResponse(r => r.url().endsWith(`/api/confirm/${q[0].id}/answer`));
  await card.getByRole('button',{name:/Merge/}).click();
  expect((await answer).status()).toBe(200);
  await expect(page.locator('[data-account-duplicates]')).toHaveCount(0);
  await expect(series(page)).toContainText('1.2');
  let sc=await (await request.get('/api/scenario')).json();
  expect(sc.accounts.filter(a=>[pair.keep,pair.own].includes(a.id))).toHaveLength(1);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator('[data-account-duplicates]')).toBeVisible();
  await expect(series(page)).toContainText('2.4');
  sc=await (await request.get('/api/scenario')).json();
  expect(sc.accounts.filter(a=>[pair.keep,pair.own].includes(a.id))).toHaveLength(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({path:test.info().outputPath('account-merge-undo.png'),fullPage:true});
});

test('Confirm shares the repair question and Keep both clears the Money warning @sm-ac2 @sm-ac4 @mobile', async ({page,request}) => {
  await seed(request);
  const sc=await (await request.get('/api/scenario')).json();
  const q=sc.live.ingest.items.find(i=>i.context.repair);
  await gotoRoute(page,'confirm');
  await deckTo(page,sc.live.ingest.items.map(i=>i.id),q.id);
  const card=page.locator(`[data-item="${q.id}"]`);
  await expect(card).toContainText('Same account?');
  await card.getByRole('button',{name:/Keep both/}).click();
  await gotoRoute(page,'accounts');
  await expect(page.locator('[data-account-duplicates]')).toHaveCount(0);
  await expect(series(page)).toContainText('2.4');
});
