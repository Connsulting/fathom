import { tx, parseJson, getSetting } from '../store/db.mjs';
import { resolveCategories, importedCategory, historyExamples, createHistoryIndex, normalizeMerchant } from './resolve.mjs';
import { loadCategoryInputs, queueCategoryChecks, categoryOptions, categoryNames, isJevProposal } from './store.mjs';
import { categoryQuestions, JEV_MODEL } from './jev.mjs';
import { confidenceBand, jevEvidence, categoryEvidence } from './policy.mjs';
import { ask, getItem, recordAutoAnswer } from '../ingest/confirm.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { merchantDisplayName } from './display.mjs';

export const householdNames = async db => parseJson((await db.prepare("SELECT value FROM facts WHERE key='household.names'").get())?.value,{});

async function categoryItem(db,options,t,resolution,at,prediction,account) {
  const context={kind:'transaction_category',subject:String(t.id),transactionId:t.id,amount:t.amount,date:t.date,
    description:t.description,category:'Uncategorized',bucket:t.amount>0?'income':'household',layer:'uncategorized',
    guess:resolution.category,account:accountLabel(account),merchant:normalizeMerchant(t.description),...(prediction?{jev:prediction}:{})};
  const prior=await db.prepare("SELECT id,status FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(t.id));
  if(prior?.status==='answered') return null;
  const item=prior ?? await ask(db,{kind:'transaction_category',subject:String(t.id),question:'Check this transaction category',options,context,now:at});
  const pending=await getItem(db,item.id);
  if(pending?.status!=='pending') return null;
  await db.prepare('UPDATE confirm_items SET context=?,options=? WHERE id=?').run(JSON.stringify(context),JSON.stringify(options),pending.id);
  return pending;
}

const investmentKind = kind => ['taxable','brokerage','investment','retirement','ira','roth','529'].includes(kind);
const reinvestment = text => /\breinvest(?:ment|ed)?\b/i.test(text ?? '');
const incomeActivity = text => reinvestment(text) ? null : /\bdividends?\b/i.test(text ?? '') ? 'dividend' : /\binterest\b/i.test(text ?? '') ? 'interest' : null;
const investmentActivity = text => /\b(?:trades?|bought|sold|buys?|sells?|purchas(?:e|ed)|sale|dividends?|interest|reinvest(?:ment|ed)?|fees?|contributions?)\b/i.test(text ?? '');

export async function autoDecideCategories(db,{now}={}) {
  const at=now ?? new Date().toISOString(), input=await loadCategoryInputs(db), deterministic=resolveCategories(input);
  const choices=categoryOptions(input), accounts=new Map(input.accounts.map(a=>[a.id,a])), index=createHistoryIndex(input);
  const ownerLabels=new Set(input.corrections.filter(c=>!c.auto).map(c=>c.transaction_id));
  const guesses=new Map(input.guesses.map(g=>[g.transaction_id,g.category]));
  const invested=new Set((await db.prepare('SELECT DISTINCT account_id FROM positions').all()).map(p=>p.account_id));
  let applied=0;
  for(const t of input.transactions) {
    if(t.category_declined || ownerLabels.has(t.id)) continue;
    let c=deterministic.get(t.id);
    if(!['merchant','structural','uncategorized'].includes(c.layer) || c.evidence.imported) continue;
    const account=accounts.get(t.account_id);
    const prior=await db.prepare("SELECT context,status FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(t.id));
    if(prior?.status==='answered') continue;
    const guess=guesses.get(t.id) ?? parseJson(prior?.context,{}).guess;
    const samples=historyExamples(t,input,index,Infinity).filter(s=>ownerLabels.has(s.id) && accounts.get(s.account_id)?.kind===account?.kind);
    const matching=samples.filter(s=>s.merchant===normalizeMerchant(t.description));
    const consistent=rows=>rows.length && rows.every(s=>s.category===rows[0].category && s.bucket===rows[0].bucket);
    if(c.bucket!=='transfer' && (investmentKind(account?.kind) || (account?.kind==='hsa' && invested.has(account.id)))
      && (guess==='Investment' || investmentActivity(t.description))) {
      const activity=incomeActivity(t.description), income=samples.filter(s=>activity && incomeActivity(s.description)===activity);
      c={category:consistent(income) ? income[0].category : 'Investment',evidence:{stage:'investment_account',
        transactionIds:income.map(s=>s.id),text:'Investment account activity'}};
    } else if(c.bucket!=='transfer' && matching.length>=3 && consistent(matching) && matching[0].category===guess) {
      c={category:guess,evidence:{stage:'history',transactionIds:matching.map(s=>s.id),
        text:categoryEvidence(`Matches how you categorized ${merchantDisplayName(normalizeMerchant(t.description))}`)}};
    } else if(!['merchant','structural'].includes(c.layer)
      || (c.layer==='merchant' && matching.length && (!consistent(matching) || (guess && guess!==c.category)))) continue;
    const item=await categoryItem(db,choices,t,c,at,undefined,account);
    if(!item || await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id)) continue;
    await recordAutoAnswer(db,item.id,c.category,{rule:'jev_category',evidence:{text:c.evidence.text,
      refs:{stage:c.evidence.stage,transactionIds:c.evidence.transactionIds??[]}},now:at});
    applied++;
  }
  return applied;
}

export async function guessCategories(db, jev, { now, batchSize = 10, maxBatches = Infinity, policy } = {}) {
  let guessed=0, applied=0;
  const stats=()=>jev?.stats?.().costUsd??0;
  const at=now ?? new Date().toISOString();
  try {
    applied=await autoDecideCategories(db,{now:at});
    guessed=applied;
    if(!jev?.isOn() || (await getSetting(db,'engine',{on:true}))?.on===false) {
      await queueCategoryChecks(db,{now,policy});
      return {guessed,applied,costUsd:stats(),...(!guessed?{skipped:'provider_off'}:{})};
    }
    for(let n=0;n<maxBatches;n++) {
      if((await getSetting(db,'engine',{on:true}))?.on===false) break;
      const input=await loadCategoryInputs(db), resolved=resolveCategories(input), names=categoryNames(input);
      if(names.length<2) break;
      const attempted=new Set(input.guesses.filter(isJevProposal).map(g=>g.transaction_id));
      const rows=input.transactions.filter(t=>resolved.get(t.id)?.layer==='uncategorized' && !attempted.has(t.id)
        && (!importedCategory(t).category || importedCategory(t).category==='Uncategorized')).slice(0,batchSize);
      if(!rows.length) break;
      const index=createHistoryIndex(input), choices=categoryOptions(input);
      const answers=await jev.choose(categoryQuestions(rows,{accounts:input.accounts,householdNames:await householdNames(db),categories:names,
        examples:rows.map(t=>historyExamples(t,input,index))}));
      const current=resolveCategories(await loadCategoryInputs(db));
      const auto=[];
      await tx(db,async (db)=>{
        for(const [i,t] of rows.entries()) {
          if(current.get(t.id)?.layer!=='uncategorized') continue;
          const a=answers[i], prediction={category:a.choice,confidence:a.confidence,probabilities:a.probabilities,...(jev.model && jev.model!==JEV_MODEL ? {modelPort:true} : {})};
          await db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,model=excluded.model,updated_at=excluded.updated_at')
            .run(t.id,JSON.stringify(prediction),jev.model??JEV_MODEL,at);
          const band=confidenceBand(a.confidence,jev.model && jev.model!==JEV_MODEL ? {autoApply:null,review:0} : policy);
          if(band==='uncategorized') continue;
          const item=await categoryItem(db,choices,t,{category:a.choice},at,prediction,input.accounts.find(account=>account.id===t.account_id));
          if(!item) continue;
          guessed++;
          const declined=await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id);
          if(band==='auto' && !declined) auto.push({id:item.id,choice:a.choice});
        }
      });
      applied+=await autoDecideCategories(db,{now:at});
      for(const a of auto) {
        if((await getItem(db,a.id))?.status!=='pending') continue;
        await recordAutoAnswer(db,a.id,a.choice,{rule:'jev_category',evidence:{text:jevEvidence(),refs:{stage:'model'}},now:at});
        applied++;
      }
    }
    await queueCategoryChecks(db,{now,policy});
    return {guessed,applied,costUsd:stats()};
  } catch(error) { return {guessed,applied,costUsd:stats(),stopped:error.code??'category_guess_failed'}; }
}
