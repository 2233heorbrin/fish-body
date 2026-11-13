// Runs outside the Profile installation lock, in a cancellable child process.
import { pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runPnpm, preparePnpmWorkspace } from './w6-package.mjs';
import { nativeOfficialSpecs } from '../fish-hand-admission-gate.mjs';
import { reviewToolContent, marketError } from './market-source.mjs';
// Maintenance tree keeps the orchestrator beside the gate; installed modules
// reuse the approval host's existing orchestrator rather than copying it again.
import { FishHandOrchestrator } from '../fish-hand-orchestrator.mjs';

export function prepareMarketPackage({frameworkRoot,profileDir,spec,requestId,sourceUrl=null,packageName=null,version=null,registryUrl=null},report=()=>{}) {
  const orchestrator=new FishHandOrchestrator({frameworkRoot});
  const request=orchestrator.createPending({requestId,packageName,version,spec,sourceUrl,targetProfile:profileDir,loadForm:'tool',
    note:'用户在市场主动安装/更新纯工具插件，含首次加载及必要准备；人格/记忆修改不在授权内'});
  orchestrator.store.save({...request,...(!sourceUrl?{sourceKind:'npm'}:{}),marketRegistry:registryUrl});
  report('下载并固定实际发布内容');
  const result=orchestrator.runW2W3(request.id);
  if(result.status==='failed')throw marketError('FH_MARKET_SOURCE_FAILED','来源材料准备失败');
  report('胃：审查实际代码和配置');
  const assessment=reviewToolContent(join(result.record.rice.dir,'仓库'));
  const review=result.review??JSON.parse(readFileSync(result.record.stomach.reviewPath,'utf8'));
  const capabilities=(review.candidates.capabilities??[]).map(c=>c.value);
  const build=review.facts.installScripts.length>0 || Object.keys(review.facts.packageJson?.scripts??{}).some(k=>['build','prebuild','postbuild','prepack'].includes(k))
    || Object.keys({...review.facts.packageJson?.dependencies,...review.facts.packageJson?.optionalDependencies}).length>0;
  const approvedScopes={capabilities,replaces:[],credentialScopes:[],externalSideEffects:false,installScripts:build};
  const dim=(granted,detail,basis)=>({granted,detail,basis});
  const basis='用户市场安装/更新意图授权纯工具安装、首次加载和必要构建；内容已审查，无具体人格/记忆改动证据';
  const authorization={firstHostCodeExecution:dim(true,capabilities,basis),toolReplacement:dim(false,[],basis),
    credentialAccess:dim(false,[],basis),externalActions:dim(false,[],basis),personaMemoryChange:dim(false,[],basis),
    buildScripts:{...dim(build,build?['necessary-install-build']:[],basis),reviewedInstallIntent:true}};
  report('手：准备依赖与可运行安装包');
  const ready=orchestrator.approve({requestId:request.id,approvedBy:'market-user-install-intent',approvedScopes,authorization,
    unknownDispositions:review.unknowns.map(u=>({field:u.field,originalStatus:'unknown',disposition:'accepted-as-residual',basis:assessment.basis+'；'+basis})),
    conclusionFields:{shape:'tool',capabilities,basis:assessment.basis,
      injectionAssessment:{personaInjection:'unknown',memoryInjection:'unknown'}},marketInstall:true});
  if(ready.status!=='ready')throw marketError('FH_MARKET_NOT_READY','准备未完成，未进入安装阶段');
  report('受管安装包已就绪，交给 DSH 原生安装');
  return {spec:ready.package.installSpec,packageName:ready.record.packageName,version:ready.record.version,requestId:request.id};
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
      const ready=prepareMarketPackage({...input,requestId:requestId+'-'+prepared.length,spec:target,packageName:name,version:null,sourceUrl},report);
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

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.once('message',input=>{
    try {const report=stage=>process.send?.({stage});const value=input.repair?prepareMarketRepair(input,report):prepareMarketPackage(input,report);process.send?.({value});}
    catch(error) {process.send?.({error:{code:error.code??'FH_MARKET_PREPARE_FAILED',message:error.message,reasons:error.reasons??null,
      diagnostic:error.diagnostic??null,pnpmFailure:error.pnpmFailure??null}});}
    finally {process.disconnect?.();}
  });
}
