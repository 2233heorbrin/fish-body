import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const install=process.env.FISH_TEST_INSTALL_ROOT;
if(!install)throw new Error('FISH_TEST_INSTALL_ROOT is required');
const packageRoot=join(install,'node_modules','fish-body');
const backend=join(packageRoot,'internal','backend');
const {prepareInChild}=await import(pathToFileURL(join(backend,'lib','market-runtime.mjs')));
const {nativeNodeRuntime}=await import(pathToFileURL(join(backend,'lib','runtime-programs.mjs')));
const ROOT=process.env.FISH_TEST_WORK_ROOT??join(tmpdir(),'fh-prepare-'+Date.now());
mkdirSync(ROOT,{recursive:true});
const registry=createServer((_request,response)=>{response.statusCode=404;response.setHeader('content-type','application/json');response.end('{}');});
registry.listen(0,'127.0.0.1');await once(registry,'listening');
const REGISTRY='http://127.0.0.1:'+registry.address().port;

function directory(name) {const value=join(ROOT,name);mkdirSync(value,{recursive:true});return value;}
function script(name,body) {const value=join(directory('scripts'),name);writeFileSync(value,body);return value;}
// Use the installed dependency by default. An explicit executable can reuse an
// already provisioned manager when optional native pnpm packages are absent.
const testManager=process.env.FISH_TEST_PNPM
  ?{command:resolve(process.env.FISH_TEST_PNPM),args:[]}
  :{command:process.execPath,args:[createRequire(realpathSync(join(packageRoot,'package.json'))).resolve('pnpm/bin/pnpm.mjs')]};
// Missing optional desktop integration is a skip; an invalid supplied path fails.
const dsh=process.env.FISH_TEST_DSH_EXEC_PATH;
const dshTest={skip:dsh?false:'FISH_TEST_DSH_EXEC_PATH is not configured; desktop integration unknown'};
const stateRoot=directory('state'),stateProfile=directory('state/profiles/profile'),hand=directory('state/hand');
const registryPath=join(hand,'插件注册表','registry.json'),testStatePath=join(stateRoot,'view.json');
mkdirSync(dirname(registryPath),{recursive:true});writeFileSync(registryPath,JSON.stringify({plugins:[]}));
writeFileSync(testStatePath,JSON.stringify({candidates:{}}));writeFileSync(join(stateProfile,'package.json'),JSON.stringify({name:'state-profile',private:true}));
const STATE_PATH=join(stateRoot,'state.json');
writeFileSync(STATE_PATH,JSON.stringify({mode:'isolation',testStatePath,registryPath,artifactsRoot:join(hand,'插件仓'),
  decisionsRoot:join(hand,'插件注册表','decisions'),profileRoot:join(stateRoot,'profiles'),defaultProfileDir:stateProfile,
  snapshotRoot:join(hand,'运行数据','snapshots'),reportDir:join(hand,'运行数据','reports'),auditPath:join(hand,'审计日志','state.jsonl'),
  packageManager:testManager}));
const originalStatePath=process.env.FISH_HAND_STATE;
process.env.FISH_HAND_STATE=STATE_PATH;
function isolatedEnv(name,extra={}) {
  const root=directory(join('env',name));
  const env={...process.env,FISH_HAND_STATE:STATE_PATH,...extra,TEMP:join(root,'temp'),TMP:join(root,'temp'),TMPDIR:join(root,'temp'),HOME:join(root,'home'),
    USERPROFILE:join(root,'home'),APPDATA:join(root,'appdata'),LOCALAPPDATA:join(root,'localappdata'),DSH_HOME:join(root,'dsh-home'),
    DSH_AGENTS_HOME:join(root,'dsh-agents'),npm_config_cache:join(root,'npm-cache'),PNPM_HOME:join(root,'pnpm-home'),
    pnpm_config_store_dir:join(root,'pnpm-store')};
  for(const key of ['TEMP','HOME','APPDATA','LOCALAPPDATA','DSH_HOME','DSH_AGENTS_HOME','npm_config_cache','PNPM_HOME','pnpm_config_store_dir'])
    mkdirSync(env[key],{recursive:true});
  delete env.FISH_HAND_DSH_ROOT;
  return env;
}
function profile(name) {
  const frameworkRoot=directory(join(name,'framework')),profileDir=directory(join(name,'profile'));
  writeFileSync(join(profileDir,'package.json'),JSON.stringify({name:'test-profile',private:true,dependencies:{}}));
  return {frameworkRoot,profileDir,repair:true,requestId:name,registryUrl:REGISTRY};
}
const prepareHelper=script('prepare-helper.mjs',[
  "import {join} from 'node:path';",
  "import {pathToFileURL} from 'node:url';",
  "const [install,inputText]=process.argv.slice(2);",
  "if(process.env.PREPARE_NODE_OPTIONS)process.env.NODE_OPTIONS=process.env.PREPARE_NODE_OPTIONS;",
  "const {prepareInChild}=await import(pathToFileURL(join(install,'node_modules','fish-body','internal','backend','lib','market-runtime.mjs')));",
  "try{const result=await prepareInChild(JSON.parse(inputText));process.stdout.write(JSON.stringify({ok:true,result}));}",
  "catch(error){process.stdout.write(JSON.stringify({ok:false,error:{name:error.name,code:error.code,message:error.message,causeCode:error.causeCode,exitCode:error.exitCode,signal:error.signal,stderr:error.stderr,processErrors:error.processErrors}}));}"
].join('\n'));
function helperPrepare(name,input,extra={}) {
  const run=spawnSync(process.execPath,[prepareHelper,install,JSON.stringify(input)],{encoding:'utf8',windowsHide:true,timeout:120000,
    env:isolatedEnv(name,{...extra,FISH_TEST_INSTALL_ROOT:install})});
  assert.equal(run.error,undefined,run.error?.message);assert.equal(run.status,0,run.stderr);
  return JSON.parse(run.stdout);
}

