import { pendingItems, getItem } from './confirm.mjs';
import { cardDetail } from './context.mjs';
import { deterministicGuess } from './bestguess.mjs';
import { multiHolder } from './auto.mjs';
import { householdNames } from '../categories/guess.mjs';
import { scrubDescription, JEV_MODEL } from '../categories/jev.mjs';
import { jevEvidence } from '../categories/policy.mjs';
import { tx } from '../store/db.mjs';
import { filterSeries, forEachSeries, mapSeries } from '../shared/series.mjs';

const words=text=>String(text??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
const match=(name,holder)=>{
  const need=words(name), have=new Set(words(holder));
  return need.length ? need.filter(w=>have.has(w)).length/need.length : 0;
};
export async function guessClosedOptions(db,jev,{now}={}) {
  if(!await jev?.isOn()) return {guessed:0};
  const names=await householdNames(db), accounts=await db.prepare('SELECT id,mask FROM accounts').all();
  const items=await filterSeries((await pendingItems(db)), async item=>['account_kind','account_owner'].includes(item.kind)
    && !await db.prepare('SELECT 1 FROM confirm_guesses WHERE item_id=?').get(item.id)
    && !await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(item.id));
  let guessed=0;
  try {
    for(let i=0;i<items.length;i+=10) {
      const batch=await filterSeries((await mapSeries(items.slice(i,i+10), async item=>({item,detail:await cardDetail(db,item)}))), async ({item,detail})=>
        !await deterministicGuess(db,item,detail) && (item.kind!=='account_owner' || !!detail?.account?.holder));
      if(!batch.length) continue;
      const answers=await jev.choose(batch.map(({item,detail})=>({
        state:item.kind==='account_owner' ? {ownerMatch:match(names.me,detail.account.holder),spouseMatch:match(names.spouse,detail.account.holder),
          multipleHolders:multiHolder(detail.account.holder),accountKind:detail.account.kind} : {
          accountHint:scrubDescription(detail.account?.name,{accounts,householdNames:names})},
        instructions:item.kind==='account_owner' ? 'Choose the account owner from local household-name match fractions and multi-holder evidence. owner means the owner, spouse means the spouse. No raw names are provided.' : 'Choose the account kind from the redacted account hint.',
        options:item.options.map(o=>o.id),
      })));
      await tx(db,async (db)=>{
        await forEachSeries(batch, async ({item},j)=>{
          const fresh=await getItem(db,item.id);
          if(fresh?.status!=='pending' || await deterministicGuess(db,fresh,await cardDetail(db,fresh))) return;
          const a=answers[j];
          if(!fresh.options.some(o=>o.id===a.choice)) return;
          await db.prepare('INSERT INTO confirm_guesses VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO NOTHING')
            .run(item.id,a.choice,JSON.stringify({confidence:a.confidence,probabilities:a.probabilities,...(jev.model && jev.model!==JEV_MODEL ? {modelPort:true} : {})}),jev.model??JEV_MODEL,now??new Date().toISOString());
          guessed++;
        });
      });
    }
    return {guessed};
  } catch(error) { return {guessed,stopped:error.code??'jev_confirm_failed'}; }
}
