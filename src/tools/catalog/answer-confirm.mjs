import { HttpError } from '../../api/http.mjs';
import { isDeepStrictEqual } from 'node:util';
import { tx, parseJson } from '../../store/db.mjs';
import { saveConfirmAnswers, saveConfirmReopen, afterAnswer } from '../../api/ingest-handlers.mjs';
import { getItem, reopenItems, answerItems, reviseItem } from '../../ingest/confirm.mjs';
import { saveRecAnswers, saveAnswerReceipt } from '../../api/fact-answers.mjs';
import { markItem } from '../../api/yearend-handlers.mjs';
import { taxYearFor } from '../../yearend/expected.mjs';
import { requireActor, registerReceiptKind, saveReceipt, replanAction } from '../../actions/receipts.mjs';
import { requireEvidence } from '../../actions/evidence.mjs';
import { ANSWER_SHAPES, answerShape } from '../../jobs/triggers/common.mjs';
import { bounded } from './balances.mjs';
import { clockOf, plainDeep } from './figures.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { ToolError } from '../errors.mjs';

const nowOf=ctx=>new Date(ctx.now ?? Date.now()).toISOString();
const itemState=(db,ids)=>ids.map(id=>{const row=db.prepare('SELECT * FROM confirm_items WHERE id=?').get(id);return row?{...row}:null;});
const changed=()=>{throw new ToolError('changed_since','This item changed since that action.');};
const ident=s=>'"'+s.replaceAll('"','""')+'"';
function domainError(err) {
  if (err.name === 'ConfirmError' || err instanceof HttpError) return new ToolError(err.reason || err.code || (err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'bad_input'), err.reason || err.message);
  return err;
}
function domain(fn) { try { return fn(); } catch (err) { throw domainError(err); } }
function changedRows(db,ids) {
  const changes=ids.flatMap(id=>parseJson(db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(id)?.changes,[])||[]);
  const rows=new Map();
  for (const change of changes) {
    const key=`${change.table}:${change.rowid}`;
    const previous=rows.get(key);
    const fields=change.op==='update' && change.table==='accounts'
      ? Object.keys(JSON.parse(change.after)).filter(k=>JSON.parse(change.before)[k]!==JSON.parse(change.after)[k]) : null;
    rows.set(key,{table:change.table,rowid:change.rowid,fields:previous
      ? previous.fields && fields ? [...new Set([...previous.fields,...fields])] : null
      : fields});
  }
  return [...rows.values()];
}
function rowStates(db,rows){return rows.map(({table,rowid,fields})=>{
  const row=db.prepare(`SELECT * FROM ${ident(table)} WHERE rowid=?`).get(rowid)||null;
  return {table,rowid,fields,value:row?(fields?Object.fromEntries(fields.map(k=>[k,row[k]])):{...row}):null};
});}
registerReceiptKind('confirm_answer',{restore(ctx,{before,after}){
  const ids=after.ids;
  if(!isDeepStrictEqual(itemState(ctx.db,ids),after.items))changed();
  domain(()=>afterAnswer(ctx,()=>{
    const out=reopenItems(ctx.db,ids,{now:nowOf(ctx)});
    const prior=before.items.filter(i=>i.status==='answered').map(i=>({id:i.id,option:i.answer}));
    if(prior.length)answerItems(ctx.db,prior,{now:nowOf(ctx)});
    return out;
  }));
}});
registerReceiptKind('confirm_reopen',{restore(ctx,{before,after}){
  if(!isDeepStrictEqual(itemState(ctx.db,after.ids),after.items)||!isDeepStrictEqual(rowStates(ctx.db,after.rows),after.rows))changed();
  domain(()=>afterAnswer(ctx,()=>answerItems(ctx.db,before.items.map(i=>({id:i.id,option:i.answer})),{now:nowOf(ctx)})));
}});
registerReceiptKind('yearend_mark',{restore(ctx,{id,before,after}){
  const [year,key]=JSON.parse(id);
  const row=ctx.db.prepare('SELECT * FROM yearend_marks WHERE tax_year=? AND item_key=?').get(year,key)||null;
  if(!isDeepStrictEqual(row?{...row}:null,after))changed();
  if(before===null)ctx.db.prepare('DELETE FROM yearend_marks WHERE tax_year=? AND item_key=?').run(year,key);
  else ctx.db.prepare('UPDATE yearend_marks SET reason=?,marked_at=? WHERE tax_year=? AND item_key=?').run(before.reason,before.marked_at,year,key);
}});

