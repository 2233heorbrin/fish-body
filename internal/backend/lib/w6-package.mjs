import { packageManagerCommand, nativeNodeRuntime } from './runtime-programs.mjs';
import { extract as extractTar } from 'tar';
/** Approved source -> stomach dependency/build workspace -> immutable runnable tarball.
 * Source, resolved dependencies, tarball and installed files have separate identities.
 * Native DSH remains the only Profile installer. No candidate module is imported here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, relative, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sha256Buffer, sri512, treeHashOf, treeManifest, hashOf, copyTree, removeTree, atomicJson, readJson } from './w6-utils.mjs';

export const PKG = Object.freeze({ SOURCE_MISSING:'PKG_SOURCE_MISSING', DEP_MISSING:'PKG_DEP_MISSING',
  UNPACK_MISMATCH:'PKG_UNPACK_MISMATCH', INTEGRITY_MISMATCH:'PKG_INTEGRITY_MISMATCH',
  SCRIPT_UNAPPROVED:'PKG_SCRIPT_UNAPPROVED', BUILD_FAILED:'PKG_BUILD_FAILED' });
const LIFECYCLE = ['preinstall','install','postinstall','prepare','prepublish','prepublishOnly','prepack','postpack'];
function error(code, message, pendingScripts) {
  return Object.assign(new Error(`[${code}] ${message}`), { code, ...(pendingScripts ? { pendingScripts } : {}) });
}
// Dependency package identity excludes dependency subtrees at every depth.
// Source identity instead preserves tracked nested node_modules fixtures.
export function packageFiles(root,{source=false}={}) {
  const rows=[];
  function walk(dir,prefix='') {
    for (const e of readdirSync(dir,{withFileTypes:true})) {
      if (e.name==='.git'||(e.name==='node_modules'&&(!source||prefix===''))) continue;
      const path=prefix?`${prefix}/${e.name}`:e.name, full=join(dir,e.name);
      if(e.isDirectory()) walk(full,path);
      else { const b=readFileSync(full);rows.push({path,bytes:b.length,sha256:sha256Buffer(b)}); }
    }
  }
  walk(root);return rows.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
export const sourceFiles=root=>packageFiles(root,{source:true});

function yamlParser() {
  // Reuse DSH's installed YAML parser; tests point at their existing kernel copy.
  const req=process.env.FISH_HAND_DSH_ROOT
    ?createRequire(join(resolve(process.env.FISH_HAND_DSH_ROOT),'package.json')):createRequire(import.meta.url);
  return req('yaml');
}
function readDependencyLock(root) {
  const path=join(root,'pnpm-lock.yaml');
  if(!existsSync(path))throw error(PKG.DEP_MISSING,'依赖来源缺少解析锁');
  return yamlParser().parse(readFileSync(path,'utf8'));
}
export function preparePnpmWorkspace(work) {
  const path=join(work,'pnpm-workspace.yaml');
  const existing=existsSync(path)?yamlParser().parse(readFileSync(path,'utf8'))??{}:{};
  const lock=existsSync(join(work,'pnpm-lock.yaml'))?readDependencyLock(work):null;
  // pnpm 12 ignores these CLI flags. Read a workspace rooted in this isolated
  // preparation directory, preserving the source's other resolution settings.
  writeFileSync(path,yamlParser().stringify({...existing,packages:['.'],
    autoInstallPeers:lock?.settings?.autoInstallPeers===true,nodeLinker:'hoisted',verifyStoreIntegrity:true}));
}
export function dependencyOrigin(lock,name,version,spec,reference) {
  const ref=String(reference??version),key=ref.startsWith(name+'@')?ref:`${name}@${ref}`;
  const entry=lock.packages?.[key]??lock.packages?.[`${name}@${version}`];
  const resolution=entry?.resolution??{};
  let kind='unknown';
  if(resolution.type==='git'||resolution.repo||resolution.commit||/^(git[+:]|github:|gitlab:|bitbucket:)/.test(ref))kind='git';
  else if(resolution.type==='directory')kind='directory';
  else if(ref.startsWith('link:')||String(spec).startsWith('link:'))kind='link';
  else if(resolution.tarball&&!/^v?\d+\./.test(ref))kind='tarball';
  else if(resolution.integrity)kind='registry';
  else if(resolution.tarball)kind='tarball';
  return {kind,key,resolution,snapshot:lock.snapshots?.[key]??lock.snapshots?.[`${name}@${version}`]??{}};
}
export function selectDependencyScripts(meta,origin,{bindingGyp=false}={}) {
  if(origin.kind==='link')return {};
  const keys=['preinstall','install','postinstall',...(['git','directory'].includes(origin.kind)?['prepare']:[])];
  if(origin.kind==='unknown'&&(keys.some(k=>meta.scripts?.[k])||meta.scripts?.prepare||bindingGyp))
    throw error(PKG.DEP_MISSING,'有生命周期脚本的依赖无法确定锁定来源');
  const scripts=Object.fromEntries(keys.filter(k=>typeof meta.scripts?.[k]==='string').map(k=>[k,meta.scripts[k]]));
  if(bindingGyp&&meta.gypfile!==false&&!meta.scripts?.install&&!meta.scripts?.preinstall)scripts.install='node-gyp rebuild';
  return scripts;
}
export function resolveLocalDep(spec, base=process.cwd()) {
  if(typeof spec!=='string'||!spec.startsWith('file:')) return null;
  const path=resolve(base,spec.slice(5));return existsSync(path)?path:null;
}
function packageDir(from,name) {
  let cursor=resolve(from);
  while(true) {
    const path=join(cursor,'node_modules',...name.split('/'));
    if(existsSync(join(path,'package.json'))) return realpathSync(path);
    const parent=dirname(cursor);if(parent===cursor) break;cursor=parent;
  }
  throw error(PKG.DEP_MISSING,`未解析的依赖 ${name}`);
}
function dependencyRows(pkg,root,{includeDev=false,lock=null}={}) {
  const rows=[], seen=new Set();
  const visit=(name,spec,from,parent,optional=false,reference=null,bundle=null)=>{
    let dir;try {dir=packageDir(from,name);} catch(e) {if(optional)return;throw e;}
    const key=realpathSync(dir);const meta=readJson(join(dir,'package.json'));
    let origin=lock?dependencyOrigin(lock,meta.name??name,meta.version,spec,reference):null;
    // Registry tarballs such as npm include nested dependencies without separate
    // pnpm lock entries. Their provenance is the locked containing tarball.
    // A dependency resolved outside that bundle must still have its own origin.
    const bundledPath=bundle&&relative(bundle.root,dir).replaceAll('\\','/');
    if(origin?.kind==='unknown'&&bundledPath?.startsWith('node_modules/'))
      origin={kind:'bundled',key:bundle.key+' > '+name+'@'+meta.version,resolution:bundle.resolution,snapshot:{}};
    const scripts=origin?selectDependencyScripts(meta,origin,{bindingGyp:existsSync(join(dir,'binding.gyp'))}):{};
    rows.push({name,spec,parent,version:meta.version,resolvedDir:dir,
      treeHash:treeHashOf(packageFiles(dir)),fileCount:packageFiles(dir).length,
      scripts,...(origin?{source:origin.kind,lockKey:origin.key}:{}),
      implicitNodeGyp:scripts.install==='node-gyp rebuild'&&!meta.scripts?.install});
    if(seen.has(key)) return;seen.add(key);
    const declaredBundles=meta.bundleDependencies??meta.bundledDependencies??[];
    const nestedBundle=n=>(declaredBundles===true||Array.isArray(declaredBundles)&&declaredBundles.includes(n))
      &&origin&&origin.kind!=='unknown'
      ?{root:dir,key:origin.key,resolution:origin.resolution}:bundle;
    for(const [n,s] of Object.entries(meta.dependencies??{})) visit(n,s,dir,`${name}@${meta.version}`,false,origin?.snapshot.dependencies?.[n],nestedBundle(n));
    for(const [n,s] of Object.entries(meta.optionalDependencies??{})) visit(n,s,dir,`${name}@${meta.version}`,true,origin?.snapshot.optionalDependencies?.[n],nestedBundle(n));
  };
  const importer=lock?.importers?.['.']??{};
  for(const [n,s] of Object.entries({...pkg.dependencies,...(includeDev?pkg.devDependencies:{})})) visit(n,s,root,'root',false,(importer.dependencies?.[n]??importer.devDependencies?.[n])?.version);
  for(const [n,s] of Object.entries(pkg.optionalDependencies??{})) visit(n,s,root,'root',true,importer.optionalDependencies?.[n]?.version);
  return rows.sort((a,b)=>`${a.parent}/${a.name}@${a.version}`.localeCompare(`${b.parent}/${b.name}@${b.version}`,'en'));
}
const depIdentity=rows=>rows.map(({name,spec,parent,version,treeHash,fileCount})=>({name,spec,parent,version,treeHash,fileCount}));
export function collectRuntimeDependencies(packageJson,root=null) {
  const dependencySpecs={...packageJson.dependencies};
  if(root) {const packages=dependencyRows(packageJson,root);return {dependencySpecs,packages,missing:[]};}
  const packages=[],missing=[];
  for(const [name,spec]of Object.entries(dependencySpecs)) {
    const dir=resolveLocalDep(spec);
    if(String(spec).startsWith('file:')&&!dir) {missing.push({name,spec});continue;}
    const meta=dir?readJson(join(dir,'package.json')):null,files=dir?packageFiles(dir):[];
    packages.push({name,spec,parent:'root',resolvedDir:dir,version:meta?.version??null,treeHash:dir?treeHashOf(files):null,fileCount:files.length,from:dir?'file':'registry'});
  }
  packages.sort((a,b)=>a.name.localeCompare(b.name,'en'));return {dependencySpecs,packages,missing};
}
function orderedRecompute(root,expected) {
  const actual=expected?.some(f=>f.path.startsWith('node_modules/'))
    ?treeManifest(root).filter(f=>!f.path.startsWith('.git/')):sourceFiles(root);
  const map=new Map(actual.map(f=>[f.path,f]));
  if(!Array.isArray(expected)||actual.length!==expected.length) throw error(PKG.UNPACK_MISMATCH,'源码清单不一致');
  return expected.map(f=>{const a=map.get(f.path);if(!a||a.bytes!==f.bytes||a.sha256!==f.sha256)throw error(PKG.UNPACK_MISMATCH,'源码已改变');return a;});
}
function redactOutput(value) {
  return String(value??'')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/([?&](?:token|access_token|auth|key|api_key|signature|sig)=)[^&\s]+/gi,'$1[redacted]')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)[^\r\n]+/gi,'$1[redacted]')
    .replace(/((?:_authToken|_auth|password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
}
export function runPnpm(args,cwd,runner) {
  if(runner) return runner(args,cwd);
  let manager,phase='command-resolution';
  try {
    manager=packageManagerCommand();phase='execution';
    const result=execFileSync(manager.command,[...manager.args,...args],{cwd,stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024,windowsHide:true,
      env:{...manager.env,CI:'true',HUSKY:'0'}});
    phase='result-processing';return result.toString();
  }
  catch (cause) {
    const stdout=redactOutput(cause?.stdout).slice(0,12000),stderr=redactOutput(cause?.stderr).slice(0,12000);
    const raw=[stderr,stdout].join('\n').replace(/(https?:\/\/)\s*\r?\n\s*/g,'$1');
    // spawnSync also reports timeouts/buffer failures after starting a process.
    const creationFailure=['ENOENT','EACCES','ENOEXEC','ENOTDIR','EPERM','EINVAL'].includes(cause?.code)&&/^spawn(?:Sync)?\b/.test(cause?.syscall??'');
    const failurePhase=phase==='execution'?(Number.isInteger(cause?.status)?'process-exit':creationFailure?'process-creation':'execution'):phase;
    const diagnostic=raw.match(/ERR_PNPM_[A-Z0-9_]+/)?.[0]??(Number.isInteger(cause?.status)?`EXIT_${cause.status}`:cause?.code??(failurePhase==='process-creation'?'PROCESS_START_FAILED':failurePhase==='result-processing'?'RESULT_PROCESSING_FAILED':'PNPM_CALL_FAILED'));
    const wrappedUrl=raw.match(/(?:GET|POST)\s+(https?:\/\/[\s\S]*?)(?=:\s*(?:Not Found|Forbidden|Unauthorized)|\s+-\s*\d{3})/i)?.[1];
    const requestUrl=wrappedUrl?.replace(/\s+/g,'')??raw.match(/(?:GET|POST)\s+(https?:\/\/[^\s]+)/)?.[1]?.replace(/:$/,'')??null;
    let packageName=null;
    if(requestUrl)try {
      const path=decodeURIComponent(new URL(requestUrl).pathname).split('/-/')[0];
      packageName=path.match(/(@[^/]+\/[^/]+|[^/]+)$/)?.[1]??null;
    }catch{}
    const stage=args[0]==='pack'?'package':'dependency-preparation';
    const pnpmFailure={stage,phase:failurePhase,command:[manager?.command??'pnpm',...(manager?.args??[]),...args].map(redactOutput),exitCode:cause.status??null,
      code:diagnostic,causeName:cause?.name??null,causeCode:cause?.code??null,causeMessage:redactOutput(cause?.message??cause).slice(0,12000),
      syscall:redactOutput(cause?.syscall)||null,path:redactOutput(cause?.path)||null,signal:cause?.signal??null,
      packageName,requestUrl,stdout,stderr};
    const label=stage==='package'?'安装包打包失败':'依赖准备失败';
    throw Object.assign(error(PKG.BUILD_FAILED,`${label}：${diagnostic} (${failurePhase})；${pnpmFailure.causeMessage}${packageName?'，'+packageName:''}${requestUrl?'\n'+requestUrl:''}；可复用有效批准重试`),{diagnostic,pnpmFailure});
  }
}
function runHook(hook,script,cwd,root,runner) {
  // Execute exactly the already-authorized hook, without a package-manager
  // command in the dependency directory (pnpm run may auto-install there).
  if(runner)return runner(['lifecycle',hook],cwd,{hook,script,root});
  try {
    // The desktop Host may be DSH.exe rather than a Node CLI executable.
    const runtime=nativeNodeRuntime();
    execFileSync(runtime.command,[fileURLToPath(new URL('./w6-lifecycle.mjs',import.meta.url))],{
      cwd,input:JSON.stringify({hook,script,cwd,root}),stdio:['pipe','pipe','pipe'],maxBuffer:32*1024*1024,windowsHide:true,
      env:{...process.env,...runtime.env,CI:'true',HUSKY:'0'}});
  }catch(cause){
    throw Object.assign(error(PKG.BUILD_FAILED,`生命周期 ${hook} 失败；可复用有效批准重试`),{diagnostic:Number.isInteger(cause.status)?`EXIT_${cause.status}`:'PROCESS_START_FAILED'});
  }
}
function scriptRows(deps) {
  const rows=deps.filter(d=>Object.keys(d.scripts).length||d.implicitNodeGyp).map(d=>({name:d.name,version:d.version,
    scripts:{...d.scripts,...(d.implicitNodeGyp?{install:'node-gyp rebuild'}:{})},treeHash:d.treeHash}));
  return [...new Map(rows.map(d=>[`${d.name}@${d.version}`,d])).values()];
}
export function authorizeDependencyScripts(rows,authorization) {
  const grants=authorization?.buildScripts?.dependencies??[];
  const pending=rows.filter(d=>!grants.some(g=>g.name===d.name&&g.version===d.version
    &&g.treeHash===d.treeHash&&Object.entries(d.scripts).every(([k,v])=>g.scripts?.[k]===v)));
  if(pending.length)throw error(PKG.SCRIPT_UNAPPROVED,'依赖生命周期脚本需要新增授权（name/version/treeHash/scripts）',pending);
  return rows;
}
function unpack(tgzPath,dest) {
  mkdirSync(dest,{recursive:true});
  // Decode npm/pnpm UTF-8 paths in Node, independent of Windows' system tar.
  extractTar({file:resolve(tgzPath),cwd:dest,sync:true,strict:true});
  return join(dest,'package');
}

