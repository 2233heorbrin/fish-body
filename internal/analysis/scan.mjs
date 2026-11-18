import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { cruise } from 'dependency-cruiser';
import { moduleRoot, walk, writeJson, packageInfo, astBinary } from './io.mjs';
import { languages, classifyCall, ruleDocuments, ruleVersion } from './rules.mjs';
export const nativeBinary=astBinary();
const relative=(root,file)=>path.relative(root,file).split(path.sep).join('/');
const packageVersion=name=>packageInfo(name).version;
function runAst(args) {
  const r=spawnSync(nativeBinary,args,{cwd:moduleRoot,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
  if(r.error||![0,1].includes(r.status))throw new Error(`ast-grep ${r.status}: ${r.error?.message||r.stderr}`);
  return {status:r.status,stderr:r.stderr,matches:JSON.parse(r.stdout||'[]')};
}
function graphOf(raw) {
  const modules=raw.modules||[],reverse={};
  const edges=modules.flatMap(m=>(m.dependencies||[]).map(d=>{
    (reverse[d.resolved]??=[]).push(m.source);
    return {from:m.source,to:d.resolved,request:d.module,types:d.dependencyTypes,core:d.coreModule||false,unresolved:d.couldNotResolve||false,followed:d.followable,circular:d.circular||false,cycle:d.cycle};
  }));
  return {modules,edges,reverse,cycles:edges.filter(e=>e.circular),external:edges.filter(e=>e.core||e.unresolved||!e.request?.startsWith('.')),unresolved:edges.filter(e=>e.unresolved)};
}
export async function scan(sourceArg,outArg) {
  const started=performance.now(),source=path.resolve(sourceArg),out=path.resolve(outArg);
  if(out===source||out.startsWith(source+path.sep))throw new Error('Output must be outside candidate source');
  if(fs.existsSync(path.join(out,'source-snapshot')))throw new Error('Existing scan; select a new output directory');
  fs.mkdirSync(out,{recursive:true});
  const files=walk(source),snapshot=path.join(out,'source-snapshot'),snapshotId=path.basename(out);
  const inventory=files.map(file=>{
    const bytes=fs.readFileSync(path.join(source,file)),copy=path.join(snapshot,file);
    fs.mkdirSync(path.dirname(copy),{recursive:true});fs.writeFileSync(copy,bytes);
    if(!bytes.equals(fs.readFileSync(copy)))throw new Error(`Snapshot mismatch: ${file}`);
    return {file,bytes:bytes.length,language:languages[path.extname(file)]?.[0]||null,exactSnapshotCopy:true};
  });
  writeJson(path.join(out,'inventory.json'),{snapshotId,source,snapshot,versionBinding:'Retained source-snapshot plus exact byte comparison, not an upstream commit claim',files:inventory});
  const failures=[],ignored=[],evidence=[],astRuns=[],callSites=[],config=path.join(out,'sgconfig.yml');
  fs.writeFileSync(config,'ruleDirs: []\n');
  const grouped=new Map();
  for(const f of inventory) {
    const descriptor=languages[path.extname(f.file)];
    if(!descriptor){ignored.push({file:f.file,reason:'No configured syntax/dependency analyzer for this material'});continue;}
    const [language,kind]=descriptor;
    if(!grouped.has(language))grouped.set(language,{kind,files:[]});
    grouped.get(language).files.push(path.join(snapshot,f.file));
  }
  for(const [language,{kind,files:inputs}]of grouped) {
    try {
      const r=runAst(['scan','--config',config,'--inline-rules',ruleDocuments(language,kind),'--json=compact',...inputs]);
      writeJson(path.join(out,`ast-${language}.json`),r.matches);
      astRuns.push({language,status:r.status,stderr:r.stderr,inputCount:inputs.length,matches:r.matches.length});
      r.matches.sort((a,b)=>a.file.localeCompare(b.file)||a.range.byteOffset.start-b.range.byteOffset.start||a.ruleId.localeCompare(b.ruleId));
      for(const match of r.matches) {
        const file=relative(snapshot,path.resolve(match.file));
        const base={file,snapshotId,sourceCopy:path.join(snapshot,file),location:{startLine:match.range.start.line+1,startColumn:match.range.start.column+1,endLine:match.range.end.line+1,endColumn:match.range.end.column+1,byteRange:match.range.byteOffset},locator:`ast-grep:${language}:${match.ruleId}`,snippet:match.text.slice(0,1400),snippetTruncated:match.text.length>1400};
        if(match.ruleId==='parse-error'){failures.push({...base,reason:'Tree-sitter ERROR node; incomplete parse, no absence conclusions'});continue;}
        if(match.ruleId==='calls')callSites.push({file,range:match.range.byteOffset,line:base.location.startLine,callee:match.text.slice(0,match.text.indexOf('(')).trim()});
        const literal=name=>{
          const raw=match.metaVariables?.single?.[name]?.text;
          return raw&&/^(['"]).*\1$/s.test(raw)?raw.slice(1,-1):null;
        };
        const observations=match.ruleId==='inject'?[{category:'declared-services'}]:match.ruleId==='tool-declaration'?[{category:'tool-declaration',declaredName:literal('NAME'),declaredDescription:literal('DESCRIPTION')}]:classifyCall(match.text,language);
        for(const o of observations)if(o.category==='dynamic-import')o.argumentMode=/^import\(\s*['"]/.test(match.text)?'static-string':'computed-or-other; target unknown';
        for(const observation of observations)evidence.push({id:`E${String(evidence.length+1).padStart(4,'0')}`,...base,...observation,level:'syntax-observation'});
      }
    }catch(error){failures.push({language,files:inputs.map(f=>relative(snapshot,f)),reason:error.message});}
  }
  let graph=null,raw=null;
  const jsFiles=inventory.filter(f=>/\.(?:[cm]?js|tsx?)$/.test(f.file)).map(f=>f.file);
  if(jsFiles.length){
    const previous=process.cwd();
    try {
      process.chdir(snapshot);
      // Explicit owned options. No candidate config/webpack/babel/tsconfig extractors.
      const r=await cruise(jsFiles,{outputType:'json',doNotFollow:{path:'(?:^|/)node_modules/'},exclude:{path:'(?:^|/)node_modules/'},tsPreCompilationDeps:false},{},{});
      raw=typeof r.output==='string'?JSON.parse(r.output):r.output;
      writeJson(path.join(out,'dependency-cruiser.json'),raw);graph=graphOf(raw);
    }catch(error){failures.push({analyzer:'dependency-cruiser',reason:error.stack});}
    finally{process.chdir(previous);}
  }
  writeJson(path.join(out,'module-graph.json'),graph);
  const closure=file=>{
    const seen=new Set(),pending=[file];
    while(pending.length){const f=pending.pop();if(seen.has(f))continue;seen.add(f);for(const edge of graph?.edges||[])if(edge.from===f&&!edge.core&&!edge.unresolved)pending.push(edge.to);}
    return [...seen].sort();
  };
  const toolCandidates=evidence.filter(e=>e.category==='tool-declaration').map(e=>({
    name:e.declaredName||'unknown',description:e.declaredDescription,evidence:e.id,file:e.file,line:e.location.startLine,
    codeDependencyScope:'Module-level transitive overapproximation, not the minimal dependencies of this tool',codeModules:closure(e.file),
    implementationCalls:[...new Set(callSites.filter(c=>c.file===e.file&&c.range.start>e.location.byteRange.start&&c.range.end<=e.location.byteRange.end).map(c=>c.callee))],
    scopedEvidence:evidence.filter(c=>c.file===e.file&&c.id!==e.id&&c.location.byteRange.start>e.location.byteRange.start&&c.location.byteRange.end<=e.location.byteRange.end).map(c=>c.id),
    unknowns:['Tool registration is wrapped; declaration alone does not prove activation','Injected services belong to the whole plugin, not automatically to this selected tool','Shared closure parameters and effects need semantic review; no safe split approval']
  }));
  writeJson(path.join(out,'tool-candidates.json'),toolCandidates);
  const byCategory={};for(const e of evidence)(byCategory[e.category]??=[]).push(e.id);
  const candidates=[];
  const candidate=(id,label,categories,splitObstacles)=>{
    const ids=categories.flatMap(c=>byCategory[c]||[]);
    if(ids.length)candidates.push({id,label,evidence:ids,confidence:'requires semantic review',splitObstacles});
  };
  candidate('tools','Tool entry points',['tool-registration','tool-definition'],['Wrapper/handler ownership unresolved','Selecting a tool must not implicitly retain prompt or capture hooks']);
  candidate('prompt','Prompt contribution',['prompt-injection'],['Content and config gates need source review','Must not implicitly enable with a selected tool']);
  candidate('state','State interactions (not automatically brain memory)',['state-access'],['Cache, conversation memory and policy require semantic distinction','Reader/writer and path ownership not solved by imports']);
  candidate('background','Background work and routes',['listener','timer','route','lifecycle'],['Lifetime clues do not prove disposal order','Service and feature gates require review']);
  candidate('external','External programs and resources',['process','external-resource'],['Computed paths/arguments unresolved','No external program or resource request executed']);
  const typeCandidate=byCategory['tool-registration']?.length&&byCategory['prompt-injection']?.length?'mixed-candidate':byCategory['prompt-injection']?.length?'brain-candidate':'unknown';
  const coupling={
    codeDependencies:{file:'module-graph.json',meaning:'Import edges, not complete capability dependencies'},
    runtimeServices:evidence.filter(e=>e.category==='declared-services').map(e=>({evidence:e.id,declaration:e.snippet})),
    sharedData:evidence.filter(e=>e.category==='state-access').map(e=>({evidence:e.id,file:e.file,callee:e.callee,meaning:'Syntactic receiver only; object/alias ownership unresolved'})),
    sideEffects:evidence.filter(e=>['listener','timer','route','process','prompt-injection','lifecycle'].includes(e.category)).map(e=>({evidence:e.id,category:e.category,file:e.file}))
  };
  const unknowns=[
    'No-hit does not mean absence: wrappers, aliases, computed properties, reflection and parser failures can hide behavior.',
    'No executable candidate build/webpack/babel/tsconfig/plugin configuration loaded. Aliases needing them remain unresolved.',
    'No symbol/reference or control/data-flow resolution; an imported module is not capability ownership proof.',
    'External Python/PowerShell programs, files, services, credentials and paths are clues only; no candidate run.',
    'No rewriting, extraction, compatible split, independent plugin generation or runtime validation implemented.',
    'Packed/transformed sources retain current coordinates; original source mapping not reconstructed.',
    ...failures.map(f=>`Incomplete analysis: ${f.file||f.language||f.analyzer}: ${f.reason}`),
    ...(graph?.unresolved||[]).map(e=>`Unresolved module ${e.from} -> ${e.request}`)
  ];
  const vr=spawnSync(nativeBinary,['--version'],{encoding:'utf8',windowsHide:true});
  if(vr.status!==0)throw new Error(`Cannot run analyzer: ${vr.stderr||vr.error}`);
  for(const f of inventory)if(!fs.readFileSync(path.join(source,f.file)).equals(fs.readFileSync(path.join(snapshot,f.file))))throw new Error(`Source changed while scanning: ${f.file}`);
  const metadata={recordedAt:new Date().toISOString(),runtime:{execPath:process.execPath,node:process.version,electron:process.versions.electron||null},analyzers:{dependencyCruiser:{version:packageVersion('dependency-cruiser'),path:packageInfo('dependency-cruiser').dir},astGrep:{version:vr.stdout.trim(),path:nativeBinary}},ruleVersion,source,snapshot,snapshotId,scope:{files:inventory.length,bytes:inventory.reduce((n,f)=>n+f.bytes,0),syntaxFiles:inventory.filter(f=>f.language).length,dependencyInputs:jsFiles.length,ignored:ignored.length},elapsedMs:Math.round(performance.now()-started)};
  const analysis={metadata,facts:{inventory:'inventory.json',evidence,graph:'module-graph.json',coupling},interpretations:{typeCandidate,candidates,toolCandidates:'tool-candidates.json',warning:'Candidates, not final business conclusions or safe split approval'},unknowns,failures,ignored,astRuns};
  writeJson(path.join(out,'analysis.json'),analysis);
  for(const e of evidence)writeJson(path.join(out,'evidence',`${e.id}.json`),e);
  writeJson(path.join(out,'evidence-index.json'),evidence.map(({id,category,file,location,locator})=>({id,category,file,line:location.startLine,locator,detail:`evidence/${id}.json`})));
  writeJson(path.join(out,'reading-index.json'),{snapshotId,groups:Object.entries(byCategory).map(([category,ids])=>({category,count:ids.length,examples:ids.slice(0,3).map(id=>{const e=evidence.find(e=>e.id===id);return {id,file:e.file,line:e.location.startLine,detail:`evidence/${id}.json`};})})),tools:toolCandidates.map(c=>({name:c.name,evidence:c.evidence,file:c.file,line:c.line})),details:'Select IDs using evidence-index.json; each evidence/*.json is independently readable. No need to inject full raw AST or analysis.json.'});
  const summary=[`# Analysis reading packet`,`Snapshot: ${snapshotId} (retained exact source copy)`,`Files ${metadata.scope.files}, bytes ${metadata.scope.bytes}; syntax ${metadata.scope.syntaxFiles}; dependency inputs ${jsFiles.length}; elapsed ${metadata.elapsedMs} ms.`,`Analyzers: dependency-cruiser ${metadata.analyzers.dependencyCruiser.version}; ${metadata.analyzers.astGrep.version}; rules ${ruleVersion}.`,`Type: ${typeCandidate} (candidate only).`,...candidates.map(c=>`- ${c.id}: ${c.label}; ${c.evidence.length} observations; first IDs ${c.evidence.slice(0,5).join(', ')}.`),`Declared tool candidates: ${toolCandidates.map(c=>c.name).join(', ')||'not resolved'}.`,'',`Read reading-index.json, tool-candidates.json and selected evidence/ID.json; follow only corresponding source-snapshot ranges. Supplement module-graph.json with runtime services, shared data and side effects.`,`Check feature gates, wrappers, ownership and external requirements before proposing a split. Separate program facts from interpretation.`,`Failures ${failures.length}; unresolved dependencies ${graph?.unresolved.length??'unknown'}.`,...unknowns.slice(0,6).map(u=>`- ${u}`),`DSH conversation receipt: unknown. No model call; manually readable packet only.`].join('\n')+'\n';
  fs.writeFileSync(path.join(out,'dsh-summary.md'),summary);
  writeJson(path.join(out,'measurements.json'),{...metadata,summaryBytes:Buffer.byteLength(summary),readingIndexBytes:fs.statSync(path.join(out,'reading-index.json')).size,toolCandidatesBytes:fs.statSync(path.join(out,'tool-candidates.json')).size,evidenceDetailBytes:evidence.map(e=>({id:e.id,bytes:fs.statSync(path.join(out,'evidence',`${e.id}.json`)).size})),indexBytes:fs.statSync(path.join(out,'evidence-index.json')).size,analysisBytes:fs.statSync(path.join(out,'analysis.json')).size,rawDependencyBytes:raw?fs.statSync(path.join(out,'dependency-cruiser.json')).size:0,tokenUsage:null,reason:'No model request or usage receipt; byte sizes are not token savings'});
  return {out,metadata,evidence:evidence.length,typeCandidate,failures:failures.length,unresolved:graph?.unresolved.length??null};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [source,out]=process.argv.slice(2);if(!source||!out)throw new Error('scan.mjs SOURCE OUT');
  console.log(JSON.stringify(await scan(source,out)));
}
