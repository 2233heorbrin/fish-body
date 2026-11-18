// Local experimental evidence composition/query. No candidate imports or model calls.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {walk,writeJson,codeFile,packageInfo} from './io.mjs';
export const protocol='unified-spike-1';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const recipeFiles={initial:['scan.mjs','rules.mjs','io.mjs','unified.mjs','package.json'],deep:['morph-scan.mjs','morph-model.mjs','status.mjs','io.mjs','unified.mjs','package.json']};
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
const effective=(kind,a)=>kind==='deep'?{rules:a.metadata.rules,compilerOptions:a.metadata.compilerOptions,projectOptions:a.metadata.projectOptions,supplementalDeclarations:a.metadata.supplementalDeclarations,entryHostAssumption:a.metadata.entryHostAssumption}:{rules:a.metadata.ruleVersion,analyzers:a.metadata.analyzers};
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
function locationOf(value){return value.location||value.use||value.call||value.definitionCall||value.variable||null;}
function coordinate(value,kind){
  const l=locationOf(value);if(!l)return null;
  return {file:value.file||l.file,line:l.startLine||value.line||null,column:l.startColumn||null,endLine:l.endLine||null,
    unit:kind==='initial'?'UTF-8 byte offsets (ast-grep)':'UTF-16 code units (ts-morph)',original:l};
}
function summarize(r){
  return {id:r.id,originalId:r.originalId,localId:r.localId,idOrigin:r.idOrigin,run:r.run,kind:r.kind,layer:r.layer,file:r.coordinate?.file,line:r.coordinate?.line,coordinate:r.coordinate,
    label:r.label,status:statusSummary(r.status),compilerBoundary:r.kind==='wiring'?{receiverAny:r.detail.compilerReceiver.type.any,directMemberDeclarations:r.detail.compilerMember.declarations.length,attribution:r.detail.attribution}:r.kind==='method'?{calleeAny:r.detail.compilerCalleeType.any,interpretation:r.detail.confidence}:undefined,snippet:(r.detail.snippet||r.detail.location?.snippet||r.detail.use?.snippet||r.detail.call?.snippet||'').slice(0,220),
    raw:r.raw,links:r.links||[],more:'evidence '+r.id};
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
      for(const [key,kind,layer]of [['methodOwnership','method','syntax-trace-candidate'],['wiring','wiring','syntax-trace-candidate']])for(const [i,e]of a[key].entries())add(r,kind,e.id,e,layer,'/'+key+'/'+i,e.assessment||e.member);
      for(const [key,prefix,kind,layer]of [['functions','F','function','fact'],['edges','G','call','syntax-trace-candidate'],['constructions','C','construction','syntax-trace-candidate'],['effects','L','effect','syntax-trace-candidate'],['resources','R','resource','syntax-trace-candidate'],['mutations','S','state-write','fact'],['unresolvedCalls','U','unresolved-call','unknown'],['toolBodies','B','callback','syntax-trace-candidate']]){
        for(const [i,e]of a.phases[key].entries())add(r,kind,e.id||prefix+String(i+1).padStart(4,'0'),e,layer,'/phases/'+key+'/'+i,e.name||e.mechanism||kind);
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
export async function query(dirArg,command,options={}){
  const dir=path.resolve(dirArg),start=performance.now(),b=read(path.join(dir,'bundle.json')),validity=validateBundle(dir,b);
  let result={protocol,command,conditions:options,source:{path:b.source,bundle:dir,runs:b.runs.map(r=>({name:r.name,path:r.path,kind:r.kind,rule:r.metadata.rules||r.metadata.ruleVersion,versions:r.metadata.version||r.metadata.analyzers}))},validity};
  if(!validity.valid){result.state='invalid-no-analysis-rerun';}
  else{
    result.state=validity.runs.some(r=>r.completeness.mode==='diagnostic-partial')?'reused-diagnostic-partial':'reused-evidence-with-known-limits';
    let rows=[];
    if(command==='summary'){
      rows=[{source:b.source,scope:compareSource(b.source,path.join(b.runs[0].path,'source-snapshot')),records:b.records.length,capabilities:b.capabilities.length,warning:b.warning},...b.capabilities,...b.records.filter(r=>['configuration','unknown','ignored','failure'].includes(r.kind)).map(summarize)];
    }else if(command==='evidence'){
      const rec=b.records.find(r=>r.id===options.id);
      if(!rec)throw Error('Use exact namespaced ID; bare or unknown IDs are rejected');
      result.evidence={...summarize(rec),links:rec.links||[]};rows=parts(rec.detail);
    }else if(command==='file'){
      const line=options.line?Number(options.line):null;
      rows=b.records.filter(r=>r.coordinate?.file===options.file&&(!line||r.coordinate.line<=line&&(r.coordinate.original?.endLine||r.coordinate.line)>=line)).map(summarize);
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
            r.kind==='function'&&ids.has(r.originalId)||['call','unresolved-call'].includes(r.kind)&&ids.has(r.detail.from)||r.kind==='state-write'&&ids.has(r.detail.function)||r.kind==='wiring'&&ranges.some(f=>r.coordinate?.file===f.file&&r.coordinate.line>=f.startLine&&r.coordinate.line<=f.endLine)));
          rows.push(...scoped.map(summarize));
        }
      }
      if(command==='capability'){
        const caps=b.capabilities.filter(c=>c.name===options.name);
        for(const c of caps){
          const record=b.records.find(r=>r.id===c.id),t=record.detail;
          rows.push({id:c.id,layer:'interpretation',codeDependencyScope:t.codeDependencyScope,codeModules:t.codeModules,unknowns:t.unknowns,more:'evidence '+c.id});
          const prefix=record.run+'/';
          rows.push(...b.records.filter(r=>r.run===record.run&&(t.scopedEvidence.includes(r.originalId)||r.kind==='module'&&t.codeModules.includes(r.coordinate?.file))).map(summarize));
        }
      }
    }else throw Error('Commands: summary, evidence, file, capability, phase');
    result.page=paginate(rows,options);
  }
  result.elapsedMs=Math.round(performance.now()-start);
  // Return actual encoded size (stabilizes after the digit count settles).
  for(let i=0;i<3;i++)result.returnBytes=Buffer.byteLength(JSON.stringify(result)+'\n');
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
