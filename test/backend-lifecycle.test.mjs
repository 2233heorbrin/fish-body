import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
// Regression port: all implementation imports address the independently installed tgz.
const artifactRoot=process.env.FISH_TEST_INSTALL_ROOT;
if(!artifactRoot)throw new Error('FISH_TEST_INSTALL_ROOT is required');
const installedBackend=new URL('node_modules/fish-body/internal/backend/',pathToFileURL(artifactRoot.replaceAll('\\','/')+'/'));
const {packageFiles,sourceFiles,buildInstallPackage,inspectInstallPackage,dependencyOrigin,selectDependencyScripts,authorizeDependencyScripts}=await import(new URL("lib/w6-package.mjs",installedBackend));
const {recomputeFiles}=await import(new URL("lib/artifact.mjs",installedBackend));
const {atomicJson,treeHashOf,sha256File}=await import(new URL("lib/w6-utils.mjs",installedBackend));
const BASE=dirname(dirname(fileURLToPath(import.meta.url)));

const ROOT=join(tmpdir(),`fh-lifecycle-${Date.now()}`);
mkdirSync(ROOT,{recursive:true});
const packaged=[];
function recordPackage(pkg) {
 packaged.push({name:pkg.packageName,recordPath:pkg.recordPath,tgzPath:pkg.tgzPath,packageIntegrity:pkg.packageIntegrity,
  sourceTreeHash:pkg.sourceTreeHash,runtimeContentHash:pkg.runtimeContentHash,
  rootCommands:pkg.build.commands,dependencyScripts:pkg.build.dependencyScripts,
  dependencySources:pkg.build.dependencySources,validated:inspectInstallPackage({artifactDir:pkg.artifactDir,recordPath:pkg.recordPath}).ok});
 return pkg;
}
test.after(()=>console.log(JSON.stringify({temporaryRoot:ROOT,packages:packaged.length})));
const grants={approvedScopes:{installScripts:true},authorization:{buildScripts:{granted:true}}};
function artifact(name,{scripts={},dependencies={},extra={}}={}) {
  const dir=join(ROOT,name),warehouse=join(dir,'仓库');mkdirSync(warehouse,{recursive:true});
  atomicJson(join(warehouse,'package.json'),{name,version:'1.0.0',main:'lib/index.js',files:['lib'],scripts,dependencies});
  for(const [path,body]of Object.entries(extra)){mkdirSync(dirname(join(warehouse,path)),{recursive:true});writeFileSync(join(warehouse,path),body);}
  const files=recomputeFiles(warehouse);atomicJson(join(dir,'manifest.json'),{contentFiles:files,contentHash:treeHashOf(files)});
  return {artifactDir:dir,outDir:join(dir,'out'),workRoot:join(ROOT,'work'),packageName:name,version:'1.0.0',revision:'fixed',production:true};
}
test('lock source distinguishes registry, Git, directory, tarball and link prepare semantics',()=>{
 const meta={scripts:{prepare:'should-not-run',postinstall:'must-authorize'}};
 for(const [resolution,expected]of [[{integrity:'sha512-x'},'registry'],[{type:'git',repo:'repo',commit:'abc'},'git'],
   [{type:'directory',directory:'../local'},'directory'],[{tarball:'file:../dep.tgz',integrity:'sha512-x'},'tarball']]) {
   const ref=expected==='tarball'?'file:../dep.tgz':'1.0.0';
   const origin=dependencyOrigin({packages:{[`dep@${ref}`]:{resolution}}},'dep','1.0.0','^1',ref);
   assert.equal(origin.kind,expected);const selected=selectDependencyScripts(meta,origin);
   assert.equal(!!selected.prepare,['git','directory'].includes(expected));assert.equal(selected.postinstall,'must-authorize');
 }
 assert.deepEqual(selectDependencyScripts(meta,{kind:'link'}),{});
 assert.throws(()=>selectDependencyScripts(meta,{kind:'unknown'}),e=>e.code==='PKG_DEP_MISSING');
});
test('source includes tracked nested fixture; dependency and runtime use their own scopes',()=>{
 const f=artifact('nested-fixture',{scripts:{prepare:'node build.cjs'},extra:{
  'tests/fixtures/profiles/node_modules/demo/package.json':'{"name":"fixture"}',
  'build.cjs':"require('fs').mkdirSync('lib');require('fs').writeFileSync('lib/index.js','module.exports=42');"}});
 const warehouse=join(f.artifactDir,'仓库');
 assert.equal(sourceFiles(warehouse).length,3);assert.equal(packageFiles(warehouse).length,2);
 const result=recordPackage(buildInstallPackage({...f,...grants}));
 assert.equal(result.sourceFiles.length,3);assert.equal(inspectInstallPackage({artifactDir:f.artifactDir,recordPath:result.recordPath}).ok,true);
 assert.equal(existsSync(join(result.runtimeDir,'tests')),false);assert.ok(existsSync(join(result.runtimeDir,'lib/index.js')));
 assert.equal(existsSync(join(warehouse,'lib')),false);
 const fixture=join(warehouse,'tests/fixtures/profiles/node_modules/demo/package.json');
 const original=readFileSync(fixture);writeFileSync(fixture,'changed fixture');
 assert.equal(inspectInstallPackage({artifactDir:f.artifactDir,recordPath:result.recordPath}).ok,false);writeFileSync(fixture,original);
 mkdirSync(join(result.build.workDir,'node_modules/generated'),{recursive:true});writeFileSync(join(result.build.workDir,'node_modules/generated/index.js'),'generated');
 assert.equal(sourceFiles(result.build.workDir).some(r=>r.path==='node_modules/generated/index.js'),false);
});
test('root prepare plus prepack execute exactly once and unapproved root stays blocked',()=>{
 const body="const fs=require('fs');fs.mkdirSync('lib',{recursive:true});fs.appendFileSync('lib/log',process.env.npm_lifecycle_event+'\\n');fs.writeFileSync('lib/index.js','module.exports=1');";
 const f=artifact('root-events',{scripts:{prepare:'node hook.cjs',prepack:'node hook.cjs'},extra:{'hook.cjs':body}});
 assert.throws(()=>buildInstallPackage(f),e=>e.code==='PKG_SCRIPT_UNAPPROVED');
 const result=recordPackage(buildInstallPackage({...f,...grants}));assert.equal(readFileSync(join(result.runtimeDir,'lib/log'),'utf8'),'prepare\nprepack\n');
 assert.equal(result.build.lifecycleSemantics,'lifecycle-v2');assert.equal(result.packageJson.scripts.prepare,undefined);
});
test('approved subset reuses older broader dependency grant; changed hook still rejected',()=>{
 const row={name:'dep',version:'1',treeHash:'hash',scripts:{postinstall:'node good.cjs'}};
 const auth={buildScripts:{dependencies:[{...row,scripts:{...row.scripts,prepare:'old-grant'}}]}};
 assert.deepEqual(authorizeDependencyScripts([row],auth),[row]);
 assert.throws(()=>authorizeDependencyScripts([{...row,scripts:{postinstall:'node other.cjs'}}],auth),e=>e.code==='PKG_SCRIPT_UNAPPROVED');
});
test('published registry prepare not requested or executed, even with old prepare grants',async()=>{
 const pack=join(ROOT,'registry');mkdirSync(join(pack,'package'),{recursive:true});
 atomicJson(join(pack,'package/package.json'),{name:'registry-prepare-fixture',version:'1.0.0',main:'index.js',scripts:{prepare:'node missing-dev-tool.js'}});
 writeFileSync(join(pack,'package/index.js'),'module.exports=42');execFileSync('tar',['-czf','dep.tgz','package'],{cwd:pack,stdio:'pipe'});
 const serverFile=join(ROOT,'registry.mjs');
 writeFileSync(serverFile,`import{createServer}from'node:http';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';const b=readFileSync(process.argv[2]);const s=createServer((q,r)=>{if(q.url.includes('.tgz')){r.end(b);return;}r.setHeader('content-type','application/json');r.end(JSON.stringify({name:'registry-prepare-fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'registry-prepare-fixture',version:'1.0.0',dist:{tarball:'http://127.0.0.1:'+s.address().port+'/dep.tgz',integrity:'sha512-'+createHash('sha512').update(b).digest('base64')}}}}));});s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)));`);
 const server=spawn(process.execPath,[serverFile,join(pack,'dep.tgz')],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 try{
  const [port]=await once(server.stdout,'data');
  const f=artifact('registry-build',{dependencies:{'registry-prepare-fixture':'1.0.0'},scripts:{prepare:'node build.cjs'},extra:{
   '.npmrc':`registry=http://127.0.0.1:${port}\n`,
   'build.cjs':"const fs=require('fs');fs.mkdirSync('lib');fs.writeFileSync('lib/index.js','module.exports='+require('registry-prepare-fixture'));"}});
  const result=recordPackage(buildInstallPackage({...f,...grants,authorization:{buildScripts:{granted:true,dependencies:[{name:'registry-prepare-fixture',version:'1.0.0',scripts:{prepare:'old-grant'},treeHash:'historical'}]}}}));
  assert.deepEqual(result.build.dependencyScripts,[]);assert.equal(result.build.dependencySources[0].source,'registry');
  assert.equal(inspectInstallPackage({artifactDir:f.artifactDir,recordPath:result.recordPath}).ok,true);
  assert.equal(readFileSync(join(result.runtimeDir,'lib/index.js'),'utf8'),'module.exports=42');
 }finally{server.kill();await once(server,'exit');}
});
test('genuine local postinstall requires approval then receives cwd, PATH and lifecycle environment',()=>{
 const dep=join(ROOT,'local-hook');mkdirSync(join(dep,'node_modules'),{recursive:true});
 atomicJson(join(dep,'package.json'),{name:'local-hook-fixture',version:'1.0.0',scripts:{postinstall:'node hook.cjs'},devDependencies:{missing:'file:./not-present'}});
 writeFileSync(join(dep,'hook.cjs'),"const fs=require('fs');if(!process.env.PATH&&!process.env.Path)throw Error('PATH');if(!process.env.npm_package_json||!process.env.INIT_CWD)throw Error('env');fs.writeFileSync('environment.json',JSON.stringify({event:process.env.npm_lifecycle_event,cwd:process.cwd(),root:process.env.INIT_CWD}));");
 const f=artifact('local-hook-build',{dependencies:{'local-hook-fixture':'file:'+dep.replace(/\\/g,'/')},extra:{'lib/index.js':'module.exports=1'}});
 let pending;assert.throws(()=>buildInstallPackage(f),e=>{pending=e.pendingScripts;return e.code==='PKG_SCRIPT_UNAPPROVED';});
 assert.equal(pending.length,1);assert.deepEqual(Object.keys(pending[0].scripts),['postinstall']);
 const result=recordPackage(buildInstallPackage({...f,authorization:{buildScripts:{dependencies:pending}}}));
 const env=JSON.parse(readFileSync(join(result.runtimeDir,'node_modules/local-hook-fixture/environment.json'),'utf8'));
 assert.equal(env.event,'postinstall');assert.equal(env.root,result.build.workDir);assert.ok(env.cwd.endsWith('local-hook-fixture'));
 assert.equal(existsSync(join(dep,'environment.json')),false);
 assert.ok(existsSync(join(result.runtimeDir,'node_modules/local-hook-fixture/environment.json')));
});
test('implicit native build is authorized once; prepare never synthesizes a native build',()=>{
 assert.deepEqual(selectDependencyScripts({scripts:{prepare:'ignored'}},{kind:'registry'}),{});
 assert.deepEqual(selectDependencyScripts({scripts:{}},{kind:'registry'},{bindingGyp:true}),{install:'node-gyp rebuild'});
 assert.deepEqual(selectDependencyScripts({gypfile:false},{kind:'registry'},{bindingGyp:true}),{});
});
test('desktop Host executable is not incorrectly used as Node lifecycle CLI',()=>{
 const f=artifact('desktop-node',{scripts:{prepare:'node build.cjs'},extra:{'build.cjs':"require('fs').mkdirSync('lib');require('fs').writeFileSync('lib/index.js','module.exports=1')"}});
 const original=process.execPath;
 try{process.execPath=join(ROOT,'DSH.exe');const pkg=recordPackage(buildInstallPackage({...f,...grants}));assert.ok(existsSync(join(pkg.runtimeDir,'lib/index.js')));}
 finally{process.execPath=original;}
});
