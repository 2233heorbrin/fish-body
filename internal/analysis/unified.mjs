// Local experimental evidence composition/query. No candidate imports or model calls.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {walk,writeJson,codeFile,packageInfo} from './io.mjs';
export const protocol='unified-spike-1';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const recipeFiles={initial:['scan.mjs','rules.mjs','io.mjs','unified.mjs','package.json'],deep:['morph-scan.mjs','morph-model.mjs','rules.mjs','status.mjs','io.mjs','unified.mjs','package.json']};
const packageVersions=()=>Object.fromEntries(['dependency-cruiser','@ast-grep/cli','ts-morph','@ts-morph/common'].map(n=>[n,packageInfo(n).version]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function compareSource(a,b){
  try{
    const aa=walk(a),bb=walk(b);
    if(!same(aa,bb))return {equal:false,reason:'source-file-list-changed'};
    for(const f of aa)if(!fs.readFileSync(path.join(a,f)).equals(fs.readFileSync(path.join(b,f))))return {equal:false,reason:'source-bytes-changed',file:f};
    return {equal:true,files:aa.length,bytes:aa.reduce((n,f)=>n+fs.statSync(path.join(a,f)).size,0),method:'exact-byte-comparison; same scope as scanner walk (no symlinks/.git/node_modules/.cache)'};
  }catch(e){return {equal:false,reason:e.message}};
}
function recordCode(out,files){
  for(const f of files){const to=path.join(out,f);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(codeFile(f),to);}
}
function compareCode(out,files){return files.filter(f=>!fs.existsSync(path.join(out,f))||!fs.readFileSync(codeFile(f)).equals(fs.readFileSync(path.join(out,f))));}
const effective=(kind,a)=>kind==='deep'?{rules:a.metadata.rules,compilerOptions:a.metadata.compilerOptions,projectOptions:a.metadata.projectOptions,supplementalDeclarations:a.metadata.supplementalDeclarations,entryHostAssumption:a.metadata.entryHostAssumption,entryRules:a.metadata.entryRules}:{rules:a.metadata.ruleVersion,analyzers:a.metadata.analyzers};
function completeness(kind,a){
  if(kind==='initial')return {mode:a.failures.length?'diagnostic-partial':'evidence-with-known-limits',parseFailures:a.failures.length,incompleteRelations:0,completeRuntimeProof:false};
  const n=[...a.methodOwnership,...a.wiring,...a.phases.edges,...a.phases.unresolvedCalls,...a.phases.registrations,...a.phases.effects].filter(r=>r.status?.candidateSetComplete===false).length;
  return {mode:a.syntaxErrors.length||n?'diagnostic-partial':'evidence-with-known-limits',parseFailures:a.syntaxErrors.length,incompleteRelations:n,completeRuntimeProof:false};
}
export function validateRun(dir,source,expectedKind=null){
  try{
    const receipt=read(path.join(dir,'reuse.json')),a=read(path.join(dir,'analysis.json'));
    const reasons=[];
    if(fs.existsSync(path.join(dir,'failed.json')))reasons.push('failed-run-not-reusable');
    if(!Object.hasOwn(recipeFiles,receipt.kind))return {valid:false,reasons:['missing-or-unsupported-analysis-kind'],kind:receipt.kind??null};
    if(expectedKind!==null&&expectedKind!==receipt.kind)return {valid:false,reasons:['analysis-kind-mismatch: requested '+expectedKind+', saved '+receipt.kind+'; choose a new output'],kind:receipt.kind};
    if(receipt.protocol!==protocol)reasons.push('receipt-protocol-changed');
    const changed=compareCode(path.join(dir,'validity/code'),recipeFiles[receipt.kind]);
    if(changed.length)reasons.push('effective-rule-code-changed:'+changed.join(','));
    if(!same(receipt.versions,packageVersions()))reasons.push('analyzer-version-changed');
    if(!same(receipt.effective,effective(receipt.kind,a)))reasons.push('effective-config-or-result-metadata-changed');
    const content=compareSource(source,path.join(dir,'source-snapshot'));
    if(!content.equal)reasons.push(content.reason+(content.file?':'+content.file:''));
    return {valid:!reasons.length,reasons,content,kind:receipt.kind,completeness:completeness(receipt.kind,a)};
  }catch(e){return {valid:false,reasons:['missing-or-failed-result:'+e.message]};}
}
function log(dir,event){fs.appendFileSync(path.join(dir,'operations.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');}
export async function analyze(kind,sourceArg,outArg){
  if(!Object.hasOwn(recipeFiles,kind))throw Error('Unknown analyzer kind');
  const source=path.resolve(sourceArg),out=path.resolve(outArg),start=performance.now();
  if(fs.existsSync(out)){
    const validity=validateRun(out,source,kind);
    const result={action:'reuse',analyzerExecutions:0,elapsedMs:Math.round(performance.now()-start),out,validity};
    if(!validity.valid)throw Error('Existing result invalid; keep it and explicitly choose a fresh run: '+validity.reasons.join('; '));
    log(out,result);return result;
  }
  if(out===source||out.startsWith(source+path.sep))throw Error('Output must be outside source');
  fs.mkdirSync(out,{recursive:true});recordCode(path.join(out,'validity/code'),recipeFiles[kind]);
  try{
    if(kind==='initial'){const {scan}=await import('./scan.mjs');await scan(source,out);}
    else{const {morphScan}=await import('./morph-scan.mjs');await morphScan(source,out);}
    const a=read(path.join(out,'analysis.json'));
    if(compareCode(path.join(out,'validity/code'),recipeFiles[kind]).length)throw Error('Analyzer code changed during analysis');
    writeJson(path.join(out,'reuse.json'),{protocol,kind,source,versions:packageVersions(),effective:effective(kind,a),identity:'source-snapshot exact bytes + saved effective implementation/config; no path-only key'});
    const result={action:kind,analyzerExecutions:1,out,elapsedMs:Math.round(performance.now()-start),validity:validateRun(out,source,kind)};
    log(out,result);return result;
  }catch(e){writeJson(path.join(out,'failed.json'),{error:e.message});log(out,{action:kind,analyzerExecutions:1,failed:e.message,elapsedMs:Math.round(performance.now()-start)});throw e;}
}
const statusSummary=s=>s?{candidateSetComplete:s.candidateSetComplete!==false,conditional:!!s.conditional,multipleSources:!!s.multipleSources,unresolved:!!s.unresolved,
  uncertaintyCount:s.uncertainty?.length||0,truncationCount:s.truncations?.length||0,
  truncations:(s.truncations||[]).slice(0,2).map(({kind,location,limit,retained,total,observedAtLeast})=>({kind,file:location?.file,line:location?.startLine,limit,retained,total,observedAtLeast})),
  furtherStatusDetails:(s.truncations?.length||0)>2}:null;
// Shared ownership attribution (v2 §3.2). query and task consume the same helpers so the field keeps one meaning.
const OWNERSHIP_SCOPES=new Set(['direct','associated','background','unknown']);
const unknownOwnership=reason=>({scope:'unknown',basis:[],path:[],ambiguity:[],reason:reason||'ownership not established; no attribution invented'});
function normalizeOwnership(value,reason){
  if(!value||typeof value!=='object'||!OWNERSHIP_SCOPES.has(value.scope))return unknownOwnership(reason);
  return {scope:value.scope,
    basis:Array.isArray(value.basis)?value.basis.slice(0,8):[],
    path:Array.isArray(value.path)?value.path.slice(0,8):[],
    ambiguity:Array.isArray(value.ambiguity)?value.ambiguity.slice(0,8):[],
    reason:typeof value.reason==='string'?value.reason.slice(0,220):(reason||'ownership carried from producer verbatim')};
}
// Ambiguity is computed per run + evidence namespace; ids already carry the run prefix.
export function ownershipIndex(bundle){
  const byFunction=new Map();
  for(const r of bundle.records||[]){const fn=r.detail?.function;if(fn){if(!byFunction.has(fn))byFunction.set(fn,[]);byFunction.get(fn).push(r);}}
  // v2 §3.2: duplicate registration — one body function registered at more than one
  // definitionCall site. Registrations are keyed by run + coordinate, so the same site in
  // different runs is still a cross-run ambiguity rather than being silently collapsed.
  const registrationSites=new Map();
  for(const r of bundle.records||[]){
    if(r.kind!=='callback')continue;
    const body=r.detail?.body;if(!body)continue;
    const site=r.detail?.definitionCall;
    const key=(r.run||'')+'|'+(site?[site.file,site.startLine,site.startColumn].join(':'):'unknown-site');
    if(!registrationSites.has(body))registrationSites.set(body,new Set());
    registrationSites.get(body).add(key);
  }
  const idx=new Map();
  for(const r of bundle.records||[]){
    if(r.kind!=='entry-condition')continue;
    const fn=r.detail?.function??null,siblings=fn?(byFunction.get(fn)||[]):[],ambiguity=[];
    if(new Set(siblings.map(x=>x.coordinate?.file).filter(Boolean)).size>1)ambiguity.push('same-function-id-across-different-files:'+fn);
    if(new Set(siblings.map(x=>x.run).filter(Boolean)).size>1)ambiguity.push('same-function-id-across-different-runs:'+fn);
    if(fn&&(registrationSites.get(fn)?.size||0)>1)ambiguity.push('duplicate-toolBody-registration:'+fn);
    if(r.originalId){
      const same=(bundle.records||[]).filter(x=>x.kind==='entry-condition'&&x.originalId===r.originalId);
      if(new Set(same.map(x=>x.run)).size>1)ambiguity.push('same-entry-original-id-across-different-runs:'+r.originalId);
      if(same.length>1)ambiguity.push('multiple-sources-for-same-entry:'+r.originalId);
    }
    idx.set(r.id,{fn,file:r.coordinate?.file??null,ambiguity});
  }
  // Map toolBody name -> callback body function IDs. Capability scopedEvidence uses initial-run
  // IDs (E####), while entry conditions use deep function IDs (F####); the declaration name is
  // the only traceable bridge. Never hardcode a specific capability name or entry ID here.
  idx.bodyByName=new Map();
  for(const r of bundle.records||[]){
    if(r.kind!=='callback'||!r.detail?.name||!r.detail?.body)continue;
    const name=r.detail.name;
    if(!idx.bodyByName.has(name))idx.bodyByName.set(name,[]);
    idx.bodyByName.get(name).push({id:r.id,body:r.detail.body,
      file:r.coordinate?.file??r.detail?.definitionCall?.file??null,run:r.run});
  }
  // Directed call graph for ownership tracing. Real deep 'call' records come from
  // phases.edges and carry detail.from (caller function ID) and detail.to (callee function ID);
  // 'callee' is only a display string, never a function ID. Record-local call facts
  // (detail.relations.calls, traceable entry actionCandidates) are also real edges owned by
  // that record's function/body, so a chain may cross them. Module closure never adds an edge.
  idx.callEdges=new Map();
  const addCallEdge=(from,to)=>{
    if(!from||!to||from===to)return;
    if(!idx.callEdges.has(from))idx.callEdges.set(from,new Set());
    idx.callEdges.get(from).add(to);
  };
  for(const r of bundle.records||[]){
    if(r.kind==='call')addCallEdge(r.detail?.from,r.detail?.to);
    const owner=r.detail?.function??(r.kind==='callback'?r.detail?.body:null);
    if(!owner)continue;
    for(const x of r.detail?.relations?.calls||[]){
      const id=typeof x==='string'?x:(x?.functionId||x?.target||null);
      addCallEdge(owner,id);
    }
    for(const c of r.detail?.entry?.actionCandidates||[]){
      if(c?.relation==='traceable-call'&&c.target?.functionId)addCallEdge(owner,c.target.functionId);
    }
  }
  return idx;
}
// Bounded, cycle-safe reachability over the call graph. Returns the ordered path
// [start,...,target], or null when no real call chain connects the two functions.
const OWNERSHIP_TRACE_DEPTH=12;
function traceCallPath(index,startId,targetId){
  if(!startId||!targetId)return null;
  if(startId===targetId)return [startId];
  const queue=[[startId]],seen=new Set([startId]);
  while(queue.length){
    const p=queue.shift();
    if(p.length>=OWNERSHIP_TRACE_DEPTH)continue;
    for(const next of index?.callEdges?.get(p[p.length-1])||[]){
      if(next===targetId)return [...p,next];
      if(seen.has(next))continue;
      seen.add(next);queue.push([...p,next]);
    }
  }
  return null;
}
// A's ownership is carried verbatim. When absent, B derives only conservative attribution from
// locatable function identity, call edges and module closure; it never promotes a closure to direct.
export function ownershipOf(r,index,cap){
  const carried=r.detail?.ownership;
  if(carried&&OWNERSHIP_SCOPES.has(carried.scope)){
    const base=normalizeOwnership(carried),meta=index?.get(r.id);
    if(meta?.ambiguity?.length){
      base.ambiguity=[...new Set([...base.ambiguity,...meta.ambiguity])];
      if(base.scope==='direct'){base.scope='unknown';base.reason='Ambiguous declaration/source attribution; not direct: '+meta.ambiguity.join('; ');}
    }
    return base;
  }
  const meta=index?.get(r.id)||{},fn=r.detail?.function??null,file=r.coordinate?.file??null;
  const ambiguity=[...(meta.ambiguity||[])];
  // v2 §3.2: duplicate registration / cross-file / cross-run / multiple sources win over any
  // call edge or module match — never silently pick one body function.
  if(ambiguity.length)return {scope:'unknown',basis:[],path:[],ambiguity,
    reason:'Ambiguous declaration/source attribution (duplicate registration, cross-file or cross-run, or multiple sources); no single body function selected.'};
  const bodies=(cap?.name&&index?.bodyByName?.get(cap.name))||[];
  if(bodies.length>1&&new Set(bodies.map(b=>b.body)).size>1)
    return {scope:'unknown',basis:[],path:[],ambiguity:['multiple-body-functions-for-tool-name:'+cap.name],
      reason:'Same tool name maps to more than one callback body function; no single declaration selected.'};
  const locatedBodies=bodies.filter(b=>!cap?.file||!b.file||b.file===cap.file);
  // v2 §3.2 direct: the entry condition belongs to the callback body of the selected declaration.
  if(fn&&locatedBodies.length===1&&fn===locatedBodies[0].body&&file&&(!cap?.file||cap.file===file))
    return {scope:'direct',basis:['toolBody name maps to a unique callback body function ID','definitionCall file matches the selected declaration over the byte-identical source snapshot'],path:[fn],ambiguity:[],
      reason:'Entry condition belongs to the callback body of the selected declaration; module closure alone is never direct.'};
  const scoped=cap?.scopedEvidence||[],modules=cap?.codeModules||[];
  if(fn&&scoped.includes(fn)&&file&&cap?.file===file)
    return {scope:'direct',basis:['body function ID is in the selected declaration scopedEvidence','coordinate matches the initial declaration file over the byte-identical source snapshot'],path:[fn],ambiguity:[],
      reason:'Entry condition belongs to the selected body function; a module-closure file match alone is never a direct basis.'};
  // v3 fix: associated is only legitimate when there is a traceable call path FROM the
  // selected capability's body function (cap.name -> bodyByName -> body ID) TO this entry
  // condition's owning function. A record calling some other function on its own is a local
  // syntax fact, never capability ownership; a shared file/module closure cannot support it.
  const startBody=locatedBodies.length===1?locatedBodies[0].body:null;
  if(fn&&startBody){
    const callPath=traceCallPath(index,startBody,fn);
    if(callPath)return {scope:'associated',
      basis:['traceable call path from the selected capability body function to this entry condition function'],
      path:callPath.slice(0,8),ambiguity:[],
      reason:'Reachable from the selected body function through real call edges; module closure or a sibling local call is never an associated basis.'};
  }
  if(file&&modules.includes(file))
    return {scope:'background',basis:['linked to the capability only through codeModules import closure'],path:[file],ambiguity:[],
      reason:'Import closure is module background only, never direct evidence.'};
  return {scope:'unknown',basis:[],path:fn?[fn]:[],ambiguity:[],reason:'No locatable declaration/callback plus entry-function match; ownership left unknown.'};
}
function locationOf(value){return value.location||value.use||value.call||value.definitionCall||value.variable||null;}
function coordinate(value,kind){
  const l=locationOf(value);if(!l)return null;
  return {file:value.file||l.file,line:l.startLine||value.line||null,column:l.startColumn||null,endLine:l.endLine||null,
    unit:kind==='initial'?'UTF-8 byte offsets (ast-grep)':'UTF-16 code units (ts-morph)',original:l};
}
function summarize(r){
  const stored=r.detail.snippet||r.detail.location?.snippet||r.detail.use?.snippet||r.detail.call?.snippet||'';
  const storedSnippetTruncated=!!r.detail.snippetTruncated, summarySnippetTruncated=stored.length>220;
  return {id:r.id,originalId:r.originalId,localId:r.localId,idOrigin:r.idOrigin,run:r.run,kind:r.kind,layer:r.layer,file:r.coordinate?.file,line:r.coordinate?.line,coordinate:r.coordinate,
    label:r.label,status:statusSummary(r.status),compilerBoundary:r.kind==='wiring'?{receiverAny:r.detail.compilerReceiver.type.any,directMemberDeclarations:r.detail.compilerMember.declarations.length,attribution:r.detail.attribution}:r.kind==='method'?{calleeAny:r.detail.compilerCalleeType.any,interpretation:r.detail.confidence}:undefined,snippet:stored.slice(0,220),
    snippetTruncated:storedSnippetTruncated||summarySnippetTruncated,storedSnippetTruncated,summarySnippetTruncated,
    ...(r.detail.declaredDescription||r.detail.description?{descriptionOrigin:'author-declared; not verified runtime behavior'}:{}),
    sourceContext:r.coordinate?.file?{queryType:'file',queryOptions:{view:'source',file:r.coordinate.file,line:r.coordinate.line||1,offset:0,limit:5}}:undefined,
    raw:r.raw,links:r.links||[],more:'evidence '+r.id};
}
const SUM_LIMITS={comparisons:5,actionCandidates:5,earlyExits:5,support:4};
// Structured entry-condition row for capability/phase/entry-conditions: no longer relies on the 220-char snippet alone.
function summarizeEntryCondition(r,ctx={}){
  const e=r.detail.entry||{},gate=e.permissionGate||null,accepts=e.acceptsAction||null;
  const cut=(s,n)=>typeof s==='string'?s.slice(0,n):'';
  const loc=l=>l?{file:l.file??null,line:l.startLine??null,unit:l.positionUnit??null}:null;
  const exits=e.earlyExits||[],comps=e.comparisons||[],cands=e.actionCandidates||[];
  const trimmed=[];
  if(comps.length>SUM_LIMITS.comparisons)trimmed.push('comparisons');
  if(cands.length>SUM_LIMITS.actionCandidates)trimmed.push('actionCandidates');
  if(exits.length>SUM_LIMITS.earlyExits)trimmed.push('earlyExits');
  const supportCut=(r.detail.support?.extracted||[]).length>SUM_LIMITS.support||(r.detail.support?.notSupported||[]).length>SUM_LIMITS.support;
  if(supportCut)trimmed.push('support');
  const cmpRow=c=>({id:c.id??null,operator:c.operator??null,
    literal:c.literal?{value:c.literal.value??null,form:c.literal.form??null,side:c.literal.side??null,raw:cut(c.literal.raw,120)}:null,
    subject:c.subject?{text:cut(c.subject.text,120),kind:c.subject.kind??null}:null,
    coordinate:c.coordinate??null,equalsLiteral:c.equalsLiteral??null,status:c.status??null});
  const candRow=c=>({id:c.id??null,action:c.action??null,
    target:c.target?{functionId:c.target.functionId??null,entryLocation:c.target.entryLocation??null,location:loc(c.target.location)}:null,
    condition:c.condition??null,basis:(c.basis||[]).slice(0,4).map(x=>cut(x,160)),relation:c.relation??'unpaired-clue',
    uncertainty:(c.uncertainty||[]).slice(0,3).map(x=>cut(x,120)),status:c.status??'unknown'});
  const exitRow=x=>({action:x.action??null,expression:cut(x.expression,160),literalActions:(x.literalActions||[]).slice(0,6),
    expressionKind:x.expressionKind??null,location:loc(x.location),branch:x.branch??null,polarity:x.polarity??null});
  const row={id:r.id,originalId:r.originalId,kind:r.kind,layer:r.layer,run:r.run,file:r.coordinate?.file,line:r.coordinate?.line,
    coordinate:r.coordinate,label:r.label,status:statusSummary(r.status),ownership:ownershipOf(r,ctx.index,ctx.cap),
    entryCondition:{
      permissionGate:gate?{expression:cut(gate.expression,220),truncated:!!gate.truncated,location:loc(gate.location)}:null,
      comparisons:comps.slice(0,SUM_LIMITS.comparisons).map(cmpRow),
      actionCandidates:cands.slice(0,SUM_LIMITS.actionCandidates).map(candRow),
      acceptsAction:accepts?{action:cut(accepts.action,220),truncated:!!accepts.truncated,location:loc(accepts.location)}:null,
      earlyExits:exits.slice(0,SUM_LIMITS.earlyExits).map(exitRow),
      declaredDescription:typeof e.declaredDescription==='string'&&e.declaredDescription
        ?{text:cut(e.declaredDescription,220),origin:'author-declared; not verified runtime behavior'}:null},
    support:{extracted:(r.detail.support?.extracted||[]).slice(0,SUM_LIMITS.support),notSupported:(r.detail.support?.notSupported||[]).slice(0,SUM_LIMITS.support)},
    sourceContext:r.coordinate?.file?{queryType:'file',queryOptions:{view:'source',file:r.coordinate.file,line:r.coordinate.line||1,offset:0,limit:5}}:undefined,
    summaryTrimmed:trimmed.length?{fields:trimmed,reason:'summary budget; use entry-conditions --run <run> --scope <scope> for full enumeration'}:undefined,
    truncated:trimmed.length>0,
    raw:r.raw,more:'entry-conditions --run '+(r.run||'?')+' --scope all; evidence '+r.id};
  // Keep the paginate row budget without dropping the required fields. Record every drop as a real trim.
  const droppable=['comparisons','actionCandidates','earlyExits','support'];
  while(Buffer.byteLength(JSON.stringify(row))>6000&&droppable.length){
    const field=droppable.shift();
    if(field==='support'){if(row.support.extracted.length||row.support.notSupported.length){row.support={extracted:[],notSupported:[]};trimmed.push('support');row.truncated=true;}}
    else if(row.entryCondition[field]?.length){row.entryCondition[field]=[];trimmed.push(field);row.truncated=true;}
  }
  if(trimmed.length)row.summaryTrimmed={fields:[...new Set(trimmed)],reason:'summary budget; use entry-conditions --run <run> --scope <scope> for full enumeration'};
  return row;
}
export function compose(sourceArg,outArg,runs){
  const source=path.resolve(sourceArg),out=path.resolve(outArg);
  if(fs.existsSync(out))throw Error('Do not overwrite a bundle');
  const names=new Set();
  for(const r of runs){if(!/^[a-zA-Z0-9_-]+$/.test(r.name)||names.has(r.name))throw Error('Run names must be unique simple labels');names.add(r.name);r.path=path.resolve(r.path);r.validity=validateRun(r.path,source);if(!r.validity.valid)throw Error('Cannot merge mismatched/invalid source: '+JSON.stringify(r.validity));}
  const records=[],capabilities=[],deepRuns=[];
  function add(run,kind,local,detail,layer,pointer,label,status){
    const rec={id:run.name+'/'+local,originalId:detail.id||null,localId:local,idOrigin:detail.id?'retained-source-id':'adapter-local-id',run:run.name,kind,layer,label:label||kind,coordinate:coordinate(detail,run.kind),status:status||detail.status||null,raw:{file:path.join(run.path,'analysis.json'),pointer},detail};records.push(rec);return rec;
  }
  for(const r of runs){
    r.kind=r.validity.kind;const a=read(path.join(r.path,'analysis.json'));r.metadata=a.metadata;r.completeness=r.validity.completeness;
    const config=add(r,'configuration','CONFIG',read(path.join(r.path,'reuse.json')).effective,'fact','/effective','Effective owned configuration / rule version');
    config.raw={file:path.join(r.path,'reuse.json'),pointer:'/effective'};
    for(const [i,u]of a.unknowns.entries())add(r,'unknown','Q'+String(i+1).padStart(3,'0'),{message:u},'unknown','/unknowns/'+i,String(u).slice(0,180));
    for(const [i,u]of (a.ignored||[]).entries())add(r,'ignored','I'+String(i+1).padStart(3,'0'),u,'unknown','/ignored/'+i,'Outside analyzed syntax scope');
    if(r.kind==='initial'){
      for(const [i,e]of a.facts.evidence.entries())add(r,'observation',e.id,e,'fact','/facts/evidence/'+i,e.category);
      const tools=read(path.join(r.path,'tool-candidates.json'));
      for(const [i,t]of tools.entries()){
        const rec=add(r,'capability','T'+String(i+1).padStart(3,'0'),t,'interpretation',null,t.name);rec.raw={file:path.join(r.path,'tool-candidates.json'),pointer:'/'+i};
        capabilities.push({name:t.name,id:rec.id,evidence:r.name+'/'+t.evidence,file:t.file,line:t.line,scope:t.codeDependencyScope});
      }
      for(const [i,c]of a.interpretations.candidates.entries())add(r,'category-candidate','K'+String(i+1).padStart(3,'0'),c,'interpretation','/interpretations/candidates/'+i,c.label);
      for(const [i,f]of a.failures.entries())add(r,'failure','X'+String(i+1).padStart(3,'0'),f,'unknown','/failures/'+i,f.reason);
      const graph=read(path.join(r.path,'module-graph.json'));
      for(const [i,m]of (graph?.modules||[]).entries()){
        const rec=add(r,'module','N'+String(i+1).padStart(3,'0'),{...m,file:m.source},'fact',null,'module imports; NOT capability minimum');rec.raw={file:path.join(r.path,'module-graph.json'),pointer:'/modules/'+i};rec.coordinate={file:m.source,line:null,unit:'module path; no source offset'};
      }
    }else{
      deepRuns.push(r);
      for(const [key,kind,layer]of [['methodOwnership','method','syntax-trace-candidate'],['wiring','wiring','syntax-trace-candidate']])for(const [i,e]of (a[key]||[]).entries())add(r,kind,e.id,e,layer,'/'+key+'/'+i,e.assessment||e.member);
      for(const [key,prefix,kind,layer]of [['functions','F','function','fact'],['edges','G','call','syntax-trace-candidate'],['constructions','C','construction','syntax-trace-candidate'],['effects','L','effect','syntax-trace-candidate'],['resources','R','resource','syntax-trace-candidate'],['mutations','S','state-write','fact'],['unresolvedCalls','U','unresolved-call','unknown'],['toolBodies','B','callback','syntax-trace-candidate'],['entryConditions','H','entry-condition','syntax-trace-candidate']]){
        for(const [i,e]of (a.phases?.[key]||[]).entries()){
          // v2 §3.1: label prefers the first action candidate, then acceptsAction, then kind.
          // detail.ownership is carried verbatim; when absent B supplies only an unknown fallback.
          const label=kind==='entry-condition'
            ?(e.entry?.actionCandidates?.[0]?.action ?? e.entry?.acceptsAction?.action ?? e.label ?? kind)
            :(e.name||e.mechanism||kind);
          const rec=add(r,kind,e.id||prefix+String(i+1).padStart(4,'0'),e,layer,'/phases/'+key+'/'+i,label);
          if(kind==='entry-condition')rec.ownership=e.ownership&&OWNERSHIP_SCOPES.has(e.ownership.scope)?e.ownership:unknownOwnership('Producer did not supply detail.ownership; B does not invent attribution');
        }
      }
      for(const [i,d]of a.diagnostics.entries())add(r,'diagnostic','D'+String(i+1).padStart(4,'0'),d,'unknown','/diagnostics/'+i,String(d.code));
    }
  }
  const methods=records.filter(r=>r.kind==='method');
  const sourceTexts=new Map();
  function sameCallSpan(observation,method){
    if(observation.coordinate?.file!==method.coordinate?.file)return false;
    const file=method.coordinate.file;if(!sourceTexts.has(file))sourceTexts.set(file,fs.readFileSync(path.join(source,file),'utf8'));
    const text=sourceTexts.get(file),utf16=method.coordinate.original,bytes=observation.coordinate.original.byteRange;
    return !!bytes&&bytes.start===Buffer.byteLength(text.slice(0,utf16.start),'utf8')&&bytes.end===Buffer.byteLength(text.slice(0,utf16.end),'utf8');
  }
  for(const m of methods){
    const observations=records.filter(r=>r.kind==='observation'&&sameCallSpan(r,m));
    const prior=observations.filter(r=>r.label==='prompt-injection');
    if(prior.length&&m.detail.assessment==='local-definition-not-host-proof'){
      const conflict=m.status?.conditional||m.status?.multipleSources||m.status?.candidateSetComplete===false;
      records.push({id:m.run+'/revision-'+m.originalId,originalId:null,localId:'revision-'+m.originalId,idOrigin:'adapter-local-id',run:m.run,kind:conflict?'conflict':'revision',layer:'interpretation',label:conflict?'Unresolved attribution conflict':'Revise host-prompt attribution; keep syntax hit',coordinate:m.coordinate,status:m.status,links:[...prior.map(r=>r.id),m.id],raw:m.raw,
        detail:{retainedSyntaxObservations:prior.map(r=>r.id),definitionEvidence:m.id,alignment:'Exact span after UTF-16 to UTF-8 conversion in byte-identical source; original units retained',interpretation:conflict?'Uncertainty prevents choosing one attribution':'Compiler resolves a local method; the host-prompt interpretation needs revision',unknown:'Local definition does not prove absence of other brain-related behavior. No numeric confidence added.'}});
    }else if(m.detail.provenance.some(p=>p.steps.some(s=>['bind-alias','object-shorthand'].includes(s.kind)))||/\[['"]/.test(m.detail.expression)){
      records.push({id:m.run+'/supplement-'+m.originalId,originalId:null,localId:'supplement-'+m.originalId,idOrigin:'adapter-local-id',run:m.run,kind:'supplement',layer:'interpretation',label:'Additional provenance, not automatic classification',coordinate:m.coordinate,status:m.status,links:[m.id,...observations.map(r=>r.id)],raw:m.raw,
        detail:{method:m.id,initialAtSameLocation:observations.map(r=>r.id),meaning:'New alias/literal-property provenance; no initial hit does not prove absence',limits:m.detail.confidence}});
    }
  }
  fs.mkdirSync(out,{recursive:true});recordCode(path.join(out,'validity/code'),['unified.mjs','morph-focus.mjs','status.mjs','io.mjs']);
  const bundle={protocol,createdAt:new Date().toISOString(),source,runs,capabilities,deepRuns:deepRuns.map(r=>r.name),records,
    warning:'Facts, syntax-guided candidates and interpretations remain distinct. No safety, split approval, runtime execution or release proof. Module closures are overapproximations.'};
  writeJson(path.join(out,'bundle.json'),bundle);log(out,{action:'compose',analyzerExecutions:0,records:records.length});return {out,records:records.length,capabilities:capabilities.length};
}
function validateBundle(dir,b){
  const reasons=compareCode(path.join(dir,'validity/code'),['unified.mjs','morph-focus.mjs','status.mjs','io.mjs']).map(f=>'query-or-composition-code-changed:'+f);
  const runs=b.runs.map(r=>({name:r.name,...validateRun(r.path,b.source,r.kind)}));
  if(b.protocol!==protocol)reasons.push('bundle-protocol-changed');
  for(const r of runs)if(!r.valid)reasons.push(...r.reasons.map(x=>r.name+':'+x));
  return {valid:!reasons.length,reasons,runs:runs.map(({name,valid,completeness})=>({name,valid,completeness})),analyzerExecutions:0};
}
function parts(value,pointer=''){
  if(Buffer.byteLength(JSON.stringify(value))<=1800)return [{pointer,value}];
  if(typeof value==='string'){
    const chars=Array.from(value),out=[];for(let i=0;i<chars.length;i+=350)out.push({pointer,stringCharacterOffset:i,value:chars.slice(i,i+350).join(''),continued:i+350<chars.length});return out;
  }
  return Object.entries(value||{}).flatMap(([k,v])=>parts(v,pointer+'/'+k.replaceAll('~','~0').replaceAll('/','~1')));
}
function paginate(rows,options){
  const offset=Number(options.offset||0),limit=Number(options.limit||5);
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)throw Error('offset>=0 and limit=1..20 required');
  const items=[];let i=offset;
  for(;i<rows.length&&items.length<limit;i++){
    const row=rows[i];if(Buffer.byteLength(JSON.stringify(row))>6500)throw Error('Unbounded row; use evidence detail parts');
    if(items.length&&Buffer.byteLength(JSON.stringify([...items,row]))>10000)break;items.push(row);
  }
  return {offset,limit,total:rows.length,items,nextOffset:i<rows.length?i:null,hasMore:i<rows.length,bound:'max 20 rows / 10000 item bytes; details are paged JSON-pointer parts'};
}
// Explicit source view of an already validated run. No live source reads or candidate imports.
function sourcePage(b,options){
  const file=options.file;
  if(typeof file!=='string'||!file||/[\\:\0]/.test(file)||path.isAbsolute(file)||file.split('/').some(p=>!p||p==='.'||p==='..'))
    throw Error('Source view requires a canonical relative file from this analysis scope');
  const run=b.runs.find(r=>read(path.join(r.path,'inventory.json')).files.some(f=>f.file===file));
  if(!run)throw Error('Source file is outside this analysis inventory');
  const root=path.join(run.path,'source-snapshot'),target=path.join(root,file);
  // Reuse the scanner walk scope, including its link and ignored-directory exclusions.
  if(fs.lstatSync(root).isSymbolicLink()||!walk(root).includes(file)
    ||fs.realpathSync.native(target)!==path.join(fs.realpathSync.native(root),file))throw Error('Source reference escapes verified snapshot scope');
  const bytes=fs.readFileSync(target);
  if(bytes.includes(0))throw Error('Source view supports UTF-8 text only; binary material remains a source clue');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),split=text.split(/(\r\n|\n|\r)/);
  const lines=[];for(let i=0;i<split.length;i+=2)lines.push({text:split[i],ending:split[i+1]||''});
  let line=Number(options.line??1),offset=Number(options.offset??0);const limit=Number(options.limit??5);
  if(!Number.isSafeInteger(line)||line<1||line>lines.length||!Number.isSafeInteger(offset)||offset<0
    ||!Number.isInteger(limit)||limit<1||limit>20)throw Error('Source view requires line=1..totalLines, offset>=0, limit=1..20');
  if(offset>Array.from(lines[line-1].text).length)throw Error('Source offset exceeds the selected line');
  const items=[];
  while(line<=lines.length&&items.length<limit){
    const chars=Array.from(lines[line-1].text),end=Math.min(chars.length,offset+600),continued=end<chars.length;
    const item={file,line,column:offset+1,endColumn:end+1,text:chars.slice(offset,end).join(''),continued,
      ...(continued?{}:{lineEnding:lines[line-1].ending})};
    if(items.length&&Buffer.byteLength(JSON.stringify([...items,item]))>8000)break;
    items.push(item);
    if(continued)offset=end;else{line++;offset=0;}
  }
  const hasMore=line<=lines.length;
  return {context:{view:'source',file,run:run.name,origin:'verified source-snapshot',coordinateUnit:'1-based line/column; Unicode code points',
      evidenceId:null,boundary:'Source context only, not scanner evidence or reachability, runtime, minimum-dependency or safety proof'},
    page:{line:Number(options.line??1),offset:Number(options.offset??0),limit,totalLines:lines.length,items,hasMore,truncated:hasMore,
      nextLine:hasMore?line:null,nextOffset:hasMore?offset:null,
      bound:'max 20 segments / 8000 item bytes / 600 Unicode code points per segment; continue with both nextLine and nextOffset'}};
}
export async function query(dirArg,command,options={}){
  const dir=path.resolve(dirArg),start=performance.now(),b=read(path.join(dir,'bundle.json')),validity=validateBundle(dir,b);
  let result={protocol,command,conditions:options,analyzerExecutions:0,source:{path:b.source,bundle:dir,runs:b.runs.map(r=>({name:r.name,path:r.path,kind:r.kind,rule:r.metadata.rules||r.metadata.ruleVersion,versions:r.metadata.version||r.metadata.analyzers}))},validity};
  if(!validity.valid){result.state='invalid-no-analysis-rerun';}
  else{
    result.state=validity.runs.some(r=>r.completeness.mode==='diagnostic-partial')?'reused-diagnostic-partial':'reused-evidence-with-known-limits';
    if(options.view!==undefined&&(command!=='file'||options.view!=='source'))throw Error('view is only supported as file view=source; omit it for record queries');
    let rows=[];
    const ownership=ownershipIndex(b);
    if(command==='summary'){
      rows=[{source:b.source,scope:compareSource(b.source,path.join(b.runs[0].path,'source-snapshot')),records:b.records.length,capabilities:b.capabilities.length,
        entryConditions:b.records.filter(r=>r.kind==='entry-condition').length,warning:b.warning},...b.capabilities,...b.records.filter(r=>['configuration','unknown','ignored','failure'].includes(r.kind)).map(summarize)];
    }else if(command==='evidence'){
      const rec=b.records.find(r=>r.id===options.id);
      if(!rec)throw Error('Use exact namespaced ID; bare or unknown IDs are rejected');
      result.evidence={...summarize(rec),links:rec.links||[]};rows=parts(rec.detail);
    }else if(command==='file'){
      if(options.view==='source'){
        const source=sourcePage(b,options);result.sourceContext=source.context;result.page=source.page;
      }else{
        const line=options.line?Number(options.line):null;
        rows=b.records.filter(r=>r.coordinate?.file===options.file&&(!line||r.coordinate.line<=line&&(r.coordinate.original?.endLine||r.coordinate.line)>=line)).map(summarize);
      }
    }else if(command==='capability'||command==='phase'){
      if(command==='capability'&&!options.name)throw Error('capability requires --name');
      if(command==='phase'&&!options.function&&!options.stage)throw Error('phase requires --function or explicit --stage label and function');
      if(command==='phase'&&!options.function)throw Error('A phase label alone is not automatic discovery; provide --function and optionally --file');
      if(!b.deepRuns.length)rows=[{unknown:'No deep result. Explicitly run deep over the full source, then compose a fresh bundle; query never starts ts-morph.'}];
      else{
        const {phaseFocus}=await import('./morph-focus.mjs');
        for(const name of b.deepRuns){
          const run=b.runs.find(r=>r.name===name),a=read(path.join(run.path,'analysis.json'));
          const question=command==='capability'?{label:'User-selected capability question',tool:options.name}:{label:options.stage||'User-selected function question',file:options.file,name:options.function};
          const focus=phaseFocus(a,[question]).groups[0];
          result.question={...question,origin:'manual selector; not automatically inferred business phase'};
          rows.push({run:name,roots:focus.roots.map(r=>({id:name+'/'+r.id,name:r.name,file:r.location.file,line:r.location.startLine})),status:statusSummary(focus.status),traversalTruncated:focus.truncated,warning:focus.warning});
          const ids=new Set(focus.reachableFunctionIds),ranges=focus.functions.map(f=>f.location);
          const scoped=b.records.filter(r=>r.run===name&&(
            r.kind==='function'&&ids.has(r.originalId)||['call','unresolved-call'].includes(r.kind)&&ids.has(r.detail.from)||r.kind==='state-write'&&ids.has(r.detail.function)||r.kind==='wiring'&&ranges.some(f=>r.coordinate?.file===f.file&&r.coordinate.line>=f.startLine&&r.coordinate.line<=f.endLine)||r.kind==='entry-condition'&&(ids.has(r.detail.function)||ranges.some(f=>r.coordinate?.file===f.file&&r.coordinate.line>=f.startLine&&r.coordinate.line<=f.endLine))));
          rows.push(...scoped.map(r=>r.kind==='entry-condition'?summarizeEntryCondition(r,{index:ownership}):summarize(r)));
        }
      }
      if(command==='capability'){
        const caps=b.capabilities.filter(c=>c.name===options.name);
        for(const c of caps){
          const record=b.records.find(r=>r.id===c.id),t=record.detail;
          rows.push({id:c.id,layer:'interpretation',codeDependencyScope:t.codeDependencyScope,codeModules:t.codeModules,unknowns:t.unknowns,more:'evidence '+c.id});
          const prefix=record.run+'/';
          const capScoped=b.records.filter(r=>r.run===record.run&&(t.scopedEvidence.includes(r.originalId)||r.kind==='module'&&t.codeModules.includes(r.coordinate?.file)));
          const capCtx={id:c.id,name:c.name,file:c.file??record.coordinate?.file??null,codeModules:t.codeModules??[],scopedEvidence:t.scopedEvidence??[]};
          // Capability records belong to the initial run while entry-condition records belong to deep runs.
          // Surface them with explicit ownership so a codeModules match is visible as background, not direct.
          const capEntryConditions=b.records.filter(r=>r.kind==='entry-condition'&&(
            capCtx.scopedEvidence.includes(r.detail?.function)||capCtx.codeModules.includes(r.coordinate?.file)));
          rows.push(...[...capScoped,...capEntryConditions].map(r=>r.kind==='entry-condition'
            ?summarizeEntryCondition(r,{index:ownership,cap:capCtx}):summarize(r)));
        }
      }
      if(!b.records.some(r=>r.kind==='entry-condition'))rows.push({note:'no deep entry-condition evidence',
        meaning:'This bundle has no deep entry-condition records. Explicitly run deep with entryConditions support and compose a fresh bundle; no entry condition is fabricated here.'});
    }else if(command==='entry-conditions'){
      if(!options.run||!b.runs.some(r=>r.name===options.run))throw Error('entry-conditions requires --run with an existing run name');
      const scope=options.scope??'all';
      if(!['direct','associated','background','all'].includes(scope))throw Error('--scope must be direct|associated|background|all');
      if(options.name&&options.function)throw Error('Use either --name or --function, not both');
      const capMeta=options.name?b.capabilities.find(c=>c.name===options.name):null;
      if(options.name&&!capMeta)throw Error('Unknown capability name for --name');
      const capRecord=capMeta?b.records.find(r=>r.id===capMeta.id):null;
      const cap=capMeta?{id:capMeta.id,name:capMeta.name,file:capMeta.file??capRecord?.coordinate?.file??null,
        codeModules:capRecord?.detail?.codeModules??[],scopedEvidence:capRecord?.detail?.scopedEvidence??[]}:null;
      const fnIds=new Set();
      if(options.function){
        for(const f of b.records.filter(r=>r.kind==='function'&&r.detail?.name===options.function))fnIds.add(f.originalId||f.localId);
        if(!fnIds.size)throw Error('Unknown function name for --function');
      }
      const bucketCounts={direct:0,associated:0,background:0,unknown:0};
      const all=b.records.filter(r=>r.kind==='entry-condition'&&r.run===options.run);
      for(const r of all){
        const own=ownershipOf(r,ownership,cap);
        bucketCounts[own.scope]=(bucketCounts[own.scope]||0)+1;
        if(scope!=='all'&&own.scope!==scope)continue;
        if(cap){
          const relevant=(r.detail?.function&&cap.scopedEvidence.includes(r.detail.function))||(r.coordinate?.file&&cap.codeModules.includes(r.coordinate.file));
          if(!relevant)continue;
        }
        if(fnIds.size&&!fnIds.has(r.detail?.function))continue;
        rows.push(summarizeEntryCondition(r,{index:ownership,cap}));
      }
      rows.sort((x,y)=>String(x.id).localeCompare(String(y.id)));
      result.entryConditions={run:options.run,scope,name:options.name??null,function:options.function??null,
        matching:rows.length,omittedCandidates:all.length-rows.length,bucketCounts,
        behavior:'Explicit enumeration of already-composed entry-condition records; IDs retain their run namespace. No analysis started.'};
    }else throw Error('Commands: summary, evidence, file, capability, phase, entry-conditions');
    result.page??=paginate(rows,options);
  }
  result.elapsedMs=Math.round(performance.now()-start);
  // The paginate item cap does not include the fixed response envelope (source, validity,
  // conditions). If the whole result still exceeds the budget, drop trailing rows and make
  // them explicitly reachable through nextOffset instead of failing the whole query.
  for(let i=0;i<3;i++)result.returnBytes=Buffer.byteLength(JSON.stringify(result)+'\n');
  if(result.page?.items?.length){
    while(result.returnBytes>16000&&result.page.items.length){
      result.page.items.pop();
      result.page.hasMore=true;
      result.page.nextOffset=result.page.offset+result.page.items.length;
      result.page.truncated=true;
      result.page.summaryTrimmed={fields:['page.items'],reason:'response budget; continue with nextOffset'};
      for(let i=0;i<3;i++)result.returnBytes=Buffer.byteLength(JSON.stringify(result)+'\n');
    }
  }
  if(result.returnBytes>16000)throw Error('Response budget exceeded');
  log(dir,{action:'query',command,conditions:options,valid:validity.valid,state:result.state,analyzerExecutions:0,elapsedMs:result.elapsedMs,returnBytes:result.returnBytes});return result;
}
export async function runCLI(argv=process.argv.slice(2)){
  const [command,...args]=argv;
  let result;
  if(command==='scan'||command==='deep')result=await analyze(command==='scan'?'initial':'deep',args[0],args[1]);
  else if(command==='compose')result=compose(args[0],args[1],args.slice(2).map(s=>{const i=s.indexOf('=');if(i<1)throw Error('NAME=RUN required');return {name:s.slice(0,i),path:s.slice(i+1)};}));
  else{
    const [dir,...flags]=args,options={};for(let i=0;i<flags.length;i+=2){if(!flags[i].startsWith('--')||flags[i+1]===undefined)throw Error('Use --key value');options[flags[i].slice(2)]=flags[i+1];}
    result=await query(dir,command,options);
  }
  console.log(JSON.stringify(result));
  if(result.validity?.valid===false)process.exitCode=2;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runCLI();
