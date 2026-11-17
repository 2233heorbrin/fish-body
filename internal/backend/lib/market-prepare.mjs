// Cancellable preparation child. A pending result ends the caller's lock scope.
import { pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runPnpm, preparePnpmWorkspace } from './w6-package.mjs';
import { nativeOfficialSpecs } from '../fish-hand-admission-gate.mjs';
import { npmCommand } from './runtime-programs.mjs';
import { reviewToolContent, marketError } from './market-source.mjs';
// Maintenance tree keeps the orchestrator beside the gate; installed modules
// reuse the approval host's existing orchestrator rather than copying it again.
import { FishHandOrchestrator } from '../fish-hand-orchestrator.mjs';

// Capture only files from the already acquired source. Never run candidate
// lifecycle scripts to create an original-package choice.
function fixedOriginal(collected, spec, requestId) {
  const source=collected.sourceDoc;
  let archive=source.published?.tarballPath,integrity=source.published?.integrity;
  if(!archive) {
    const destination=join(dirname(collected.riceDir),'original-'+requestId);
    mkdirSync(destination,{recursive:true});
    const cli=npmCommand();
    const rows=JSON.parse(execFileSync(cli.exe,[...cli.args,'pack','--ignore-scripts','--json','--pack-destination',destination],
      {cwd:join(collected.riceDir,'仓库'),env:cli.env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}));
    if(rows.length!==1)throw marketError('FH_ORIGINAL_PACKAGE_INVALID','固定源码没有生成唯一原包');
    archive=join(destination,rows[0].filename);
    integrity=rows[0].integrity;
  }
  const baseline=join(dirname(archive),requestId+'-original.bytes');
  writeFileSync(baseline,readFileSync(archive));
  return {archive,baseline,integrity,
    packageName:source.packageJson.name,version:source.packageJson.version,requestedSpec:spec,
    pinnedCommit:source.pinnedCommit,subdir:source.subdir??'',contentHash:source.contentHash,
    delivery:source.published?'original published tarball':'npm pack --ignore-scripts of fixed commit/subdir; no adaptation or build'};
}

