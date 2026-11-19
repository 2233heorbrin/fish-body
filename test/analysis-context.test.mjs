// Packed production interfaces only. Synthetic source is parsed, never imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const install=process.env.FISH_TEST_INSTALL_ROOT,work=process.env.FISH_CONTEXT_TEST_ROOT;
if(!install||!work||fs.existsSync(work))throw Error('Use the actual extracted package and a fresh FISH_CONTEXT_TEST_ROOT');
const load=f=>import(pathToFileURL(path.join(install,'node_modules/fish-body',f)));
const {fishHandToolDefinition,createHandler}=await load('internal/backend/fish-body-approval.mjs');
const gate=await load('internal/backend/lib/body-switch.mjs');
const {findRecordDirectory}=await load('internal/analysis/records.mjs');
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const json=(file,value)=>write(file,JSON.stringify(value,null,2));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const root=work+'/body',profile=work+'/profile',source=work+'/candidate',marker=work+'/EXECUTED';
const select=on=>json(profile+'/package.json',{dependencies:{'fish-body':'file:test'},dsh:{profile:{bundles:on?['fish-body']:[]}}});
select(true);
const privateFile=root+'/鱼的大脑/private.txt';write(privateFile,'PRIVATE_SENTINEL');
json(source+'/package.json',{name:'context-fixture',displayName:'上下文合成插件',version:'1.0.0',type:'module',scripts:{prepare:'node trap.cjs'}});
write(source+'/trap.cjs',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`);
write(source+'/catalog.js',`export const actions={action_x:{accepted:false},action_y:{accepted:true}};\n`);
const entry=`import './trap.cjs';
import { actions } from './catalog.js';
const defineTool=(name,description,params,inject,execute)=>({name,execute});
export function apply(ctx){
 const store={approvalCount(){},fatigueValue(){},rewardAdd(){},unrelatedMemory(){}};
 ${Array.from({length:28},(_,i)=>`store.unrelatedMemory(${i});`).join('\n ')}
 ctx.tools.register(defineTool('generic_entry',${JSON.stringify('作者声称支持 action_x；'.repeat(140))},{},[],async({action})=>{
   const selected=actions[action];
   if(!selected || !selected.accepted) return {ok:false,reason:'entry rejects action'};
   const count=store.approvalCount();
   if(store.fatigueValue()>50) return {ok:false,reason:'fatigue gate'};
   store.rewardAdd(1);
   return {ok:true,count,fatigue:store.fatigueValue()};
 }));
 ctx.tools.register(defineTool('alternate_entry','另一入口接受 action_x',{},[],({action})=>action==='action_x'?{ok:true}:{ok:false}));
 ctx.systemPrompt.section('local','background persona');
}
`;
write(source+'/入口.js',entry);
const longLine='/*'+ '中😀文'.repeat(5000)+'*/';
write(source+'/长行.js',longLine+'\r\nexport const 下一行=1;\r\n');
write(source+'/.cache/ignored.js','OUTSIDE_WALK_SCOPE');
write(source+'/binary.bin',Buffer.from([0,255,1]));
const outside=work+'/outside';write(outside+'/secret.js','OUTSIDE_SENTINEL');
fs.symlinkSync(outside,source+'/linked','junction');
const config={frameworkRoot:root,profileDir:profile},tool=fishHandToolDefinition({bodySwitch:config}),handler=createHandler({bodySwitch:config});
const calls=[];
const loads=()=>process.env.FISH_ANALYSIS_LOAD_LOG&&fs.existsSync(process.env.FISH_ANALYSIS_LOAD_LOG)?fs.readFileSync(process.env.FISH_ANALYSIS_LOAD_LOG,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
async function invoke(args,t=tool){
 const before=loads().length;
 try{const value=await t.execute(args);calls.push({args,value});assert(Buffer.byteLength(JSON.stringify(value))<=16000);return value;}
 finally{if(args.action!=='analyze')assert.equal(loads().length,before,'queries/tasks must not load analyzers');}
}
async function call(args){const v=await invoke(args);assert(v.ok,JSON.stringify(v));return v.result;}
let analysis,task,cap,bundle;
const query=(file,options={})=>call({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{file,...options}});
const taskCall=(op,args={})=>call({action:'task',taskOperation:op,...args});
const patch=async value=>task=await taskCall('update',{taskId:task.taskId,expectedRevision:task.revision,taskPatch:value});
const dependencies=async()=>{
 const rows=[];let offset=0;
 do{const r=await taskCall('read',{taskId:task.taskId,taskView:'dependencies',taskOptions:{offset,limit:20}});rows.push(...r.page.items);offset=r.page.nextOffset;}while(offset!==null);
 return rows;
};
const origin={kind:'current-model',actor:'synthetic-model-fixture',reason:'Synthetic attribution, not a real model judgment'};
let analysisCount=0;

test('source view recovers catalog and hidden entry guard; record view and author/truncation boundaries remain',async()=>{
 analysis=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'local',path:source}});analysisCount+=analysis.analyzerExecutions;assert.equal(analysisCount,1);
 const dir=findRecordDirectory(root+'/鱼的胃/分析','analysis',analysis.analysisId);bundle=read(dir+'/bundle/bundle.json');
 cap=bundle.records.find(r=>r.kind==='capability'&&r.label==='generic_entry');assert(cap);
 const declaration=bundle.records.find(r=>r.originalId===cap.detail.evidence&&r.run===cap.run);
 assert(declaration.detail.snippetTruncated);assert(!declaration.detail.snippet.includes('!selected.accepted'));
 const detail=await call({action:'query',analysisId:analysis.analysisId,queryType:'evidence',queryOptions:{id:declaration.id,limit:20}});
 assert.equal(detail.evidence.storedSnippetTruncated,true);assert.equal(detail.evidence.summarySnippetTruncated,true);
 assert.equal(detail.evidence.descriptionOrigin,'author-declared; not verified runtime behavior');
 const hinted=await call({action:'query',analysisId:analysis.analysisId,...detail.evidence.sourceContext});assert.equal(hinted.sourceContext.view,'source');assert(hinted.page.items.length);
 const old=await query('catalog.js');assert(old.page.items.some(r=>r.kind==='module'));assert(!old.sourceContext);assert(old.page.items.every(r=>!Object.hasOwn(r,'text')));
 const catalog=await query('catalog.js',{view:'source',limit:1});assert(catalog.page.items[0].text.includes('accepted:false'));
 assert.equal(catalog.sourceContext.analysisId,analysis.analysisId);assert.equal(catalog.sourceContext.evidenceId,null);
 const guardLine=entry.split('\n').findIndex(l=>l.includes('!selected.accepted'))+1;
 const guard=await query('入口.js',{view:'source',line:guardLine,limit:1});assert(guard.page.items[0].text.includes('return {ok:false'));
 const altLine=entry.split('\n').findIndex(l=>l.includes("'alternate_entry'"))+1;
 const alt=await query('入口.js',{view:'source',line:altLine,limit:1});assert(alt.page.items[0].text.includes("action==='action_x'?{ok:true}"));
 for(const r of [catalog,guard,alt]){assert.equal(r.analyzerExecutions,0);assert(r.validity.valid);assert.equal(r.validity.runs[0].completeness.completeRuntimeProof,false);}
 json(work+'/source-conflict.json',{declaration:detail.evidence,catalog,guard,alternate:alt,notRuntimeAcceptance:true});
});

test('long Unicode line resumes within budget with exact coordinates and no lost text',async()=>{
 let line=1,offset=0,text='',pages=0,previous=null;
 do{
  const q=await query('长行.js',{view:'source',line,offset,limit:20}),p=q.page;pages++;
  assert.equal(q.analyzerExecutions,0);assert.equal(p.truncated,p.hasMore);assert(p.items.length>0);assert(Buffer.byteLength(JSON.stringify(q))<=16000);
  for(const row of p.items){assert.equal(Array.from(row.text).length,row.endColumn-row.column);text+=row.text+(row.lineEnding??'');}
  if(!p.hasMore)break;
  const next=[p.nextLine,p.nextOffset];assert.notDeepEqual(next,[line,offset]);previous=next;[line,offset]=next;
  assert(pages<100);
 }while(true);
 assert(pages>2);assert(previous);assert.equal(text,fs.readFileSync(source+'/长行.js','utf8'));
 json(work+'/unicode-pagination.json',{pages,characters:Array.from(text).length,exact:true,analyzerExecutions:0});
});

test('dependency groups prioritize scoped observations and preserve decisions, references, explanations and old outputs',async()=>{
 task=await taskCall('create',{analysisId:analysis.analysisId,taskMode:'compatibility'});await patch({selected:[cap.id]});
 let ds=await dependencies();assert.equal(ds.length,6);const state=ds.find(d=>d.kind==='shared-state-initialization');
 assert.equal(state.scope.direct.observed,4);assert.equal(state.scope.background.observed,28);assert.equal(state.scope.necessity,'unproven');
 const defaultRefs=state.evidenceRefs.map(id=>bundle.records.find(r=>r.id===id));
 assert(defaultRefs.some(r=>r.detail.callee==='store.rewardAdd'));assert(defaultRefs.some(r=>r.detail.callee==='store.fatigueValue'));
 assert(defaultRefs.filter(r=>r.detail.callee?.includes('unrelatedMemory')).length<state.scope.background.observed);
 assert(state.scope.direct.examples.every(e=>defaultRefs.some(r=>r.id===e.id)));
 assert(state.scope.background.examples.every(e=>!state.scope.direct.examples.some(d=>d.id===e.id)));
 assert.equal(state.scope.direct.referenced,4);assert.equal(state.scope.background.referenced,4);assert.equal(state.scope.referenced,8);assert(state.scope.truncated);
 const incidental=ds.find(d=>d.kind==='incidental-behavior');assert.equal(incidental.scope.direct.observed,0);assert.equal(incidental.scope.background.observed,1);
 const extra=bundle.records.find(r=>r.kind==='observation'&&!state.evidenceRefs.includes(r.id));assert(extra);
 const saved={id:state.id,decision:'narrow',rationale:'Discuss mixed responsibilities; do not keep or delete the whole object',origin,evidenceRefs:[extra.id],proposedChange:'Later separate fatigue/reward and keep approval counting',businessSemanticChange:'yes'};
 await patch({dependencyDecisions:[saved],classification:{value:'mixed',origin,evidenceRefs:[cap.id]}});
 task=await taskCall('produce',{taskId:task.taskId,expectedRevision:task.revision});const output=task.outputs.at(-1),old=fs.readFileSync(output.path);
 const explanation={origin,goal:'Synthetic scope discussion',recommendation:'Review gate conflict before claiming action support; discuss fatigue independently of controls',retained:[{capabilityId:cap.id,reason:'selected for synthetic verification',evidenceRefs:[cap.id]}],evidenceRefs:[cap.id]};
 await patch({explanation});const revision=task.revision;assert.equal(task.explanationState,'current');assert.equal(task.confirmation,null);
 const viaHttp=await handler(new Request('http://localhost/api/fish-hand/task',{method:'POST',body:JSON.stringify({taskOperation:'read',taskId:task.taskId})}));
 assert.deepEqual((await viaHttp.json()).result.explanation,task.explanation);assert.equal(task.revision,revision);
 for(const p of [{mode:'reverse'},{classification:{value:'unknown',origin,evidenceRefs:[]}},{unknowns:[{text:'Retain pending behavior tradeoffs',origin,evidenceRefs:[]}]},{dependencyDecisions:[{id:ds[0].id,decision:'retain',rationale:'Edit another dependency',origin}]}]){
  await patch(p);const kept=(await dependencies()).find(d=>d.id===state.id);for(const k of ['decision','rationale','evidenceRefs','proposedChange','businessSemanticChange'])assert.deepEqual(kept[k],saved[k]);
  assert.deepEqual(kept.origin,{...origin,attribution:'caller-declared, not identity authentication'});
  assert.equal(task.explanationState,'stale');assert.equal(task.confirmation,null);assert(old.equals(fs.readFileSync(output.path)));
 }
 await patch({dependencyDecisions:[{...saved,evidenceRefs:[]}]});let d=(await dependencies()).find(d=>d.id===state.id);assert.deepEqual(d.evidenceRefs,[]);assert.equal(d.scope.referenced,0);assert.equal(d.scope.direct.referenced,0);
 await patch({dependencyDecisions:[{...saved,evidenceRefs:[cap.id]}]});assert.deepEqual((await dependencies()).find(d=>d.id===state.id).evidenceRefs,[cap.id]);
 await assert.rejects(patch({dependencyDecisions:[{...saved,evidenceRefs:['other-run/E0001']}]}),/Unknown evidence/);
 // Old stored task without new metadata remains readable; only the response gets refreshed scope.
 const td=findRecordDirectory(root+'/鱼的胃/任务','task',task.taskId),doc=read(td+'/task.json');for(const d of doc.dependencies){delete d.scope.direct;delete d.scope.background;}
 json(td+'/task.json',doc);const oldTask=fs.readFileSync(td+'/task.json');ds=await dependencies();assert(ds[0].scope.direct);assert(oldTask.equals(fs.readFileSync(td+'/task.json')));
 await patch({addCapabilities:[{name:'Synthetic added capability',category:'unknown',origin,evidenceRefs:[cap.id]}]});
 const extraCapability=(await taskCall('read',{taskId:task.taskId,taskView:'capabilities',taskOptions:{limit:20}})).page.items.find(c=>c.id.startsWith('supplement/'));
 await patch({selected:[cap.id,extraCapability.id]});const supplemented=(await dependencies()).find(d=>d.capabilityId===extraCapability.id);
 assert.equal(supplemented.scope.direct.observed,0);assert(!supplemented.scope.more.direct.queryOptions);assert.deepEqual(supplemented.evidenceRefs.slice(0,1),[cap.id]);
 await patch({selected:[cap.id]});assert.deepEqual((await dependencies()).find(d=>d.id===state.id).evidenceRefs,[cap.id]);
 json(work+'/dependency-scope.json',{dependencies:ds,historyUnchanged:true,syntheticExplanationOnly:true,confirmation:null});
});

test('canonical scoped files only; invalid paths, ignored files, links and binary text refuse without scans',async()=>{
 for(const file of ['../outside/secret.js',source+'/入口.js','入口.js/../catalog.js','./catalog.js','catalog.js:stream','\\\\server\\file','linked/secret.js','.cache/ignored.js','new-not-scanned.js'])
  await assert.rejects(query(file,{view:'source'}),/relative|inventory|scope/);
 await assert.rejects(query('binary.bin',{view:'source'}),/UTF-8/);
 await assert.rejects(query('catalog.js',{view:'source',line:0}),/line=/);
 await assert.rejects(query('catalog.js',{view:'source',offset:99999}),/offset exceeds/);
 await assert.rejects(call({action:'query',analysisId:analysis.analysisId,queryType:'evidence',queryOptions:{view:'source',id:cap.id}}),/view is only/);
 const dir=findRecordDirectory(root+'/鱼的胃/分析','analysis',analysis.analysisId),snapshot=dir+'/run/source-snapshot/catalog.js',saved=fs.readFileSync(snapshot);
 write(snapshot,saved.toString().replace('false','true '));let invalid=await invoke({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'catalog.js'}});assert.equal(invalid.ok,false);assert(!invalid.result.page);write(snapshot,saved);
 const target=dir+'/run/source-snapshot/linked-copy';fs.symlinkSync(outside,target,'junction');
 await assert.rejects(query('linked-copy/secret.js',{view:'source'}),/inventory/);
 // A junction at an originally scanned location must not expose the target either.
 const snapshotFile=dir+'/run/source-snapshot/入口.js',original=fs.readFileSync(snapshotFile);fs.renameSync(snapshotFile,snapshotFile+'.held');fs.symlinkSync(outside+'/secret.js',snapshotFile,'file');
 invalid=await invoke({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'入口.js'}});assert.equal(invalid.ok,false);fs.unlinkSync(snapshotFile);fs.renameSync(snapshotFile+'.held',snapshotFile);assert(original.equals(fs.readFileSync(snapshotFile)));
});

test('source/Profile/binding/off/closing boundaries hold and no candidate or private state executes',async()=>{
 const original=fs.readFileSync(source+'/catalog.js');write(source+'/catalog.js',original.toString().replace('false','true '));
 const invalid=await invoke({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'catalog.js'}});assert.equal(invalid.ok,false);assert.equal(invalid.result.analyzerExecutions,0);write(source+'/catalog.js',original);
 const other=work+'/other-profile';json(other+'/package.json',read(profile+'/package.json'));
 await assert.rejects(invoke({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'catalog.js'}},fishHandToolDefinition({bodySwitch:{...config,profileDir:other}})),/PROFILE_MISMATCH/);
 const binding=profile+'/binding.json';json(binding,{root});const routes=new Map();
 const {apply}=await load('internal/backend/fish-body-approval.mjs');apply({effect:fn=>fn(),connection:{fetch:{register:r=>{routes.set(r.path,r.fetch);return()=>{}}}}},{...config,dataBindingPath:binding});json(binding,{root:outside});
 const response=await routes.get('/api/fish-hand/analysis')(new Request('http://localhost/api/fish-hand/analysis',{method:'POST',body:JSON.stringify({action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'catalog.js'}})}));assert.equal(response.status,409);assert.match((await response.json()).error,/ROOT_RELOAD_REQUIRED/);
 const args={action:'query',analysisId:analysis.analysisId,queryType:'file',queryOptions:{view:'source',file:'catalog.js'}};
 select(false);assert.equal((await invoke(args)).result.phase,'off');select(true);
 let release;const pending=gate.withBodyOperation(profile,()=>new Promise(r=>release=r)),closing=gate.runBodySwitchChange({profileDir:profile,enabled:false,operation:()=>select(false)});
 assert.equal((await invoke(args)).result.phase,'closing');release();await pending;await closing;select(true);assert.equal(gate.activeOperationCount(profile),0);
 assert(!fs.existsSync(marker));assert.equal(fs.readFileSync(privateFile,'utf8'),'PRIVATE_SENTINEL');
});

test('legacy direct-ID analysis/task paths, rebind reset and historic output remain valid',async()=>{
 const {analyze,compose}=await load('internal/analysis/unified.mjs'),{pathIdentity}=await load('internal/backend/lib/path-identity.mjs');
 const id=randomUUID(),dir=root+'/鱼的胃/分析/'+id,run=await analyze('initial',source,dir+'/run');analysisCount+=run.analyzerExecutions;assert(run.validity.valid);
 compose(source,dir+'/bundle',[{name:'initial',path:dir+'/run'}]);
 const current=findRecordDirectory(root+'/鱼的胃/分析','analysis',analysis.analysisId),rec=read(current+'/record.json');
 json(dir+'/record.json',{analysisId:id,profile:pathIdentity(profile),kind:'initial',source:rec.source,status:'ready',bundle:'bundle',createdAt:new Date().toISOString()});
 const q=await call({action:'query',analysisId:id,queryType:'file',queryOptions:{view:'source',file:'catalog.js',limit:1}});assert(q.page.items[0].text.includes('accepted:false'));
 const td=findRecordDirectory(root+'/鱼的胃/任务','task',task.taskId),direct=root+'/鱼的胃/任务/'+task.taskId;fs.renameSync(td,direct);
 const doc=read(direct+'/task.json'),outputBytes=fs.readFileSync(direct+'/'+doc.outputs[0].file);await patch({analysisId:id});assert.deepEqual(task.selected,[]);assert.equal(task.judgment,null);assert.equal(task.confirmation,null);assert.equal(task.explanationState,'stale');assert.deepEqual(await dependencies(),[]);
 const taskDoc=read(direct+'/task.json');assert.equal(taskDoc.analysisId,id);assert(outputBytes.equals(fs.readFileSync(direct+'/'+doc.outputs[0].file)));
 const listed=await taskCall('list',{taskView:'analyses',taskOptions:{limit:20}});assert(listed.page.items.some(r=>r.id===id));assert(listed.page.items.some(r=>r.id===analysis.analysisId));
 assert.equal(analysisCount,2);assert.equal(loads().filter(r=>r.url.endsWith('/morph-scan.mjs')).length,0);
 json(work+'/results.json',{calls,analysisCount,realSourceScans:0,deep:0,candidateExecutions:0,syntheticExplanationsOnly:true,analyzerLoads:loads()});
});

test('fixed request content validation precedes source reads, including same-length edits',async()=>{
 const {collectFromArchive}=await load('internal/backend/lib/upstream.mjs');
 const rice=work+'/rice',repo=rice+'/仓库',commit='b'.repeat(40);
 json(repo+'/package.json',{name:'fixed-context-fixture',version:'1.0.0'});write(repo+'/entry.js',"defineTool('fixed_entry','fixed',{},[],()=>1)");write(repo+'/.cache/ignored.txt','fixed');
 const collected=collectFromArchive({repoDir:repo,commit,sourceEntry:{downloadMethod:'codeload-tar',repoDir:repo,head:commit}});
 json(rice+'/来源.json',{pinnedCommit:commit,contentHash:collected.treeHash});json(rice+'/内容清单.json',{pinnedCommit:commit,treeHash:collected.treeHash,files:collected.files});
 json(root+'/鱼的手/插件注册表/requests/context-fixed.json',{id:'context-fixed',targetProfile:profile,rice:{dir:rice},source:{pinnedCommit:commit,contentHash:collected.treeHash}});
 const a=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'request',requestId:'context-fixed'}});analysisCount+=a.analyzerExecutions;
 const args={action:'query',analysisId:a.analysisId,queryType:'file',queryOptions:{view:'source',file:'entry.js',limit:1}};
 assert((await call(args)).page.items[0].text.endsWith('()=>1)'));
 const original=fs.readFileSync(repo+'/entry.js');write(repo+'/entry.js',original.toString().replace('()=>1','()=>2'));
 await assert.rejects(invoke(args),/FIXED_SOURCE_CHANGED/);write(repo+'/entry.js',original);
 write(repo+'/.cache/ignored.txt','drift');await assert.rejects(invoke(args),/FIXED_SOURCE_CHANGED/);write(repo+'/.cache/ignored.txt','fixed');
 const dir=findRecordDirectory(root+'/鱼的胃/分析','analysis',a.analysisId),snapshot=dir+'/run/source-snapshot/entry.js';write(snapshot,original.toString().replace('()=>1','()=>2'));
 await assert.rejects(invoke(args),/FIXED_SOURCE_CHANGED/);write(snapshot,original);assert((await call(args)).validity.valid);
 assert.equal(analysisCount,3);assert(!fs.existsSync(marker));
 json(work+'/results.json',{calls,analysisCount,realSourceScans:0,deep:0,candidateExecutions:0,privateSentinelUnchanged:fs.readFileSync(privateFile,'utf8')==='PRIVATE_SENTINEL',syntheticExplanationsOnly:true,analyzerLoads:loads()});
});
