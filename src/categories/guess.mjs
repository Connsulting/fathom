import { tx, parseJson } from '../store/db.mjs';
import { resolveCategories, importedCategory, sourceBucket } from './resolve.mjs';
import { loadCategoryInputs, queueCategoryChecks, categoryOptions } from './store.mjs';
import { categoryQuestions, JEV_MODEL } from './jev.mjs';
import { confidenceBand, jevEvidence } from './policy.mjs';
import { ask, getItem, recordAutoAnswer } from '../ingest/confirm.mjs';

export function categoryNames(input) {
  return [...new Set([...input.transactions.flatMap(t=>{
    const c=importedCategory(t); return sourceBucket(c.parser,c.category) ? [c.category] : [];
  }),...input.corrections.map(r=>r.category),...input.sourceRules.map(r=>r.category),...input.merchantRules.map(r=>r.category)])].sort();
}
export const householdNames = db => parseJson(db.prepare("SELECT value FROM facts WHERE key='household.names'").get()?.value,{});

export async function guessCategories(db, jev, { now, batchSize = 10, maxBatches = Infinity, policy } = {}) {
  if (!jev?.isOn()) return {skipped:'provider_off'};
  let guessed=0, applied=0;
  try {
    for(let n=0;n<maxBatches;n++) {
      const input=loadCategoryInputs(db), resolved=resolveCategories(input), names=categoryNames(input);
      if(names.length<2) break;
      const attempted=new Set(input.guesses.map(g=>g.transaction_id));
      const rows=input.transactions.filter(t=>resolved.get(t.id)?.layer==='uncategorized' && !attempted.has(t.id)).slice(0,batchSize);
      if(!rows.length) break;
      const answers=await jev.choose(categoryQuestions(rows,{accounts:input.accounts,householdNames:householdNames(db),categories:names}));
      const current=resolveCategories(loadCategoryInputs(db));
      const auto=[];
      tx(db,()=>{
        for(const [i,t] of rows.entries()) {
          if(current.get(t.id)?.layer!=='uncategorized') continue;
          const a=answers[i], prediction={category:a.choice,confidence:a.confidence,probabilities:a.probabilities};
          const at=now ?? new Date().toISOString();
          db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?) ON CONFLICT(transaction_id) DO NOTHING')
            .run(t.id,JSON.stringify(prediction),JEV_MODEL,at);
          const band=confidenceBand(a.confidence,policy);
          if(band==='uncategorized') continue;
          const context={kind:'transaction_category',subject:String(t.id),transactionId:t.id,amount:t.amount,date:t.date,
            description:t.description,category:'Uncategorized',bucket:t.amount>0?'income':'household',layer:'uncategorized',guess:a.choice,jev:prediction};
          const prior=db.prepare("SELECT id,status FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(t.id));
          if(prior?.status==='answered') continue;
          const item=prior ?? ask(db,{kind:'transaction_category',subject:String(t.id),question:'Check this transaction category',options:categoryOptions(context),context,now:at});
          const pending=getItem(db,item.id);
          if(pending?.status!=='pending') continue;
          db.prepare('UPDATE confirm_items SET context=?,options=? WHERE id=?').run(JSON.stringify(context),JSON.stringify(categoryOptions(context)),pending.id);
          guessed++;
          const declined=db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(pending.id);
          if(band==='auto' && !declined) {
            auto.push({id:pending.id,choice:a.choice,confidence:a.confidence,at});
          }
        }
      });
      for(const a of auto) {
        recordAutoAnswer(db,a.id,a.choice,{rule:'jev_category',evidence:{text:jevEvidence(a.confidence),refs:{confidence:a.confidence,model:JEV_MODEL}},now:a.at});
        applied++;
      }
    }
    queueCategoryChecks(db,{now,policy});
    return {guessed,applied,costUsd:jev.stats().costUsd};
  } catch(error) { return {guessed,applied,costUsd:jev.stats().costUsd,stopped:error.code??'category_guess_failed'}; }
}
