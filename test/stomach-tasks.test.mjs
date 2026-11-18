import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const install=process.env.FISH_TEST_INSTALL_ROOT, work=process.env.FISH_TASK_TEST_ROOT;
if(!install||!work||fs.existsSync(work))throw Error('Provide installed package and fresh FISH_TASK_TEST_ROOT');
const pkg=path.join(install,'node_modules/fish-body');
const load=f=>import(pathToFileURL(path.join(pkg,f)));
const {fishHandToolDefinition,createHandler}=await load('internal/backend/fish-body-approval.mjs');
const phase=await load('internal/backend/lib/body-switch.mjs');
const write=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,v)};
const json=(f,v)=>write(f,JSON.stringify(v,null,2));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const root=path.join(work,'root'),profile=path.join(work,'profile'),source=path.join(work,'source'),marker=path.join(work,'EXECUTED');
const select=on=>json(profile+'/package.json',{dependencies:{'fish-body':'file:test'},dsh:{profile:{bundles:on?['fish-body']:[]}}});select(true);
const brain=root+'/鱼的大脑/人格/private.txt';write(brain,'PRIVATE_SENTINEL');
json(source+'/package.json',{name:'synthetic-mixed',version:'1.0.0',type:'module',scripts:{prepare:'node trap.cjs'}});
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
 const bundle=read(root+'/鱼的胃/分析/'+analysis.analysisId+'/bundle/bundle.json');
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
 const ds=await rows(),d=ds[0],bundle=read(root+'/鱼的胃/分析/'+analysis.analysisId+'/bundle/bundle.json');
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
 const db=read(root+'/鱼的胃/分析/'+sharedDeep.analysisId+'/bundle/bundle.json'),foreign=db.records.find(r=>r.id.startsWith('deep/'));assert(foreign);
 await assert.rejects(step({dependencyDecisions:[{...decision,evidenceRefs:[foreign.id]}]}),/Unknown evidence ID/);
 assert.deepEqual((await rows())[0].evidenceRefs,[extra.id]);
 const metadata=await task('list',{taskView:'analyses',taskOptions:{limit:20}});assert.equal(metadata.page.items.find(r=>r.id===analysis.analysisId).kind,'initial');assert.equal(metadata.page.items.find(r=>r.id===sharedDeep.analysisId).kind,'deep');assert.equal(metadata.page.items.find(r=>r.id===sharedDeep.analysisId).initialAnalysisId,analysis.analysisId);
 await assert.rejects(call({action:'analyze',analysisType:'deep',analysisSource:{kind:'local',path:source},initialAnalysisId:sharedDeep.analysisId}),/valid initial/);
 await step({analysisId:sharedDeep.analysisId});assert.equal(x.judgment,null);assert.deepEqual(x.selected,[]);assert.deepEqual(await rows(),[]);assert(old.equals(fs.readFileSync(x.outputs[0].path)));
 json(work+'/evidence-preservation.json',{defaultRefs:d.evidenceRefs,supplementalRef:extra.id,snapshots,explicitRemoval:[],foreignRejected:foreign.id,analysisReset:x,oldOutputUnchanged:true});
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
