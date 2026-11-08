import { HttpError } from '../../api/http.mjs';
import { listPendingConfirm, listConfirm, getConfirm } from '../../api/ingest-handlers.mjs';
import { accountMergeCandidates } from '../../api/accounts.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { plainDeep } from './figures.mjs';
import { bounded } from './balances.mjs';
import { ToolError } from '../errors.mjs';
import { mapSeries } from '../../shared/series.mjs';

export async function confirmItems(args, ctx) {
  const status=args.status ?? (args.ids ? 'all' : 'pending');
  let items;
  if (args.ids) {
    items=(await mapSeries(args.ids, async id=>(await getConfirm({...ctx,params:{id:String(id)}})).item))
      .filter(i=>status==='all'||i.status===status);
  } else items=(status==='pending'?await listPendingConfirm(ctx):await listConfirm({...ctx,body:{status}})).items;
  if(args.kinds) items=items.filter(i=>args.kinds.includes(i.kind));
  return {items};
}
async function read(fn,args,ctx) {
  try {return bounded(plainDeep(await tokenScope(ctx.db),fn(args,ctx)));}
  catch(err){if(err instanceof HttpError)throw new ToolError(err.status===404?'not_found':'bad_input',err.message);throw err;}
}
export const operations=[
  {tool:'household',name:'confirm_items',scope:'read',summary:'List or fetch Confirm items by id, status or kind.',route:'Confirm items',
    routes:['GET /api/confirm','POST /api/confirm/list','GET /api/confirm/:id'],params:{status:{type:'string',enum:['pending','answered','all']},kinds:{type:'array',items:{type:'string'}},ids:{type:'array',items:{type:'integer',minimum:1},maxItems:500}},required:[],handler:async (args,ctx)=>await read(confirmItems,args,ctx)},
  {tool:'accounts',name:'merge_candidates',scope:'read',summary:'Show merge candidates and moved rows.',route:'Merge candidates',routes:['GET /api/accounts/:id/merge-candidates'],params:{id:{type:'string'}},required:['id'],handler:async (args,ctx)=>await read(async (a,c)=>await accountMergeCandidates({...c,params:{id:a.id}}),args,ctx)},
];
