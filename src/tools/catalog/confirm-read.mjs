import { HttpError } from '../../api/http.mjs';
import { listPendingConfirm, listConfirm, getConfirm } from '../../api/ingest-handlers.mjs';
import { accountMergeCandidates } from '../../api/accounts.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { plainDeep } from './figures.mjs';
import { bounded } from './balances.mjs';
import { ToolError } from '../errors.mjs';

export function confirmItems(args, ctx) {
  const status=args.status ?? 'pending';
  let items;
  if (args.ids) {
    items=args.ids.map(id=>getConfirm({...ctx,params:{id:String(id)}}).item)
      .filter(i=>status==='all'||i.status===status);
  } else items=(status==='pending'?listPendingConfirm(ctx):listConfirm({...ctx,body:{status}})).items;
  if(args.kinds) items=items.filter(i=>args.kinds.includes(i.kind));
  return {items};
}
function read(fn,args,ctx) {
  try {return bounded(plainDeep(tokenScope(ctx.db),fn(args,ctx)));}
  catch(err){if(err instanceof HttpError)throw new ToolError(err.status===404?'not_found':'bad_input',err.message);throw err;}
}
export const operations=[
  {tool:'household',name:'confirm_items',scope:'read',summary:'List pending or answered Confirm items, or fetch items by id.',route:'List Confirm questions and answers',
    routes:['GET /api/confirm','POST /api/confirm/list','GET /api/confirm/:id'],params:{status:{type:'string',enum:['pending','answered','all']},kinds:{type:'array',items:{type:'string'}},ids:{type:'array',items:{type:'integer',minimum:1},maxItems:500}},required:[],handler:(args,ctx)=>read(confirmItems,args,ctx)},
  {tool:'accounts',name:'merge_candidates',scope:'read',summary:'Show duplicate candidates and the rows a merge would move.',route:'Show account merge candidates',routes:['GET /api/accounts/:id/merge-candidates'],params:{id:{type:'string'}},required:['id'],handler:(args,ctx)=>read((a,c)=>accountMergeCandidates({...c,params:{id:a.id}}),args,ctx)},
];
