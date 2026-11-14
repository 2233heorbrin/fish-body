import { nativeNodeRuntime } from './runtime-programs.mjs';
// One optional dshmarket seam. Native manager remains alive when body is off,
// so re-enabling uses the same bundle selection/lifecycle, not another switch.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadProductionState, assertProfileAllowed, refreshProductionState, stateConfigPath } from '../production-state.mjs';
import { projectPlugin } from '../registry-adapter.mjs';
import { readBodyPhase, withBodyOperation } from './body-switch.mjs';
import { samePath } from './path-identity.mjs';
import { atomicJson } from './w6-utils.mjs';
import { expectedDeployedHashes, verifyDeployedContent } from './w6-deploy.mjs';
import { parseInstallSpecs, classifyPnpmArgs } from '../fish-hand-admission-gate.mjs';

const SLOT=Symbol.for('fish-body.market.v1');
const state=globalThis[SLOT]??= {managers:new Map()};
state.managers??=new Map();
state.forProfile=profileDir=>{
  const row=[...state.managers.values()].find(r=>samePath(r.profileDir,profileDir));
  // A native manager exists for Profiles without body, too. Its mere presence
  // does not authorize body to claim their market operations.
  return row&&existsSync(join(profileDir,'node_modules/fish-body/package.json'))
    ?(row.adapter??createMarketBodyAdapter({profileDir,switchBody:row.change})):null;
};
export function registerMarketManager(profileDir,change,adapter=null) {
  const token={}; state.managers.set(token,{profileDir,change,adapter});
  return ()=>state.managers.delete(token);
}
function confFor(profileDir) {assertProfileAllowed(profileDir);return loadProductionState();}
function registryOf(conf) {const doc=JSON.parse(readFileSync(conf.registryPath,'utf8'));if(!Array.isArray(doc.plugins))doc.plugins=Object.values(doc.plugins??{});return doc;}
function allVersions(doc) {return doc.plugins.flatMap(r=>[r,...r.previousVersions??[]]);}
export function restorePreparedRegistration(conf,previous,prepared) {
  if(!prepared)return;
  const doc=registryOf(conf),current=doc.plugins.find(r=>r.packageName===prepared.packageName);
  if(current?.spec!==prepared.spec)return;
  const history=allVersions(doc).filter(r=>r.packageName===prepared.packageName&&r.spec!==previous?.spec)
    .map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>k!=='previousVersions')));
  doc.plugins=doc.plugins.filter(r=>r.packageName!==prepared.packageName);
  doc.plugins.push(previous?{...previous,previousVersions:history}:{...current,state:'prepared',active:false});
  atomicJson(conf.registryPath,doc);refreshProductionState();
}
function redactProcessOutput(value) {
  return String(value??'')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/([?&](?:token|access_token|auth|key|api_key|signature|sig)=)[^&\s]+/gi,'$1[redacted]')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)[^\r\n]+/gi,'$1[redacted]')
    .replace(/((?:_authToken|_auth|password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]')
    .slice(-12000);
}
function prepareProcessError(code,message,cause,details={}) {
  const suffix=cause?.message?': '+cause.message:'';
  return Object.assign(new Error(code+': '+message+suffix),{code,causeCode:cause?.code??null,...details});
}
export function prepareInChild(input,{signal,onStage=()=>{},entry=fileURLToPath(new URL('./market-prepare.mjs',import.meta.url)),runtime=null,forkProcess=fork}={}) {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let selected;
    try {selected=runtime??nativeNodeRuntime();}
    catch(error) {reject(error);return;}
    const childEnv={...(selected.env??process.env)};
    const statePath=stateConfigPath();
    if(statePath)childEnv.FISH_HAND_STATE=statePath;else delete childEnv.FISH_HAND_STATE;
    let child;
    try {child=forkProcess(entry,[],{execPath:selected.command,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,env:childEnv});}
    catch(cause) {reject(prepareProcessError('FH_MARKET_PREPARE_START_FAILED','准备进程启动失败',cause,{runtime:selected.command,runtimeSource:selected.source}));return;}
    let result,resultSeen=false,structuredError=null,stderr='',exitCode=null,exitSignal=null,killer=null,finished=false;
    const failures=[];
    const recordFailure=(kind,code,cause)=>{if(finished)return;failures.push({kind,code,cause});};
    const terminate=()=>{
      if(killer||child.exitCode!==null||child.signalCode!==null)return;
      if(process.platform==='win32'&&child.pid)killer=new Promise(done=>{
        const kill=spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
        kill.once('close',done);kill.once('error',()=>{try{child.kill();}catch{}done();});
      });
      else {try{child.kill('SIGTERM');}catch{}}
    };
    const cancel=()=>terminate();
    const onStderr=buffer=>{stderr+=buffer.toString();};
    const onMessage=message=>{
      if(message?.stage)try {onStage(message.stage);} catch(cause) {
        recordFailure('stage','FH_MARKET_PREPARE_STAGE_FAILED',cause);terminate();return;
      }
      if(Object.hasOwn(message??{},'value')){result=message.value;resultSeen=true;}
      if(message?.error)structuredError=Object.assign(new Error(message.error.message),message.error);
    };
    const onError=cause=>recordFailure('process','FH_MARKET_PREPARE_START_FAILED',cause);
    const onExit=(code,childSignal)=>{exitCode=code;exitSignal=childSignal;};
    const cleanup=()=>{
      signal?.removeEventListener('abort',cancel);
      child.stderr?.off('data',onStderr);child.off('message',onMessage);child.off('error',onError);child.off('exit',onExit);child.off('close',onClose);
    };
    const onClose=async(code,childSignal)=>{
      if(finished)return;finished=true;
      await killer;exitCode=code??exitCode;exitSignal=childSignal??exitSignal;cleanup();
      const details={runtime:selected.command,runtimeSource:selected.source,exitCode,signal:exitSignal,stderr:redactProcessOutput(stderr),
        processErrors:failures.map(row=>({kind:row.kind,code:row.cause?.code??row.code,message:row.cause?.message??String(row.cause)}))};
      if(signal?.aborted){reject(Object.assign(new Error('准备已取消；未部署，可手动重试'),{name:'AbortError',code:'FH_MARKET_CANCELLED',...details}));return;}
      if(resultSeen&&(exitCode!==0||exitSignal)){reject(prepareProcessError('FH_MARKET_PREPARE_EXIT_AFTER_RESULT','准备进程返回结果后异常退出',null,details));return;}
      if(structuredError){reject(Object.assign(structuredError,details));return;}
      if(failures.length){const first=failures[0];reject(prepareProcessError(first.code,first.kind==='ipc'?'准备进程通信失败':'准备进程启动或运行失败',first.cause,details));return;}
      if(resultSeen){resolve(result);return;}
      reject(prepareProcessError('FH_MARKET_PREPARE_EXIT','准备进程未返回结果；未安装',null,details));
    };
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    child.stderr?.on('data',onStderr);child.on('message',onMessage);child.on('error',onError);child.on('exit',onExit);child.once('close',onClose);
    if(!child.connected){recordFailure('ipc','FH_MARKET_PREPARE_IPC_FAILED',new Error('IPC channel is not connected'));terminate();return;}
    try {child.send(input,error=>{if(error){recordFailure('ipc','FH_MARKET_PREPARE_IPC_FAILED',error);terminate();}});}
    catch(error) {recordFailure('ipc','FH_MARKET_PREPARE_IPC_FAILED',error);terminate();}
  });
}
function selectVersion(conf,profileDir,spec) {
  const doc=registryOf(conf),row=allVersions(doc).find(r=>r.spec===spec&&r.requestId&&r.formalDecisionId);
  if(!row)return null;
  const projected=projectPlugin({...row,state:'ready'},conf);
  if(!projected.candidate || !samePath(projected.candidate.request.targetProfile,profileDir))
    throw new Error('FH_MARKET_MANAGED_ARTIFACT_INVALID: 旧受管产物或目标绑定无效');
  const old=doc.plugins.find(r=>r.packageName===row.packageName);
  if(old?.spec===row.spec&&['ready','installed','active'].includes(old.state))return {packageName:row.packageName,version:row.version,spec:row.spec,requestId:row.requestId};
  const history=allVersions(doc).filter(r=>r.packageName===row.packageName&&r.spec!==row.spec)
    .map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>k!=='previousVersions')));
  doc.plugins=doc.plugins.filter(r=>r.packageName!==row.packageName);
  doc.plugins.push({...row,state:'ready',previousVersions:history});atomicJson(conf.registryPath,doc);refreshProductionState();
  return {packageName:row.packageName,version:row.version,spec:row.spec,requestId:row.requestId};
}
function verifyResult(conf,profileDir,prepared) {
  const current=loadProductionState().candidates?.[prepared.packageName];
  const declared=JSON.parse(readFileSync(join(profileDir,'package.json'),'utf8')).dependencies?.[prepared.packageName];
  const installed=JSON.parse(readFileSync(join(profileDir,'node_modules',prepared.packageName,'package.json'),'utf8'));
  if(!current || declared!==prepared.spec || current.spec!==prepared.spec || installed.name!==prepared.packageName || installed.version!==prepared.version)
    throw new Error('FH_MARKET_DEPLOY_IDENTITY_MISMATCH: 安装身份未与受管包对应');
  const expected=expectedDeployedHashes({artifactDir:current.artifactDir,packageName:current.packageName,
    packageRecord:current.admission.packageRecord,dependencySubtree:current.admission.packageRecord.dependencySubtree,profileDir});
  const verified=verifyDeployedContent({profileDir,expected,packageNames:[prepared.packageName]});
  if(!verified.ok)throw new Error('FH_MARKET_DEPLOY_CONTENT_MISMATCH: 安装内容未与受管包对应');
  return {packageName:prepared.packageName,version:prepared.version,spec:prepared.spec};
}
export function createMarketBodyAdapter({profileDir,switchBody=null,prepare=prepareInChild,prepareLocal=false}) {
  return {
    profileDir,
    managedSpec(name,spec) {
      if(readBodyPhase({profileDir}).phase!=='on')return false;
      const conf=confFor(profileDir),row=allVersions(registryOf(conf)).find(r=>r.packageName===name&&r.spec===spec&&r.formalDecisionId);
      return !!row&&!!projectPlugin({...row,state:'ready'},conf).candidate;
    },
    ownsSwitch:name=>name==='fish-body'&&!!switchBody,
    async setEnabled(name,enabled) {if(name!=='fish-body'||!switchBody)return null;return switchBody(enabled);},
    async run({args,signal,onStage=()=>{},deploy,registryUrl=null}) {
      const phase=readBodyPhase({profileDir}).phase;
      if(phase==='off')return null; // no registry reads/audit while off
      if(phase==='closing')return {exitCode:1,timedOut:false,cancelled:false,stdout:'',stderr:'鱼的身体正在关闭，请稍后重试',wroteNothing:true};
      const classified=classifyPnpmArgs(args);
      if(!['install','repair','update'].includes(classified.op))return null;
      const conf=confFor(profileDir);
      return withBodyOperation(profileDir,async()=>{
        let deployed=false,prepared=null,previous=null,repairPrepared=[],repairPrevious=[];
        try {
          signal?.throwIfAborted();
          if(classified.op==='repair') {
            // Exact managed files stay bound; unmanaged existing dependencies are
            // repaired by native pnpm. Never invent historical approvals.
            repairPrevious=registryOf(conf).plugins;
            const deps=JSON.parse(readFileSync(join(profileDir,'package.json'),'utf8')).dependencies??{};
            for(const spec of Object.values(deps))if(typeof spec==='string'&&spec.startsWith('file:'))selectVersion(conf,profileDir,spec);
            const plan=await prepare({frameworkRoot:dirname(conf.handRoot),profileDir,repair:true,registryUrl,requestId:'market-'+randomUUID()},{signal,onStage});
            repairPrepared=plan.prepared??[];
            for(const p of repairPrepared)selectVersion(conf,profileDir,p.spec);
            onStage('原生修复既有依赖，受管插件使用已审安装包');
            signal?.throwIfAborted();deployed=true;
            const result=await deploy(plan.prepared?.length?['add',...plan.prepared.map(p=>p.spec)]:args);
            if(result.exitCode!==0||result.cancelled||result.timedOut)for(const p of repairPrepared)
              restorePreparedRegistration(conf,repairPrevious.find(r=>r.packageName===p.packageName),p);
            if(result.exitCode===0&&!result.cancelled&&!result.timedOut) {
              for(const p of plan.prepared??[])verifyResult(conf,profileDir,p);
              for(const r of plan.resolutions??[]) {
                const meta=JSON.parse(readFileSync(join(profileDir,'node_modules',r.packageName,'package.json'),'utf8'));
                if(meta.version!==r.version)throw new Error('FH_MARKET_REPAIR_VERSION_DRIFT: '+r.packageName+' 实际版本偏离本次修复计划');
              }
            }
            return {...result,bodyHandled:true,repairResolutions:plan.resolutions??[]};
          }
          const {specs,subcommand}=parseInstallSpecs(args);
          if(specs.length!==1)return null; // market schedules each package; don't add another batch scheduler
          const raw=specs[0];
          const beforeRows=registryOf(conf).plugins;
          if(/^(file|link):/i.test(raw)) {
            prepared=selectVersion(conf,profileDir,raw);
            if(!prepared && prepareLocal) prepared=await prepare({frameworkRoot:dirname(conf.handRoot),profileDir,spec:raw,
              registryUrl,requestId:'market-'+randomUUID()},{signal,onStage});
            if(!prepared)return null; // legacy market adapters retain their existing local-package contract
          } else {
            const match=/^(@[^/\s]+\/[^@\s]+|[^@/:\s]+)(?:@([^\s]+))?$/.exec(raw);
            const github=/^(?:github:|git\+https:\/\/github.com\/|https:\/\/github.com\/)/.test(raw);
            if(!match&&!github)return null;
            const sourceUrl=github?raw.replace(/^github:/,'https://github.com/').replace(/^git\+/,'').split('#')[0]:null;
            const fixed=match&&/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(match[2]??'')?match[2]:null;
            prepared=await prepare({frameworkRoot:dirname(conf.handRoot),profileDir,spec:raw,
              packageName:match?.[1]??null,version:fixed,sourceUrl,registryUrl,requestId:'market-'+randomUUID()}, {signal,onStage});
          }
          previous=beforeRows.find(r=>r.packageName===prepared.packageName)??null;
          signal?.throwIfAborted();
          selectVersion(conf,profileDir,prepared.spec);
          // No installation lock has been acquired during preparation. One
          // original native call owns final locks, snapshots and rollback.
          deployed=true;
          const commandIndex=args.indexOf(subcommand);
          const result=await deploy([...args.slice(0,commandIndex),'add',...args.slice(commandIndex+1).filter(a=>a!==raw),prepared.spec]);
          if(result.exitCode!==0||result.timedOut||result.cancelled) {
            restorePreparedRegistration(conf,previous,prepared);
            return {...result,bodyHandled:true};
          }
          const managedLocal=verifyResult(conf,profileDir,prepared);
          return {...result,bodyHandled:true,managedLocal,resolvedNpmVersion:prepared.version};
        }catch(error) {
          restorePreparedRegistration(conf,previous,prepared);
          for(const p of repairPrepared)restorePreparedRegistration(conf,repairPrevious.find(r=>r.packageName===p.packageName),p);
          const cancelled=signal?.aborted||error.name==='AbortError';
          const reasons=(error.reasons??[]).map(r=>`${r.file}:${r.line} (${r.kind})`).join('; ');
          const failure=error.pnpmFailure;
          const processDiagnostic=[error.stderr,Number.isInteger(error.exitCode)?'exitCode='+error.exitCode:null,error.signal?'signal='+error.signal:null,
            error.causeCode?'causeCode='+error.causeCode:null].filter(Boolean).join('\n');
          return {exitCode:cancelled?130:1,timedOut:false,cancelled,stdout:failure?.stdout??'',stderr:[error.message,reasons,processDiagnostic,failure?.stderr].filter(Boolean).join('\n'),
            ...(failure?{pnpmFailure:failure,pnpmError:error.message,pnpmErrorCode:failure.code}:{}),
            wroteNothing:!deployed,bodyHandled:true,refusalCode:error.code??(cancelled?'FH_MARKET_CANCELLED':'FH_MARKET_FAILED')};
        }
      });
    },
  };
}
