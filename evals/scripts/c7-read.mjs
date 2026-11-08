import { callTool } from '../../src/tools/index.mjs';

export async function script({turn,db,clock}) {
  const ctx={db,clock,channel:'ask',ownerStatements:()=>[turn.question]};
  const calls=[],results=[];
  for(const req of turn.required) {
    const args={operation:req.operation};
    for(const p of req.predicates) {
      if(p.path==='people')args.people=p.value;
      if(p.path==='obligations')args.obligations=[p.value];
      if(p.path==='retireAge.value')args.retireAge={value:p.value,source:'owner',evidence:turn.question};
    }
    calls.push({name:req.name,args});
    results.push(await callTool(req.name,args,ctx));
  }
  const gaps=[...new Set(results.flatMap(r=>r.gaps ?? []).map(g=>g.message.replace(/\(\s*\d{4}\s*\)/g,'')))];
  const out=results[0];
  const f=out?.people?.[0]?.milestones?.[0]?.date ?? out?.shortfall ?? out?.obligations?.[0]?.monthly ?? out?.years?.[0]?.spending;
  const text=[f?.value!=null?`The returned result is ${f.quote}.`:'The requested figure is unavailable.',...gaps.slice(0,2)].join(' ');
  return [{toolCalls:calls,costUsd:0},{text,costUsd:0}];
}
