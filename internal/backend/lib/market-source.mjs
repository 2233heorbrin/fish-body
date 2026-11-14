import { npmCommand } from './runtime-programs.mjs';
import { list as listTar, extract as extractTar } from 'tar';
// npm input is the actual published tarball, not a GitHub approximation.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { recomputeFiles } from './artifact.mjs';
import { atomicJson, treeHashOf, sri512, sha256Buffer } from './w6-utils.mjs';
import { buildReview, writeReview } from './review.mjs';

export function marketError(code,message,extra={}) {return Object.assign(new Error(`[${code}] ${message}`),{code,...extra});}
export const npmCli = npmCommand;
export function ingestNpmPublished(orchestrator,record,{pack=null}={}) {
  const {riceRoot,stomachRoot,store}=orchestrator;
  const download=join(riceRoot,'npm',record.packageName,record.id);
  mkdirSync(download,{recursive:true});
  const cli=npmCli();
  const rows=pack?pack(record.intent.spec,download):JSON.parse(execFileSync(cli.exe,
    [...cli.args,'pack',record.intent.spec,'--ignore-scripts','--json','--pack-destination',download,...(record.marketRegistry?['--registry',record.marketRegistry]:[])],
    {cwd:download,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024}));
  if(rows.length!==1) throw marketError('FH_NPM_DOWNLOAD_FAILED','npm 未返回唯一发布包');
  const row=rows[0],tgz=join(download,basename(row.filename));
  const bytes=readFileSync(tgz), integrity=sri512(bytes);
  if(row.integrity!==integrity) throw marketError('FH_NPM_INTEGRITY_MISMATCH','发布包完整性不符');
  const entries=[];
  // tar normalizes Windows separators on ReadEntry; validate the original path.
  listTar({file:tgz,sync:true,strict:true,onReadEntry:entry=>entries.push({path:entry.header.path,type:entry.type})});
  if(entries.some(({path:p})=>!p.startsWith('package/')||p.split(/[\\/]/).includes('..')||p.includes('\\')))
    throw marketError('FH_NPM_ARCHIVE_INVALID','发布包路径不符合 npm 包布局');
  if(entries.some(({type})=>type==='Link'||type==='SymbolicLink')) throw marketError('FH_NPM_ARCHIVE_INVALID','发布包含不能安全采集的链接');
  const unpack=join(download,'unpacked');mkdirSync(unpack,{recursive:true});
  extractTar({file:tgz,cwd:unpack,sync:true,strict:true});
  const warehouse=join(unpack,'package'), pkg=JSON.parse(readFileSync(join(warehouse,'package.json'),'utf8'));
  if(pkg.name!==record.packageName || (record.requestedVersion && pkg.version!==record.requestedVersion))
    throw marketError('FH_PACKAGE_IDENTITY_MISMATCH',`发布包期望 ${record.packageName}@${record.requestedVersion??'所选目标'}，实际 ${pkg.name}@${pkg.version}`);
  const files=recomputeFiles(warehouse),contentHash=treeHashOf(files);
  const riceDir=join(download,'材料');mkdirSync(riceDir,{recursive:true});
  // Copy all published files, including bundled dependencies. Never execute them.
  for(const f of files) {const dest=join(riceDir,'仓库',f.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(warehouse,f.path)));}
  const declarations=Object.fromEntries(['dependencies','optionalDependencies','peerDependencies','devDependencies'].map(k=>[k,pkg[k]??{}]));
  const scripts={status:pkg.scripts?'present':'absent',all:Object.keys(pkg.scripts??{}),
    installScripts:['preinstall','install','postinstall','prepare'].filter(k=>typeof pkg.scripts?.[k]==='string')};
  const source={schema:'rice-source/v1',sourceKind:'npm',requestId:record.id,packageName:pkg.name,
    versionFromManifest:pkg.version,packageNameFromManifest:pkg.name,packageJson:pkg,
    upstreamUrl:record.intent.spec,pinnedCommit:sha256Buffer(bytes).slice(7),pinnedTag:null,
    sourceStatus:'collected',contentHash,fileCount:files.length,contentFiles:files.map(f=>f.path),
    dependencyDeclarations:declarations,flatDependencies:Object.keys({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies}),
    scripts,installScripts:scripts.installScripts,published:{integrity,tarballPath:tgz,requestedSpec:record.intent.spec},
    collectionMethod:'npm pack --ignore-scripts; inspect actual published tarball (no Git source substitution)'};
  const sourcePath=join(riceDir,'来源.json'),contentListPath=join(riceDir,'内容清单.json');
  const contentDoc={schema:'rice-content-list/v1',fileCount:files.length,files,contentHash};
  atomicJson(sourcePath,source);atomicJson(contentListPath,contentDoc);
  const review=buildReview({riceDir,sourceDoc:source,contentDoc,requestId:record.id});
  const result=writeReview({stomachRoot,repoName:pkg.name.replace('/','+'),reviewDoc:review});
  const rec={...record,packageName:pkg.name,version:pkg.version,state:'awaiting-approval',
    source:{kind:'npm',upstreamUrl:record.intent.spec,pinnedCommit:source.pinnedCommit,contentHash,published:source.published},
    rice:{dir:riceDir,sourcePath,contentListPath,fileCount:files.length,treeHash:contentHash},
    stomach:{dir:stomachRoot,reviewPath:result.path,materialOnly:true},
    review:{complete:false,unknowns:review.unknowns.map(u=>u.field),acceptedUnknowns:[]},holdInStomach:review.holdInStomach};
  store.save(rec);
  return {status:rec.state,record:rec,review,riceDir};
}

// Investigate actual code/config operations, not a description saying "memory"
// or the mere capability to register a prompt section. Generic tool instructions
// are allowed. The recorded locations explain a hold; absence is not a safety proof.
export function reviewToolContent(root) {
  const reasons=[];
  const visit=(dir)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      if(entry.name==='.git'||entry.name==='node_modules') continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory()) {visit(path);continue;}
      if(!/\.(?:[cm]?[jt]sx?|ya?ml|json)$/i.test(entry.name))continue;
      const lines=readFileSync(path,'utf8').replace(/\/\*[\s\S]*?\*\//g,comment=>comment.replace(/[^\r\n]/g,' ')).split(/\r?\n/);
      lines.forEach((line,index)=>{
        if(/^\s*\/\//.test(line)) return;
        const persona=/(?:systemPrompt\s*\.\s*(?:section|context)|prompt\s*\.\s*set)\s*\([^\n]*(?:agent:self|agent:mood|persona|SELF|人格|人设)/i.test(line)
          // Match a file operation call, not this reviewer's regex vocabulary.
          || /\b(?:readFile|writeFile|appendFile)(?:Sync)?\s*\([^\n]*(?:SELF\.md|PERSONA\.md|deepseek的记忆)/i.test(line);
        const memory=/(?:ctx\.)?(?:memory|mnemon)\s*\.\s*(?:remember|forget|archive|mutate|create|write|set)\s*\(/i.test(line)
          || /(?:personaInjection|memoryInjection)\s*:\s*true/.test(line);
        if(persona||memory)reasons.push({file:path.slice(root.length+1).replace(/\\/g,'/'),line:index+1,kind:persona?'persona-change':'memory-change'});
      });
    }
  };
  visit(root);
  if(reasons.length)throw marketError('FH_MARKET_DISCUSSION_REQUIRED','发现具体人格或记忆操作；材料已保留，请与 DSH 讨论后手动重试',{reasons});
  return {reviewed:true,basis:'实际代码/配置定点检查；通用工具说明及缺少元数据不构成拒绝；运行时行为未被静态证明'};
}
