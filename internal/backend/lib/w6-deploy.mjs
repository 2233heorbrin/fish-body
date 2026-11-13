/** Native installation verification and recovery. Compare installed runtime files
 * with the prepared tarball/closure. Never import or call an arbitrary plugin as a probe.
 * The native DSH installer still owns bundle compatibility, selection and activation.
 */

import { createRequire } from 'node:module';
import { packageFiles } from './w6-package.mjs';
import { treeHashOf, treeManifest, sha256Buffer, sri512 } from './w6-utils.mjs';
import { realpathSync } from 'node:fs';
import { existsSync, renameSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withNativeInstallLock, nativeLockPathOf } from './w6-lock.mjs';
import {
  captureW6Snapshot, verifyW6Snapshot, restoreW6Snapshot,
} from './w6-snapshot.mjs';
import { runFullAdmission, W6ADM } from './w6-admission.mjs';
import { reverifyInstallApproval } from './w6-approval.mjs';
import {
  deployedTreeHash, atomicJson, readJson, NL,
} from './w6-utils.mjs';
import {
  independentProbe, registrySet, registryGet, profileState, PROBE_SCRIPT_PATH,
} from './w6-runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENDER = join(HERE, 'w6-lock-contender.mjs');

export const W6DEP = Object.freeze({
  NOT_ISOLATION: 'W6_NOT_ISOLATION',
  ADMISSION_BLOCKED: 'W6_ADMISSION_BLOCKED',
  APPROVAL_BLOCKED: 'W6_APPROVAL_BLOCKED',
  INSTALL_FAILED: 'W6_INSTALL_FAILED',
  DEPLOY_VERIFY_FAILED: 'W6_DEPLOY_VERIFY_FAILED',
  RESTORE_FAILED: 'W6_RESTORE_FAILED',
  RESTORE_VERIFY_FAILED: 'W6_RESTORE_VERIFY_FAILED',
  NO_ACTIVE: 'W6_NO_ACTIVE',
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 部署后内容校验的**期望值**：对 W5 产物与本地依赖源目录用同一 deployedTreeHash 算法复算。 */
export function expectedDeployedHashes({ artifactDir, dependencySubtree, packageName, packageRecord=null, profileDir=null }) {
  const runtime=packageRecord?.runtimeDir??join(artifactDir,'仓库');
  const out={[packageName]:{hash:packageRecord?.runtimeContentHash??treeHashOf(packageFiles(runtime)),parent:null,fullTree:!!packageRecord?.runtimeContentHash}};
  if(packageRecord?.runtimeContentHash) {
    // Recover old records from their bound tarball, never from the installed tree.
    const baseline=packedBaseline(packageRecord);
    out[packageName].files=baseline.files;
    out[packageName].generatedBins=baseline.generatedBins;
    out[packageName].peerBins=profileDir?existingPeerBins(baseline.peerRequests,profileDir):[];
  }
  for(const d of dependencySubtree?.packages??[])if(d.resolvedDir) {
    out[`${d.parent??'root'}/${d.name}@${d.version}`]={hash:treeHashOf(packageFiles(d.resolvedDir)),name:d.name,parent:d.parent??'root',version:d.version};
  }
  return out;
}

function binEntries(pkg) {
  const bins=typeof pkg.bin==='string'?{[String(pkg.name).split('/').at(-1)]:pkg.bin}:pkg.bin;
  return Object.entries(bins&&typeof bins==='object'?bins:{}).filter(([name,target])=>
    /^[^/\\:\0]+$/.test(name)&&name!=='.'&&name!=='..'&&typeof target==='string');
}
function binPaths(binDir,pkg,hasTarget) {
  return binEntries(pkg).flatMap(([name,target])=>{
    const normalized=posix.normalize(target.replace(/\\/g,'/'));
    if(normalized.startsWith('../')||posix.isAbsolute(normalized)||!hasTarget(normalized))return [];
    return [name,...(process.platform==='win32'?[name+'.cmd',name+'.ps1']:[])].map(file=>posix.join(binDir,file));
  });
}
function packedBaseline(record) {
  let temp;
  try {
    let runtime=record.runtimeDir,files=record.runtimeFiles;
    if(!Array.isArray(files)||!runtime||!existsSync(runtime)) {
      if(!record.tgzPath||sri512(readFileSync(record.tgzPath))!==record.packageIntegrity)
        throw new Error('绑定安装包 integrity 不一致，无法恢复内容清单');
      temp=mkdtempSync(join(tmpdir(),'fh-packed-baseline-'));
      execFileSync('tar',['-xzf',record.tgzPath,'-C',temp],{stdio:['ignore','pipe','pipe'],windowsHide:true});
      runtime=join(temp,'package');files=treeManifest(runtime);
    }
    if(treeHashOf(files)!==record.runtimeContentHash)throw new Error('安装包内容清单与已绑定摘要不一致');
    const byPath=new Map(files.map(row=>[row.path,row])),manifests=new Map();
    const manifestAt=dir=>{
      if(!manifests.has(dir)) {
        const path=posix.join(dir,'package.json'),row=byPath.get(path);
        if(!row)throw new Error('已打包依赖缺少 package.json：'+path);
        const bytes=readFileSync(join(runtime,path));
        if(sha256Buffer(bytes)!==row.sha256)throw new Error('已打包 package.json 漂移：'+path);
        manifests.set(dir,JSON.parse(bytes));
      }
      return manifests.get(dir);
    };
    const generatedBins=new Set(),peerRequests=[],seen=new Set();
    const resolveBundled=(from,name)=>{
      let cursor=from;
      while(true){const dir=posix.join(cursor,'node_modules',name);if(byPath.has(posix.join(dir,'package.json')))return dir;
        if(cursor==='.')return null;cursor=posix.dirname(cursor);}
    };
    const visit=dir=>{
      if(seen.has(dir))return;seen.add(dir);const pkg=manifestAt(dir);
      for(const [name]of Object.entries({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies})) {
        const target=resolveBundled(dir,name);
        if(target) {
          const binDir=posix.join(target.slice(0,-name.length),'.bin');
          for(const path of binPaths(binDir,manifestAt(target),p=>byPath.has(posix.join(target,p))))generatedBins.add(path);
          visit(target);
        }else if(Object.hasOwn(pkg.peerDependencies??{},name)) {
          // Only declared peers; capture existing host providers before installation.
          peerRequests.push({name,binDir:posix.join(dir,'node_modules/.bin')});
        }
      }
    };
    visit('.');return {files,generatedBins:[...generatedBins],peerRequests};
  }finally{if(temp)rmSync(temp,{recursive:true,force:true})}
}
function existingPeerBins(requests,profileDir) {
  const rows=[];
  for(const {name,binDir}of requests) {
    try {
      let provider;
      try{provider=resolvePackageRoot(profileDir,name)}catch{
        // DSH supplies peers from its existing installation as well as Profile.
        const req=process.env.FISH_HAND_DSH_ROOT
          ?createRequire(join(process.env.FISH_HAND_DSH_ROOT,'package.json')):createRequire(import.meta.url);
        provider=dirname(req.resolve(name+'/package.json'));
      }
      const manifestPath=join(provider,'package.json'),bytes=readFileSync(manifestPath),pkg=JSON.parse(bytes);
      if(pkg.name!==name)continue;
      const targets=[];
      const paths=binPaths(binDir,pkg,p=>{
        try{targets.push({path:p,sha256:sha256Buffer(readFileSync(join(provider,p)))});return true}catch{return false}
      });
      if(paths.length)rows.push({name,provider:realpathSync(provider),manifestHash:sha256Buffer(bytes),targets,paths});
    }catch{ /* An unavailable peer cannot explain any generated entry. */ }
  }
  return rows;
}
function compareRuntimeFiles(dir,value) {
  if(!Array.isArray(value.files)||treeHashOf(value.files)!==value.hash)
    throw new Error('缺少绑定安装包文件清单，请从原安装包建立部署期望值');
  const actualFiles=treeManifest(dir),observed=new Map(actualFiles.map(row=>[row.path,row]));
  const original=new Set(value.files.map(row=>row.path)),allowed=new Set(value.generatedBins??[]);
  for(const peer of value.peerBins??[]) {
    // The provider was captured before pnpm, not chosen by an added shim.
    try{const provider=resolvePackageRoot(dir,peer.name);
      if(sha256Buffer(readFileSync(join(provider,'package.json')))===peer.manifestHash
        &&peer.targets.every(row=>sha256Buffer(readFileSync(join(provider,row.path)))===row.sha256))
        for(const path of peer.paths)allowed.add(path);
    }catch{ /* No matching existing provider: additions remain unexplained. */ }
  }
  const missing=[],modified=[],unexpected=[],generated=[];
  for(const row of value.files){const actual=observed.get(row.path);if(!actual)missing.push(row.path);else if(actual.sha256!==row.sha256)modified.push(row.path)}
  for(const row of actualFiles)if(!original.has(row.path)) (allowed.has(row.path)?generated:unexpected).push(row.path);
  return {actual:treeHashOf(actualFiles.filter(row=>!generated.includes(row.path))),
    ok:!missing.length&&!modified.length&&!unexpected.length,missing,modified,unexpected,generated};
}
function resolvePackageRoot(from,name) {
  let cursor=realpathSync(from);
  while(true) {
    const p=join(cursor,'node_modules',...name.split('/'));
    if(existsSync(join(p,'package.json')))return p;
    const next=dirname(cursor);if(next===cursor)throw new Error('dependency missing');cursor=next;
  }
}
export function verifyDeployedContent({profileDir,expected,packageNames}) {
  const rows={},roots=new Map();
  for(const name of packageNames) {
    const p=join(profileDir,'node_modules',...name.split('/'));
    if(existsSync(join(p,'package.json')))roots.set(name,p);
  }
  // Resolve dependency closure from the package that requires it (not from Profile hoisting).
  const pending=Object.entries(expected);
  while(pending.length) {
    let progressed=false;
    for(let i=pending.length-1;i>=0;i--) {
      const [key,value]=pending[i];
      if(typeof value==='string') {
        const dir=join(profileDir,'node_modules',...key.split('/'));const actual=deployedTreeHash(dir);
        rows[key]={dir,expected:value,actual,ok:actual===value};pending.splice(i,1);progressed=true;continue;
      }
      const parent=value.parent==='root'?packageNames[0]:value.parent;
      if(parent&&!roots.has(parent))continue;
      try {
        const dir=value.parent?resolvePackageRoot(roots.get(parent),value.name):join(profileDir,'node_modules',...key.split('/'));
        const comparison=value.fullTree?compareRuntimeFiles(dir,value):null;
        const actual=comparison?.actual??treeHashOf(packageFiles(dir));roots.set(value.name?`${value.name}@${value.version}`:key,dir);
        rows[key]={dir,expected:value.hash,actual,...comparison,ok:comparison?comparison.ok:actual===value.hash};
      }catch(error) {rows[key]={ok:false,reason:error.code==='ENOENT'?'运行产物或依赖缺失':error.message};}
      pending.splice(i,1);progressed=true;
    }
    if(!progressed){for(const [key]of pending)rows[key]={ok:false,reason:'依赖父节点缺失'};break;}
  }
  return {ok:Object.values(rows).every(r=>r.ok),rows,kind:'packed-runtime-and-resolved-dependencies'};
}
export function resolutionProbe({profileDir,pluginName,depName=''}) {
  const req=createRequire(join(profileDir,'package.json')),parsed={};
  try {
    const root=join(profileDir,'node_modules',...pluginName.split('/'));
    let entry;try {entry=req.resolve(pluginName);} catch {entry=join(root,'package.json');}
    if(!existsSync(entry))throw new Error('missing package');parsed.resolvedPlugin=entry;
    parsed.pluginEntrySha256=treeHashOf(packageFiles(join(profileDir,'node_modules',...pluginName.split('/'))));
    parsed.pluginTreeHash=parsed.pluginEntrySha256;
    parsed.pluginVersion=JSON.parse(readFileSync(join(profileDir,'node_modules',...pluginName.split('/'),'package.json'))).version;
    if(depName) {const d=resolvePackageRoot(join(profileDir,'node_modules',...pluginName.split('/')),depName);parsed.resolvedDep=d;parsed.depTreeHash=treeHashOf(packageFiles(d));parsed.depVersion=JSON.parse(readFileSync(join(d,'package.json'))).version;}
    return {ok:true,parsed,pid:process.pid,method:'resolve-and-hash-only; no import or invocation'};
  }catch{return {ok:false,parsed,pid:process.pid,method:'resolve-and-hash-only'};}
}

/** 独立进程采集运行时基线。定点收口后仅由部署器在锁内、pnpm 前调用。 */
export function captureRuntimeBaseline({ profileDir, packageName, depName }) {
  const probe = resolutionProbe({ profileDir, pluginName: packageName, depName });
  return {
    ok: probe.ok,
    probe,
    pluginVersion: probe.parsed?.pluginVersion ?? null,
    depVersion: probe.parsed?.depVersion ?? null,
    depMarker: probe.parsed?.depMarker ?? null,
    pluginEntrySha256: probe.parsed?.pluginEntrySha256 ?? null,
    depEntrySha256: probe.parsed?.depEntrySha256 ?? null,
    pluginTreeHash: probe.parsed?.pluginTreeHash ?? null,
    depTreeHash: probe.parsed?.depTreeHash ?? null,
    lockSha256: probe.parsed?.lockSha256 ?? null,
  };
}

const RUNTIME_FIELDS = [
  'pluginVersion', 'depVersion', 'depMarker', 'pluginEntrySha256',
  'depEntrySha256', 'pluginTreeHash', 'depTreeHash', 'lockSha256',
];

/**
 * 恢复后五项核对：目标包 / 运行时依赖 / 锁文件 / 模块解析结果 / 注册记录。
 * baselineValid=false（更新场景基线采集失败）时模块解析项必须判失败，
 * 不能因为「没有基线可比」就默认通过。
 */
export function verifyRestoredState({
  profileDir, registryPath, snapshot, packageName, depNames,
  runtimeBaseline = null, baselineValid = true,
}) {
  const packageNames = [packageName, ...depNames];
  const snapshotVerification = verifyW6Snapshot(snapshot, { profileDir });
  const probe = resolutionProbe({
    profileDir, pluginName: packageName, depName: depNames[0] ?? '',
  });
  const state = profileState(profileDir, registryPath, packageNames);
  const registry = registryGet(registryPath, packageName);

  // 比较前统一 null 归一：字段缺失（undefined）与显式 null 语义相同，
  // 都表示「该字段不存在」。此前 undefined === null 为 false，会让「两次都没有依赖字段」
  // 被判成模块解析不一致（第二轮 W6-B 服务恢复场景暴露）。
  const runtimeCompare = RUNTIME_FIELDS.map((field) => ({
    field,
    expected: runtimeBaseline?.[field] ?? null,
    actual: probe.parsed?.[field] ?? null,
    ok: runtimeBaseline
      ? (probe.parsed?.[field] ?? null) === (runtimeBaseline[field] ?? null)
      : true,
  }));

  const lockChecks = snapshotVerification.checks.filter((c) => c.item !== 'dsh.profile.bundles');
  // 首次安装失败恢复到「未安装」：此时正确的运行时状态是**解析不到插件 / 没有注册记录**。
  // 更新失败才会带 runtimeBaseline 去比对旧代码旧依赖。
  const expectAbsent = runtimeBaseline === null;
  const items = {
    // ① 目标包：目录树哈希 + 逐文件哈希 + 版本
    targetPackage: {
      ok: snapshotVerification.perPackage.find((p) => p.name === packageName)?.ok === true,
      detail: snapshotVerification.perPackage.find((p) => p.name === packageName) ?? null,
    },
    // ② 运行时依赖：每个 dep 都单独核对
    runtimeDependency: {
      ok: depNames.every((n) => snapshotVerification.perPackage.find((p) => p.name === n)?.ok === true),
      names: depNames,
      details: depNames.map((n) => snapshotVerification.perPackage.find((p) => p.name === n) ?? null),
    },
    // ③ 锁文件 / 清单 / pnpm 内部状态 / 注册表文件
    lockFiles: {
      ok: lockChecks.every((c) => c.ok) && snapshotVerification.checks
        .find((c) => c.item === 'dsh.profile.bundles')?.ok === true,
      checks: snapshotVerification.checks,
    },
    // ④ 模块解析结果：独立进程 + 基线有效性 + 与旧基线逐字段一致（或首次安装时确认未装）
    moduleResolution: {
      ok: baselineValid === true && (expectAbsent
        ? (probe.ok === false && !probe.parsed?.resolvedPlugin)
        : (probe.ok && runtimeCompare.every((r) => r.ok))),
      baselineValid,
      expected: expectAbsent ? 'absent（未安装，独立进程应解析失败）' : '旧代码 + 旧依赖',
      probeProcessPid: probe.pid,
      resolvedPlugin: probe.parsed?.resolvedPlugin ?? null,
      resolvedDep: probe.parsed?.resolvedDep ?? null,
      runtimeCompare,
      probeCommand: probe.command,
    },
    // ⑤ 注册记录：更新失败恢复后仍是 installed 且版本与旧状态一致，不得出现 active；
    //    首次安装失败恢复后应当没有该插件的注册记录。
    registryRecord: {
      ok: snapshotVerification.checks.find(c=>c.item==='registry.json')?.ok===true,
      expected: expectAbsent ? 'no registry record' : 'installed（非 active）',
      registry,
      installedVersions: state.packages,
      bundles: state.bundles,
    },
  };

  return {
    ok: baselineValid === true
      && Object.values(items).every((i) => i.ok)
      && snapshotVerification.ok,
    items,
    baselineValid,
    snapshotVerification,
    probe,
    profileState: state,
    registry,
    note: '五项独立核对；模块解析由独立 Node 进程完成，规避同进程 require 缓存',
  };
}

/**
 * 定点收口 ③：**统一恢复判定的唯一权威实现**。
 * 部署失败分支与独立探针失败分支都必须调用本函数，不允许各自简化。
 */
export function recoveryVerdict({ restoreReport, recovered }) {
  const snapshotRestored = restoreReport?.ok === true;
  const independentlyVerified = recovered?.ok === true
    && Object.values(recovered?.items ?? {}).every((i) => i?.ok === true);
  const rolledBack = snapshotRestored && independentlyVerified;
  const failedItems = Object.entries(recovered?.items ?? {})
    .filter(([, v]) => v?.ok !== true).map(([k]) => k);
  return {
    rolledBack,
    snapshotRestored,
    independentlyVerified,
    failedItems,
    verdict: rolledBack ? 'rolled-back' : 'restore-failed',
    code: rolledBack
      ? W6DEP.INSTALL_FAILED
      : (snapshotRestored ? W6DEP.RESTORE_VERIFY_FAILED : W6DEP.RESTORE_FAILED),
    note: rolledBack
      ? '失败后按完整快照恢复，且恢复后五项独立核对全部通过；未登记 installed/active'
      : `恢复判定未通过：快照恢复=${snapshotRestored}，恢复后独立核对=${independentlyVerified}`
        + `，失败项=[${failedItems.length > 0 ? failedItems.join(', ') : '快照恢复'}]`
        + '；明确 restore-failed，不宣称成功，磁盘状态不可判为已恢复',
  };
}

export function spawnContender({ profileDir, timelinePath, waitMs = 30000 }) {
  const args = [CONTENDER, profileDir, timelinePath, String(waitMs)];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString(); });
  child.stderr.on('data', (b) => { stderr += b.toString(); });
  const promise = new Promise((resolve) => {
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch { /* 保留原文 */ }
      resolve({ exitCode: code, parsed, stdout: stdout.trim().slice(-400), stderr: stderr.slice(-400) });
    });
  });
  return { child, promise, command: [process.execPath, ...args].join(' ') };
}