function runCacheCase(name,operation) {
  const helper=script(name+'.mjs',[
    "import assert from 'node:assert/strict';import{basename,dirname,join,delimiter}from'node:path';import{mkdirSync}from'node:fs';",
    "import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';",
    "const [runtimeUrl,root]=process.argv.slice(2);const {nativeNodeRuntime}=await import(runtimeUrl);",
    "const originalEnv={...process.env},originalExecPath=process.execPath,originalCwd=process.cwd();",
    "try{("+operation.toString()+")(nativeNodeRuntime,{root,originalExecPath});console.log(JSON.stringify({cacheCase:"+JSON.stringify(name)+",status:'pass'}));}",
    "finally{process.execPath=originalExecPath;process.chdir(originalCwd);for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv);}"
  ].join('\n'));
  const env=isolatedEnv(name);delete env.DSH_NODE;delete env.ELECTRON_RUN_AS_NODE;
  const run=spawnSync(process.execPath,[helper,pathToFileURL(join(backend,'lib','runtime-programs.mjs')).href,directory(name)],{
    env,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(run.error,undefined,run.error?.message);assert.equal(run.status,0,run.stderr);
  console.log(run.stdout.trim());
}

test('no-argument cache rejects invalid DSH_NODE after a valid explicit selection',()=>{
  runCacheCase('cache-invalid',(nativeNodeRuntime,{root,originalExecPath})=>{
    process.env.DSH_NODE=originalExecPath;
    assert.equal(nativeNodeRuntime().command,originalExecPath);
    process.env.DSH_NODE=join(root,'missing-node.exe');
    let observed;
    assert.throws(()=>nativeNodeRuntime(),error=>{observed=error.code;return error.code==='FH_NODE_CONFIG_INVALID';});
    console.log(JSON.stringify({transition:'valid explicit -> invalid explicit',code:observed}));
    process.env.DSH_NODE=originalExecPath;
    assert.equal(nativeNodeRuntime().command,originalExecPath);
    process.env.NODE_OPTIONS='--require='+join(root,'workload-only.cjs');
    assert.equal(nativeNodeRuntime().env.NODE_OPTIONS,process.env.NODE_OPTIONS);
  });
});

test('no-argument cache respects fallback to explicit and explicit configuration changes',()=>{
  runCacheCase('cache-selection',(nativeNodeRuntime,{originalExecPath})=>{
    delete process.env.DSH_NODE;
    assert.equal(nativeNodeRuntime().source,'process.execPath');
    process.env.DSH_NODE=originalExecPath;
    assert.equal(nativeNodeRuntime().source,'DSH_NODE');
    const alias=dirname(originalExecPath)+'/./'+basename(originalExecPath);
    process.env.DSH_NODE=alias;
    assert.equal(nativeNodeRuntime().command,alias);
    delete process.env.DSH_NODE;
    assert.equal(nativeNodeRuntime().source,'process.execPath');
  });
});

test('no-argument cache invalidates PATH fallback when the search path changes',{skip:process.platform!=='win32'&&'Windows PATH regression'},()=>{
  runCacheCase('cache-path',(nativeNodeRuntime,{root,originalExecPath})=>{
    process.execPath=join(root,'desktop-host.exe');
    delete process.env.DSH_NODE;delete process.env.ELECTRON_RUN_AS_NODE;
    for(const key of Object.keys(process.env))if(key.toLowerCase()==='path')delete process.env[key];
    const system=join(process.env.SystemRoot,'System32');
    process.env.Path=[dirname(originalExecPath),system].join(delimiter);
    assert.equal(nativeNodeRuntime().source,'PATH');
    process.env.Path=system;
    assert.throws(()=>nativeNodeRuntime(),error=>error.code==='FH_NODE_UNAVAILABLE');
  });
});

test('no-argument cache revalidates relative explicit commands after cwd changes',()=>{
  runCacheCase('cache-cwd',(nativeNodeRuntime,{root,originalExecPath})=>{
    const other=join(root,'other');mkdirSync(other);
    process.chdir(dirname(originalExecPath));process.env.DSH_NODE='./'+basename(originalExecPath);
    assert.equal(nativeNodeRuntime().source,'DSH_NODE');
    process.chdir(other);
    assert.throws(()=>nativeNodeRuntime(),error=>error.code==='FH_NODE_CONFIG_INVALID');
  });
});

test('no-argument cache revalidates the same executable when Electron mode changes',()=>{
  runCacheCase('cache-electron-mode',(nativeNodeRuntime,{originalExecPath})=>{
    // Model the launcher's required mode without starting a desktop GUI.
    // The actual DSH.exe run-as-node path is exercised by integration below.
    const originalProbe=cp.execFileSync;
    cp.execFileSync=(command,args,options)=>{
      if(command===originalExecPath&&options?.env?.ELECTRON_RUN_AS_NODE!=='1')
        throw Object.assign(new Error('synthetic launcher requires run-as-node'),{code:'ERUNASNODE'});
      return originalProbe(command,args,options);
    };
    syncBuiltinESMExports();
    try{
      process.env.DSH_NODE=originalExecPath;process.env.ELECTRON_RUN_AS_NODE='1';
      assert.equal(nativeNodeRuntime().source,'DSH_NODE');
      process.env.ELECTRON_RUN_AS_NODE='0';
      assert.throws(()=>nativeNodeRuntime(),error=>error.code==='FH_NODE_CONFIG_INVALID'&&error.causeCode==='ERUNASNODE');
      process.env.ELECTRON_RUN_AS_NODE='1';
      assert.equal(nativeNodeRuntime().env.ELECTRON_RUN_AS_NODE,'1');
    }finally{cp.execFileSync=originalProbe;syncBuiltinESMExports();}
  });
});

test('actual installed prepare entry completes an empty repair under normal Node',async()=>{
  const result=await prepareInChild(profile('normal'),{runtime:{command:process.execPath,env:isolatedEnv('normal-runtime'),source:'test-node'}});
  assert.deepEqual(result,{repair:true,prepared:[],resolutions:[]});
});

test('DSH.exe with run-as-node completes the actual installed prepare entry',dshTest,()=>{
  assert.ok(existsSync(dsh),'configured DSH.exe must exist');
  const result=helperPrepare('dsh-prepare',profile('dsh-prepare'),{DSH_NODE:dsh,ELECTRON_RUN_AS_NODE:'1'});
  assert.equal(result.ok,true,JSON.stringify(result.error));assert.deepEqual(result.result,{repair:true,prepared:[],resolutions:[]});
});

test('fallback package-manager command carries the DSH runtime environment',dshTest,()=>{
  assert.ok(existsSync(dsh),'configured DSH.exe must exist');
  const helper=script('manager-helper.mjs',[
    "import{join}from'node:path';import{pathToFileURL}from'node:url';",
    "const root=process.argv[2];const {packageManagerCommand}=await import(pathToFileURL(join(root,'node_modules','fish-body','internal','backend','lib','runtime-programs.mjs')));",
    "const value=packageManagerCommand();process.stdout.write(JSON.stringify({command:value.command,args:value.args,source:value.runtimeSource,electron:value.env?.ELECTRON_RUN_AS_NODE}));"
  ].join('\n'));
  const run=spawnSync(process.execPath,[helper,install],{encoding:'utf8',windowsHide:true,
    env:isolatedEnv('manager-fallback',{DSH_NODE:dsh,ELECTRON_RUN_AS_NODE:'1',FISH_HAND_STATE:join(ROOT,'missing-state.json')})});
  assert.equal(run.status,0,run.stderr);const value=JSON.parse(run.stdout);assert.equal(resolve(value.command).toLowerCase(),resolve(dsh).toLowerCase());
  assert.equal(value.source,'DSH_NODE');assert.equal(value.electron,'1');assert.match(value.args[0],/pnpm[\\/]bin[\\/]pnpm\.mjs$/);
});

test('invalid explicit DSH_NODE fails without fallback',()=>{
  const bad=join(ROOT,'missing-host.exe');
  assert.throws(()=>nativeNodeRuntime({env:{...isolatedEnv('bad-dsh'),DSH_NODE:bad},execPath:process.execPath,platform:process.platform}),error=>
    error.code==='FH_NODE_CONFIG_INVALID'&&error.candidate===bad);
});

test('PATH fallback skips shell shims and selects a directly executable node',{skip:process.platform!=='win32'&&'Windows shim regression'},()=>{
  const shims=directory('path-shims');writeFileSync(join(shims,'node'),'#!/bin/sh\nexit 1\n');writeFileSync(join(shims,'node.cmd'),'@exit /b 1\r\n');
  const env=isolatedEnv('path-fallback');delete env.PATH;delete env.Path;env.Path=[shims,dirname(process.execPath),join(env.SystemRoot,'System32')].join(delimiter);
  const selected=nativeNodeRuntime({env,execPath:join(ROOT,'DSH.exe'),platform:'win32'});
  assert.equal(resolve(selected.command).toLowerCase(),resolve(process.execPath).toLowerCase());assert.equal(selected.source,'PATH');
});

test('spawn failure is controlled and preserves the original cause',async()=>{
  const command=join(ROOT,'missing-node.exe');
  await assert.rejects(prepareInChild({}, {runtime:{command,env:isolatedEnv('spawn-failure'),source:'test-missing'}}),error=>
    error.code==='FH_MARKET_PREPARE_START_FAILED'&&error.causeCode==='ENOENT'&&error.processErrors?.[0]?.code==='ENOENT');
});

test('preload failure is reported through stderr and exit status',()=>{
  const preload=script('throw-preload.cjs',"throw new Error('SYNTHETIC_PRELOAD_FAILURE')\n");
  const result=helperPrepare('preload',profile('preload'),{PREPARE_NODE_OPTIONS:'--require='+JSON.stringify(preload)});
  assert.equal(result.ok,false);assert.equal(result.error.code,'FH_MARKET_PREPARE_EXIT');assert.notEqual(result.error.exitCode,0);
  assert.match(result.error.stderr,/SYNTHETIC_PRELOAD_FAILURE/);
});

test('missing entry reports module failure rather than a generic-only exit',async()=>{
  await assert.rejects(prepareInChild({}, {entry:join(ROOT,'missing-entry.mjs'),runtime:{command:process.execPath,env:isolatedEnv('missing-entry'),source:'test-node'}}),error=>
    error.code==='FH_MARKET_PREPARE_EXIT'&&error.exitCode!==0&&/MODULE_NOT_FOUND|Cannot find module/.test(error.stderr));
});

test('disconnect without a result ends as a controlled failure',async()=>{
  const entry=script('disconnect.mjs',"process.once('message',()=>{process.disconnect();setTimeout(()=>{process.exitCode=2},10)})\n");
  await assert.rejects(prepareInChild({}, {entry,runtime:{command:process.execPath,env:isolatedEnv('disconnect'),source:'test-node'}}),error=>
    error.code==='FH_MARKET_PREPARE_EXIT'&&error.exitCode===2);
});

test('send callback EPIPE and a later process error are both contained',async()=>{
  class FakeChild extends EventEmitter {
    constructor(){super();this.stderr=new PassThrough();this.connected=true;this.exitCode=null;this.signalCode=null;this.pid=0;}
    send(_input,callback){setImmediate(()=>{const first=Object.assign(new Error('synthetic EPIPE'),{code:'EPIPE'});callback(first);
      this.emit('error',Object.assign(new Error('secondary process error'),{code:'ESECOND'}));});return true;}
    kill(){this.connected=false;setImmediate(()=>{this.exitCode=1;this.emit('exit',1,null);this.stderr.end();this.emit('close',1,null);});return true;}
  }
  await assert.rejects(prepareInChild({}, {runtime:{command:process.execPath,env:isolatedEnv('fake-epipe'),source:'fake'},forkProcess:()=>new FakeChild()}),error=>
    error.code==='FH_MARKET_PREPARE_IPC_FAILED'&&error.causeCode==='EPIPE'&&error.processErrors?.some(row=>row.code==='ESECOND'));
});

test('a result followed by exit 7 is not reported as success',async()=>{
  const entry=script('result-exit.mjs',"process.once('message',()=>process.send({value:{ok:true}},()=>{process.exitCode=7;process.disconnect()}))\n");
  await assert.rejects(prepareInChild({}, {entry,runtime:{command:process.execPath,env:isolatedEnv('result-exit'),source:'test-node'}}),error=>
    error.code==='FH_MARKET_PREPARE_EXIT_AFTER_RESULT'&&error.exitCode===7);
});

test('cancellation terminates the child once and returns the cancellation code',async()=>{
  const pidFile=join(directory('cancel'),'pid.txt');
  const entry=script('cancel.mjs',"import{writeFileSync}from'node:fs';process.once('message',input=>{writeFileSync(input.pidFile,String(process.pid));process.send({stage:'running'});setInterval(()=>{},1000)})\n");
  const controller=new AbortController();let stages=0;
  await assert.rejects(prepareInChild({pidFile},{entry,signal:controller.signal,onStage:()=>{stages++;controller.abort();},
    runtime:{command:process.execPath,env:isolatedEnv('cancel'),source:'test-node'}}),error=>error.name==='AbortError'&&error.code==='FH_MARKET_CANCELLED');
  assert.equal(stages,1);const pid=Number(readFileSync(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0));
});

test('DSH.exe runtime drives pnpm and an authorized lifecycle build',dshTest,()=>{
  assert.ok(existsSync(dsh),'configured DSH.exe must exist');
  const helper=script('lifecycle-helper.mjs',[
    "import{join}from'node:path';import{mkdirSync,writeFileSync,existsSync}from'node:fs';import{pathToFileURL}from'node:url';",
    "const [install,root]=process.argv.slice(2),backend=join(install,'node_modules','fish-body','internal','backend');",
    "const {buildInstallPackage}=await import(pathToFileURL(join(backend,'lib','w6-package.mjs')));const {recomputeFiles}=await import(pathToFileURL(join(backend,'lib','artifact.mjs')));const {atomicJson,treeHashOf}=await import(pathToFileURL(join(backend,'lib','w6-utils.mjs')));",
    "const artifactDir=join(root,'artifact'),warehouse=join(artifactDir,'仓库');mkdirSync(warehouse,{recursive:true});atomicJson(join(warehouse,'package.json'),{name:'dsh-runtime-build',version:'1.0.0',main:'lib/index.js',files:['lib'],scripts:{prepare:'node build.cjs'}});writeFileSync(join(warehouse,'build.cjs'),\"const fs=require('fs');fs.mkdirSync('lib',{recursive:true});fs.writeFileSync('lib/index.js','module.exports=1')\");const files=recomputeFiles(warehouse);atomicJson(join(artifactDir,'manifest.json'),{contentFiles:files,contentHash:treeHashOf(files)});",
    "const result=buildInstallPackage({artifactDir,outDir:join(artifactDir,'out'),workRoot:join(root,'work'),packageName:'dsh-runtime-build',version:'1.0.0',revision:'fixed',production:true,registryUrl:process.env.TEST_REGISTRY_URL,approvedScopes:{installScripts:true},authorization:{buildScripts:{granted:true}}});process.stdout.write(JSON.stringify({ok:existsSync(join(result.runtimeDir,'lib','index.js')),commands:result.build.commands}));"
  ].join('\n'));
  const runRoot=directory('dsh-lifecycle');const run=spawnSync(process.execPath,[helper,install,runRoot],{encoding:'utf8',windowsHide:true,timeout:120000,
    env:isolatedEnv('dsh-lifecycle-env',{DSH_NODE:dsh,ELECTRON_RUN_AS_NODE:'1',FISH_TEST_INSTALL_ROOT:install,TEST_REGISTRY_URL:REGISTRY})});
  assert.equal(run.error,undefined,run.error?.message);assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).ok,true);
});

test.after(()=>{
  registry.close();
  if(originalStatePath===undefined)delete process.env.FISH_HAND_STATE;else process.env.FISH_HAND_STATE=originalStatePath;
  console.log(JSON.stringify({prepareProcessRoot:ROOT,installedPackage:packageRoot,registry:REGISTRY,
    packageManager:testManager,dshIntegration:dsh??'unknown (not configured)'}));
});