export function buildInstallPackage({artifactDir,outDir,packageName,version,revision,workRoot=null,
  approvedScopes={},authorization={},production=false,runner=null,published=false,reviewPrepared=null,registryUrl=null}) {
  const warehouse=join(artifactDir,'仓库'), w5ManifestPath=join(artifactDir,'manifest.json');
  if(!existsSync(w5ManifestPath))throw error(PKG.SOURCE_MISSING,'缺少已审源码');
  const manifest=readJson(w5ManifestPath),sourceFiles=orderedRecompute(warehouse,manifest.contentFiles);
  const sourceTreeHash=treeHashOf(sourceFiles);
  if(sourceTreeHash!==manifest.contentHash)throw error(PKG.UNPACK_MISMATCH,'源码身份与审查不符');
  const pkg=readJson(join(warehouse,'package.json'));
  if(pkg.name!==packageName||pkg.version!==version)
    throw error(PKG.UNPACK_MISMATCH,`包身份不匹配：期望 ${packageName}@${version}，实际 ${pkg.name}@${pkg.version}`);
  const safeName=packageName.replace(/^@/,'').replace(/\//g,'-');
  const authorizationHash=hashOf({approvedScopes,authorization});
  const staging=join(outDir,'安装包',`${safeName}-${version}-${revision}`,hashOf({authorizationHash,builder:'lifecycle-v2'}).slice(7,23));
  const recordPath=join(staging,'安装包记录.json');
  if(existsSync(recordPath)) {
    const checked=inspectInstallPackage({artifactDir,recordPath});
    if(checked.ok&&checked.record.authorizationHash===authorizationHash)return {...checked.record,recordPath,stagingDir:staging};
    throw error(PKG.INTEGRITY_MISMATCH,'已有构建产物漂移，拒绝覆盖；保留现场');
  }
  // New semantics must not reuse the interrupted pre-fix workspace or its lib/.
  const work=join(workRoot??join(dirname(artifactDir),'构建工作副本'),hashOf({sourceTreeHash,authorizationHash,builder:'lifecycle-v2'}).slice(7,31));
  const preparationPath=join(work,'../'+basename(work)+'.preparation.json');
  const preparing=existsSync(preparationPath)?readJson(preparationPath):null;
  if(!preparing) {
    mkdirSync(work,{recursive:true});copyTree(warehouse,work);
    atomicJson(preparationPath,{sourceTreeHash,authorizationHash});
  } else if(preparing.sourceTreeHash!==sourceTreeHash||preparing.authorizationHash!==authorizationHash) {
    throw error(PKG.UNPACK_MISMATCH,'工作副本来源或授权不一致');
  }
  copyTree(warehouse,work);
  atomicJson(join(work,'package.json'),pkg);
  // npm's published artifact is already built. Do not rebuild upstream sources,
  // execute prepare/prepack, or install its development-only dependencies.
  const executionKeys=published?['preinstall','install','postinstall']:
    ['preinstall','install','postinstall',...(pkg.scripts?.prepare?['prepare']:pkg.scripts?.build?['prebuild','build','postbuild']:[]),'prepack'];
  const rootScripts=Object.fromEntries(Object.entries(pkg.scripts??{}).filter(([k])=>executionKeys.includes(k)));
  if(Object.keys(rootScripts).length&&!(approvedScopes.installScripts===true&&authorization.buildScripts?.granted===true))
    throw error(PKG.SCRIPT_UNAPPROVED,'根包构建脚本未批准',[{name:pkg.name,version:pkg.version,root:true,scripts:rootScripts,treeHash:sourceTreeHash}]);
  mkdirSync(join(work,'node_modules'),{recursive:true});
  if(published) { delete pkg.devDependencies; atomicJson(join(work,'package.json'),pkg); }
  const hasDeps=Object.keys({...pkg.dependencies,...pkg.devDependencies,...pkg.optionalDependencies}).length>0;
  preparePnpmWorkspace(work);
  if(hasDeps)runPnpm(['install','--ignore-scripts','--ignore-pnpmfile',existsSync(join(work,'pnpm-lock.yaml'))?'--frozen-lockfile':'--no-frozen-lockfile',
    `--config.auto-install-peers=${existsSync(join(work,'pnpm-lock.yaml')) ? /autoInstallPeers:\s*true/.test(readFileSync(join(work,'pnpm-lock.yaml'),'utf8')) : false}`,'--config.node-linker=hoisted','--config.verify-store-integrity=true',...(registryUrl?['--registry',registryUrl]:[])],work,runner);
  const allDeps=hasDeps?dependencyRows(pkg,work,{includeDev:true,lock:readDependencyLock(work)}):[];
  const discoveredScripts=scriptRows(allDeps);
  if(reviewPrepared) reviewPrepared({work,dependencies:allDeps,scripts:discoveredScripts});
  const dependencyScripts=authorizeDependencyScripts(discoveredScripts,
    reviewPrepared&&authorization.buildScripts?.reviewedInstallIntent===true
      ?{...authorization,buildScripts:{...authorization.buildScripts,dependencies:discoveredScripts}}:authorization);
  const built=new Set();
  for(const d of [...allDeps].reverse()) {
    if(built.has(d.resolvedDir))continue;built.add(d.resolvedDir);
    for(const [hook,script]of Object.entries(d.scripts))runHook(hook,script,d.resolvedDir,work,runner);
  }
  // Run the chosen hooks once. Pack receives a manifest without lifecycle scripts.
  const commands=executionKeys;
  for(const key of commands)if(pkg.scripts?.[key])runHook(key,pkg.scripts[key],work,work,runner);
  const resolvedLock=join(work,'pnpm-lock.yaml');
  const preparedDeps=hasDeps?dependencyRows(pkg,work):[];
  // Lifecycle scripts have already run under explicit grants. Bundled dependencies
  // must not run them a second time when native DSH installs the tarball.
  for(const dir of new Set(preparedDeps.map(d=>d.resolvedDir))) {
    const meta=readJson(join(dir,'package.json'));
    meta.scripts=Object.fromEntries(Object.entries(meta.scripts??{}).filter(([k])=>!LIFECYCLE.includes(k)));
    atomicJson(join(dir,'package.json'),meta);
  }
  // Pin direct registry versions; transitive selection is still checked against the prepared closure after native installation.
  const packed={...readJson(join(work,'package.json'))};
  if(packed.dependencies)packed.dependencies={...packed.dependencies};
  for(const d of preparedDeps.filter(d=>d.parent==='root')) {
    if(packed.dependencies?.[d.name]&&!/^(file:|link:|workspace:)/.test(packed.dependencies[d.name]))packed.dependencies[d.name]=d.version;
  }
  if(preparedDeps.length)packed.bundleDependencies=Object.keys({...packed.dependencies,...packed.optionalDependencies});
  packed.scripts=Object.fromEntries(Object.entries(packed.scripts??{}).filter(([k])=>!LIFECYCLE.includes(k)));
  writeFileSync(join(work,'package.json'),JSON.stringify(packed,null,2)+'\n');
  mkdirSync(staging,{recursive:true});
  runPnpm(['pack','--config.node-linker=hoisted','--ignore-pnpmfile','--pack-destination',staging],work,runner);
  const tgzPath=join(staging,`${safeName}-${version}.tgz`);
  if(!existsSync(tgzPath)) {
    const actualTgzFiles=readdirSync(staging,{withFileTypes:true})
      .filter(row=>row.isFile()&&row.name.endsWith('.tgz')).map(row=>row.name).sort();
    throw Object.assign(error(PKG.BUILD_FAILED,
      `pnpm pack 未生成预期包：${packageName}@${version}；预期 ${basename(tgzPath)}；实际 tgz：${actualTgzFiles.join(', ')||'无'}`),
      {packageName,version,expectedTgz:basename(tgzPath),actualTgzFiles});
  }
  const runtimeDir=unpack(tgzPath,join(staging,'runtime'));
  const packageJson=readJson(join(runtimeDir,'package.json')),runtimeFiles=treeManifest(runtimeDir);
  const exportPaths=(v)=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(exportPaths):[];
  for(const entry of [packageJson.main,packageJson.dsh?.bundle?.entry,...exportPaths(packageJson.exports)].filter(v=>typeof v==='string'&&!v.includes('*'))) {
    if(!existsSync(join(runtimeDir,entry)))throw error(PKG.BUILD_FAILED,'构建后的入口文件缺失');
  }
  const tarball=readFileSync(tgzPath);
  const runtimeDependencies=dependencyRows(packageJson,runtimeDir);
  const packagedLock=existsSync(resolvedLock)?join(staging,'pnpm-lock.yaml'):null;
  if(packagedLock)writeFileSync(packagedLock,readFileSync(resolvedLock));
  const dependencySubtree={schema:'w6-dependency-subtree/v2',packageCount:runtimeDependencies.length,packages:runtimeDependencies,
    sha256:hashOf(depIdentity(runtimeDependencies)),lockPath:packagedLock,
    lockSha256:packagedLock?sha256Buffer(readFileSync(packagedLock)):null};
  const record={schema:'w6-install-package/v2',createdAt:new Date().toISOString(),packageName,version,revision,
    spec:'file:'+tgzPath.replace(/\\/g,'/'),tgzPath,artifactDir,w5ManifestPath,sourceTreeHash,w5ContentHash:manifest.contentHash,
    sourceMatchesW5:true,sourceFiles,authorizationHash,packageIntegrity:sri512(tarball),packageSha256:sha256Buffer(tarball),
    packageBytes:tarball.length,packageJson,dependencySpecs:{...packageJson.dependencies},dependencySubtree,
    runtimeDir,runtimeFiles,runtimeContentHash:treeHashOf(runtimeFiles),deployedContentHash:null,
    unpacked:{matchesRuntime:true,unpackedDir:runtimeDir,fileCount:runtimeFiles.length},
    build:{workDir:work,sourceLockSha256:existsSync(join(warehouse,'pnpm-lock.yaml'))?sha256Buffer(readFileSync(join(warehouse,'pnpm-lock.yaml'))):null,
      rootScripts,dependencyScripts,dependencySources:allDeps.map(({name,version,source,lockKey})=>({name,version,source,lockKey})),
      lifecycleSemantics:'lifecycle-v2',commands:commands.filter(k=>pkg.scripts?.[k]),production},
    ...(production?{}:{testData:{simulated:true,isolationOnly:true,nonProduction:true}})};
  atomicJson(recordPath,record);return {...record,recordPath,stagingDir:staging};
}
export function verifyInstallPackage(record,tgzPath=null) {
  const path=tgzPath??record?.tgzPath;
  const actual=path&&existsSync(path)?sri512(readFileSync(path)):null;
  return {ok:!!actual&&actual===record?.packageIntegrity,code:actual===record?.packageIntegrity?null:PKG.INTEGRITY_MISMATCH,expected:record?.packageIntegrity,actual};
}
export function verifyDependencySubtree(record) {
  const registered=record?.dependencySubtree,rows=[],fingerprints=[];
  for(const d of registered?.packages??[]) {
    if(!d.resolvedDir) {
      // Legacy registry specifications are not local directories. Resolution belongs to pnpm.
      const ok=d.from==='registry'&&typeof d.spec==='string';rows.push({name:d.name,ok});
      fingerprints.push({...d});continue;
    }
    try {
      const files=packageFiles(d.resolvedDir),meta=readJson(join(d.resolvedDir,'package.json'));
      const actual={...d,version:meta.version,treeHash:treeHashOf(files),fileCount:files.length};fingerprints.push(actual);
      rows.push({name:d.name,ok:actual.version===d.version&&actual.treeHash===d.treeHash});
    }catch{rows.push({name:d.name,ok:false});}
  }
  const modern=record?.schema==='w6-install-package/v2';
  const recomputedSha256=modern?hashOf(depIdentity(fingerprints)):hashOf(fingerprints.map(d=>({name:d.name,version:d.version,treeHash:d.treeHash,fileCount:d.fileCount})));
  const lockOk=!registered?.lockPath||(existsSync(registered.lockPath)&&sha256Buffer(readFileSync(registered.lockPath))===registered.lockSha256);
  return {ok:rows.every(r=>r.ok)&&lockOk&&recomputedSha256===registered?.sha256,rows,lockOk,recomputedSha256,registeredSha256:registered?.sha256};
}
export function inspectInstallPackage({artifactDir,tgzPath=null,recordPath=null}) {
  const w5ManifestPath=join(artifactDir,'manifest.json'),reasons=[],drift=[];
  let manifest,record,artifactOk=false,packageOk=false;
  try {
    manifest=readJson(w5ManifestPath);
    const files=orderedRecompute(join(artifactDir,'仓库'),manifest.contentFiles);
    const sourceTreeHash=treeHashOf(files);artifactOk=sourceTreeHash===manifest.contentHash;
    if(!recordPath||!existsSync(recordPath))throw error(PKG.INTEGRITY_MISMATCH,'缺少安装包记录');
    record=readJson(recordPath);
    if(record.sourceTreeHash!==sourceTreeHash||record.w5ContentHash!==manifest.contentHash)throw error(PKG.UNPACK_MISMATCH,'源码绑定不一致');
    packageOk=verifyInstallPackage(record,tgzPath).ok;
    if(!packageOk)reasons.push('安装包 integrity 不一致');
    if(packageOk && record.schema!=='w6-install-package/v2') {
      const entries=execFileSync('tar',['-tzf',tgzPath??record.tgzPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).split(/\r?\n/).map(p=>p.replace(/^\.\//,''));
      const main=record.packageJson?.main;
      if(main && !entries.includes('package/'+main.replace(/^\.\//,'')))reasons.push('PKG_BUILD_REQUIRED：历史安装包缺少运行入口，请复用既有批准重新 prepare/approve 构建');
    }
    if(!verifyDependencySubtree(record).ok)reasons.push('依赖或解析锁漂移');
    if(record.runtimeDir&&treeHashOf(treeManifest(record.runtimeDir))!==record.runtimeContentHash)reasons.push('运行产物漂移');
  }catch(e){reasons.push(e.message);}
  return {ok:artifactOk&&packageOk&&!reasons.length,code:reasons.length?PKG.INTEGRITY_MISMATCH:null,
    artifactOk,packageOk,record,w5Manifest:manifest,w5ManifestPath,reasons,drift};
}
