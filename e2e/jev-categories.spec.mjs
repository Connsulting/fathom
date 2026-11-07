import { test, expect, resetDemo, gotoRoute, deckCard, deckTo, deckOrder } from './helpers.mjs';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, DB_FILE } from '../src/store/db.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { createJev, JEV_MODEL } from '../src/categories/jev.mjs';

test('Jev review confidence appears in Confirm and an accepted guess can be undone',async ({page,request})=>{
  await resetDemo(request);
  const db=openDb(resolve(process.env.E2E_DATA||'.e2e-data',DB_FILE));
  const dir=mkdtempSync(join(tmpdir(),'jev-e2e-'));
  let id;
  try {
    const file=join(dir,'key');writeFileSync(file,'synthetic-key',{mode:0o600});
    db.exec("INSERT INTO accounts (id,kind,name) VALUES ('jev-test','checking','Synthetic everyday')");
    for(const [description,category] of [['Historical food','Groceries'],['Historical work','Business']])
      db.prepare("INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES ('jev-test','2026-10-01',-30,?,?,'aggregator')").run(description,category);
    id=Number(db.prepare("INSERT INTO transactions (account_id,date,amount,description,parser) VALUES ('jev-test','2026-10-02',-25,'Synthetic review merchant','simplefin')").run().lastInsertRowid);
    const jev=await createJev({keyFile:file,transport:async(_,o)=>{
      const body=JSON.parse(o.body);
      return Response.json({model:JEV_MODEL,usage:{input_tokens:120,output_tokens:12},answers:Object.fromEntries(Object.entries(body.questions).map(([id,q])=>{
        const options=Object.keys(q.criteria); return [id,{type:'choice',choice:'Groceries',confidence:.9,
          probabilities:Object.fromEntries(options.map(c=>[c,c==='Groceries'?.9:.1/(options.length-1)]))}];
      }))});
    }});
    await guessCategories(db,jev,{policy:{autoApply:.95,review:.7}});
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
  const pending=await (await request.get('/api/confirm')).json();
  const item=pending.items.find(i=>i.kind==='transaction_category'&&i.subject===String(id));
  expect(item).toBeTruthy();
  await gotoRoute(page,'confirm');await deckTo(page,await deckOrder(request),item.id);
  await expect(deckCard(page).locator('.h-cf-guess')).toContainText('Jev guess, 90% confident');
  const answer=await request.post(`/api/confirm/${item.id}/answer`,{data:{answer:'Groceries'}});expect(answer.status()).toBe(200);
  const undo=await request.post(`/api/confirm/${item.id}/reopen`,{data:{}});expect(undo.status()).toBe(200);
  expect((await (await request.get(`/api/confirm/${item.id}`)).json()).item.status).toBe('pending');
});
