import { HttpError } from '../../api/http.mjs';
import { isDeepStrictEqual } from 'node:util';
import { tx, parseJson } from '../../store/db.mjs';
import { accountOf, renameAccount, setAccountMask, restoreAccountMask, writeAccountAnswer, mergeAccountPair } from '../../accounts/write.mjs';
import { afterAnswer } from '../../api/ingest-handlers.mjs';
import { getItem, reopenItem, undoAccountAnswer, OWNER_OPTIONS, KIND_OPTIONS } from '../../ingest/confirm.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { registerReceiptKind, requireActor, saveReceipt } from '../../actions/receipts.mjs';
import { isExplicitYes, requireEvidence } from '../../actions/evidence.mjs';
import { ToolError } from '../errors.mjs';
import { txWith } from '../../store/db.mjs';

const nowOf = ctx => new Date(ctx.now ?? Date.now()).toISOString();
const conflict = () => { throw new ToolError('conflict', 'This item changed since that action.'); };
const itemState = async (db, id) => { const row=await db.prepare('SELECT * FROM confirm_items WHERE id=?').get(id); return row ? {...row} : null; };
const answerState = async (db, id, kind) => ({ value: (await accountOf(db,id))[kind === 'account_owner' ? 'owner' : 'kind'],
  item: (async () => { const row=await db.prepare('SELECT * FROM confirm_items WHERE kind=? AND subject=?').get(kind,id); return row ? {...row} : null; })() });
function domain(fn) {
  try { return fn(); } catch (err) {
    if (err instanceof HttpError || err.name === 'ConfirmError') throw new ToolError(err.reason || (err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'bad_input'), err.reason || err.message);
    throw err;
  }
}
registerReceiptKind('account_field', { async restore(ctx,{id,before,after}) {
  const current = await accountOf(ctx.db,id), fields = Object.keys(after);
  if (!fields.every(k => current[k] === after[k])) conflict();
  if (Object.hasOwn(after,'mask')) {
    domain(async () => await restoreAccountMask(ctx.db,id,{set:after.mask}));
    if (before.mask !== null) await ctx.db.prepare('UPDATE accounts SET mask=? WHERE id=?').run(before.mask,id);
  }
  else await renameAccount(ctx.db,id,before.display_name);
} });
registerReceiptKind('account_answer', { async restore(ctx,{id,before,after}) {
  if (!isDeepStrictEqual(await answerState(ctx.db,id,after.kind),after.state)) conflict();
  domain(async () => await afterAnswer(ctx,async () => await undoAccountAnswer(ctx.db,after.kind,id,before.undo,{now:nowOf(ctx)})));
} });
registerReceiptKind('account_merge', { async restore(ctx,{before,after}) {
  if (!isDeepStrictEqual(await itemState(ctx.db,after.itemId),after.item)) conflict();
  domain(async () => await afterAnswer(ctx,async () => await reopenItem(ctx.db,after.itemId,{now:nowOf(ctx)})));
} });

async function mergeEvidence(args,ctx) {
  if (args.confirm !== true || !isExplicitYes(args.evidence)) throw new ToolError('bad_input','Merge needs confirm: true and the owner\'s explicit confirming words.');
  if (ctx.channel === 'mcp') return;
  await requireEvidence(ctx,args.evidence,{evidence:args.evidence,argument:'merge confirmation'});
  if (!ctx.conversationKey || !ctx.actorId) throw new ToolError('bad_input','Show the merge candidates first, then ask the owner to confirm in a later message.');
  const rows=await ctx.db.prepare('SELECT id,role,text,provenance FROM messages WHERE conversation_key=? AND id<=? ORDER BY id DESC').all(ctx.conversationKey,ctx.evidenceMessageId ?? Number.MAX_SAFE_INTEGER);
  const previous=rows.find(r=>r.role==='fathom');
  const reads=parseJson(previous?.provenance,{})?.tools || [];
  const shown=reads.some(r=>r.name==='accounts' && !r.isError && r.args?.operation==='merge_candidates' && [args.id,args.withId].includes(r.args.id));
  const later=typeof ctx.ownerText==='string' ? ctx.ownerText.includes(args.evidence)
    : rows.some(r=>r.id>previous?.id && r.role==='me' && parseJson(r.provenance,{})?.ownerInput?.actorId===ctx.actorId && r.text.includes(args.evidence));
  if (!shown || !later) throw new ToolError('bad_input','Show the merge candidates first, then quote the owner\'s confirmation in a later message.');
}

