import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
// Regression port: all implementation imports address the independently installed tgz.
const artifactRoot=process.env.FISH_TEST_INSTALL_ROOT;
if(!artifactRoot)throw new Error('FISH_TEST_INSTALL_ROOT is required');
const installedBackend=new URL('node_modules/fish-body/internal/backend/',pathToFileURL(artifactRoot.replaceAll('\\','/')+'/'));
const base=installedBackend;
const load=p=>import(new URL(p,base).href);
const {parseGithubUrl,fetchSourceToRice,normalizeSubdir}=await load('lib/source-fetch.mjs');
const {FishHandOrchestrator}=await load('fish-hand-orchestrator.mjs');
const {fishHandToolDefinition}=await load('fish-body-approval.mjs');
const {simulatedApproval}=await load('lib/pipeline.mjs');
const {acceptAllAsResidual}=await load('lib/conclusion.mjs');
const {computeBinding,compareBinding}=await load('lib/decision.mjs');
const root=mkdtempSync(join(tmpdir(),'fish-github-subdir-'));
const json=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v,null,2)+'\n');};
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const git=(args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const upstream=join(root,'upstream');mkdirSync(upstream);
for(const [dir,name]of [['','root-fixture'],['plugins/a','sub-a'],['plugins/b','sub-b'],['plugins/c','sub-a']]) {
  json(join(upstream,dir,'package.json'),{name,version:'1.2.3',main:'index.js',files:['index.js']});
  writeFileSync(join(upstream,dir,'index.js'),'module.exports = {apply() {}};\n');
}
mkdirSync(join(upstream,'empty'));writeFileSync(join(upstream,'empty/readme.md'),'no manifest');
git(['-C',upstream,'init','-q','-b','main']);git(['-C',upstream,'add','.']);
git(['-C',upstream,'-c','user.name=fixture','-c','user.email=fixture@local','commit','-qm','real local upstream']);
const commit=git(['-C',upstream,'rev-parse','HEAD']);
git(['-C',upstream,'branch','feature/with/slashes']);
const archive=join(root,'source.tgz');
execFileSync('git',['-C',upstream,'archive','--format=tar.gz','--prefix=fixture/','-o',archive,commit],{windowsHide:true});
const calls=[];
const localGit=(args,options)=>{calls.push({args,options});return git(args.map(a=>a==='https://github.com/fixture/monorepo.git'?upstream:a));};
const getCalls=[];
const archiveGet=url=>{getCalls.push(url);if(url.includes('/commits/'))return Buffer.from(JSON.stringify({sha:commit}));
  if(url.includes('/git/matching-refs/'))return Buffer.from(JSON.stringify([{ref:'refs/heads/main'},{ref:'refs/heads/feature/with/slashes'}]));
  if(url.includes('/tar.gz/')){assert(url.endsWith(commit));return readFileSync(archive);}throw new Error('unexpected request '+url);};
function fixture(label,transport={git:localGit,get:()=>{throw new Error('network forbidden')}}) {
  const framework=join(root,label),profile=join(framework,'profile');mkdirSync(profile,{recursive:true});
  const o=new FishHandOrchestrator({frameworkRoot:framework,mode:'production',sourceTransport:transport});
  const tool=fishHandToolDefinition({orchestrator:o});return {framework,profile,o,tool};
}
async function request(f,id,extra={}) {
  await f.tool.execute({action:'submit',requestId:id,source:'https://github.com/fixture/monorepo',targetProfile:f.profile,...extra});
  const out=await f.tool.execute({action:'review',requestId:id});assert(out.ok,JSON.stringify(out));return f.o.store.load(id);
}
function approve(f,id) {
  const rec=f.o.store.load(id),review=read(rec.stomach.reviewPath);
  const scopes={capabilities:review.candidates.capabilities.map(c=>c.value),replaces:[],credentialScopes:[],externalSideEffects:false,installScripts:false};
  const grant=simulatedApproval(scopes);
  return f.o.approve({requestId:id,approvedBy:'local fixture user',...grant,
    unknownDispositions:acceptAllAsResidual(review,'isolated local fixture')});
}

test('root submit/review/pack remains usable and preserves dirty downloaded worktree',async()=>{
  const f=fixture('root'),rec=await request(f,'root');assert.equal(rec.packageName,'root-fixture');assert.equal(rec.source.subdir,'');
  const dirty=join(rec.repoDir,'index.js');writeFileSync(dirty,'user modification');
  f.o.runW2W3('root');assert.equal(readFileSync(dirty,'utf8'),'user modification');
  const out=approve(f,'root');assert(existsSync(out.package.tgzPath));
});
test('tree link and explicit subdir select identical subtree and real package identity',async()=>{
  const f=fixture('tree');
  const a=await request(f,'tree',{source:'https://github.com/fixture/monorepo/tree/main/plugins/a'});
  const b=await request(f,'explicit',{ref:'main',subdir:'plugins/a'});
  assert.equal(a.source.pinnedCommit,commit);assert.equal(a.source.subdir,'plugins/a');assert.equal(a.packageName,'sub-a');
  assert.equal(a.source.contentHash,b.source.contentHash);assert.equal(a.rice.dir,b.rice.dir);
  const files=read(a.rice.contentListPath).files.map(f=>f.path);assert.deepEqual(files,['index.js','package.json']);
  const out=approve(f,'tree');assert(existsSync(out.package.tgzPath));
  assert.equal(out.decision.binding.source.subdir,'plugins/a');assert(f.o.verifyDecision({decisionId:out.decision.id,requestId:'tree',profileDir:f.profile}).ok);
  const changed={...a,source:{...a.source,subdir:'plugins/b'}};
  const before=computeBinding({record:a,kind:'approve'}),after=computeBinding({record:changed,kind:'approve'});
  assert.equal(compareBinding(before,after).match,false);
  assert(compareBinding(before,after).mismatches.some(m=>m.field==='subdir'));
});
test('two same-commit subpackages retain separate rice, stomach, artifact and approval bindings',async()=>{
  const f=fixture('two'),a=await request(f,'a',{subdir:'plugins/a'}),b=await request(f,'b',{subdir:'plugins/b'});
  assert.notEqual(a.rice.dir,b.rice.dir);assert.notEqual(a.stomach.reviewPath,b.stomach.reviewPath);
  assert.equal(read(a.rice.sourcePath).packageName,'sub-a');assert.equal(read(b.rice.sourcePath).packageName,'sub-b');
  const aa=approve(f,'a'),bb=approve(f,'b');assert.notEqual(aa.artifact.artifactPath,bb.artifact.artifactPath);
  assert.notEqual(aa.decision.binding.source.subdir,bb.decision.binding.source.subdir);
  const tampered=f.o.store.load('a');tampered.source.subdir='plugins/b';f.o.store.save(tampered);
  assert(!f.o.verifyDecision({decisionId:aa.decision.id,requestId:'a',profileDir:f.profile}).ok);
  const retried=approve(f,'b');assert.equal(retried.decision.id,bb.decision.id,'same source retry reuses approval');
});
test('identical package bytes under a different subdir cannot silently reuse approval',async()=>{
  const f=fixture('identical'),a=await request(f,'a',{subdir:'plugins/a'});const approved=approve(f,'a');
  const c=await request(f,'c',{subdir:'plugins/c'});assert.equal(a.source.contentHash,c.source.contentHash);
  assert.throws(()=>f.o.approve({requestId:'c'}),e=>e.code==='FH_NO_APPROVER');
  const other=approve(f,'c');assert.notEqual(approved.artifact.artifactPath,other.artifact.artifactPath);
  assert.notEqual(approved.decision.binding.source.subdir,other.decision.binding.source.subdir);
});
test('slash-containing branch resolves as a whole, ambiguous refs require explicit selection',()=>{
  const f=fixture('slash');const a=fetchSourceToRice({frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo/tree/feature/with/slashes/plugins/a',transport:{git:localGit}});
  assert.equal(a.ref,'feature/with/slashes');assert.equal(a.subdir,'plugins/a');
  const ambiguous={git:args=>args[0]==='ls-remote'?`${commit}\trefs/heads/feature\n${commit}\trefs/heads/feature/with/slashes`:localGit(args)};
  assert.throws(()=>fetchSourceToRice({frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo/tree/feature/with/slashes/plugins/a',transport:ambiguous}),e=>e.code==='FH_REF_AMBIGUOUS');
  const explicit=parseGithubUrl('https://github.com/fixture/monorepo/tree/feature/with/slashes/plugins/a',{ref:'feature/with/slashes',subdir:'plugins/a'});
  assert.equal(explicit.ref,'feature/with/slashes');
});
test('conflicting URL/ref/subdir and invalid subdir are rejected before download',()=>{
  for(const options of [{ref:'other'},{ref:'main',subdir:'plugins/b'},{subdir:'other'}])
    assert.throws(()=>parseGithubUrl('https://github.com/fixture/monorepo/tree/main/plugins/a',options),e=>e.code==='FH_SOURCE_CONFLICT');
  for(const s of ['/absolute','../escape','a/../b','C:/absolute','a\\b','a//b'])assert.throws(()=>normalizeSubdir(s));
});
test('missing subtree/manifest and explicit name/version errors remain specific',async()=>{
  for(const [id,extra,code]of [
    ['missing',{subdir:'missing'},'SOURCE_SUBDIR_NOT_FOUND'],['manifest',{subdir:'empty'},'SOURCE_PACKAGE_JSON_MISSING'],
    ['name',{subdir:'plugins/a',packageName:'wrong'},'FH_PACKAGE_IDENTITY_MISMATCH'],
    ['version',{subdir:'plugins/a',version:'9.9.9'},'FH_PACKAGE_VERSION_MISMATCH']]) {
    const f=fixture('failure-'+id);await f.tool.execute({action:'submit',requestId:id,source:'https://github.com/fixture/monorepo',targetProfile:f.profile,...extra});
    await assert.rejects(f.tool.execute({action:'review',requestId:id}),e=>e.code===code);
    assert.equal(f.o.store.load(id).state,'pending');assert.equal(f.o.registry().plugins.length,0);
  }
});
test('Git fails -> fixed upstream archive -> same review/approve/real pack, no fabricated Git',async()=>{
  const f=fixture('archive',{git:()=>{throw new Error('remote connection reset')},get:archiveGet});
  const rec=await request(f,'archive',{source:'https://github.com/fixture/monorepo/tree/main/plugins/a'});
  assert.equal(rec.source.pinnedCommit,commit);assert.equal(rec.source.downloadMethod,'codeload-tar');
  assert.equal(rec.source.upstreamUrl,'https://github.com/fixture/monorepo.git');assert(!existsSync(join(rec.repoDir,'.git')));
  const out=approve(f,'archive');assert(existsSync(out.package.tgzPath));
  assert.equal(read(rec.rice.sourcePath).subdir,'plugins/a');assert(getCalls.some(u=>u.endsWith('/tar.gz/'+commit)));
});
test('known full commit can use immutable codeload without a floating API lookup',()=>{
  const f=fixture('known-commit'),entry=fetchSourceToRice({frameworkRoot:f.framework,
    url:`https://github.com/fixture/monorepo/tree/${commit}/plugins/a`,transport:{git:()=>{throw new Error('Git unavailable')},
      get:url=>{assert(url.includes('/tar.gz/'+commit),'must not query a floating API ref');return readFileSync(archive);}}});
  assert.equal(entry.head,commit);assert.equal(entry.subdir,'plugins/a');assert.equal(entry.downloadMethod,'codeload-tar');
});
test('recognized proxy failure retries direct once; other failures do not retry direct',()=>{
  for(const proxy of [true,false]) {
    const seen=[],f=fixture('retry-'+proxy);
    const entry=fetchSourceToRice({frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo',ref:'main',
      transport:{git:(args,options)=>{seen.push(options);throw new Error(proxy?'Failed to connect via 127.0.0.1: Could not connect to server':'repository not found')},get:archiveGet}});
    assert.equal(seen.filter(x=>x?.direct).length,proxy?1:0);assert.equal(entry.downloadMethod,'codeload-tar');
  }
});
test('Git and archive failure include actual stages, preserve partial directories, permit retry',()=>{
  const f=fixture('both-fail'),opts={frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo',ref:'main',transport:{git:()=>{throw new Error('Git unreachable')},get:()=>{throw new Error('HTTP 503 archive/API unavailable')}}};
  assert.throws(()=>fetchSourceToRice(opts),e=>e.code==='FH_REF_UNAVAILABLE'&&e.message.includes('Git unreachable')&&e.message.includes('503'));
  assert(!existsSync(join(f.framework,'饭/github.com/fixture/monorepo/仓库')));
  assert.equal(fetchSourceToRice({...opts,transport:{git:localGit}}).head,commit);
});
test('failed refresh never claims stale HEAD as new upstream',()=>{
  const f=fixture('stale');fetchSourceToRice({frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo',transport:{git:localGit}});
  const broken={git:args=>args.includes('fetch')?(()=>{throw new Error('fetch failed')})():localGit(args),get:()=>{throw new Error('API unavailable')}};
  assert.throws(()=>fetchSourceToRice({frameworkRoot:f.framework,url:'https://github.com/fixture/monorepo',transport:broken}),e=>e.code==='FH_REF_UNAVAILABLE');
});
test('fixed commit input stays fixed; same request cannot change subdir',async()=>{
  const f=fixture('fixed'),rec=await request(f,'fixed',{source:`https://github.com/fixture/monorepo#${commit}`,subdir:'plugins/a'});
  assert.equal(rec.source.pinnedCommit,commit);
  await assert.rejects(f.tool.execute({action:'submit',requestId:'fixed',source:`https://github.com/fixture/monorepo#${commit}`,subdir:'plugins/b',targetProfile:f.profile}),e=>e.code==='FH_REQUEST_ID_REUSED');
});
console.log(JSON.stringify({temporaryRoot:root,implementation:"installed-tarball",productionInstall:false}));
