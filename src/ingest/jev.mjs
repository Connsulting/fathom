import { pendingItems, getItem } from './confirm.mjs';
import { cardDetail } from './context.mjs';
import { deterministicGuess } from './bestguess.mjs';
import { multiHolder } from './auto.mjs';
import { householdNames } from '../categories/guess.mjs';
import { scrubDescription, JEV_MODEL } from '../categories/jev.mjs';
import { jevEvidence } from '../categories/policy.mjs';
import { tx } from '../store/db.mjs';

const words=text=>String(text??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const match=(name,holder)=>{
  const need=words(name), have=new Set(words(holder));
  return need.length ? need.filter(w=>have.has(w)).length/need.length : 0;
};
export async function guessClosedOptions(db,jev,{now}={}) {
  if(!jev?.isOn()) return {guessed:0};
  const names=householdNames(db), accounts=db.prepare('SELECT id,mask FROM accounts').all();
  const items=pendingItems(db).filter(item=>['account_kind','account_owner'].includes(item.kind)
    && !db.prepare('SELECT 1 FROM confirm_guesses WHERE item_id=?').get(item.id)
    && !db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id));
  let guessed=0;
  try {
    for(let i=0;i<items.length;i+=10) {
      const batch=items.slice(i,i+10).map(item=>({item,detail:cardDetail(db,item)})).filter(({item,detail})=>
        !deterministicGuess(db,item,detail) && (item.kind!=='account_owner' || !!detail?.account?.holder));
      if(!batch.length) continue;
      const answers=await jev.choose(batch.map(({item,detail})=>({
        state:item.kind==='account_owner' ? {ownerMatch:match(names.me,detail.account.holder),spouseMatch:match(names.spouse,detail.account.holder),
          multipleHolders:multiHolder(detail.account.holder),accountKind:detail.account.kind} : {
          accountHint:scrubDescription(detail.account?.name,{accounts,householdNames:names})},
        instructions:item.kind==='account_owner' ? 'Choose the account owner from local household-name match fractions and multi-holder evidence. owner means the owner, spouse means the spouse. No raw names are provided.' : 'Choose the account kind from the redacted account hint.',
        options:item.options.map(o=>o.id),
      })));
      tx(db,()=>{
        batch.forEach(({item},j)=>{
          const fresh=getItem(db,item.id);
          if(fresh?.status!=='pending' || deterministicGuess(db,fresh,cardDetail(db,fresh))) return;
          const a=answers[j];
          if(!fresh.options.some(o=>o.id===a.choice)) return;
          db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING')
            .run(item.id,a.choice,JSON.stringify({confidence:a.confidence,probabilities:a.probabilities}),jev.model??JEV_MODEL,now??new Date().toISOString());
          guessed++;
        });
      });
    }
    return {guessed};
  } catch(error) { return {guessed,stopped:error.code??'jev_confirm_failed'}; }
}
