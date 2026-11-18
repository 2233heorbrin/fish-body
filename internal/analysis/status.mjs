export function provenanceStatus(results){
  return {candidateSetComplete:!results.some(x=>x.incomplete),conditional:results.some(x=>x.conditional),multipleSources:results.some(x=>x.multipleSources)||results.length>1,
    unresolved:results.some(x=>['unknown','parameter'].includes(x.kind)),
    uncertainty:[...new Map(results.flatMap(x=>x.uncertainty||[]).map(x=>[JSON.stringify(x),x])).values()],
    truncations:[...new Map(results.flatMap(x=>x.truncations||[]).map(x=>[JSON.stringify(x),x])).values()],
    warning:'Syntactic alternatives/conditions only; no control-flow reachability or runtime completeness proof'};
}
