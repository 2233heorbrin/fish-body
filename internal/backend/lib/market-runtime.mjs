import { nativeNodeRuntime } from './runtime-programs.mjs';
// One optional dshmarket seam. Native manager remains alive when body is off,
// so re-enabling uses the same bundle selection/lifecycle, not another switch.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadProductionState, assertProfileAllowed, refreshProductionState, stateConfigPath, withStateConfig } from '../production-state.mjs';
import { projectPlugin } from '../registry-adapter.mjs';
import { readBodyPhase, withBodyOperation } from './body-switch.mjs';
import { samePath, pathIdentity } from './path-identity.mjs';
import { atomicJson } from './w6-utils.mjs';
import { expectedDeployedHashes, verifyDeployedContent } from './w6-deploy.mjs';
import { parseInstallSpecs, classifyPnpmArgs } from '../fish-hand-admission-gate.mjs';
import { originalSourceOptions, installedSourceRecord } from './original-source.mjs';
// W2 纠正①②：直装来源登记 + 真实受管来源读取 + 原渠道更新目标（与 fish-body-optional seam 共用）。
import { registerDirectSource, directInstallIntent, readInstalledSource, directUpdateTarget,
  isDirectManagedLink, installedVersion, currentLinkRealPath, isWithinWarehouse, warehouseRoot } from './market-direct-source.mjs';
// 安装意图分流单点入口（补位后端落地，只读引用；Codex #315 #2 / 共享契约 §2）：
// 市场普通安装显式 installKind:'market' → 固定 off，绝不读持久化分析模式；
// 只有显式合法 intakeMode 才走 explicit，其余不在此处自造分析默认。
import { resolveInstallIntent } from '../../analysis/intake-mode.mjs';

/** 把市场 adapter 的全部函数方法包进 Profile 配置作用域（ALS），保留 this=adapter。
 *  Codex #324 / dev18 #1：市场经 SLOT.forProfile 拿到的 adapter 方法（managedDirectLink /
 *  directSourceRecord / directUpdateTarget / registerDirect ...）内部 confFor()→loadProductionState()
 *  依赖 withStateConfig 的 ALS 作用域；裸调会回退 FISH_HAND_STATE/deployedConfigPath 而 FH_STATE_MISSING。
 *  value.apply(adapter,args) 保证 directUpdateTarget 里的 this.directSourceRecord 仍指向同一 adapter。 */
export function withProfileStateScope(adapter, configPath) {
  return Object.fromEntries(Object.entries(adapter).map(([key, value]) =>
    [key, typeof value === 'function'
      ? (...args) => withStateConfig(configPath, () => value.apply(adapter, args))
      : value]));
}

