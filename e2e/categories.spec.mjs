import { test, expect } from '@playwright/test';

async function scenario(request) {
  const r=await request.get('/api/scenario'); expect(r.status()).toBe(200); return r.json();
}
async function start(request) {
  expect((await scenario(request)).live.mode).toBe('demo');
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
  await expect(card.locator('details[data-bank-details] summary')).toHaveText('Bank details');
  await expect(card.locator('details[data-bank-details]')).not.toHaveAttribute('open','');
  const order=await card.locator('button[data-answer]').evaluateAll(b=>b.map(x=>x.getAttribute('data-option')));
  expect(order.slice(0,7),'one fixed category order on every card').toEqual(['Shopping','Business','Income','Internal Transfers','Taxes','Investment','Ignore']);
  expect(await card.innerText()).not.toMatch(/%|jev|typesafe/i);
  await expect(card).toContainText('Uncategorized');
  await card.getByLabel('Always for this merchant').check();
  const sent=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await card.getByRole('button',{name:/Business/}).click();
  const answer=await sent; expect(answer.status()).toBe(200); expect(answer.request().postDataJSON().answer).toBe('always:Business');
  const after=await scenario(request); expect(spending(after,id)).toBeLessThan(baseline);
  await page.goto('/#/goals');
  const target=page.locator(`[data-sugg="${id}"]`);
  await expect(target).toContainText('From');
  const changedText=await target.textContent();
  await page.goto('/#/confirm');
  const undo=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/reopen$/.test(new URL(r.url()).pathname));
  await page.locator('button[data-deck="undo"]').click();
  expect((await undo).status()).toBe(200);
  expect(spending(await scenario(request),id)).toBe(baseline);
  await page.goto('/#/goals');
  await expect(page.locator(`[data-sugg="${id}"]`)).not.toHaveText(changedText);
  await serviceCard(page);
  await page.screenshot({path:info.outputPath('check-these.png'),fullPage:true});
});

test('number keys and take-guess cannot learn a merchant rule without the checkbox @mobile @cat-ac3',async({page,request})=>{
  await start(request); const card=await serviceCard(page);
  const itemId=await card.getAttribute('data-item');
  await expect(card.getByLabel('Always for this merchant')).not.toBeChecked();
  const options=card.locator('button[data-answer]');
  const second=await options.nth(1).getAttribute('data-option');
  const numberPost=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await page.evaluate(()=>document.activeElement?.blur());
  await page.keyboard.press('2');
  const n=await numberPost; expect(n.status()).toBe(200); expect(n.request().postDataJSON().answer).toBe(second);
  expect(second.startsWith('always:')).toBe(false);
  const reopened=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname===`/api/confirm/${itemId}/reopen`);
  await page.locator('button[data-deck="undo"]').click();
  expect((await reopened).status()).toBe(200);
  await expect(card).toHaveAttribute('data-item',itemId);
  await expect(card.getByLabel('Always for this merchant')).not.toBeChecked();
  const guessed=page.waitForResponse(r=>r.request().method()==='POST' && /\/api\/confirm\/\d+\/answer$/.test(new URL(r.url()).pathname));
  await card.getByRole('button',{name:'Use best guess'}).click();
  const g=await guessed; expect(g.status()).toBe(200); expect(g.request().postDataJSON().answer.startsWith('always:')).toBe(false);
});
