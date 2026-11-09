import { isDeepStrictEqual } from 'node:util';
import { txWith } from '../../store/db.mjs';
import { setTransactionCategory, setMerchantRule, loadCategoryInputs } from '../../categories/store.mjs';
import { resolveCategories, normalizeMerchant } from '../../categories/resolve.mjs';
import { classOf } from '../../calc/classes.mjs';
import { envelope } from '../../calc/figure.mjs';
import { registerReceiptKind, requireActor, saveReceipt } from '../../actions/receipts.mjs';
import { afterAnswer } from '../../api/ingest-handlers.mjs';
import { ToolError } from '../errors.mjs';

function restoreCategory(table, pk) {
  return { async restore(ctx, { id, before, after }) {
    const row=await ctx.db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(id);
    if (!isDeepStrictEqual(row ? {...row} : null, after)) throw new ToolError('conflict','This item changed since that action.');
    if (before === null) await ctx.db.prepare(`DELETE FROM ${table} WHERE ${pk}=?`).run(id);
    else await ctx.db.prepare(`UPDATE ${table} SET category=?,bucket=?,updated_at=? WHERE ${pk}=?`).run(before.category,before.bucket,before.updated_at,id);
    await afterAnswer(ctx,()=>({items:[],factsChanged:false}));
  } };
}
registerReceiptKind('category_correction',restoreCategory('transaction_category_corrections','transaction_id'));
registerReceiptKind('merchant_rule',restoreCategory('category_merchant_rules','merchant'));

async function categorize(operation,args,ctx) {
  await requireActor(ctx);
  const db=ctx.db,at=new Date(ctx.now ?? Date.now()).toISOString();
  const table=operation==='transaction'?'transaction_category_corrections':'category_merchant_rules';
  const pk=operation==='transaction'?'transaction_id':'merchant';
  const id=operation==='transaction'?args.transactionId:normalizeMerchant(args.merchant);
  let receipt,result;
  try { await txWith(ctx,async (ctx)=>{ const { db }=ctx;
    const before=await db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(id)||null;
    if(operation==='transaction') {
      const transaction=await setTransactionCategory(db,id,args.category,{now:at});
      const resolved=resolveCategories(await loadCategoryInputs(db)).get(id);
      result={transaction:{...transaction,class:classOf(resolved.category,resolved.bucket)}};
    } else {
      const prior=resolveCategories(await loadCategoryInputs(db));
      const rule=await setMerchantRule(db,id,args.category,{now:at});
      const input=await loadCategoryInputs(db),resolved=resolveCategories(input);
      const affected=input.transactions.filter(t=>normalizeMerchant(t.description)===id && resolved.get(t.id).evidence.merchant===id
        && (prior.get(t.id).category!==resolved.get(t.id).category || prior.get(t.id).bucket!==resolved.get(t.id).bucket || prior.get(t.id).evidence.merchant!==id));
      result={rule,affected:envelope(affected.length,{unit:'count',label:'Transactions reclassified',kind:'a',asOf:affected.map(t=>t.date).sort().at(-1)||null,
        provenance:{calc:'setMerchantRule',sources:[{table:'transactions',ids:affected.slice(0,50).map(t=>t.id),count:affected.length}]},gaps:[]})};
    }
    const after=await db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(id);
    receipt=await saveReceipt(ctx,{scope:'write:categories',kind:operation==='transaction'?'category_correction':'merchant_rule',id:String(id),label:operation==='transaction'?'Transaction category':'Merchant category rule',before,after});
  }); } catch(err) {
    if(err.name==='ConfirmError') throw new ToolError(err.code==='stale'?'not_found':'bad_input',err.message);
    throw err;
  }
  await afterAnswer(ctx,()=>({items:[],factsChanged:false}));
  ctx.onReceipt?.(receipt);
  return {...result,receipt};
}
const category={type:'string',minLength:1};
export const operations=[
  {tool:'categorize',name:'transaction',scope:'write:categories',summary:'Transaction category and bucket.',route:'Transaction category',routes:[],params:{transactionId:{type:'integer',minimum:1},category},required:['transactionId','category'],handler:async (args,ctx)=>await categorize('transaction',args,ctx)},
  {tool:'categorize',name:'merchant_rule',scope:'write:categories',summary:'Set a merchant rule; count reclassified rows.',route:'Merchant category',routes:[],params:{merchant:{type:'string',minLength:1,maxLength:200},category},required:['merchant','category'],handler:async (args,ctx)=>await categorize('merchant_rule',args,ctx)},
];
