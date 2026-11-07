import { test, expect } from '@playwright/test';

async function scenario(request) {
  const r=await request.get('/api/scenario'); expect(r.status()).toBe(200); return r.json();
}
async function start(request) {
  expect((await scenario(request)).meta.mode).toBe('demo');
  expect((await request.post('/api/demo/reset',{data:{}})).status()).toBe(200);
  const goal=await request.post('/api/goals',{data:{title:'A cash cushion',note:'Months of spending',horizon:'now'}});
  expect(goal.status()).toBe(200); return (await goal.json()).goal.id;
}
async function serviceCard(page) {
  await page.goto('/#/confirm');
  for(let n=0;n<30;n++) {
    const card=page.locator('article.h-deck-card.cur');
    if((await card.textContent()).includes('Example Service')) return card;
    await page.locator('button[data-deck="next"]').click();
  }
  throw new Error('No Example Service category card');
}
const suggestion=(s,id)=>s.suggestions.find(x=>x.goalId===id);
const spending=(s,id)=>s.fig[suggestion(s,id).figures.monthlySpend].v;

test('Check these learns a merchant rule, changes displayed spending, and undoes @mobile @cat-ac6',async({page,request},info)=>{
  const id=await start(request); const before=await scenario(request); const baseline=spending(before,id);
  const card=await serviceCard(page);
  await expect(card).toContainText('Check these');
  await expect(card).toContainText('Account');
  await expect(card).toContainText('Uncategorized');
  await card.getByLabel('Always for this merchant').check();
  await page.screenshot({path:info.outputPath('check-these.png'),fullPage:true});
  const sent=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await card.getByRole('button',{name:/Business/}).click();
  const answer=await sent; expect(answer.status()).toBe(200); expect(answer.request().postDataJSON().answer).toBe('always:Business');
  const after=await scenario(request); expect(spending(after,id)).toBeLessThan(baseline);
  await page.goto('/#/goals');
  const target=page.locator(`[data-sugg="${id}"]`);
  await expect(target).toContainText('From');
  const changedText=await target.textContent();
  await page.goto('/#/confirm');
  const answered=(await request.post('/api/confirm/list',{data:{status:'answered'}}));
  const it=(await answered.json()).items.find(x=>x.kind==='transaction_category' && x.answer==='always:Business');
  expect(it).toBeTruthy();
  // The same reopen boundary backs the deck Undo control after returning from Goals.
  expect((await request.post(`/api/confirm/${it.id}/reopen`,{data:{}})).status()).toBe(200);
  expect(spending(await scenario(request),id)).toBe(baseline);
  await page.goto('/#/goals');
  await expect(page.locator(`[data-sugg="${id}"]`)).not.toHaveText(changedText);
});

test('number keys and take-guess cannot learn a merchant rule without the checkbox @mobile @cat-ac3',async({page,request})=>{
  await start(request); let card=await serviceCard(page);
  await expect(card.getByLabel('Always for this merchant')).not.toBeChecked();
  const options=card.locator('button[data-answer]');
  const second=await options.nth(1).getAttribute('data-option');
  const numberPost=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await page.evaluate(()=>document.activeElement?.blur());
  await page.keyboard.press('2');
  const n=await numberPost; expect(n.status()).toBe(200); expect(n.request().postDataJSON().answer).toBe(second);
  expect(second.startsWith('always:')).toBe(false);
  await page.locator('button[data-deck="undo"]').click();
  card=await serviceCard(page);
  const guessed=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await card.getByRole('button',{name:'Use best guess'}).click();
  const g=await guessed; expect(g.status()).toBe(200); expect(g.request().postDataJSON().answer.startsWith('always:')).toBe(false);
});