async function update(operation,args,ctx) {
  await requireActor(ctx);
  if (operation==='merge') await mergeEvidence(args,ctx);
  let receipt, result;
  domain(async () => await txWith(ctx,async (ctx) => {
    const row=await accountOf(ctx.db,args.id);
    if (operation==='rename' || operation==='mask') {
      const field=operation==='rename'?'display_name':'mask', before={ [field]:row[field] };
      if(operation==='rename') await renameAccount(ctx.db,args.id,args.displayName);
      else await setAccountMask(ctx.db,args.id,args.mask);
      const after={ [field]:(await accountOf(ctx.db,args.id))[field] };
      receipt=await saveReceipt(ctx,{scope:'write:accounts',kind:'account_field',id:args.id,label:'Account '+operation,before,after});
    } else if(operation==='owner' || operation==='kind') {
      const kind='account_'+operation, before=await answerState(ctx.db,args.id,kind);
      let undo;
      await afterAnswer(ctx,async () => {const out=await writeAccountAnswer(ctx.db,args.id,operation,args,{now:nowOf(ctx)});undo=out.before;return out;});
      const state=await answerState(ctx.db,args.id,kind);
      if (!isDeepStrictEqual(before,state)) receipt=await saveReceipt(ctx,{scope:'write:accounts',kind:'account_answer',id:args.id,label:'Account '+operation,
        before:{state:before,undo},after:{kind,state},from:before.value,to:state.value});
    } else {
      let merged;
      await afterAnswer(ctx,async () => (merged=await mergeAccountPair(ctx.db,args.id,args.withId,{now:nowOf(ctx)})));
      result={survivorId:merged.survivorId,itemId:merged.item.id};
      receipt=await saveReceipt(ctx,{scope:'write:accounts',kind:'account_merge',id:String(merged.item.id),label:'Merge accounts',
        before:{id:args.id,withId:args.withId},after:{itemId:merged.item.id,item:await itemState(ctx.db,merged.item.id)},from:{id:args.id,withId:args.withId},to:result});
    }
    result ||= {account:{id:args.id,label:(await accountNaming(ctx.db)).label(await accountOf(ctx.db,args.id))}};
  }));
  ctx.onReceipt?.(receipt);
  return {...result,receipt};
}
const id={type:'string',minLength:1};
const op=(name,params,required,summary)=>({tool:'update_account',name,scope:'write:accounts',summary,route:'Account '+name,
  routes:[`POST /api/accounts/:id/${name==='rename'?'name':name}`],params:{id,...params},required:['id',...required],handler:async (args,ctx)=>await update(name,args,ctx)});
export const operations=[
  op('rename',{displayName:{anyOf:[{type:'string'},{type:'null'}]}},['displayName'],'Set or clear a display name.'),
  op('mask',{mask:{type:'string',pattern:'^\\d{4}$'}},['mask'],'Set absent last four on unconnected accounts.'),
  op('owner',{owner:{type:'string',enum:OWNER_OPTIONS.map(o=>o.id)}},['owner'],'Set owner through Confirm.'),
  op('kind',{kind:{type:'string',enum:KIND_OPTIONS.map(o=>o.id)}},['kind'],'Set kind through Confirm.'),
  op('merge',{withId:id,confirm:{type:'boolean',enum:[true]},evidence:{type:'string',minLength:1}},['withId','confirm','evidence'],'Merge shown candidates after a later owner yes.'),
];
export const rules=['Show accounts.merge_candidates and moves; only after a later owner yes call update_account.merge with confirm true and quote that yes as evidence.'];
