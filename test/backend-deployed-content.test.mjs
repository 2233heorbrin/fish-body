import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
// Regression port: all implementation imports address the independently installed tgz.
const artifactRoot=process.env.FISH_TEST_INSTALL_ROOT;
if(!artifactRoot)throw new Error('FISH_TEST_INSTALL_ROOT is required');
const installedBackend=new URL('node_modules/fish-body/internal/backend/',pathToFileURL(artifactRoot.replaceAll('\\','/')+'/'));
const maintained=await import(new URL("lib/w6-deploy.mjs",installedBackend));
const {treeManifest,treeHashOf,copyTree,sri512}=await import(new URL("lib/w6-utils.mjs",installedBackend));
const api=maintained;
const {packageManagerCommand}=await import(new URL('lib/runtime-programs.mjs',installedBackend));
const root=mkdtempSync(join(tmpdir(),'fh-deployed-content-'));
const put=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text)};
const json=(path,value)=>put(path,JSON.stringify(value,null,2)+'\n');
const variants=name=>[name,...(process.platform==='win32'?[name+'.cmd',name+'.ps1']:[])];
let seq=0;
function fixture({originalBin=false,nested=false,stringBin=false,peer=false}={}) {
  const base=join(root,String(++seq)),runtime=join(base,'packed/package'),profile=join(base,'profile'),installed=join(profile,'node_modules/sample-plugin');
  json(join(runtime,'package.json'),{name:'sample-plugin',version:'1.0.0',main:'index.js',dependencies:{'@fixture/cli':'1.0.0'},...(peer?{peerDependencies:{'fixture-host-cli':'^1'}}:{})});
  put(join(runtime,'index.js'),'module.exports=42;');
  const dep='node_modules/@fixture/cli';
  json(join(runtime,dep,'package.json'),{name:'@fixture/cli',version:'1.0.0',main:'index.js',bin:stringBin?'cli.js':{'sample-command':'cli.js'},...(nested?{dependencies:{'nested-cli':'1.0.0'}}:{})});
  put(join(runtime,dep,'index.js'),'module.exports=1;');put(join(runtime,dep,'cli.js'),'#!/usr/bin/env node\nconsole.log("fixture")\n');
  if(nested){json(join(runtime,dep,'node_modules/nested-cli/package.json'),{name:'nested-cli',version:'1.0.0',bin:{'nested-command':'bin.js'}});put(join(runtime,dep,'node_modules/nested-cli/bin.js'),'#!/usr/bin/env node\n');}
  const original='node_modules/.bin/'+(stringBin?'cli':'sample-command')+'.cmd';
  if(originalBin)put(join(runtime,original),'original packed shim bytes');
  if(peer){json(join(profile,'node_modules/fixture-host-cli/package.json'),{name:'fixture-host-cli',version:'1.0.0',bin:{'host-command':'bin.js'}});put(join(profile,'node_modules/fixture-host-cli/bin.js'),'#!/usr/bin/env node\n');}
  const runtimeFiles=treeManifest(runtime),record={runtimeDir:runtime,runtimeFiles,runtimeContentHash:treeHashOf(runtimeFiles)};
  const expected=()=>api.expectedDeployedHashes({artifactDir:base,packageName:'sample-plugin',packageRecord:record,profileDir:profile});
  const bound=expected();copyTree(runtime,installed);
  const check=(e=bound)=>api.verifyDeployedContent({profileDir:profile,expected:e,packageNames:['sample-plugin']});
  const generate=(paths)=>{for(const path of paths)if(!existsSync(join(installed,path)))put(join(installed,path),'package-manager platform launcher');};
  return {base,runtime,profile,installed,dep,original,record,bound,expected,check,generate};
}
test('A: approved bundled bin yields only named platform launchers; full expected hash stays unchanged',()=>{
  const f=fixture(),paths=variants('sample-command').map(n=>'node_modules/.bin/'+n);f.generate(paths);
  const r=f.check();assert(r.ok,JSON.stringify(r));assert.deepEqual(r.rows['sample-plugin'].generated,paths.sort());
  assert.equal(r.rows['sample-plugin'].actual,f.record.runtimeContentHash);
});
test('B/C/E: changed or missing original code and bundled dependency remain failures with exact paths',()=>{
  for(const [path,kind]of [['index.js','modified'],['index.js','missing'],['node_modules/@fixture/cli/index.js','modified']]){
    const f=fixture(),file=join(f.installed,path);kind==='missing'?rmSync(file):put(file,'changed');
    const r=f.check();assert(!r.ok);assert(r.rows['sample-plugin'][kind].includes(path),JSON.stringify(r));
  }
});
test('D: unrelated additions outside and inside .bin are rejected; added package.json cannot self-authorize',()=>{
  for(const path of ['unexpected.js','node_modules/.bin/unknown.cmd','node_modules/.bin/sample-command.exe','node_modules/.bin/subdir/sample-command.cmd']) {
    const f=fixture();put(join(f.installed,path),'unexpected');assert(f.check().rows['sample-plugin'].unexpected.includes(path));
  }
  const f=fixture();json(join(f.installed,'node_modules/unreviewed/package.json'),{name:'unreviewed',bin:{rogue:'index.js'}});
  put(join(f.installed,'node_modules/unreviewed/index.js'),'unreviewed');put(join(f.installed,'node_modules/.bin/rogue.cmd'),'launcher');
  const r=f.check();assert(!r.ok);assert(r.rows['sample-plugin'].unexpected.includes('node_modules/.bin/rogue.cmd'));
});
test('F: original .bin entries take precedence, even for a declared command; modification/deletion fail',()=>{
  for(const kind of ['modified','missing']){
    const f=fixture({originalBin:true});kind==='missing'?rmSync(join(f.installed,f.original)):put(join(f.installed,f.original),'changed launcher');
    const r=f.check();assert(!r.ok);assert(r.rows['sample-plugin'][kind].includes(f.original));
  }
});
test('scoped string bin and nested dependency command paths follow the reviewed dependency layout',()=>{
  const f=fixture({stringBin:true,nested:true});
  f.generate([...variants('cli').map(n=>'node_modules/.bin/'+n),...variants('nested-command').map(n=>f.dep+'/node_modules/.bin/'+n)]);
  assert(f.check().ok,JSON.stringify(f.check()));put(join(f.installed,'node_modules/.bin/nested-command.cmd'),'wrong directory');
  assert(!f.check().ok);
});
test('declared host peer bins use pre-install provider metadata; absent, changed or newly added providers do not self-authorize',()=>{
  const f=fixture({peer:true}),paths=variants('host-command').map(n=>'node_modules/.bin/'+n);assert.equal(f.bound['sample-plugin'].peerBins.length,1);
  f.generate(paths);assert(f.check().ok,JSON.stringify(f.check()));
  put(join(f.profile,'node_modules/fixture-host-cli/bin.js'),'changed provider');assert(!f.check().ok);
  const missing=fixture({peer:true});rmSync(join(missing.profile,'node_modules/fixture-host-cli'),{recursive:true});
  const before=missing.expected();json(join(missing.profile,'node_modules/fixture-host-cli/package.json'),{name:'fixture-host-cli',bin:{'host-command':'bin.js'}});
  put(join(missing.profile,'node_modules/fixture-host-cli/bin.js'),'new');missing.generate(paths);assert(!missing.check(before).ok);
});
test('legacy digest-only records recover exact expected files from their integrity-bound tarball',()=>{
  const f=fixture({originalBin:true}),tgz=join(f.base,'bound.tgz');
  execFileSync('tar',['-czf',tgz,'-C',dirname(f.runtime),'package'],{stdio:'pipe'});
  const old={runtimeContentHash:f.record.runtimeContentHash,tgzPath:tgz,packageIntegrity:sri512(readFileSync(tgz))};
  const expected=api.expectedDeployedHashes({artifactDir:f.base,packageName:'sample-plugin',packageRecord:old});
  assert.deepEqual(expected['sample-plugin'].files,f.record.runtimeFiles);
  f.generate(variants('sample-command').map(n=>'node_modules/.bin/'+n));assert(f.check(expected).ok);
  put(tgz,'changed tarball');assert.throws(()=>api.expectedDeployedHashes({artifactDir:f.base,packageName:'sample-plugin',packageRecord:old}),/integrity/);
});
test('real pnpm pack/add in temporary offline Profile creates supported launchers and verifies against original package files',()=>{
  const f=fixture(),pm=packageManagerCommand();
  const packed=join(f.base,'tgz');mkdirSync(packed);
  const meta=JSON.parse(readFileSync(join(f.runtime,'package.json'),'utf8'));meta.bundleDependencies=['@fixture/cli'];json(join(f.runtime,'package.json'),meta);
  execFileSync(pm.command,[...pm.args,'pack','--config.node-linker=hoisted','--ignore-pnpmfile','--ignore-workspace','--pack-destination',packed],{cwd:f.runtime,stdio:'pipe',windowsHide:true});
  const tgz=join(packed,'sample-plugin-1.0.0.tgz'),baseline=join(f.base,'actual-packed');mkdirSync(baseline);
  execFileSync('tar',['-xzf',tgz,'-C',baseline],{stdio:'pipe'});
  const runtimeDir=join(baseline,'package'),runtimeFiles=treeManifest(runtimeDir),profile=join(f.base,'pnpm-profile');mkdirSync(profile);
  json(join(profile,'package.json'),{name:'offline-fixture-profile',private:true,version:'1.0.0'});
  put(join(profile,'pnpm-workspace.yaml'),'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  const record={runtimeDir,runtimeFiles,runtimeContentHash:treeHashOf(runtimeFiles),tgzPath:tgz,packageIntegrity:sri512(readFileSync(tgz))};
  const expected=api.expectedDeployedHashes({artifactDir:f.base,packageName:'sample-plugin',packageRecord:record,profileDir:profile});
  execFileSync(pm.command,[...pm.args,'add','file:'+tgz.replace(/\\/g,'/'),'--offline','--ignore-scripts','--ignore-pnpmfile','--ignore-workspace','--config.node-linker=hoisted','--config.auto-install-peers=false'],{cwd:profile,stdio:'pipe',windowsHide:true});
  const verified=api.verifyDeployedContent({profileDir:profile,expected,packageNames:['sample-plugin']});
  assert(verified.ok,JSON.stringify(verified));
  assert.deepEqual(verified.rows['sample-plugin'].generated,variants('sample-command').map(n=>'node_modules/.bin/'+n).sort());
});
console.log(JSON.stringify({implementation:'installed-tarball',temporaryRoot:root,productionInstallation:false}));