export function prepareMarketPackage({frameworkRoot,profileDir,spec,requestId,sourceUrl=null,packageName=null,version=null,registryUrl=null,updateSpec=spec},report=()=>{},onSource=()=>{}) {
  const orchestrator=new FishHandOrchestrator({frameworkRoot});
  const ref=sourceUrl?spec.match(/#(.+)$/)?.[1]:null;
  const request=orchestrator.createPending({requestId,packageName,version,spec,sourceUrl,ref,targetProfile:profileDir,loadForm:'unknown',
    note:'本次安装意图；分析材料不是用户决定，不授权额外人格、记忆或脑区改写'});
  orchestrator.store.save({...request,...(!sourceUrl?{sourceKind:'npm'}:{}),marketRegistry:registryUrl});
  let original=null;
  report('下载并固定实际内容；不执行候选脚本');
  const pending=(analysis)=>({pendingDecision:true,packageName:original.packageName,version:original.version,
    requestId:request.id,original,analysis,deployed:false});
  try {
    const result=orchestrator.runW2W3(request.id,{onCollected:collected=>{
      original=fixedOriginal(collected,updateSpec,request.id);onSource(original);
    }});
    if(result.status==='failed') {
      if(!original)throw marketError('FH_MARKET_SOURCE_FAILED','来源材料准备失败', {diagnostic:result.error});
      return pending({status:'failed',reason:result.error,basis:'已固定原包；尚未完成胃分析'});
    }
    report('胃：保留证据、候选判断和未知项');
    const assessment=reviewToolContent(join(result.record.rice.dir,'仓库'),{evidenceOnly:true});
    const review=result.review??JSON.parse(readFileSync(result.record.stomach.reviewPath,'utf8'));
    const pkg=review.facts.packageJson;
    const loadForm=pkg.dsh?.bundle?'bundle':pkg.dsh?.client?'ui':review.candidates.capabilities.some(c=>c.value==='tool:register')?'tool':'unknown';
    orchestrator.store.save({...result.record,loadForm});
    const analysis={status:'analyzed',requestId:request.id,reviewPath:result.record.stomach.reviewPath,
      shape:review.candidates.shape,loadForm,reasons:assessment.reasons,
      candidates:review.candidates,unknowns:review.unknowns,basis:assessment.basis,
      limitations:'静态材料不能证明运行行为；未执行候选脚本。原包选择不授权脑区合并或覆盖用户人格/记忆。'};
    // Reuse only an existing, content/Profile/scope-bound formal authorization.
    // approve() retains its complete review and integrity requirements.
    try {
      const ready=orchestrator.approve({requestId:request.id,marketInstall:true});
      if(ready.status==='ready')return {spec:ready.package.installSpec,packageName:ready.record.packageName,
        version:ready.record.version,requestId:request.id,analysis,authorization:'existing-bound-decision'};
    } catch(error) {
      if(error.code!=='FH_NO_APPROVER')throw error;
    }
    // The existing install intent covers an ordinary tool's installation and
    // first load, not acceptance of every unknown or new concrete operations.
    const ordinary=loadForm==='tool'&&review.candidates.shape==='tool'&&!assessment.reasons.length
      && !(review.candidates.risks??[]).some(r=>['file-write','child-process'].includes(r.value));
    if(ordinary)return {original,packageName:original.packageName,version:original.version,requestId:request.id,
      analysis,authorization:'matching-tool-install-intent'};
    return pending({...analysis,status:'needs-discussion',reason:assessment.reasons.length
      ?'发现具体人格或记忆操作，须讨论本次原包安装':'形态或行为超出普通工具安装意图，尚无匹配的已有授权'});
  } catch(error) {
    // Content acquisition/identity/integrity failures never become choices.
    if(!original||/^(?:FH_(?:NPM|PACKAGE|ORIGINAL)|SOURCE_)/.test(error.code??'')
      ||/INTEGRITY|ARCHIVE|IDENTITY|CONTENT_(?:DRIFT|MISMATCH)/.test(error.code??''))throw error;
    return pending({status:'failed',code:error.code??'FH_ANALYSIS_FAILED',reason:error.message,
      basis:'原包已固定；分析或受管准备未完成，不记为通过'});
  }
}

export function prepareMarketRepair(input,report=()=>{}) {
  const {profileDir,frameworkRoot,requestId}=input;
  const work=join(frameworkRoot,'鱼的胃','构建工作副本',requestId+'-repair');mkdirSync(work,{recursive:true});
  const pkg=JSON.parse(readFileSync(join(profileDir,'package.json'),'utf8'));
  const installed=new Map(Object.keys(pkg.dependencies??{}).map(name=>{
    try{return [name,JSON.parse(readFileSync(join(profileDir,'node_modules',name,'package.json'),'utf8')).version];}catch{return [name,null];}
  }));
  const req=process.env.FISH_HAND_DSH_ROOT?createRequire(join(resolve(process.env.FISH_HAND_DSH_ROOT),'package.json')):createRequire(import.meta.url);
  const yaml=req('yaml');let previous=null;
  for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml'])if(existsSync(join(profileDir,file)))copyFileSync(join(profileDir,file),join(work,file));
  if(existsSync(join(work,'pnpm-lock.yaml')))previous=yaml.parse(readFileSync(join(work,'pnpm-lock.yaml'),'utf8'));
  // No fish approvals for existing packages. Resolve the actual repair first so
  // a missing/stale lock cannot silently upgrade a third-party tool unreviewed.
  const staging={...pkg,dependencies:{...pkg.dependencies}};delete staging.dsh;delete staging.devDependencies;
  for(const [name,spec]of Object.entries(staging.dependencies??{}))if(/^(file|link):/.test(spec)&&!/^\w+:[A-Za-z]:[/\\]/.test(spec))
    staging.dependencies[name]=spec.slice(0,spec.indexOf(':')+1)+resolve(profileDir,spec.slice(spec.indexOf(':')+1)).replaceAll('\\','/');
  writeFileSync(join(work,'package.json'),JSON.stringify(staging));
  preparePnpmWorkspace(work);
  report('检查缺失或过期锁文件将解析的真实版本');
  runPnpm(['install','--lockfile-only','--no-frozen-lockfile','--ignore-scripts','--ignore-pnpmfile',...(input.registryUrl?['--registry',input.registryUrl]:[])],
    work);
  const lock=yaml.parse(readFileSync(join(work,'pnpm-lock.yaml'),'utf8'));
  const prepared=[];const resolutions=[];
  for(const [name,spec]of Object.entries(pkg.dependencies??{})) {
    if(/^(?:file|link|workspace):/.test(spec))continue;
    const reference=lock.importers?.['.']?.dependencies?.[name]?.version;
    const previousReference=previous?.importers?.['.']?.dependencies?.[name]?.version;
    if(/^(?:github:|git[+:]|https?:)/.test(spec)) {
      // Remote identities may change without a semver change. Compare the
      // resolved source, not just installed package.json.version. Local
      // adapters remain native; new remote content uses the existing pipeline.
      if(!reference)throw new Error('FH_MARKET_REPAIR_RESOLUTION: 无法确定 '+name+' 的修复来源');
      if(reference===previousReference&&installed.get(name))continue;
      const github=/^(?:github:|git\+https:\/\/github.com\/|https:\/\/github.com\/)/.test(spec);
      let sourceUrl=null,target=spec;
      if(github) {
        sourceUrl=spec.replace(/^github:/,'https://github.com/').replace(/^git\+/,'').split('#')[0];
        const commit=reference.match(/[0-9a-f]{40}/ig)?.at(-1);
        if(!commit)throw new Error('FH_MARKET_REPAIR_RESOLUTION: GitHub 修复缺少固定提交 '+name);
        target=sourceUrl+'#'+commit;
      } else if(!/^https?:/.test(spec)) {
        throw new Error('FH_MARKET_SOURCE_FAILED: 既有来源入口不支持 '+name+' 的修复来源');
      }
      const ready=prepareMarketPackage({...input,requestId:requestId+'-'+prepared.length,spec:target,updateSpec:spec,packageName:name,version:null,sourceUrl},report);
      prepared.push(ready);resolutions.push({packageName:name,beforeVersion:installed.get(name)??null,version:ready.version,sourceRef:reference});
      continue;
    }
    const version=reference?.split('(')[0];
    if(!version||!/^\d+\.\d+\.\d+/.test(version))throw new Error('FH_MARKET_REPAIR_RESOLUTION: 无法确定 '+name+' 的修复版本');
    const before=installed.get(name)??previous?.importers?.['.']?.dependencies?.[name]?.version?.split('(')[0];
    resolutions.push({packageName:name,beforeVersion:before??null,version});
    if(version!==before&&!nativeOfficialSpecs(['add',name+'@'+version]))
      prepared.push(prepareMarketPackage({...input,requestId:requestId+'-'+prepared.length,spec:name+'@'+version,packageName:name,version},report));
  }
  return {repair:true,prepared,resolutions};
}

function ipcError(message,cause=null) {
  return Object.assign(new Error('FH_MARKET_PREPARE_IPC_FAILED: '+message+(cause?.message?': '+cause.message:'')),
    {code:'FH_MARKET_PREPARE_IPC_FAILED',causeCode:cause?.code??null});
}
function sendMessage(message) {
  return new Promise((resolve,reject)=>{
    if(!process.send||!process.connected){reject(ipcError('IPC channel is not connected'));return;}
    try {process.send(message,error=>error?reject(ipcError('IPC send failed',error)):resolve());}
    catch(error) {reject(ipcError('IPC send threw',error));}
  });
}
function errorPayload(error) {
  return {code:error.code??'FH_MARKET_PREPARE_FAILED',message:error.message,reasons:error.reasons??null,
    diagnostic:error.diagnostic??null,pnpmFailure:error.pnpmFailure??null,causeCode:error.causeCode??null};
}
function stderrFailure(error,sendError) {
  const rows=[error?.code??'FH_MARKET_PREPARE_FAILED',error?.message,sendError?.code,sendError?.causeCode,sendError?.message].filter(Boolean);
  process.stderr.write(rows.join(': ')+'\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.once('message',async input=>{
    let queue=Promise.resolve(),sendFailure=null;
    const report=stage=>{queue=queue.then(()=>sendMessage({stage})).catch(error=>{sendFailure??=error;});};
    try {
      const onSource=source=>{
        // Start IPC immediately, before the synchronous scanner can fail or
        // exceed its deadline. Keep completion/error ordering in the same queue.
        const sent=sendMessage({source});
        queue=queue.then(()=>sent).catch(error=>{sendFailure??=error;});
      };
      const value=input.repair?prepareMarketRepair(input,report):prepareMarketPackage(input,report,onSource);
      await queue;if(sendFailure)throw sendFailure;await sendMessage({value});
    }catch(error) {
      await queue;
      try {await sendMessage({error:errorPayload(error)});}
      catch(sendError) {stderrFailure(error,sendError);process.exitCode=1;}
    }finally {
      if(process.connected)try {process.disconnect();}catch(error){stderrFailure(error,null);process.exitCode=1;}
    }
  });
}
