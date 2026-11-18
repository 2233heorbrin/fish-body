import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const install=process.env.FISH_TEST_INSTALL_ROOT, work=process.env.FISH_TASK_TEST_ROOT;
if(!install||!work||fs.existsSync(work))throw Error('Provide installed package and fresh FISH_TASK_TEST_ROOT');
const pkg=path.join(install,'node_modules/fish-body');
const load=f=>import(pathToFileURL(path.join(pkg,f)));
const {fishHandToolDefinition,createHandler}=await load('internal/backend/fish-body-approval.mjs');
const phase=await load('internal/backend/lib/body-switch.mjs');
const {findRecordDirectory,recordEntries,directoryLabel,sourcePlugin}=await load('internal/analysis/records.mjs');
const analysisDir=id=>findRecordDirectory(root+'/鱼的胃/分析','analysis',id);
const write=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,v)};
const json=(f,v)=>write(f,JSON.stringify(v,null,2));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const root=path.join(work,'root'),profile=path.join(work,'profile'),source=path.join(work,'source'),marker=path.join(work,'EXECUTED');
const select=on=>json(profile+'/package.json',{dependencies:{'fish-body':'file:test'},dsh:{profile:{bundles:on?['fish-body']:[]}}});select(true);
const brain=root+'/鱼的大脑/人格/private.txt';write(brain,'PRIVATE_SENTINEL');
json(source+'/package.json',{name:'synthetic-mixed',displayName:'合成混合插件',version:'1.0.0',type:'module',scripts:{prepare:'node trap.cjs'}});
write(source+'/trap.cjs',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'trap')`);
write(source+'/index.js',`import './trap.cjs';
export function apply(ctx){
 const store={get(){return 1}};
 const defineTool=(name,description,p,r,execute)=>({name,execute});
 ctx.tools.register(defineTool('selected_tool','synthetic',{},[],()=>store.get()));
 ctx.systemPrompt.section('plugin-private','synthetic');
 ctx.effect(()=>()=>store.get());
}
`);
const config={frameworkRoot:root,profileDir:profile},tool=fishHandToolDefinition({bodySwitch:config,getOrch(){throw Error('must not install')}}),handler=createHandler({bodySwitch:config});
const calls=[];
async function call(args,t=tool){const v=await t.execute(args);assert(v.ok,JSON.stringify(v));assert(Buffer.byteLength(JSON.stringify(v))<=16000);calls.push({args,value:v});return v.result;}
const task=(op,args={})=>call({action:'task',taskOperation:op,...args});
const origin={kind:'user',actor:'synthetic-test-user',reason:'Synthetic attribution only; not real acceptance'};
let analysis,t,compat,reverse,sharedDeep;
async function rest(args){const response=await handler(new Request('http://localhost/api/fish-hand/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}));return {code:response.status,value:await response.json()};}
const update=async patch=>t=await task('update',{taskId:t.taskId,expectedRevision:t.revision,taskPatch:patch});
async function outputAll(){const rows=[];let offset=0;do{const r=await task('output',{taskId:t.taskId,taskOptions:{offset,limit:20}});rows.push(...r.page.items);offset=r.page.nextOffset;}while(offset!==null);return rows;}
test('task flows from actual packed analysis through shared HTTP/tool state',async()=>{
 analysis=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'local',path:source}});
 t=await task('create',{analysisId:analysis.analysisId,taskMode:'compatibility'});assert.equal(t.classification.value,'mixed');assert.equal(t.judgment,null);
 const caps=await task('read',{taskId:t.taskId,taskView:'capabilities'});const selected=caps.page.items.find(c=>c.name==='selected_tool');assert(selected);
 await update({selected:[selected.id],classification:{value:'mixed',origin,evidenceRefs:t.classification.evidenceRefs}});
 const deps=await task('read',{taskId:t.taskId,taskView:'dependencies',taskOptions:{limit:20}});assert.equal(deps.page.total,6);
 await update({dependencyDecisions:[{id:deps.page.items[0].id,decision:'retain',rationale:'Retain declared handler pending shared-state review',origin}]});
 const r=await rest({taskOperation:'read',taskId:t.taskId});assert.equal(r.value.result.revision,t.revision);assert.deepEqual(r.value.result.selected,t.selected);
 const r2=await rest({taskOperation:'update',taskId:t.taskId,expectedRevision:t.revision,taskPatch:{unknowns:[{text:'Store and prompt scope need actual human discussion',origin,evidenceRefs:[]}]}});assert.equal(r2.code,200);t=await task('read',{taskId:t.taskId});assert.equal(t.revision,r2.value.result.revision);
 t=await task('produce',{taskId:t.taskId,expectedRevision:t.revision});compat=read(t.outputs.at(-1).path);assert.equal(compat.kind,'compatibility-plan');assert.equal(compat.installable,false);assert.equal(compat.derivedIdentity.nativeSwitches,1);assert.equal(compat.derivedIdentity.name,'synthetic-mixed');assert(!compat.fragments);
 t=await task('confirm',{taskId:t.taskId,expectedRevision:t.revision,taskConfirmation:origin});assert.equal(t.confirmation.revision,t.revision);assert.equal(t.phase,'confirmed-with-open-questions');
 const old=t.revision;await update({mode:'reverse'});assert.equal(t.confirmation,null);assert.equal(t.outputs[0].revision,old);
 t=await task('produce',{taskId:t.taskId,expectedRevision:t.revision});reverse=read(t.outputs.at(-1).path);assert.equal(reverse.kind,'reverse-materials');assert.equal(reverse.runnablePlugin,false);assert(reverse.fragments.some(f=>f.content.includes('selected_tool')));
 const bundle=read(analysisDir(analysis.analysisId)+'/bundle/bundle.json');
 for(const f of reverse.fragments.filter(f=>f.content)){const actual=fs.readFileSync(source+'/'+f.file,'utf8').split(/\r?\n/).slice(f.startLine-1,f.endLine).join('\n');assert.equal(f.content,actual);assert(f.evidenceRefs.length);
   for(const id of f.evidenceRefs){const r=bundle.records.find(r=>r.id===id),coord=r.coordinate?.file?r.coordinate:{file:r.detail.file,line:r.detail.line};assert.equal(coord.file,f.file);assert(coord.line>=f.startLine&&coord.line<=f.endLine,'Fragment evidence must point at its actual source range');}
 }
 const rows=await outputAll();assert(rows.some(r=>r.pointer.includes('fragments')));assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(brain,'utf8'),'PRIVATE_SENTINEL');
});
test('dependency evidence survives unrelated updates, explicit replacement and analysis rebind',async()=>{
 let x=await task('create',{analysisId:analysis.analysisId,taskMode:'compatibility'});
 const step=async p=>x=await task('update',{taskId:x.taskId,expectedRevision:x.revision,taskPatch:p});
 const rows=async()=> (await task('read',{taskId:x.taskId,taskView:'dependencies',taskOptions:{limit:20}})).page.items;
 const caps=(await task('read',{taskId:x.taskId,taskView:'capabilities'})).page.items;
 await step({selected:[caps.find(c=>c.name==='selected_tool').id]});
 const ds=await rows(),d=ds[0],bundle=read(analysisDir(analysis.analysisId)+'/bundle/bundle.json');
 const extra=bundle.records.find(r=>!d.evidenceRefs.includes(r.id));assert(extra,'Need real evidence outside default candidate set');
 const decision={id:d.id,decision:'narrow',rationale:'Synthetic decision with supplementary source evidence',origin,evidenceRefs:[extra.id],proposedChange:'Discuss narrower registration',businessSemanticChange:'unknown'};
 await step({dependencyDecisions:[decision],classification:{value:'mixed',origin,evidenceRefs:[]}});
 x=await task('produce',{taskId:x.taskId,expectedRevision:x.revision});const old=fs.readFileSync(x.outputs[0].path);
 x=await task('confirm',{taskId:x.taskId,expectedRevision:x.revision,taskConfirmation:origin});
 const snapshots=[];
 for(const patch of [{mode:'reverse'},{classification:{value:'unknown',origin,evidenceRefs:[]}},{unknowns:[{text:'Keep extra evidence while discussing',origin,evidenceRefs:[]}]},{dependencyDecisions:[{id:ds[1].id,decision:'pending',rationale:'Edit a different dependency',origin}]}]){
   await step(patch);const kept=(await rows()).find(r=>r.id===d.id);assert.deepEqual(kept.evidenceRefs,[extra.id]);assert.equal(kept.decision,'narrow');assert.equal(kept.rationale,decision.rationale);assert.deepEqual(kept.origin.kind,origin.kind);assert.equal(kept.proposedChange,decision.proposedChange);assert.equal(x.confirmation,null);snapshots.push({patch,kept});
 }
 await step({dependencyDecisions:[{...decision,evidenceRefs:[]}]});assert.deepEqual((await rows())[0].evidenceRefs,[]);
 await step({mode:'compatibility'});assert.deepEqual((await rows())[0].evidenceRefs,[],'Explicit empty refs must not repopulate');
 await step({dependencyDecisions:[decision]});
 await assert.rejects(step({dependencyDecisions:[{...decision,evidenceRefs:['not-an-evidence-id']}]}),/Unknown evidence ID/);
 sharedDeep=await call({action:'analyze',analysisType:'deep',analysisSource:{kind:'local',path:source},initialAnalysisId:analysis.analysisId});
 assert.equal(sharedDeep.initialAnalysisId,analysis.analysisId);
 const db=read(analysisDir(sharedDeep.analysisId)+'/bundle/bundle.json'),foreign=db.records.find(r=>r.id.startsWith('deep/'));assert(foreign);
 await assert.rejects(step({dependencyDecisions:[{...decision,evidenceRefs:[foreign.id]}]}),/Unknown evidence ID/);
 assert.deepEqual((await rows())[0].evidenceRefs,[extra.id]);
 const metadata=await task('list',{taskView:'analyses',taskOptions:{limit:20}});assert.equal(metadata.page.items.find(r=>r.id===analysis.analysisId).kind,'initial');assert.equal(metadata.page.items.find(r=>r.id===sharedDeep.analysisId).kind,'deep');assert.equal(metadata.page.items.find(r=>r.id===sharedDeep.analysisId).initialAnalysisId,analysis.analysisId);
 await assert.rejects(call({action:'analyze',analysisType:'deep',analysisSource:{kind:'local',path:source},initialAnalysisId:sharedDeep.analysisId}),/valid initial/);
 await step({analysisId:sharedDeep.analysisId});assert.equal(x.judgment,null);assert.deepEqual(x.selected,[]);assert.deepEqual(await rows(),[]);assert(old.equals(fs.readFileSync(x.outputs[0].path)));
 json(work+'/evidence-preservation.json',{defaultRefs:d.evidenceRefs,supplementalRef:extra.id,snapshots,explicitRemoval:[],foreignRejected:foreign.id,analysisReset:x,oldOutputUnchanged:true});
});
test('readable current-model explanation shares state, validates references and expires with plan changes',async()=>{
 let x=await task('create',{analysisId:analysis.analysisId,taskMode:'compatibility'});
 const step=async p=>x=await task('update',{taskId:x.taskId,expectedRevision:x.revision,taskPatch:p});
 const cs=(await task('read',{taskId:x.taskId,taskView:'capabilities',taskOptions:{limit:20}})).page.items;
 const c=cs.find(c=>c.name==='selected_tool'), excluded=cs.find(row=>row.id!==c.id);
 await step({selected:[c.id],classification:{value:'mixed',origin,evidenceRefs:[]}});
 const ds=(await task('read',{taskId:x.taskId,taskView:'dependencies'})).page.items;
 const model={kind:'current-model',actor:'合成说明夹具（非真实模型）',reason:'仅验证页面及持久化，不代表真实讨论'};
 const explanation={origin:model,goal:'合成目标：保留选定工具，讨论共享状态的影响',recommendation:'建议先保留工具入口，核对共享状态与提示贡献后再决定范围。',
   retained:[{capabilityId:c.id,label:'合成工具说明',reason:'与合成目标对应',evidenceRefs:c.evidenceRefs}],
   excluded:excluded?[{capabilityId:excluded.id,reason:'尚未选择，待讨论',evidenceRefs:[]}]:[],
   impacts:[{dependencyId:ds[1].id,text:'共享状态范围可能影响启动与隔离，需要核对。',evidenceRefs:ds[1].evidenceRefs}],
   questions:[{text:'是否需要保留提示贡献带来的行为？',dependencyId:ds[4].id}],
   nextSteps:['讨论依赖取舍','后续另行适配与验证，当前不安装'],evidenceRefs:c.evidenceRefs};
 const revision=x.revision;
 await step({explanation});assert.equal(x.revision,revision);assert.equal(x.explanation.origin.kind,'current-model');assert.equal(x.explanationState,'current');
 const viaHttp=await rest({taskOperation:'read',taskId:x.taskId});assert.deepEqual(viaHttp.value.result.explanation,x.explanation);
 assert.match(tool.description,/自然语言/);assert.match(x.conversation.prompt,/解释/);
 x=await task('produce',{taskId:x.taskId,expectedRevision:x.revision});const artifactBytes=fs.readFileSync(x.outputs.at(-1).path);
 assert.equal(read(x.outputs.at(-1).path).explanation.goal,explanation.goal);
 x=await task('confirm',{taskId:x.taskId,expectedRevision:x.revision,taskConfirmation:origin});const confirmation=x.confirmation;
 await step({explanation:{...explanation,recommendation:'合成修订说明，仍针对相同方案。'}});
 assert.equal(x.revision,revision);assert.deepEqual(x.confirmation,confirmation);assert(artifactBytes.equals(fs.readFileSync(x.outputs.at(-1).path)));
 for(const bad of [{...explanation,origin},{...explanation,evidenceRefs:['deep/not-current']},{...explanation,retained:[{capabilityId:excluded?.id||'invalid',reason:'invalid'}]},{...explanation,impacts:[{dependencyId:'foreign',text:'invalid'}]}])
   await assert.rejects(step({explanation:bad}),/current-model|Unknown evidence|不一致|之外/);
 const states=[];
 for(const patch of [{mode:'reverse'},{classification:{value:'unknown',origin,evidenceRefs:[]}},{dependencyDecisions:[{id:ds[0].id,decision:'narrow',rationale:'Synthetic narrowing',origin}]},{selected:[]}]){
   await step(patch);assert.equal(x.explanation,null);assert.equal(x.explanationState,'stale');assert.equal(x.confirmation,null);states.push({patch,revision:x.revision,state:x.explanationState});
   if(patch.selected) await step({selected:[c.id]});
   await step({explanation});assert.equal(x.explanationState,'current');
 }
 await step({analysisId:sharedDeep.analysisId});assert.equal(x.explanation,null);assert.deepEqual(x.selected,[]);assert.equal(x.judgment,null);
 await step({explanation:null});assert.equal(x.explanationState,'missing');
 assert(artifactBytes.equals(fs.readFileSync(x.outputs.at(-1).path)));
 json(work+'/readable-explanation.json',{synthetic:true,explanation,viaHttp:viaHttp.value.result,states,confirmationPreservedByAnnotation:true,historyUnchanged:true});
});

test('grouped names remain presentation only, same-name analyses and stable task folders do not overwrite',async()=>{
 assert.equal(analysis.plugin.displayName,'合成混合插件');
 assert.equal(path.basename(path.dirname(analysisDir(analysis.analysisId))),'合成混合插件-分析结果');
 assert.equal(path.dirname(analysisDir(analysis.analysisId)),path.dirname(analysisDir(sharedDeep.analysisId)));
 assert.notEqual(analysisDir(analysis.analysisId),analysisDir(sharedDeep.analysisId));
 const td=findRecordDirectory(root+'/鱼的胃/任务','task',t.taskId),before=fs.readFileSync(td+'/task.json');
 assert.equal(path.basename(path.dirname(td)),'合成混合插件-拆分任务');
 await update({mode:t.mode==='reverse'?'compatibility':'reverse'});assert.equal(findRecordDirectory(root+'/鱼的胃/任务','task',t.taskId),td);assert(!before.equals(fs.readFileSync(td+'/task.json')));
 const metadata=(await task('list',{taskView:'analyses',taskOptions:{limit:20}})).page.items;
 assert(metadata.filter(r=>r.plugin.displayName==='合成混合插件').length>=2);assert(metadata.every(r=>r.createdAt&&r.updatedAt));
 assert.equal(directoryLabel(' bad<>:"/\\|?*名字. '),'bad_________名字');assert.equal(sourcePlugin(work+'/missing-package').name,'missing-package');
 json(work+'/named-layout.json',{analyses:recordEntries(root+'/鱼的胃/分析','analysis'),tasks:recordEntries(root+'/鱼的胃/任务','task'),metadata});
});

test('legacy direct analysis and task layouts retain linkage, updates, outputs and validity checks',async()=>{
 const {analyze,compose}=await load('internal/analysis/unified.mjs'),{pathIdentity}=await load('internal/backend/lib/path-identity.mjs');
 const id=randomUUID(),dir=root+'/鱼的胃/分析/'+id,sourceRecord=read(analysisDir(analysis.analysisId)+'/record.json');
 const execution=await analyze('initial',source,dir+'/run');assert.equal(execution.analyzerExecutions,1);
 compose(source,dir+'/bundle',[{name:'initial',path:dir+'/run'}]);
 const rec={analysisId:id,profile:pathIdentity(profile),kind:'initial',source:sourceRecord.source,status:'ready',bundle:'bundle',createdAt:new Date().toISOString()};
 json(dir+'/record.json',rec);const before=fs.readFileSync(dir+'/record.json');
 const query=await call({action:'query',analysisId:id,queryType:'summary'});assert.equal(query.plugin.displayName,'合成混合插件');
 const linked=await call({action:'analyze',analysisType:'deep',analysisSource:{kind:'local',path:source},initialAnalysisId:id});assert.equal(linked.initialAnalysisId,id);
 let legacy=await task('create',{analysisId:id,taskMode:'compatibility'});
 const grouped=findRecordDirectory(root+'/鱼的胃/任务','task',legacy.taskId),direct=root+'/鱼的胃/任务/'+legacy.taskId;
 const doc=read(grouped+'/task.json');delete doc.plugin;delete doc.analysisKind;delete doc.initialAnalysisId;json(grouped+'/task.json',doc);fs.renameSync(grouped,direct);
 legacy=await task('read',{taskId:legacy.taskId});assert.equal(legacy.explanationState,'missing');assert.equal(legacy.plugin.displayName,'合成混合插件');
 const c=(await task('read',{taskId:legacy.taskId,taskView:'capabilities'})).page.items[0];
 legacy=await task('update',{taskId:legacy.taskId,expectedRevision:legacy.revision,taskPatch:{selected:[c.id]}});
 legacy=await task('produce',{taskId:legacy.taskId,expectedRevision:legacy.revision});const old=fs.readFileSync(legacy.outputs[0].path),rev=legacy.revision;
 legacy=await task('update',{taskId:legacy.taskId,expectedRevision:legacy.revision,taskPatch:{mode:'reverse'}});
 const historical=await task('output',{taskId:legacy.taskId,outputRevision:rev});assert.equal(historical.historical,true);assert(old.equals(fs.readFileSync(legacy.outputs[0].path)));assert(before.equals(fs.readFileSync(dir+'/record.json')));
 const listed=(await task('list',{taskOptions:{limit:20}})).page.items;assert(listed.some(r=>r.id===legacy.taskId&&r.plugin.displayName==='合成混合插件'));
 const analyses=(await task('list',{taskView:'analyses',taskOptions:{limit:20}})).page.items;assert(analyses.some(r=>r.id===id));
 json(work+'/legacy-layout.json',{id,dir,linked,legacy,historical,legacyAnalyzerExecutions:1,recordUnchanged:true});
});
test('revision conflicts and choices invalidate confirmation; supplements remain attributed',async()=>{
 await assert.rejects(task('update',{taskId:t.taskId,expectedRevision:1,taskPatch:{mode:'compatibility'}}),/REVISION_CONFLICT/);
 await update({addCapabilities:[{name:'人工补充的心情能力',category:'brain',origin:{...origin,kind:'current-model'},evidenceRefs:[]}]});
 const cs=await task('read',{taskId:t.taskId,taskView:'capabilities',taskOptions:{limit:20}});assert.equal(cs.page.items.at(-1).origin.kind,'current-model');
 t=await task('produce',{taskId:t.taskId,expectedRevision:t.revision});t=await task('confirm',{taskId:t.taskId,expectedRevision:t.revision,taskConfirmation:origin});await update({selected:[]});assert.equal(t.confirmation,null);await assert.rejects(task('produce',{taskId:t.taskId,expectedRevision:t.revision}),/at least one/);
 await assert.rejects(task('update',{taskId:t.taskId,expectedRevision:t.revision,taskPatch:{selected:['index.js']}}),/capability IDs/);
});
test('source tamper, Profile mismatch and binding change preserve old artifacts, refuse validity',async()=>{
 const bytes=fs.readFileSync(source+'/index.js'),saved=fs.readFileSync(t.outputs[0].path);write(source+'/index.js',bytes.toString().replace('return 1','return 2'));
 await assert.rejects(task('read',{taskId:t.taskId}),/INVALID/);assert(fs.readFileSync(t.outputs[0].path).equals(saved));write(source+'/index.js',bytes);
 const other=path.join(work,'other-profile');fs.mkdirSync(other);fs.copyFileSync(profile+'/package.json',other+'/package.json');
 const ot=fishHandToolDefinition({bodySwitch:{...config,profileDir:other}});await assert.rejects(call({action:'task',taskOperation:'read',taskId:t.taskId},ot),/SCOPE_MISMATCH/);
 const otherRoot=path.join(work,'other-root');fs.mkdirSync(otherRoot);const bound=fishHandToolDefinition({bodySwitch:{...config,frameworkRoot:otherRoot}});await assert.rejects(call({action:'task',taskOperation:'read',taskId:t.taskId},bound),/ENOENT/);
});
test('unknown is not tool, no evidence no fabricated component; off and closing share gates',async()=>{
 const no=path.join(work,'opaque');write(no+'/unknown.xyz','opaque');const a=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'local',path:no}});const u=await task('create',{analysisId:a.analysisId,taskMode:'reverse'});assert.equal(u.classification.value,'unknown');
 select(false);const v=await tool.execute({action:'task',taskOperation:'read',taskId:t.taskId});assert.equal(v.result.phase,'off');assert.equal((await rest({taskOperation:'read',taskId:t.taskId})).value.phase,'off');select(true);
 let release;const pending=phase.withBodyOperation(profile,()=>new Promise(r=>release=r));const closing=phase.runBodySwitchChange({profileDir:profile,enabled:false,operation:()=>select(false)});
 assert.equal((await tool.execute({action:'task',taskOperation:'read',taskId:t.taskId})).result.phase,'closing');release();await pending;await closing;select(true);assert.equal(phase.activeOperationCount(profile),0);
 assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(brain,'utf8'),'PRIVATE_SENTINEL');
 json(path.join(work,'examples.json'),{analysis,task:t,compatibility:t.outputs.find(o=>o.mode==='compatibility'),reverse:t.outputs.find(o=>o.mode==='reverse'),syntheticConfirmationsOnly:true,calls});
});


test('deep limitations and original coordinates survive task output pagination; new content clears confirmation',async()=>{
 const deep=sharedDeep;
 const dt=await task('create',{analysisId:deep.analysisId,taskMode:'reverse'});t=dt;
 let offset=0,found;do{const q=await call({action:'query',analysisId:deep.analysisId,queryType:'file',queryOptions:{file:'index.js',offset,limit:20}});found??=q.page.items.find(r=>r.status);offset=q.page.nextOffset;}while(offset!==null);
 assert(found);await update({addCapabilities:[{name:'conditional-context',category:'unknown',origin:{...origin,kind:'current-model'},evidenceRefs:[found.id]}]});
 const caps=await task('read',{taskId:t.taskId,taskView:'capabilities',taskOptions:{limit:20}});await update({selected:[caps.page.items.at(-1).id],classification:{value:'mixed',origin,evidenceRefs:t.classification.evidenceRefs}});
 t=await task('produce',{taskId:t.taskId,expectedRevision:t.revision});const doc=read(t.outputs.at(-1).path);assert(doc.completeness.runs.some(r=>r.name==='deep'));assert(doc.evidence.some(r=>r.id===found.id&&r.raw.pointer&&r.unit.includes('UTF-16')&&r.status));
 const paged=await outputAll();assert(paged.some(r=>r.pointer.includes('status'))||paged.some(r=>JSON.stringify(r).includes('candidateSetComplete')));
 t=await task('confirm',{taskId:t.taskId,expectedRevision:t.revision,taskConfirmation:origin});const old=fs.readFileSync(t.outputs.at(-1).path);
 write(source+'/extra.js','export const extra=1');const fresh=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'local',path:source}});await update({analysisId:fresh.analysisId});assert.equal(t.confirmation,null);assert.deepEqual(t.selected,[]);assert(old.equals(fs.readFileSync(t.outputs.at(-1).path)));
 json(path.join(work,'final-examples.json'),{task:t,compatibility:compat,reverse,syntheticConfirmationsOnly:true,calls});
});

test('request task rejects collected-content drift; native mounted route rejects stale binding',async()=>{
 const {collectFromArchive}=await load('internal/backend/lib/upstream.mjs');const rice=work+'/rice',repo=rice+'/仓库';json(repo+'/package.json',{name:'fixed-task-fixture',version:'1.0.0'});write(repo+'/index.js',"defineTool('fixed_tool','fixed',{},[],()=>1)");write(repo+'/.cache/ignored.txt','fixed');
 const commit='b'.repeat(40),collected=collectFromArchive({repoDir:repo,commit,sourceEntry:{downloadMethod:'codeload-tar',repoDir:repo,head:commit}});
 json(rice+'/来源.json',{pinnedCommit:commit,contentHash:collected.treeHash});json(rice+'/内容清单.json',{pinnedCommit:commit,treeHash:collected.treeHash,files:collected.files});json(root+'/鱼的手/插件注册表/requests/task-fixed.json',{id:'task-fixed',targetProfile:profile,rice:{dir:rice},source:{pinnedCommit:commit,contentHash:collected.treeHash}});
 const a=await call({action:'analyze',analysisType:'initial',analysisSource:{kind:'request',requestId:'task-fixed'}});const rt=await task('create',{analysisId:a.analysisId,taskMode:'compatibility'});write(repo+'/.cache/ignored.txt','drift');await assert.rejects(task('read',{taskId:rt.taskId}),/FIXED_SOURCE_CHANGED/);write(repo+'/.cache/ignored.txt','fixed');
 const {apply}=await load('internal/backend/fish-body-approval.mjs'),routes=new Map(),binding=profile+'/binding.json';json(binding,{root});
 apply({effect:fn=>fn(),connection:{fetch:{register:r=>{routes.set(r.path,r.fetch);return()=>{}}}}},{...config,dataBindingPath:binding});
 json(binding,{root:work+'/other-root'});const response=await routes.get('/api/fish-hand/task')(new Request('http://localhost/api/fish-hand/task',{method:'POST',body:JSON.stringify({taskOperation:'read',taskId:rt.taskId})}));assert.equal(response.status,409);assert.match((await response.json()).error,/ROOT_RELOAD_REQUIRED/);
 assert.equal(fs.existsSync(marker),false);assert.equal(fs.readFileSync(brain,'utf8'),'PRIVATE_SENTINEL');
 json(work+'/final-calls.json',{calls,analysisExecutions:calls.filter(c=>c.args.action==='analyze').reduce((n,c)=>n+c.value.result.analyzerExecutions,0),candidateExecutions:0,privateSentinelUnchanged:true});
});
