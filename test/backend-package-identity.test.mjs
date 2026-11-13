import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// Regression port: all implementation imports address the independently installed tgz.
const artifactRoot=process.env.FISH_TEST_INSTALL_ROOT;
if(!artifactRoot)throw new Error('FISH_TEST_INSTALL_ROOT is required');
const installedBackend=new URL('node_modules/fish-body/internal/backend/',pathToFileURL(artifactRoot.replaceAll('\\','/')+'/'));
const { FishHandOrchestrator: SourceOrchestrator }=await import(new URL("fish-hand-orchestrator.mjs",installedBackend));
const { fishHandToolDefinition: sourceTool }=await import(new URL("fish-body-approval.mjs",installedBackend));
const { buildInstallPackage: sourcePack }=await import(new URL("lib/w6-package.mjs",installedBackend));
const { simulatedApproval }=await import(new URL("lib/pipeline.mjs",installedBackend));
const { acceptAllAsResidual }=await import(new URL("lib/conclusion.mjs",installedBackend));
const { recomputeFiles }=await import(new URL("lib/artifact.mjs",installedBackend));
const { treeHashOf }=await import(new URL("lib/w6-utils.mjs",installedBackend));

const FishHandOrchestrator=SourceOrchestrator, fishHandToolDefinition=sourceTool, buildInstallPackage=sourcePack;
const root=mkdtempSync(join(tmpdir(),'fh-package-identity-'));
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const git=(dir,args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim();
function fixture(id,{repoName='DeepSeek-Balance-Whale-Widget',name='dsh-whale-widget',version='0.4.2'}={}) {
  const framework=join(root,id),repo=join(framework,'饭/github.com/fixture',repoName,'仓库'),profile=join(framework,'profile');
  mkdirSync(repo,{recursive:true});mkdirSync(profile);
  writeFileSync(join(profile,'cordis.patch.yml'),'- insert:\n    - id: fish-body\n      name: fish-body\n');
  json(join(profile,'package.json'),{name:'fixture-profile',private:true,dependencies:{},dsh:{profile:{bundles:[]}}});
  json(join(repo,'package.json'),{name,version,main:'index.js',files:['index.js']});
  writeFileSync(join(repo,'index.js'),'module.exports = { apply() {} };\n');
  git(repo,['init','-q']);git(repo,['add','.']);git(repo,['-c','user.name=fixture','-c','user.email=fixture@local','commit','-qm','fixed package']);
  // fetchSourceToRice reuses the canonical clone. Its fetch is local, never GitHub.
  git(repo,['remote','add','origin',repo]);
  const commit=git(repo,['rev-parse','HEAD']),o=new FishHandOrchestrator({frameworkRoot:framework,mode:'production'});
  const tool=fishHandToolDefinition({orchestrator:o,bodySwitch:{profileDir:profile}});
  const source=`https://github.com/fixture/${repoName}#${commit}`;
  return {id,name,version,repoName,framework,repo,profile,commit,o,tool,source};
}
async function submit(f,extra={}) {
  return f.tool.execute({action:'submit',requestId:f.id,source:f.source,targetProfile:f.profile,...extra});
}
async function approve(f) {
  const r=f.o.store.load(f.id),review=read(r.stomach.reviewPath);
  const scopes={capabilities:review.candidates.capabilities.map(c=>c.value),replaces:[],credentialScopes:[],externalSideEffects:false,installScripts:false};
  const grant=simulatedApproval(scopes);
  const response=await f.tool.execute({action:'approve',requestId:f.id,approvedBy:'isolated-fixture-user',
    approvedScopes:grant.approvedScopes,authorization:grant.authorization,
    unknownDispositions:acceptAllAsResidual(review,'Explicit local fixture review; no production approval')});
  assert(response.ok,JSON.stringify(response));
  return {record:f.o.store.load(f.id),registry:f.o.registry().plugins[0]};
}

test('actual submit -> source review -> approval -> real pnpm pack resolves repo/name difference consistently',async()=>{
  const f=fixture('different');const pending=await submit(f);
  assert.equal(pending.result.packageNameSource,'repository-default');assert.equal(f.o.store.load(f.id).requestedPackageName,null);
  // Uncommitted workspace metadata must not override the fixed package identity.
  json(join(f.repo,'package.json'),{name:'uncommitted-other',version:'9.9.9'});
  const reviewed=await f.tool.execute({action:'review',requestId:f.id});assert(reviewed.ok,JSON.stringify(reviewed));
  const rec=f.o.store.load(f.id),rice=read(rec.rice.sourcePath);
  assert.equal(rec.packageName,f.name);assert.equal(rec.pluginId,f.name);assert.equal(rec.version,f.version);
  assert.equal(rice.packageName,f.name);assert.equal(rice.packageNameFromManifest,f.name);assert.equal(rice.repository,f.repoName);
  const retry=await submit(f);assert.equal(retry.result.packageName,f.name,'same request resumes after automatic resolution');
  const {record,registry}=await approve(f),pkg=read(registry.packageRecordPath),decision=read(join(f.o.decisionsRoot,registry.formalDecisionId+'.json'));
  assert.equal(basename(pkg.tgzPath),'dsh-whale-widget-0.4.2.tgz');assert(existsSync(pkg.tgzPath));
  for(const row of [record,registry,pkg,pkg.packageJson]){assert.equal(row.packageName??row.name,f.name);assert.equal(row.version,f.version)}
  assert.equal(decision.packageName,f.name);assert.equal(decision.version,f.version);
  assert(registry.artifactPath.includes(f.name));assert.equal(registry.sourceCommit,f.commit);
  assert.equal(record.install.exitCode,null,'pack validation did not install a real plugin');
});

test('matching repo/name and explicitly matching version retain normal pack behavior',async()=>{
  const f=fixture('matching',{repoName:'same-package',name:'same-package'});
  await submit(f,{version:f.version});assert((await f.tool.execute({action:'review',requestId:f.id})).ok);
  const {registry}=await approve(f);assert.equal(basename(registry.packagePath),'same-package-0.4.2.tgz');
});

test('explicit mismatching package name reports expected/actual without binding review or approval',async()=>{
  const f=fixture('explicit-mismatch');await submit(f,{packageName:f.repoName});
  const original=readFileSync(join(f.o.requestsRoot,f.id+'.json'));
  await assert.rejects(f.tool.execute({action:'review',requestId:f.id}),e=>e.code==='FH_PACKAGE_IDENTITY_MISMATCH'&&e.message.includes(f.repoName)&&e.message.includes(f.name));
  const rec=f.o.store.load(f.id);assert.equal(rec.packageName,f.repoName);assert.equal(rec.packageNameSource,'explicit');assert.equal(rec.state,'pending');assert.equal(rec.decisionId,undefined);
  assert.equal(f.o.registry().plugins.length,0);assert.equal(original.length>0,true);
});

test('explicit version mismatch remains rejected; matching explicit name resolves normally',async()=>{
  const f=fixture('version-mismatch');await submit(f,{packageName:f.name,version:'0.4.1'});
  await assert.rejects(f.tool.execute({action:'review',requestId:f.id}),e=>e.code==='FH_PACKAGE_VERSION_MISMATCH'&&e.message.includes('0.4.1')&&e.message.includes('0.4.2'));
  assert.equal(f.o.store.load(f.id).version,'0.4.1');assert.equal(f.o.registry().plugins.length,0);
  const ok=fixture('explicit-match');await submit(ok,{packageName:ok.name,version:ok.version});assert((await ok.tool.execute({action:'review',requestId:ok.id})).ok);
  assert.equal(ok.o.store.load(ok.id).packageNameSource,'explicit');
});

function packFixture(label) {
  const dir=join(root,label),warehouse=join(dir,'仓库');mkdirSync(warehouse,{recursive:true});
  json(join(warehouse,'package.json'),{name:'expected-package',version:'1.2.3',main:'index.js'});writeFileSync(join(warehouse,'index.js'),'module.exports=42;');
  const contentFiles=recomputeFiles(warehouse);json(join(dir,'manifest.json'),{contentFiles,contentHash:treeHashOf(contentFiles)});
  return {artifactDir:dir,outDir:join(dir,'out'),packageName:'expected-package',version:'1.2.3',revision:'fixed'};
}
test('pack returning without expected artifact still fails with precise identity and actual tgz basenames',()=>{
  for(const wrongTgz of [null,'wrong-output-1.2.3.tgz']) {
    const f=packFixture(wrongTgz?'wrong-tgz':'no-tgz');
    assert.throws(()=>buildInstallPackage({...f,runner:(args)=>{assert.equal(args[0],'pack');if(wrongTgz)writeFileSync(join(args.at(-1),wrongTgz),'not a valid artifact');}}),e=>
      e.code==='PKG_BUILD_FAILED'&&e.packageName===f.packageName&&e.version===f.version&&e.expectedTgz==='expected-package-1.2.3.tgz'
      &&JSON.stringify(e.actualTgzFiles)===JSON.stringify(wrongTgz?[wrongTgz]:[])&&e.message.includes(wrongTgz??'无'));
  }
});
test('pack identity mismatch is refused before execution; runner failure stays failure',()=>{
  const f=packFixture('pack-mismatch');let ran=false;
  assert.throws(()=>buildInstallPackage({...f,packageName:'wrong',runner:()=>{ran=true}}),e=>e.code==='PKG_UNPACK_MISMATCH'&&e.message.includes('wrong')&&e.message.includes('expected-package'));
  assert(!ran);const failure=new Error('CONTROLLED_PACK_FAILURE');
  assert.throws(()=>buildInstallPackage({...f,runner:()=>{throw failure}}),e=>e===failure);
});
test('existing approved identity cannot be silently rebound even when original name was provisional',async()=>{
  const f=fixture('bound-request');await submit(f);
  const rec=f.o.store.load(f.id);rec.formalDecisionId='previous-decision';f.o.store.save(rec);
  await assert.rejects(f.tool.execute({action:'review',requestId:f.id}),e=>e.code==='FH_PACKAGE_IDENTITY_MISMATCH'&&e.message.includes('不自动改绑'));
  assert.equal(f.o.store.load(f.id).formalDecisionId,'previous-decision');assert.equal(f.o.store.load(f.id).packageName,f.repoName);
});
console.log(JSON.stringify({implementation:"installed-tarball",temporaryRoot:root,productionInstallation:false}));
