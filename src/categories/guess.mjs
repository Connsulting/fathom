import { tx, parseJson, getSetting } from '../store/db.mjs';
import { resolveCategories, importedCategory, historyExamples, createHistoryIndex } from './resolve.mjs';
import { loadCategoryInputs, queueCategoryChecks, categoryOptions, categoryNames, isJevProposal } from './store.mjs';
import { categoryQuestions, JEV_MODEL } from './jev.mjs';
import { confidenceBand, jevEvidence } from './policy.mjs';
import { ask, getItem, recordAutoAnswer } from '../ingest/confirm.mjs';

export const householdNames = db => parseJson(db.prepare("SELECT value FROM facts WHERE key='household.names'").get()?.value,{});

function categoryItem(db,options,t,resolution,at,prediction) {
  const context={kind:'transaction_category',subject:String(t.id),transactionId:t.id,amount:t.amount,date:t.date,
    description:t.description,category:'Uncategorized',bucket:t.amount>0?'income':'household',layer:'uncategorized',
    guess:resolution.category,...(prediction?{jev:prediction}:{})};
  const prior=db.prepare("SELECT id,status FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(t.id));
  if(prior?.status==='answered') return null;
  const item=prior ?? ask(db,{kind:'transaction_category',subject:String(t.id),question:'Check this transaction category',options,context,now:at});
  const pending=getItem(db,item.id);
  if(pending?.status!=='pending') return null;
  db.prepare('UPDATE confirm_items SET context=?,options=? WHERE id=?').run(JSON.stringify(context),JSON.stringify(options),pending.id);
  return pending;
}

export async function guessCategories(db, jev, { now, batchSize = 10, maxBatches = Infinity, policy } = {}) {
  let guessed=0, applied=0;
  const stats=()=>jev?.stats?.().costUsd??0;
  const at=now ?? new Date().toISOString();
  try {
    const initial=loadCategoryInputs(db), deterministic=resolveCategories(initial), localChoices=categoryOptions(initial);
    for(const t of initial.transactions) {
      const c=deterministic.get(t.id);
      if(!['merchant','structural'].includes(c.layer) || c.evidence.imported) continue;
      const item=categoryItem(db,localChoices,t,c,at);
      if(!item || db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id)) continue;
      // The category auto rule keeps the existing cross-import undo and duplicate-move contract.
      recordAutoAnswer(db,item.id,c.category,{rule:'jev_category',evidence:{text:c.evidence.text,
        refs:{stage:c.evidence.stage,transactionIds:c.evidence.transactionIds??[]}},now:at});
      guessed++; applied++;
    }
    if(!jev?.isOn() || getSetting(db,'engine',{on:true})?.on===false) {
      queueCategoryChecks(db,{now,policy});
      return {guessed,applied,costUsd:stats(),...(!guessed?{skipped:'provider_off'}:{})};
    }
    for(let n=0;n<maxBatches;n++) {
      if(getSetting(db,'engine',{on:true})?.on===false) break;
      const input=loadCategoryInputs(db), resolved=resolveCategories(input), names=categoryNames(input);
      if(names.length<2) break;
      const attempted=new Set(input.guesses.filter(isJevProposal).map(g=>g.transaction_id));
      const rows=input.transactions.filter(t=>resolved.get(t.id)?.layer==='uncategorized' && !attempted.has(t.id)
        && (!importedCategory(t).category || importedCategory(t).category==='Uncategorized')).slice(0,batchSize);
      if(!rows.length) break;
      const index=createHistoryIndex(input), choices=categoryOptions(input);
      const answers=await jev.choose(categoryQuestions(rows,{accounts:input.accounts,householdNames:householdNames(db),categories:names,
        examples:rows.map(t=>historyExamples(t,input,index))}));
      const current=resolveCategories(loadCategoryInputs(db));
      const auto=[];
      tx(db,()=>{
        for(const [i,t] of rows.entries()) {
          if(current.get(t.id)?.layer!=='uncategorized') continue;
          const a=answers[i], prediction={category:a.choice,confidence:a.confidence,probabilities:a.probabilities,...(jev.model && jev.model!==JEV_MODEL ? {modelPort:true} : {})};
          db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,model=excluded.model,updated_at=excluded.updated_at')
            .run(t.id,JSON.stringify(prediction),jev.model??JEV_MODEL,at);
          const band=confidenceBand(a.confidence,policy ?? (jev.model && jev.model!==JEV_MODEL ? {autoApply:null,review:0} : undefined));
          if(band==='uncategorized') continue;
          const item=categoryItem(db,choices,t,{category:a.choice},at,prediction);
          if(!item) continue;
          guessed++;
          const declined=db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id);
          if(band==='auto' && !declined) auto.push({id:item.id,choice:a.choice});
        }
      });
      for(const a of auto) {
        recordAutoAnswer(db,a.id,a.choice,{rule:'jev_category',evidence:{text:jevEvidence(),refs:{stage:'model'}},now:at});
        applied++;
      }
    }
    queueCategoryChecks(db,{now,policy});
    return {guessed,applied,costUsd:stats()};
  } catch(error) { return {guessed,applied,costUsd:stats(),stopped:error.code??'category_guess_failed'}; }
}
