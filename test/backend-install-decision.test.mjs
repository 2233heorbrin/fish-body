import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const install=process.env.FISH_TEST_INSTALL_ROOT,anchor=process.env.FISH_DSH_TEST_ANCHOR
if(!install||!anchor)throw Error('An independently installed body and isolated decision-v2 host are required')
const load=file=>import(pathToFileURL(join(install,'node_modules/fish-body',file)))
const {prepareMarketPackage}=await load('internal/backend/lib/market-prepare.mjs')
const {prepareInChild}=await load('internal/backend/lib/market-runtime.mjs')
const {npmCommand}=await load('internal/backend/lib/runtime-programs.mjs')
const {ProfileData}=await load('internal/profile-data.js')
const {createInstallTransaction}=await load('internal/install-transaction.js')
const {FishHandOrchestrator}=await load('internal/backend/fish-hand-orchestrator.mjs')
const {fishHandToolDefinition}=await load('internal/backend/fish-body-approval.mjs')
const {simulatedApproval}=await load('internal/backend/lib/pipeline.mjs')
const {acceptAllAsResidual}=await load('internal/backend/lib/conclusion.mjs')
const {activeOperationCount,readBodyPhase}=await load('internal/backend/lib/body-switch.mjs')
const req=createRequire(anchor),managerDir=dirname(req.resolve('@deepseek-ai/dsh-plugin-manager'))
const {withInstallTransaction,installTransactionExtensionVersion}=await import(pathToFileURL(join(managerDir,'install-transaction.mjs')))
assert.equal(installTransactionExtensionVersion,2,'tests must exercise the new host, never the historical copy')
const root=fs.mkdtempSync(join(tmpdir(),'install-decisions-')),cli=npmCommand()
const save=(path,doc)=>fs.writeFileSync(path,JSON.stringify(doc,null,2))
const dir=name=>{const path=join(root,name);fs.mkdirSync(path,{recursive:true});return path}
let counter=0
function source(name,code,{scripts={}}={}){
 const path=dir(name),out=dir(name+'-packed')
 save(join(path,'package.json'),{name,version:'1.0.0',type:'module',main:'index.js',files:['index.js'],scripts})
 fs.writeFileSync(join(path,'index.js'),code)
 const rows=JSON.parse(execFileSync(cli.exe,[...cli.args,'pack','--ignore-scripts','--json','--pack-destination',out],{cwd:path,env:cli.env,encoding:'utf8',windowsHide:true}))
 return {name,path,archive:join(out,rows[0].filename),spec:'file:'+join(out,rows[0].filename)}
}
const mixed=source('synthetic-brain-candidate',"export function apply(ctx){ if(false)ctx.memory.remember('synthetic'); }")
const tool=source('synthetic-ordinary-tool',"export function apply(ctx){ctx.tools.register({name:'ordinary'})}")
const unknown=source('synthetic-unclassified',"export function apply(){}")
function prepare(fixture,extra={}){
 return prepareMarketPackage({frameworkRoot:dir('data-'+ ++counter),profileDir:dir('profile-'+counter),
  spec:fixture.spec,packageName:fixture.name,requestId:'decision-'+counter,...extra})
}
let analyzed
test('actual acquired mixed package provides evidence without requiring an installed brain',()=>{
 analyzed=prepare(mixed)
 assert.equal(analyzed.pendingDecision,true);assert.equal(analyzed.analysis.status,'needs-discussion')
 assert.equal(analyzed.analysis.loadForm,'unknown');assert.equal(analyzed.analysis.shape,'mixed')
 assert(analyzed.analysis.reasons.some(row=>row.kind==='memory-change'))
 assert(analyzed.analysis.unknowns.every(row=>row.status==='unknown'))
 assert(fs.readFileSync(analyzed.original.archive).equals(fs.readFileSync(mixed.archive)))
})
test('ordinary matching tool install intent continues without fabricating residual-risk acceptance',()=>{
 const result=prepare(tool)
 assert.equal(result.pendingDecision,undefined);assert.equal(result.authorization,'matching-tool-install-intent')
 assert.equal(result.analysis.status,'analyzed');assert(result.analysis.unknowns.every(row=>row.status==='unknown'))
 assert.equal(result.analysis.loadForm,'tool')
})
test('real fish_hand submit/review exposes unknown form and collected evidence as lossless JSON',async()=>{
 const frameworkRoot=dir('tool-entry'),profileDir=dir('tool-entry-profile'),requestId='tool-entry-mixed'
 prepareMarketPackage({frameworkRoot,profileDir,requestId,spec:mixed.spec,packageName:mixed.name})
 const orchestrator=new FishHandOrchestrator({frameworkRoot}),tool=fishHandToolDefinition({orchestrator})
 const review=await tool.execute({action:'review',requestId})
 assert.equal(review.ok,true);assert.equal(review.result.shape,'mixed');assert.equal(review.result.loadForm,'unknown')
 assert(review.result.unknowns.length>0);assert(review.result.unknowns.every(row=>row.status==='unknown'))
 assert(Array.isArray(review.result.evidence));assert.deepEqual(JSON.parse(JSON.stringify(review)),review)
 const submit=await tool.execute({action:'submit',source:'https://github.com/fixture/not-fetched',targetProfile:profileDir})
 assert.equal(submit.ok,true);assert.equal(orchestrator.store.load(submit.result.requestId).loadForm,'unknown')
})
test('analysis exception after acquisition returns failed evidence with the same original',()=>{
 const id='analysis-failure-'+ ++counter
 const result=prepareMarketPackage({frameworkRoot:dir('analysis-failure-data'),profileDir:dir('analysis-failure-profile'),
  spec:mixed.spec,packageName:mixed.name,requestId:id},stage=>{if(stage.startsWith('胃：'))throw Error('synthetic scanner failure')})
 assert.equal(result.pendingDecision,true);assert.equal(result.analysis.status,'failed');assert.match(result.analysis.reason,/scanner failure/)
 assert(fs.readFileSync(result.original.archive).equals(fs.readFileSync(mixed.archive)))
})
test('an existing real formal tool decision is reused without resupplying approval',()=>{
 const frameworkRoot=dir('prior-authorized'),profileDir=dir('prior-authorized-profile'),requestId='prior-authorized'
 const input={frameworkRoot,profileDir,requestId,spec:tool.spec,packageName:tool.name}
 const first=prepareMarketPackage(input)
 const orchestrator=new FishHandOrchestrator({frameworkRoot}),rec=orchestrator.store.load(requestId)
 const review=JSON.parse(fs.readFileSync(rec.stomach.reviewPath))
 const granted=simulatedApproval({capabilities:['tool:register'],loadForm:'tool'})
 const ready=orchestrator.approve({requestId,approvedBy:'explicit-synthetic-fixture-user',...granted,
  unknownDispositions:acceptAllAsResidual(review,'Explicit synthetic fixture decision; not a production default'),
  conclusionFields:{shape:'tool',capabilities:['tool:register'],basis:'synthetic fixture inspected',
   injectionAssessment:{personaInjection:'unknown',memoryInjection:'unknown'}},marketInstall:true})
 assert.equal(ready.status,'ready');assert.equal(first.authorization,'matching-tool-install-intent')
 const second=prepareMarketPackage(input)
 assert.equal(second.authorization,'existing-bound-decision');assert.equal(second.spec,ready.package.installSpec)
 assert.equal(orchestrator.store.load(requestId).formalDecisionId,ready.record.formalDecisionId)
})
test('Git branch selection is retained and original delivery is bound to the collected commit',()=>{
 const framework=dir('git-original'),repo=join(framework,'饭/github.com/fixture/moving/仓库');fs.mkdirSync(repo,{recursive:true})
 const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim()
 save(join(repo,'package.json'),{name:'synthetic-git-brain',version:'1.0.0',type:'module',files:['index.js']})
 fs.writeFileSync(join(repo,'index.js'),"export function apply(ctx){ctx.memory.remember('first synthetic revision')}")
 git(['init','-q']);git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@local','commit','-qm','first'])
 git(['branch','-M','candidate']);git(['remote','add','origin',repo])
 const first=prepareMarketPackage({frameworkRoot:framework,profileDir:dir('git-profile'),spec:'github:fixture/moving#candidate',sourceUrl:'https://github.com/fixture/moving',requestId:'git-first'})
 assert.equal(first.pendingDecision,true);assert.equal(first.original.pinnedCommit,git(['rev-parse','HEAD']))
 const bytes=fs.readFileSync(first.original.archive)
 fs.writeFileSync(join(repo,'index.js'),"export function apply(ctx){ctx.memory.remember('second synthetic revision')}")
 git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@local','commit','-qm','second'])
 const second=prepareMarketPackage({frameworkRoot:framework,profileDir:dir('git-profile'),spec:'github:fixture/moving#candidate',sourceUrl:'https://github.com/fixture/moving',requestId:'git-second'})
 assert.notEqual(second.original.pinnedCommit,first.original.pinnedCommit)
 assert(fs.readFileSync(first.original.archive).equals(bytes));assert(!fs.readFileSync(second.original.archive).equals(bytes))
})
test('unclassified service is not hardcoded to tool; scripts are not executed before choice',()=>{
 const result=prepare(unknown);assert.equal(result.pendingDecision,true);assert.equal(result.analysis.loadForm,'unknown')
 const scripted=source('synthetic-scripted',"export function apply(){}",{scripts:{prepare:'node should-not-exist.cjs'}})
 assert.equal(prepare(scripted).pendingDecision,true)
})
test('identity mismatch and corrupt archive do not become original-package decisions',()=>{
 assert.throws(()=>prepare(mixed,{packageName:'wrong-identity'}),error=>error.code==='FH_PACKAGE_IDENTITY_MISMATCH')
 const path=join(dir('broken'),'bad.tgz');fs.writeFileSync(path,'not a package')
 assert.throws(()=>prepare({...mixed,spec:'file:'+path}))
})