/** 读取 timeline 并判定「第二次安装没有插入恢复过程」。 */
export function analyzeLockTimeline(timelinePath, mainLabel) {
  if (!timelinePath || !existsSync(timelinePath)) {
    return { ok: false, reason: 'timeline 缺失' };
  }
  const rows = readFileSync(timelinePath, 'utf8').trim().split(/\r?\n/)
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const main = rows.filter((r) => r.label === mainLabel);
  const contenders = rows.filter((r) => r.label === 'contender');
  const mainEnter = main.find((r) => r.event === 'enter-critical');
  const mainRestoreStart = main.find((r) => r.event === 'restore-start');
  const mainRestoreEnd = main.find((r) => r.event === 'restore-end');
  const mainLeave = main.find((r) => r.event === 'leave-critical');
  const cAttempt = contenders.find((r) => r.event === 'attempt-lock');
  const cEnter = contenders.find((r) => r.event === 'enter-critical');
  const cLeave = contenders.find((r) => r.event === 'leave-critical');
  return {
    ok: !!(mainEnter && mainRestoreStart && mainRestoreEnd && mainLeave && cAttempt && cEnter && cLeave)
      && cAttempt.t < mainRestoreEnd.t
      && cEnter.t > mainLeave.t
      && cEnter.t > mainRestoreEnd.t
      && mainRestoreStart.t > mainEnter.t,
    rows,
    main: { enter: mainEnter ?? null, restoreStart: mainRestoreStart ?? null,
      restoreEnd: mainRestoreEnd ?? null, leave: mainLeave ?? null },
    contender: { attempt: cAttempt ?? null, enter: cEnter ?? null, leave: cLeave ?? null },
    verdict: '争用者在恢复期间就尝试取锁，但只在主部署离开临界区之后才进入；未插入恢复过程',
  };
}

