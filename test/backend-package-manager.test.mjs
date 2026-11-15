import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname,delimiter,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import cp from 'node:child_process';
import {createRequire,syncBuiltinESMExports} from 'node:module';

const install=process.env.FISH_TEST_INSTALL_ROOT;
if(!install)throw Error('FISH_TEST_INSTALL_ROOT is required');
const pkg=join(install,'node_modules/fish-body'),backend=join(pkg,'internal/backend');
const {packageManagerCommand,nativeNodeRuntime}=await import(pathToFileURL(join(backend,'lib/runtime-programs.mjs')));
const {runPnpm}=await import(pathToFileURL(join(backend,'lib/w6-package.mjs')));
const {withStateConfig}=await import(pathToFileURL(join(backend,'production-state.mjs')));
const {createMarketBodyAdapter}=await import(pathToFileURL(join(backend,'lib/market-runtime.mjs')));
const root=fs.mkdtempSync(join(process.env.FISH_TEST_WORK_ROOT??tmpdir(),'manager-'));
const put=(p,text)=>{fs.mkdirSync(dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
const json=(p,value)=>put(p,JSON.stringify(value));
let sequence=0;
function configuration(manager) {
  const dir=join(root,String(++sequence)),profile=join(dir,'profiles/test');
  json(join(profile,'package.json'),{name:'fixture-profile',private:true,dependencies:{'fish-body':'0.0.3'},dsh:{profile:{bundles:['fish-body']}}});
  const registryPath=json(join(dir,'hand/registry.json'),{plugins:[]});
  const testStatePath=json(join(dir,'view.json'),{candidates:{}});
  const config=json(join(dir,'config.json'),{mode:'isolation',testStatePath,registryPath,packageManager:manager,
    artifactsRoot:join(dir,'hand/artifacts'),decisionsRoot:join(dir,'hand/decisions'),profileRoot:join(dir,'profiles'),
    defaultProfileDir:profile,snapshotRoot:join(dir,'snapshots'),reportDir:join(dir,'reports'),auditPath:join(dir,'audit.jsonl')});
  return {dir,profile,config,using:operation=>withStateConfig(config,operation)};
}
const observer=put(join(root,'observe.cjs'),"console.log(JSON.stringify({args:process.argv.slice(2),marker:process.env.MANAGER_MARKER,electron:process.env.ELECTRON_RUN_AS_NODE}))");
const win={skip:process.platform!=='win32'?'Windows pnpm shim contract':false};
function shim(name,{local=false,native=false}={}) {
  const base=join(root,'layouts',name),bin=local?join(base,'node_modules/.bin'):base;
  const packageDir=local?join(base,'node_modules/pnpm'):join(base,'node_modules/pnpm');
  const entry=join(packageDir,native?'pnpm.exe':'bin/pnpm.cjs');
  json(join(packageDir,'package.json'),{name:'pnpm',version:'1.0.0',bin:{pnpm:native?'pnpm.exe':'bin/pnpm.cjs'}});
  if(native)fs.copyFileSync(process.execPath,entry);else put(entry,fs.readFileSync(observer));
  // Any attempt to execute/interpret this fixture shim itself fails.
  put(join(bin,'pnpm.cmd'),'@echo UNSUPPORTED_SHIM_EXECUTION\r\n@exit /b 93\r\n');
  put(join(bin,'pnpm'),'#!/bin/sh\nexit 93\n');
  return {bin,entry,shim:join(bin,'pnpm.cmd')};
}
test('default Windows pnpm resolves the PATH-selected installation and configured environment',win,()=>{
  const selected=shim('global-native',{native:true}),other=shim('other');
  const env={Path:[selected.bin,other.bin,join(process.env.SystemRoot,'System32')].join(delimiter),MANAGER_MARKER:'configured'};
  const f=configuration({command:'pnpm',args:[observer,'first','a b'],env});
  f.using(()=>{
    const manager=packageManagerCommand();assert.equal(resolve(manager.command),resolve(selected.entry));
    assert.equal(Object.keys(manager.env).filter(k=>k.toLowerCase()==='path').length,1);
    assert.deepEqual(JSON.parse(runPnpm(['last'],f.dir)),{args:['first','a b','last'],marker:'configured'});
  });
});
for(const local of [false,true])test('normal '+(local?'node_modules/.bin':'global')+' pnpm JS shim retains arguments and runtime env',win,()=>{
  const s=shim(local?'local-js':'global-js',{local});
  const f=configuration({command:s.shim,args:['first','a b'],env:{MANAGER_MARKER:'js',DSH_NODE:process.execPath}});
  f.using(()=>{const manager=packageManagerCommand();assert.equal(manager.args[0],s.entry);
    assert.deepEqual(JSON.parse(runPnpm(['last'],f.dir)),{args:['first','a b','last'],marker:'js'});});
});
test('a selected unsupported shim fails without selecting a later PATH installation',win,()=>{
  const bad=join(root,'unsupported'),good=shim('later');put(join(bad,'pnpm.cmd'),'@exit /b 1');
  const f=configuration({command:'pnpm',env:{Path:[bad,good.bin,join(process.env.SystemRoot,'System32')].join(delimiter)}});
  f.using(()=>assert.throws(()=>packageManagerCommand(),e=>e.code==='FH_PNPM_CONFIG_INVALID'
    &&resolve(e.candidate).toLowerCase()===resolve(join(bad,'pnpm.cmd')).toLowerCase()));
});
test('explicit executable and Node plus JS preserve custom arguments and environment',()=>{
  const f=configuration({command:process.execPath,args:[observer,'custom'],env:{MANAGER_MARKER:'explicit'}});
  f.using(()=>{assert.equal(packageManagerCommand().command,process.execPath);
    assert.deepEqual(JSON.parse(runPnpm(['--last'],f.dir)),{args:['custom','--last'],marker:'explicit'});});
});
test('explicit installed pnpm JS remains executable',()=>{
  const cli=createRequire(join(pkg,'package.json')).resolve('pnpm/bin/pnpm.mjs');
  const f=configuration({command:process.execPath,args:[cli]});
  f.using(()=>assert.match(runPnpm(['--version'],f.dir),/^12\.4\.2/));
});
test('explicit DSH plus pnpm JS preserves run-as-node and configured env',{
  skip:process.env.FISH_TEST_DSH_EXEC_PATH?false:'FISH_TEST_DSH_EXEC_PATH not configured; actual DSH integration unknown'},()=>{
  const cli=createRequire(join(pkg,'package.json')).resolve('pnpm/bin/pnpm.mjs');
  const f=configuration({command:process.env.FISH_TEST_DSH_EXEC_PATH,args:[cli],env:{ELECTRON_RUN_AS_NODE:'1',MANAGER_MARKER:'desktop'}});
  f.using(()=>{assert.equal(packageManagerCommand().env.ELECTRON_RUN_AS_NODE,'1');assert.match(runPnpm(['--version'],f.dir),/^12\.4\.2/);});
});
test('invalid explicit executable reports original creation cause without fallback',()=>{
  const missing=join(root,'missing-manager.exe'),f=configuration({command:missing});
  f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.code==='PKG_BUILD_FAILED'&&e.pnpmFailure.phase==='process-creation'
    &&e.pnpmFailure.causeCode==='ENOENT'&&e.pnpmFailure.path===missing&&/ENOENT/.test(e.pnpmFailure.causeMessage)));
});
test('invalid explicit shim reports command-resolution failure without fallback',win,()=>{
  const missing=join(root,'missing/pnpm.cmd'),f=configuration({command:missing});
  f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.pnpmFailure.phase==='command-resolution'&&e.pnpmFailure.causeCode==='FH_PNPM_CONFIG_INVALID'));
});
test('invalid DSH_NODE remains strict when a JS pnpm shim needs a runtime',win,()=>{
  const s=shim('bad-runtime'),f=configuration({command:s.shim,env:{DSH_NODE:join(root,'missing-node.exe')}});
  f.using(()=>assert.throws(()=>packageManagerCommand(),e=>e.code==='FH_NODE_CONFIG_INVALID'&&e.causeCode==='ENOENT'));
  assert.throws(()=>nativeNodeRuntime({env:{...process.env,DSH_NODE:join(root,'missing-node.exe')}}),e=>e.code==='FH_NODE_CONFIG_INVALID');
});
test('real nonzero exit retains status and redacts original diagnostics',()=>{
  const script=put(join(root,'exit.cjs'),"console.error('password=TOP_SECRET');process.exit(7)");
  const f=configuration({command:process.execPath,args:[script]});
  f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.pnpmFailure.phase==='process-exit'&&e.pnpmFailure.exitCode===7
    &&e.diagnostic==='EXIT_7'&&!JSON.stringify(e.pnpmFailure).includes('TOP_SECRET')&&!e.message.includes('TOP_SECRET')));
});
test('result processing and non-spawn exceptions are not misreported as process creation',()=>{
  const f=configuration({command:process.execPath,args:[observer]}),original=cp.execFileSync;
  try {
    cp.execFileSync=()=>null;syncBuiltinESMExports();
    f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.pnpmFailure.phase==='result-processing'&&e.pnpmFailure.causeName==='TypeError'));
    cp.execFileSync=()=>{throw new TypeError('unexpected invocation error')};syncBuiltinESMExports();
    f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.pnpmFailure.phase==='execution'&&e.diagnostic!=='PROCESS_START_FAILED'));
    for(const code of ['ETIMEDOUT','ENOBUFS']) {
      cp.execFileSync=()=>{throw Object.assign(new Error(code),{code,syscall:'spawnSync node'})};syncBuiltinESMExports();
      f.using(()=>assert.throws(()=>runPnpm(['pack'],f.dir),e=>e.pnpmFailure.phase==='execution'&&e.pnpmFailure.causeCode===code));
    }
  } finally {cp.execFileSync=original;syncBuiltinESMExports();}
});
test('actual prepare IPC and final adapter result retain the pnpm creation error',async()=>{
  const f=configuration({command:join(root,'missing-ipc-manager.exe')});
  await f.using(async()=>{
    const adapter=createMarketBodyAdapter({profileDir:f.profile});let deploy=0;
    const result=await adapter.run({args:['install'],deploy:()=>{deploy++;throw Error('unexpected deployment')}});
    assert.equal(deploy,0);assert.equal(result.exitCode,1);assert.equal(result.wroteNothing,true);
    assert.ok(result.pnpmFailure,JSON.stringify(result));
    assert.equal(result.pnpmFailure.phase,'process-creation');assert.equal(result.pnpmFailure.causeCode,'ENOENT');
    assert.match(result.pnpmFailure.causeMessage,/missing-ipc-manager/);assert.match(result.stderr,/ENOENT/);
  });
});
test.after(()=>console.log(JSON.stringify({implementation:pkg,root})));