function profile(name,providerCode){
 const path=dir('host-'+name),base=join(path,'node_modules/synthetic-provider');fs.mkdirSync(base,{recursive:true})
 save(join(path,'package.json'),{name:'profile-'+name,private:true,dependencies:{'synthetic-provider':'file:'+base},dsh:{profile:{bundles:['synthetic-provider']}}})
 save(join(base,'package.json'),{name:'synthetic-provider',version:'1.0.0',type:'module',dsh:{installTransaction:'./transaction.mjs'}})
 if(providerCode!==null)fs.writeFileSync(join(base,'transaction.mjs'),providerCode)
 return {dir:path,profile:name,installAnchor:anchor}
}
const opts={outputBytes:16384,onOutput:()=>{}}
const nativeCounter=()=>{
 const calls=[]
 const native=async(context,args,options)=>{calls.push({args,activateNewBundles:options.activateNewBundles});return {exitCode:0,output:'native-success'}}
 return {calls,native}
}
function decisionProvider(value){return `export function createInstallTransaction(){return {run:async()=>(${JSON.stringify({exitCode:2,pendingDecision:{targets:[{target:mixed.spec,original:analyzed.original,analysis:analyzed.analysis}]}})})}}`}
test('import failure offers native choice outside the broken provider; no deployment/recovery before choice',async()=>{
 const ctx=profile('import-failure',null),n=nativeCounter()
 const result=await withInstallTransaction(ctx,['add','one'],opts,n.native)
 assert.equal(result.exitCode,2);assert.equal(n.calls.length,0)
 assert.equal(result.decision.targets[0].analysis.status,'unavailable')
 const end=await withInstallTransaction(ctx,['install-decision',result.decision.id,'native','1'],opts,n.native)
 assert.equal(end.exitCode,0);assert.equal(end.analysisApproved,false);assert.equal(n.calls.length,1)
 assert.deepEqual(n.calls[0].args,['add','one'])
})
for(const [name,code]of [['sync',"export function createInstallTransaction(){throw Object.assign(Error('synthetic-init'),{code:'FH_NODE_CONFIG_INVALID',causeCode:'ENOENT'})}"],
 ['async',"export async function createInstallTransaction(){throw Error('synthetic-async-init')}"]])test('factory '+name+' errors remain explicit native choices',async()=>{
 const ctx=profile(name,code),n=nativeCounter(),result=await withInstallTransaction(ctx,['add','target'],opts,n.native)
 assert.equal(result.exitCode,2);assert.equal(n.calls.length,0)
 assert.match(result.output,/synthetic-/)
 if(name==='sync')assert.match(result.output,/ENOENT/)
})
test('repeat install and --yes do not choose; reject and cancellation never deploy',async()=>{
 const ctx=profile('reject',decisionProvider()),n=nativeCounter()
 const first=await withInstallTransaction(ctx,['add',mixed.spec],opts,n.native)
 const repeated=await withInstallTransaction(ctx,['add',mixed.spec,'--yes'],opts,n.native)
 assert.notEqual(first.decision.id,repeated.decision.id);assert.equal(n.calls.length,0)
 for(const [result,choice,code]of [[first,'reject',1],[repeated,'cancel',130]]){
  const end=await withInstallTransaction(ctx,['install-decision',result.decision.id,choice,'1'],opts,n.native)
  assert.equal(end.exitCode,code);assert.equal(n.calls.length,0)
 }
})
test('choice is Profile/target/content-bound and resumes the acquired bytes, not the mutable source',async()=>{
 const ctx=profile('fixed',decisionProvider()),n=nativeCounter(),args=['add',mixed.spec,'--ignore-scripts']
 const result=await withInstallTransaction(ctx,args,{...opts,activateNewBundles:false},n.native)
 const wrong=await withInstallTransaction(ctx,['install-decision',result.decision.id,'original','different'],opts,n.native)
 assert.equal(wrong.exitCode,1);assert.equal(n.calls.length,0)
 const changedSource=fs.readFileSync(mixed.archive);fs.writeFileSync(mixed.archive,'new moving-source bytes')
 try{
  const end=await withInstallTransaction(ctx,['install-decision',result.decision.id,'original','1'],opts,n.native)
  assert.equal(end.exitCode,0);assert.equal(end.originalInstalled,true);assert.equal(end.analysisApproved,false)
  assert.equal(n.calls.length,1);assert(n.calls[0].args.includes('file:'+result.decision.targets[0].original.archive))
  assert.equal(n.calls[0].activateNewBundles,false)
 }finally{fs.writeFileSync(mixed.archive,changedSource)}
})
test('snapshot tampering, dependency changes and another Profile cannot reuse a decision',async()=>{
 const ctx=profile('tamper',decisionProvider()),n=nativeCounter(),first=await withInstallTransaction(ctx,['add',mixed.spec],opts,n.native)
 fs.appendFileSync(first.decision.targets[0].original.archive,'changed')
 assert.equal((await withInstallTransaction(ctx,['install-decision',first.decision.id,'original','1'],opts,n.native)).exitCode,1)
 const second=await withInstallTransaction(ctx,['add',mixed.spec],opts,n.native)
 const pkg=JSON.parse(fs.readFileSync(join(ctx.dir,'package.json')));pkg.dependencies.extra='1.0.0';save(join(ctx.dir,'package.json'),pkg)
 const stale=await withInstallTransaction(ctx,['install-decision',second.decision.id,'original','1'],opts,n.native)
 assert.match(stale.output,/PROFILE_CHANGED/)
 const other=profile('other-profile',decisionProvider());const wrong=await withInstallTransaction(other,['install-decision',second.decision.id,'original','1'],opts,n.native)
 assert.equal(wrong.exitCode,1);assert.equal(n.calls.length,0)
})
test('multiple unavailable targets require separate choices; one native deployment, enabled policy retained',async()=>{
 const ctx=profile('multi',null),n=nativeCounter()
 const first=await withInstallTransaction(ctx,['add','A','B'],opts,n.native)
 const partial=await withInstallTransaction(ctx,['install-decision',first.decision.id,'native','1'],opts,n.native)
 assert.equal(partial.exitCode,2);assert.equal(n.calls.length,0)
 const end=await withInstallTransaction(ctx,['install-decision',first.decision.id,'native','2'],opts,n.native)
 assert.equal(end.exitCode,0);assert.equal(n.calls.length,1);assert.deepEqual(n.calls[0].args,['add','A','B'])
 assert.equal(n.calls[0].activateNewBundles,true)
})
for(const recoveryFails of [false,true])test('deployed failure recovers once; restoration failure remains visible '+recoveryFails,async()=>{
 const ctx=profile('recovery-'+recoveryFails,"export function createInstallTransaction(){return {run:async({deploy})=>{await deploy(['add','target']);throw Error('after-deploy')},afterRecovery:async value=>({ok:value.ok})}}")
 const before=fs.readFileSync(join(ctx.dir,'package.json')),calls=[]
 const result=await withInstallTransaction(ctx,['add','target'],opts,async(c,args)=>{
  calls.push(args);if(calls.length===1){fs.writeFileSync(join(c.dir,'package.json'),'broken');return {exitCode:0}}
  assert(fs.readFileSync(join(c.dir,'package.json')).equals(before));return {exitCode:recoveryFails?1:0}
 })
 assert.equal(result.exitCode,1);assert.equal(calls.length,2);assert.equal(result.restoration.ok,!recoveryFails)
})
test('no provider and a normal adapter result retain native behavior',async()=>{
 const ctx=profile('none',null),pkg=JSON.parse(fs.readFileSync(join(ctx.dir,'package.json')));pkg.dsh.profile.bundles=[];save(join(ctx.dir,'package.json'),pkg)
 const n=nativeCounter();assert.equal((await withInstallTransaction(ctx,['add','x'],opts,n.native)).exitCode,0);assert.equal(n.calls.length,1)
 const normal=profile('normal',"export function createInstallTransaction(){return {run:async({deploy})=>deploy(['add','y'])}}")
 assert.equal((await withInstallTransaction(normal,['add','y'],opts,n.native)).exitCode,0);assert.equal(n.calls.length,2)
})
test('native preflight refusal never runs recovery; native restoration calls provider once',async()=>{
 const ctx=profile('native-boundary',"export function createInstallTransaction(){return {run:async({deploy})=>deploy(['add','x']),afterRecovery:async result=>({ok:result.ok,hook:'once'})}}")
 let calls=0
 const refused=await withInstallTransaction(ctx,['add','x'],opts,async()=>{calls++;return {exitCode:1,wroteNothing:true}})
 assert.equal(calls,1);assert.equal(refused.restoration,undefined)
 const restored=await withInstallTransaction(ctx,['add','x'],opts,async()=>{calls++;return {exitCode:1,restoration:{ok:false,native:true}}})
 assert.equal(calls,2);assert.equal(restored.restoration.ok,false);assert.equal(restored.restoration.provider.hook,'once')
})
test('uninitialized and invalid body permit native choice without initialization; off is passthrough',async()=>{
 const path=dir('body-uninitialized');save(join(path,'package.json'),{private:true,dependencies:{'fish-body':'unused'},dsh:{profile:{bundles:['fish-body']}}})
 const adapter=createInstallTransaction({dir:path,installAnchor:anchor})
 const result=await adapter.run({args:['add','x']});assert.equal(result.nativeChoiceRequired.code,'FISH_DATA_NOT_READY')
 assert(!fs.existsSync(join(path,'fish-body-data.json')));assert(!fs.existsSync(join(path,'fish-body-state.json')))
 const workspace=dir('invalid-root');new ProfileData(path,'body').initialize({root:workspace});fs.renameSync(workspace,workspace+'-moved')
 assert.equal((await createInstallTransaction({dir:path,installAnchor:anchor}).run({args:['add','x']})).exitCode,2)
 save(join(path,'package.json'),{private:true,dependencies:{'fish-body':'unused'},dsh:{profile:{bundles:[]}}})
 assert.equal(await createInstallTransaction({dir:path}).run({args:['add','x']}),null)
 assert.equal(activeOperationCount(path),0);assert.equal(readBodyPhase({profileDir:path}).phase,'off')
})
test('real preparation timeout preserves acquired source and releases its process',async()=>{
 const child=join(dir('timeout'),'child.mjs'),original=analyzed.original
 fs.writeFileSync(child,`process.once('message',()=>{process.send({source:${JSON.stringify(original)}});setInterval(()=>{},1000)})`)
 await assert.rejects(prepareInChild({},{entry:child,timeoutMs:3000}),error=>error.code==='FH_MARKET_ANALYSIS_TIMEOUT'&&error.fixedOriginal.packageName===mixed.name)
})
test.after(()=>console.log(JSON.stringify({fixtures:root})))