const SLOT=Symbol.for('fish-body.market.v1');
const state=globalThis[SLOT]??= {managers:new Map()};
state.managers??=new Map();
state.forProfile=profileDir=>{
  const row=[...state.managers.values()].find(r=>samePath(r.profileDir,profileDir));
  // A native manager exists for Profiles without body, too. Its mere presence
  // does not authorize body to claim their market operations.
  if(!row||!existsSync(join(profileDir,'node_modules/fish-body/package.json')))return null;
  // Codex #324 / dev18 #1：注册进来的 adapter 必须已带 Profile 配置作用域（见 install-transaction）；
  // fallback（原生 manager 未传 adapter，如 body-manager-patch）现场造的 adapter 也要包作用域，
  // 否则市场调 managedDirectLink/directSourceRecord/directUpdateTarget 时裸调 confFor→FH_STATE_MISSING。
  if(row.adapter)return row.adapter;
  return withProfileStateScope(createMarketBodyAdapter({profileDir,switchBody:row.change}),
    join(profileDir,'fish-body-state.json'));
};
export function registerMarketManager(profileDir,change,adapter=null) {
  const token={}; state.managers.set(token,{profileDir,change,adapter});
  return ()=>state.managers.delete(token);
}
function confFor(profileDir) {assertProfileAllowed(profileDir);return loadProductionState();}
function registryOf(conf) {const doc=JSON.parse(readFileSync(conf.registryPath,'utf8'));if(!Array.isArray(doc.plugins))doc.plugins=Object.values(doc.plugins??{});return doc;}
function allVersions(doc) {return doc.plugins.flatMap(r=>[r,...r.previousVersions??[]]);}
export function restorePreparedRegistration(conf,previous,prepared) {
  if(!prepared?.spec)return;
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
export function prepareInChild(input,{signal,onStage=()=>{},timeoutMs=null,entry=fileURLToPath(new URL('./market-prepare.mjs',import.meta.url)),runtime=null,forkProcess=fork}={}) {
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
    let result,resultSeen=false,structuredError=null,stderr='',exitCode=null,exitSignal=null,killer=null,finished=false,fixedOriginal=null,timedOut=false;
    const timer=timeoutMs>0?setTimeout(()=>{timedOut=true;terminate();},timeoutMs):null;
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
      if(message?.source)fixedOriginal=message.source;
      if(message?.stage)try {onStage(message.stage);} catch(cause) {
        recordFailure('stage','FH_MARKET_PREPARE_STAGE_FAILED',cause);terminate();return;
      }
      if(Object.hasOwn(message??{},'value')){result=message.value;resultSeen=true;}
      if(message?.error)structuredError=Object.assign(new Error(message.error.message),message.error);
    };
    const onError=cause=>recordFailure('process','FH_MARKET_PREPARE_START_FAILED',cause);
    const onExit=(code,childSignal)=>{exitCode=code;exitSignal=childSignal;};
    const cleanup=()=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',cancel);
      child.stderr?.off('data',onStderr);child.off('message',onMessage);child.off('error',onError);child.off('exit',onExit);child.off('close',onClose);
    };
    const onClose=async(code,childSignal)=>{
      if(finished)return;finished=true;
      await killer;exitCode=code??exitCode;exitSignal=childSignal??exitSignal;cleanup();
      const details={runtime:selected.command,runtimeSource:selected.source,exitCode,signal:exitSignal,stderr:redactProcessOutput(stderr),fixedOriginal,
        processErrors:failures.map(row=>({kind:row.kind,code:row.cause?.code??row.code,message:row.cause?.message??String(row.cause)}))};
      if(signal?.aborted){reject(Object.assign(new Error('准备已取消；未部署，可手动重试'),{name:'AbortError',code:'FH_MARKET_CANCELLED',...details}));return;}
      if(timedOut){reject(prepareProcessError('FH_MARKET_ANALYSIS_TIMEOUT','准备分析超时；尚未部署',null,details));return;}
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
  if(prepared.original) {
    const installed=JSON.parse(readFileSync(join(profileDir,'node_modules',prepared.packageName,'package.json'),'utf8'));
    if(installed.name!==prepared.packageName||installed.version!==prepared.version)
      throw new Error('FH_MARKET_DEPLOY_IDENTITY_MISMATCH: 原包安装身份不符');
    const declared=JSON.parse(readFileSync(join(profileDir,'package.json'),'utf8')).dependencies?.[installed.name];
    return {packageName:installed.name,version:installed.version,spec:declared??'file:'+prepared.original.archive};
  }
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
export function createMarketBodyAdapter({profileDir,switchBody=null,prepare=prepareInChild,prepareLocal=false,sourcePreservationVersion=0}) {
  return {
    profileDir,
    managedSpec(name,spec) {
      if(readBodyPhase({profileDir}).phase!=='on')return false;
      const conf=confFor(profileDir),row=allVersions(registryOf(conf)).find(r=>r.packageName===name&&r.spec===spec&&r.formalDecisionId);
      return !!row&&!!projectPlugin({...row,state:'ready'},conf).candidate;
    },
    // W2 纠正①③：来源判定与更新不依赖 body phase（胃关但身体开照常）。
    // 返回「已成功安装的真实来源记录」；普通 repository 声明/未登记开发 link/generation link 返回 null。
    directSourceRecord(name,spec) {
      try {
        const conf=confFor(profileDir);
        return installedSourceRecord({frameworkRoot:dirname(conf.handRoot),profileDir,packageName:name,spec,
          registryRows:allVersions(registryOf(conf))});
      } catch { return null; }
    },
    // 市场 seam 用它判定某个 link 是否为本模块登记的受管直装 link（普通开发 link 维持原生）。
    managedDirectLink(name,spec) {
      try {
        const conf=confFor(profileDir);
        return isDirectManagedLink({frameworkRoot:dirname(conf.handRoot),profileDir,packageName:name,
          installedSpec:spec,registryRows:allVersions(registryOf(conf))});
      } catch { return false; }
    },
    // 原渠道更新目标：GitHub ref/subdir 或 npm registry/spec，直接交现有更新链；不查 catalog、不换源。
    directUpdateTarget(name,spec) {
      const record=this.directSourceRecord(name,spec);
      return record?directUpdateTarget(record):null;
    },
    // 直装成功后登记来源（registration-only，零胃分析/零模型请求）。由 body-manager 安装后 hook 调用。
    registerDirect({packageName,spec,sourceSpec=null,sourceUrl=null,sourceCommit=null,sourceSubdir='',registryUrl=null,
      version=null,contentHash=null,id=null,mode='off'}={}) {
      const frameworkRoot=dirname(confFor(profileDir).handRoot);
      return registerDirectSource({frameworkRoot,profileDir,packageName,installedSpec:spec,sourceSpec,
        sourceUrl,sourceCommit,sourceSubdir,registryUrl,version,contentHash,id,mode});
    },
    directInstallIntent(raw,options={}) { return directInstallIntent(raw,options); },
    ownsSwitch:name=>name==='fish-body'&&!!switchBody,
    async setEnabled(name,enabled) {if(name!=='fish-body'||!switchBody)return null;return switchBody(enabled);},
    // 模式权威判定：显式请求 > 持久化配置 > 系统默认（compatibility）。
    // 只决定「新请求」是否直装，与已确认任务/页面 tab 无关；胃关≠身体关，见 phase 分支。
    async run({args,signal,onStage=()=>{},deploy,registryUrl=null,intakeMode=null}) {
      // #315 #2：市场入口是普通安装，显式 installKind:'market' 命中 resolveInstallIntent ②固定 off，
      // 完全不读持久化；只有显式合法 intakeMode（①explicit）才覆盖。绝不落③被持久化分析模式污染。
      intakeMode=resolveInstallIntent({explicitIntakeMode:intakeMode,installKind:'market'}).mode;
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
            if(repairPrepared.some(p=>p.pendingDecision))return {exitCode:2,bodyHandled:true,wroteNothing:true,
              pendingDecision:{targets:repairPrepared.map(p=>({target:p.original?.requestedSpec??p.spec,
                original:p.original,analysis:p.analysis,managedSpec:p.original?null:p.spec,
                choice:p.pendingDecision?null:'install-intent'})),repair:true}};
            for(const p of repairPrepared)if(!p.original)selectVersion(conf,profileDir,p.spec);
            onStage('原生修复既有依赖，受管插件使用已审安装包');
            signal?.throwIfAborted();
            for(const p of repairPrepared)if(p.original&&!readFileSync(p.original.archive).equals(readFileSync(p.original.baseline)))
              throw new Error('FH_NPM_INTEGRITY_MISMATCH: 原包内容已改变');
            const fixedPackageSources=repairPrepared.flatMap(p=>originalSourceOptions(p.original,sourcePreservationVersion)?.fixedPackageSources??[]);
            deployed=true;
            const result=await deploy(plan.prepared?.length?['add',...plan.prepared.map(p=>p.original?'file:'+p.original.archive:p.spec),
              ...args.filter(a=>a.startsWith('--'))]:args,fixedPackageSources.length?{fixedPackageSources}:undefined);
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
              packageName:match?.[1]??null,version:fixed,sourceUrl,registryUrl,requestId:'market-'+randomUUID(),intakeMode}, {signal,onStage});
          }
          if(prepared.pendingDecision)return {exitCode:2,bodyHandled:true,wroteNothing:true,
            pendingDecision:{targets:[{target:raw,original:prepared.original,analysis:prepared.analysis}]}};
          previous=beforeRows.find(r=>r.packageName===prepared.packageName)??null;
          signal?.throwIfAborted();
          if(!prepared.original&&!prepared.directInstall)selectVersion(conf,profileDir,prepared.spec);
          // The native caller owns the Profile lock and deployment recovery.
          const commandIndex=args.indexOf(subcommand);
          if(prepared.original&&!readFileSync(prepared.original.archive).equals(readFileSync(prepared.original.baseline)))
            throw new Error('FH_NPM_INTEGRITY_MISMATCH: 原包内容已改变');
          const sourceOptions=originalSourceOptions(prepared.original,sourcePreservationVersion);
          deployed=true;
          const result=await deploy([...args.slice(0,commandIndex),'add',...args.slice(commandIndex+1).filter(a=>a!==raw),
            prepared.original?'file:'+prepared.original.archive:prepared.spec],sourceOptions);
          if(result.exitCode!==0||result.timedOut||result.cancelled) {
            restorePreparedRegistration(conf,previous,prepared);
            return {...result,bodyHandled:true};
          }
          // W2 纠正①：直装零分析后，只登记「已成功安装的真实来源」（registration-only），
          // 不建受管产物、不伪造审批。Codex #315 #1：登记前必须 realpath 核验原生 deploy 确实
          // 把 link 本体落在本模块准备的 bodyPath；不满足则如实报安装实际状态，绝不冒充全成功。
          if(prepared.directInstall) {
            const frameworkRoot=dirname(conf.handRoot);
            const pkgName=prepared.packageName??directInstallIntent(raw,{registryUrl})?.packageName;
            // ① realpath 核验：当前 Profile 的 link 本体必须真实落在本次准备的 bodyPath，且在插件仓内。
            const landedRealPath=currentLinkRealPath(profileDir,pkgName);
            const expectedBody=prepared.bodyPath?String(prepared.bodyPath).replace(/\\/g,'/'):null;
            const root=warehouseRoot(frameworkRoot);
            const landed=!!landedRealPath&&!!expectedBody
              &&pathIdentity(landedRealPath)===pathIdentity(expectedBody)
              &&isWithinWarehouse(landedRealPath,root);
            if(!landed) {
              // 原生安装没把本体落到手仓路径：如实标「本体未落仓」，不算入仓成功、不登记来源。
              return {...result,bodyHandled:true,directInstalled:false,bodyLanded:false,analysis:null,
                authorization:'intake-off-direct',
                sourceRegistration:{status:'body-not-landed',code:'FH_DIRECT_BODY_NOT_LANDED',
                  reason:'原生安装后 link 本体 realpath 未落在手仓版本目录，来源未登记',
                  expectedBodyPath:expectedBody,observedRealPath:landedRealPath}};
            }
            // ② 本体确已落仓，登记真实来源；身份字段取获取/解析阶段已核实的真实值。
            let source=null;
            try {
              const manifest=JSON.parse(readFileSync(join(profileDir,'package.json'),'utf8'));
              const installedSpec=manifest.dependencies?.[pkgName]??raw;
              const intent=directInstallIntent(raw,{registryUrl});
              source=registerDirectSource({frameworkRoot,profileDir,packageName:pkgName,installedSpec,
                sourceSpec:intent?.sourceSpec??prepared.sourceSpec??raw,
                sourceUrl:prepared.sourceUrl??intent?.sourceUrl,
                sourceCommit:intent?.sourceCommit,requestedRef:prepared.requestedRef??intent?.requestedRef,
                resolvedCommit:prepared.resolvedCommit??intent?.resolvedCommit,
                sourceSubdir:prepared.sourceSubdir??intent?.sourceSubdir,
                registryUrl:prepared.registryUrl??registryUrl,npmSpec:prepared.npmSpec??intent?.npmSpec,
                version:prepared.version??installedVersion(profileDir,pkgName),
                contentHash:prepared.contentHash,integrity:prepared.integrity,
                bodyPath:prepared.bodyPath,pluginsRoot:root,revision:prepared.acquisition?.revision,mode:'off'});
            } catch(error) {
              // 本体已落仓但登记失败：如实报「本体已装、来源未登记」，不冒充已登记。
              return {...result,bodyHandled:true,directInstalled:true,bodyLanded:true,analysis:null,
                sourceRegistration:{status:'failed',code:error.code??'FH_DIRECT_SOURCE_REGISTER_FAILED',reason:error.message}};
            }
            return {...result,bodyHandled:true,directInstalled:true,bodyLanded:true,analysis:null,authorization:'intake-off-direct',
              sourceRegistration:{status:'registered',sourceStatus:source.sourceStatus,packageName:source.packageName,
                targetProfile:source.targetProfile,linkRealPath:source.linkRealPath,contentIdentity:source.contentIdentity,
                contentDrift:false,updateChannel:source.updateChannel},
              runtimeReadiness:prepared.runtimeReadiness??null,
              acquisition:prepared.acquisition??null};
          }
          const managedLocal=verifyResult(conf,profileDir,prepared);
          return {...result,bodyHandled:true,...(prepared.original?{originalInstalled:true,analysis:prepared.analysis,
            authorization:prepared.authorization,fixedSource:prepared.original}:{managedLocal}),resolvedNpmVersion:prepared.version};
        }catch(error) {
          restorePreparedRegistration(conf,previous,prepared);
          for(const p of repairPrepared)restorePreparedRegistration(conf,repairPrevious.find(r=>r.packageName===p.packageName),p);
          const cancelled=signal?.aborted||error.name==='AbortError';
          if(!cancelled&&!deployed&&error.fixedOriginal&&!/INTEGRITY|ARCHIVE|IDENTITY|CONTENT_(?:DRIFT|MISMATCH)/.test(error.code??''))return {exitCode:2,bodyHandled:true,wroteNothing:true,
            pendingDecision:{targets:[{target:error.fixedOriginal.requestedSpec,original:error.fixedOriginal,
              analysis:{status:'failed',code:error.code,reason:error.message,stderr:error.stderr,causeCode:error.causeCode}}]}};
          if(!cancelled&&!deployed&&['FH_NODE_CONFIG_INVALID','FH_NODE_UNAVAILABLE','FH_MARKET_PREPARE_START_FAILED',
            'FH_MARKET_PREPARE_IPC_FAILED','FH_MARKET_PREPARE_EXIT'].includes(error.code))return {
            exitCode:2,bodyHandled:true,wroteNothing:true,nativeChoiceRequired:{code:error.code,reason:error.message,causeCode:error.causeCode,stderr:error.stderr}};
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
