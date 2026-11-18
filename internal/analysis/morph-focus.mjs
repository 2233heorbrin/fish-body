// User-selected phase views over emitted static relations, not business-phase inference.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeJson} from './io.mjs';
import {provenanceStatus} from './status.mjs';
export function phaseFocus(analysis,queries){
  const p=analysis.phases,byId=new Map(p.functions.map(f=>[f.id,f]));
  function select(selector){
    if(selector.tool)return p.toolBodies.filter(t=>t.name===selector.tool).map(t=>byId.get(t.body)).filter(Boolean);
    return p.functions.filter(f=>(!selector.file||f.location.file===selector.file)&&(!selector.name||f.name===selector.name)&&(!selector.kind||f.kind===selector.kind));
  }
  return {annotation:'Phase labels and seed selectors are manually supplied analysis questions, not automatically discovered business facts',groups:queries.map(q=>{
    const roots=select(q),queue=roots.map(f=>f.id),seen=new Set(),foundEdges=[];
    for(let i=0;i<queue.length&&seen.size<150;i++){
      const id=queue[i];if(seen.has(id))continue;seen.add(id);
      for(const edge of p.edges.filter(e=>e.from===id)){
        foundEdges.push(edge);
        if(edge.to&&!seen.has(edge.to))queue.push(edge.to);
      }
    }
    const unresolved=p.unresolvedCalls.filter(e=>seen.has(e.from));
    const candidates=[...foundEdges.filter(e=>e.provenance||e.status).map(e=>({...e.provenance,
      incomplete:e.provenance?.incomplete||e.status?.candidateSetComplete===false,conditional:e.provenance?.conditional||e.status?.conditional,multipleSources:e.provenance?.multipleSources||e.status?.multipleSources,
      uncertainty:[...(e.provenance?.uncertainty||[]),...(e.status?.uncertainty||[])],truncations:[...(e.provenance?.truncations||[]),...(e.status?.truncations||[])]})),...unresolved.flatMap(e=>e.provenance||[])];
    const status=provenanceStatus(candidates);
    status.multipleSources=candidates.some(c=>c.multipleSources);
    const remaining=queue.some(id=>!seen.has(id));
    if(remaining){status.candidateSetComplete=false;status.truncations.push({kind:'phase-function-traversal',limit:150,retained:seen.size,total:null});}
    return {question:q,roots,reachableFunctionIds:[...seen],functions:[...seen].map(id=>byId.get(id)),edges:foundEdges,mutations:p.mutations.filter(m=>seen.has(m.function)),unresolvedCalls:unresolved,truncated:remaining,status,warning:'Static candidate reachability; edge paths do not prove conditions, execution order, cancellation or release success'};
  })};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [analysisFile,queriesFile,outFile]=process.argv.slice(2);
  const result=phaseFocus(JSON.parse(fs.readFileSync(analysisFile,'utf8')),JSON.parse(fs.readFileSync(queriesFile,'utf8')));
  if(fs.existsSync(outFile))throw new Error('Do not overwrite phase evidence');
  writeJson(outFile,result);console.log(JSON.stringify({groups:result.groups.map(g=>({label:g.question.label,roots:g.roots.length,functions:g.functions.length,edges:g.edges.length}))}));
}