function confirmWrite(operation,args,ctx){
  requireActor(ctx);
  let result,receipt;
  domain(()=>tx(ctx.db,()=>{
    const ids=operation==='confirm'?args.items.map(i=>i.id):args.ids;
    if(new Set(ids).size!==ids.length)throw new ToolError('bad_input','Each Confirm item may appear only once.');
    const before={items:itemState(ctx.db,ids)};
    const rows=operation==='reopen'?changedRows(ctx.db,ids):[];
    result=operation==='confirm'?saveConfirmAnswers(ctx,args.items,{revise:args.revise}):saveConfirmReopen(ctx,ids);
    const after={ids,items:itemState(ctx.db,ids),...(operation==='reopen'?{rows:rowStates(ctx.db,rows)}:{})};
    if(!isDeepStrictEqual(before.items,after.items))receipt=saveReceipt(ctx,{scope:'write:confirm',kind:operation==='confirm'?'confirm_answer':'confirm_reopen',id:JSON.stringify(ids),label:operation==='confirm'?'Confirm answers':'Reopen Confirm answers',before,after,from:before.items.map(i=>({id:i.id,answer:i.answer})),to:after.items.map(i=>({id:i.id,answer:i.answer}))});
  }));
  ctx.onReceipt?.(receipt);
  return bounded({items:plainDeep(tokenScope(ctx.db),result.items),receipt:receipt||null});
}
async function recQuestions(args,ctx){
  const actorId=requireActor(ctx),receipts=[];
  for (const answer of args.answers) {
    if (!Object.hasOwn(ANSWER_SHAPES, answer.key)) throw new ToolError('bad_input', 'Recommendation answer key is not supported.');
    requireEvidence(ctx,answer.value,{evidence:args.evidence,shape:answerShape(answer.key),argument:answer.key});
  }
  await saveRecAnswers(ctx,{recId:args.recId,answers:args.answers},{now:nowOf(ctx),channel:ctx.channel==='mcp'?'mcp':'ask',actorId,replan:async()=>{},onWrite(before,after){
    const receipt=saveAnswerReceipt(ctx,before,after);
    if(receipt)receipts.push(receipt);
    return receipt;
  }}).catch(err => { throw domainError(err); });
  let planningPending=false;
  for(const receipt of receipts)ctx.onReceipt?.(receipt);
  if(receipts.length){planningPending=await replanAction(ctx,receipts[0]);for(const receipt of receipts.slice(1)){
    receipt.planningPending=planningPending;ctx.db.prepare('UPDATE action_receipts SET planning_pending=? WHERE id=?').run(planningPending?1:0,receipt.id);
  }}
  const row=ctx.db.prepare('SELECT * FROM recs WHERE id=?').get(args.recId);
  return bounded({rec:plainDeep(tokenScope(ctx.db),{...parseJson(row.def,{}),id:row.id,status:row.status}),receipts,planningPending,
    undo:receipts.map(r=>({available:true,tool:'undo',args:{operation:'undo',id:r.id}}))});
}
function yearendMark(args,ctx){
  requireActor(ctx);
  const year=args.year??taxYearFor(clockOf(ctx)),key=args.itemKey;
  let receipt;
  domain(()=>tx(ctx.db,()=>{
    const get=()=>ctx.db.prepare('SELECT * FROM yearend_marks WHERE tax_year=? AND item_key=?').get(year,key)||null;
    const before=get();markItem({...ctx,config:{...ctx.config,clock:clockOf(ctx)},body:{year,key,reason:args.reason}});
    receipt=saveReceipt(ctx,{scope:'write:confirm',kind:'yearend_mark',id:JSON.stringify([year,key]),label:'Expected tax document',before,after:get()});
  }));
  ctx.onReceipt?.(receipt);
  return {item:{key,marked:args.reason!==null,reason:args.reason===null?null:args.reason.trim()},receipt};
}
const ids={type:'array',minItems:1,maxItems:500,items:{type:'integer',minimum:1}};
export const operations=[
  {tool:'answer',name:'confirm',scope:'write:confirm',summary:'Answer Confirm items; revise takes one answered item.',route:'Confirm answers',routes:['POST /api/confirm/answers','POST /api/confirm/:id/answer'],params:{items:{type:'array',minItems:1,maxItems:500,items:{type:'object',properties:{id:{type:'integer',minimum:1},answer:{type:'string',minLength:1}},required:['id','answer'],additionalProperties:false}},revise:{type:'boolean'}},required:['items'],handler:(args,ctx)=>confirmWrite('confirm',args,ctx)},
  {tool:'answer',name:'reopen',scope:'write:confirm',summary:'Reopen answered items unless changed since.',route:'Confirm reopen',routes:['POST /api/confirm/reopen-many','POST /api/confirm/:id/reopen'],params:{ids},required:['ids'],handler:(args,ctx)=>confirmWrite('reopen',args,ctx)},
  {tool:'answer',name:'rec_questions',scope:'write:facts',summary:'Answer a visible recommendation with owner evidence.',route:'Rec answers',routes:['POST /api/recs/:id/answers'],params:{recId:{type:'string',minLength:1},answers:{type:'array',minItems:1,maxItems:50,items:{type:'object',properties:{key:{type:'string',minLength:1},path:{type:'array',items:{type:'string'}},value:{}},required:['key','value'],additionalProperties:false}},evidence:{type:'string',minLength:1}},required:['recId','answers','evidence'],handler:recQuestions},
  {tool:'answer',name:'yearend_mark',scope:'write:confirm',summary:'Mark or clear an expected tax document.',route:'Tax document mark',routes:['POST /api/yearend/marks'],params:{year:{type:'integer',minimum:2000,maximum:2100},itemKey:{type:'string',minLength:1,maxLength:200},reason:{anyOf:[{type:'string',minLength:1,maxLength:300},{type:'null'}]}},required:['itemKey','reason'],handler:yearendMark},
];