/**
 * 执行一次部署事务。返回结构化证据对象，不抛异常（除锁超时等基础设施错误）。
 */
export async function deployOnce(options) {
  const {
    label, profileDir, registryPath, snapshotRoot, reportDir, timelinePath = null,
    packageName, depNames = [], artifactDir,
    packageRecord, w5Manifest, decision, injectionReviewEvidencePath,
    approvalRoot = null, approvalRecord = null, decisionStore = null,
    runPnpm, isolationOnly = true, failInject = {}, contender = null,
    waitMs = 60000,
  } = options;
  mkdirSync(reportDir, { recursive: true });
  const packageNames = [packageName, ...depNames];
  const dependencies = Object.keys(packageRecord.dependencySpecs ?? {});
  const expected = expectedDeployedHashes({
    artifactDir, dependencySubtree: packageRecord.dependencySubtree, packageName, packageRecord, profileDir,
  });

  const base = {
    schema: 'w6-deploy-result/v2-isolation-test-only',
    label,
    at: new Date().toISOString(),
    profileDir,
    registryPath,
    packageName,
    depNames,
    spec: packageRecord.spec,
    version: packageRecord.version,
    sourceTreeHash: packageRecord.sourceTreeHash,
    w5ContentHash: packageRecord.w5ContentHash,
    packageIntegrity: packageRecord.packageIntegrity,
    dependencySubtreeSha256: packageRecord.dependencySubtree?.sha256 ?? null,
    dependencySpecs: packageRecord.dependencySpecs,
    expectedDeployedHashes: expected,
    lockPath: nativeLockPathOf(profileDir),
    testData: { isolationOnly, simulatedDecision: true },
  };

  let contenderHandle = null;

  const outcome = await withNativeInstallLock(profileDir, async ({ line, lockPath }) => {
    line('snapshot-start', { packageNames });
    const snapshot = captureW6Snapshot({
      profileDir, packageNames, registryPath, snapshotRoot,
      id: `${label}-${Date.now()}`,
    });
    line('snapshot-done', {
      snapshotId: snapshot.id,
      trackedFiles: Object.keys(snapshot.files).length,
      packagesPresent: Object.entries(snapshot.packages).filter(([, p]) => p.exists).map(([n]) => n),
    });

    // ---- 定点收口 ③：更新前运行时基线由部署器在同一锁内、pnpm 前自行采集 ----
    const isUpdate = snapshot.packages[packageName]?.exists === true;
    const runtimeBaseline = isUpdate
      ? captureRuntimeBaseline({ profileDir, packageName, depName: depNames[0] ?? '' })
      : null;
    const baselineValid = !isUpdate || runtimeBaseline?.ok === true;
    line('runtime-baseline', {
      source: 'deployer-in-lock', isUpdate,
      captured: runtimeBaseline !== null, ok: baselineValid,
      pluginVersion: runtimeBaseline?.pluginVersion ?? null,
      depMarker: runtimeBaseline?.depMarker ?? null,
    });

    // ---- 部署前完整准入（不能仅凭 ready 或 W4/W5 范围检查）----
    const admission = runFullAdmission({
      spec: packageRecord.spec,
      packageName,
      version: packageRecord.version,
      sourceTreeHash: packageRecord.sourceTreeHash,
      dependencySubtreeSha256: packageRecord.dependencySubtree.sha256,
      dependencies,
      packageJson: packageRecord.packageJson,
      packageRecord,
      w5Manifest,
      decision,
      injectionReviewEvidencePath,
      tgzPath: failInject.admissionTgzPath ?? null,
      isolationOnly,
      inputOverride: failInject.admissionInputOverride ?? null,
    });
    line('full-admission', {
      allow: admission.allow, code: admission.code, failedChecks: admission.failedChecks,
      steps: [...new Set(admission.evaluateResult.trace.map((t) => t.step))],
    });

    if (!admission.allow) {
      const unchanged = verifyW6Snapshot(snapshot, { profileDir });
      return {
        ...base, verdict: 'admission-rejected', code: W6DEP.ADMISSION_BLOCKED,
        admission, snapshotPath: snapshot.snapshotPath,
        snapshotUnchanged: unchanged.ok,
        runtimeBaseline, runtimeBaselineSource: 'deployer-in-lock', baselineValid,
        installed: false, active: false, wroteActive: false,
        note: '完整准入未通过：未执行 pnpm、未写注册记录；磁盘保持快照状态',
      };
    }

    // ---- 定点收口 ①：同一安装锁内、执行 pnpm 前的批准复核 ----
    const approval = reverifyInstallApproval({
      root: approvalRoot, record: approvalRecord, decision, decisionStore,
      artifactDir, w5Manifest, packageRecord, isolationOnly,
      ...(failInject.approvalOverride ?? {}),
    });
    line('install-approval-recheck', {
      allow: approval.allow, code: approval.code, failedChecks: approval.failedChecks,
    });
    if (!approval.allow) {
      const unchanged = verifyW6Snapshot(snapshot, { profileDir });
      return {
        ...base, verdict: 'approval-rejected', code: W6DEP.APPROVAL_BLOCKED,
        admission, installApproval: approval,
        snapshotPath: snapshot.snapshotPath, snapshotUnchanged: unchanged.ok,
        runtimeBaseline, runtimeBaselineSource: 'deployer-in-lock', baselineValid,
        installed: false, active: false, wroteActive: false,
        note: `安装前批准复核未通过（${approval.code}）：未执行 pnpm、未写注册记录；磁盘保持快照状态`,
      };
    }

    // ---- 真实 pnpm 安装（无锁执行器）----
    line('install-start', { spec: packageRecord.spec });
    let restoreTarball = () => {};
    if (failInject.hideTarball) {
      const hidden = packageRecord.tgzPath + '.hidden';
      renameSync(packageRecord.tgzPath, hidden);
      restoreTarball = () => { if (existsSync(hidden)) renameSync(hidden, packageRecord.tgzPath); };
    }
    let install;
    try {
      install = await runPnpm(['add', packageRecord.spec], profileDir);
    } catch (error) {
      install = { exitCode: 'throw', output: String(error?.message ?? error) };
    } finally {
      restoreTarball();
    }
    line('install-done', { exitCode: install.exitCode });

    const afterInstall = verifyW6Snapshot(snapshot, { profileDir });
    const diskChanged = !afterInstall.ok;
    const deployed = verifyDeployedContent({ profileDir, expected, packageNames });

    let failureStage = null;
    let failureReason = null;
    if (install.exitCode !== 0) {
      failureStage = 'install-pnpm';
      failureReason = `真实 pnpm 非零退出：exitCode=${install.exitCode}`;
    } else if (!deployed.ok) {
      failureStage = 'deployed-content';
      failureReason = '部署内容不一致：'+JSON.stringify(Object.fromEntries(Object.entries(deployed.rows)
        .filter(([,row])=>!row.ok).map(([name,row])=>[name,{missing:row.missing,modified:row.modified,unexpected:row.unexpected,reason:row.reason}])));
    } else if (failInject.failStage === 'post-install') {
      failureStage = 'post-install-verification';
      failureReason = '注入：pnpm 安装成功且磁盘已变，但部署校验/登记阶段失败（无生命周期脚本）';
    }

    /**
     * 定点收口 ③：两个失败分支共用的恢复 + 恢复后核对 + 统一判定。
     */
    const recoverAndVerify = async ({ stage, reason, probe = null }) => {
      line('restore-start', { failureStage: stage, diskChanged, reason });
      if (contender) {
        contenderHandle = spawnContender({
          profileDir, timelinePath: contender.timelinePath ?? timelinePath,
          waitMs: contender.waitMs ?? 30000,
        });
      }
      // 留出可观测的争用窗口，确保争用者确实在恢复期间处于等待状态。
      if (failInject.holdDuringRestoreMs) await delay(failInject.holdDuringRestoreMs);
      const restoreReport = restoreW6Snapshot(snapshot, {
        profileDir, reportDir,
        failInject: failInject.dropCopyFor ? { dropCopyFor: failInject.dropCopyFor } : null,
      });
      // 真实反例注入：restoreReport 已生成后破坏注册记录，使「快照恢复 ok」但
      // 「恢复后独立核对」失败。用于验证统一恢复判定不会误报 rolled-back。
      if (failInject.corruptAfterRestore === 'registry') {
        registrySet(registryPath, packageName, {
          state: 'installed', active: true, version: packageRecord.version,
          note: '恢复后注册记录被破坏；用于验证恢复后独立核对必须真实参与判定',
        });
      }
      line('restore-end', { ok: restoreReport.ok, steps: restoreReport.steps.length });

      const recovered = verifyRestoredState({
        profileDir, registryPath, snapshot, packageName, depNames,
        runtimeBaseline, baselineValid,
      });
      const rv = recoveryVerdict({ restoreReport, recovered });
      line('recovery-verdict', {
        verdict: rv.verdict, snapshotRestored: rv.snapshotRestored,
        independentlyVerified: rv.independentlyVerified, failedItems: rv.failedItems,
      });
      return {
        ...base,
        verdict: rv.verdict,
        code: rv.code,
        admission,
        installApproval: approval,
        install: { exitCode: install.exitCode, outputTail: String(install.output ?? '').slice(-900) },
        failureStage: stage, failureReason: reason, diskChanged,
        deployedContent: deployed,
        snapshotPath: snapshot.snapshotPath,
        snapshotAfterInstall: afterInstall,
        restoreReport,
        recovered,
        recoveryVerdict: rv,
        runtimeBaseline,
        runtimeBaselineSource: 'deployer-in-lock',
        baselineValid,
        probe,
        installed: false, active: false, wroteActive: false,
        note: rv.note,
      };
    };

    if (failureStage) {
      return recoverAndVerify({ stage: failureStage, reason: failureReason });
    }

    // ---- 成功：独立进程验证 + 只登记 installed ----
    const probeOptions = {
      profileDir, pluginName: packageName, depName: depNames[0] ?? '',
    };
    const probe = resolutionProbe({
      ...probeOptions,
      ...(failInject.probeOverride ?? {}),
    });
    line('independent-probe', { ok: probe.ok, pid: probe.pid });
    if (!probe.ok) {
      // 定点收口 ③：独立探针失败分支必须走与上面**完全相同**的恢复后核对与统一判定。
      return recoverAndVerify({
        stage: 'independent-probe',
        reason: '独立进程无法解析或调用已部署样例',
        probe,
      });
    }

    const registryEntry = registrySet(registryPath, packageName, {
      state: 'installed',
      active: false,
      version: packageRecord.version,
      sourceTreeHash: packageRecord.sourceTreeHash,
      packageIntegrity: packageRecord.packageIntegrity,
      deployedContentHash: deployed.rows[packageName]?.actual ?? null,
      dependencySubtreeSha256: packageRecord.dependencySubtree.sha256,
      spec: packageRecord.spec,
      admissionChecks: admission.checks,
      note: '真实宿主激活尚未验证：只登记 installed，不登记 active',
    });
    line('registered-installed', { state: 'installed', active: false });

    return {
      ...base, verdict: 'installed', code: null,
      admission, installApproval: approval,
      install: { exitCode: install.exitCode },
      failureStage: null, diskChanged,
      deployedContent: deployed,
      probe,
      registryEntry,
      runtimeBaseline,
      runtimeBaselineSource: 'deployer-in-lock',
      baselineValid,
      installed: true, active: false, wroteActive: false,
      note: '完整准入 + 锁内批准复核 + 真实 pnpm + 部署内容校验 + 独立进程调用通过；只登记 installed',
    };
  }, { label, timelinePath, waitMs });

  if (contenderHandle) {
    const c = await contenderHandle.promise;
    outcome.contender = c;
    outcome.lockTimeline = analyzeLockTimeline(
      contender.timelinePath ?? timelinePath, label,
    );
    outcome.probeScript = PROBE_SCRIPT_PATH;
  }
  return outcome;
}

export { W6ADM };
