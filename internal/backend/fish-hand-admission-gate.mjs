/**
 * 正式候选 · 生产准入 gate（@deepseek-ai/fish-hand-admission-gate）
 * 由 W6-B 隔离验证 gate 转换：逐字复用精确绑定 / 完整准入 / 原生锁只读验证 /
 * 快照-恢复-独立复核 / 统一失败边界；删除全部测试设施与故障注入。
 * 数据源：production-state.mjs（唯一 canonical：registry + W5 产物 + 正式决定）。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { samePath, pathIdentity } from './lib/path-identity.mjs';
import { verifyInstallPackage } from './lib/w6-package.mjs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runFullAdmission } from './lib/w6-admission.mjs';
import {
  reverifyInstallApproval, checkProductionApproval,
} from './lib/w6-approval.mjs';
import { isNativeLockHeld, nativeLockPathOf } from './lib/w6-lock.mjs';
import {
  captureW6Snapshot, restoreW6Snapshot, verifyW6Snapshot,
} from './lib/w6-snapshot.mjs';
import {
  expectedDeployedHashes, verifyDeployedContent, captureRuntimeBaseline,
  verifyRestoredState, recoveryVerdict,
} from './lib/w6-deploy.mjs';
import { registrySet } from './lib/w6-runner.mjs';
import { DecisionStore } from './lib/decision.mjs';
import { loadProductionState, assertProfileAllowed, audit, deployedConfigPath } from './production-state.mjs';
import { validateFormalDecision } from './formal-decision.mjs';
import { bodyPhase, markOperationStart, markOperationEnd } from './lib/body-switch.mjs';
export { readBodyPhase, runBodySwitchChange, observeBodyPhase, notifyBodyPhase, bodyUsesBundle } from './lib/body-switch.mjs';
export { registerMarketManager } from './lib/market-runtime.mjs';

/** 「鱼的身体」总开关 phase 门（W1）：只读 profile 的 cordis.patch.yml + 进程内在途计数。
 *  off/closing 时宿主钩子退出干预、恢复 DSH 原生安装行为；on 时原有逻辑一行不改。
 *  本 helper 零写入：不读 productionState/registry/锁，不写 audit。 */
function bodyStateConfigPath() {
  try { return deployedConfigPath(); } catch { return null; }
}
function phaseAt(context) {
  return bodyPhase({
    profileDir: context?.dir ?? null,
    stateConfigPath: bodyStateConfigPath(),
  });
}
/** 每个事务只收尾一次：所有退出路径都调用也不会重复扣减在途计数（避免 closing 卡死）。 */
function endBodyOperation(txState) {
  if (!txState || txState.__bodyOpEnded) return;
  txState.__bodyOpEnded = true;
  markOperationEnd(txState.profileDir);
}

export const W6B = Object.freeze({
  NO_LEDGER: 'W6B_NO_LEDGER',
  UNKNOWN_PROFILE: 'W6B_UNKNOWN_PROFILE',
  UNKNOWN_OPERATION: 'W6B_UNKNOWN_PNPM_OPERATION',
  SPEC_NOT_BOUND: 'W6B_SPEC_NOT_BOUND',
  VERSION_MISMATCH: 'W6B_SPEC_VERSION_MISMATCH',
  SPEC_NOT_ARTIFACT: 'W6B_SPEC_NOT_REVIEWED_ARTIFACT',
  NOT_APPROVED: 'W6B_PLUGIN_NOT_APPROVED',
  ADMISSION_REJECTED: 'W6B_FULL_ADMISSION_REJECTED',
  APPROVAL_REJECTED: 'W6B_INSTALL_APPROVAL_REJECTED',
  LOCK_MISSING: 'W6B_NATIVE_LOCK_NOT_HELD',
  REPAIR_UNAPPROVED_DEP: 'W6B_REPAIR_UNAPPROVED_DEPENDENCY',
  REPAIR_VERSION_MISMATCH: 'W6B_REPAIR_VERSION_MISMATCH',
  REPAIR_SPEC_MISMATCH: 'W6B_REPAIR_SPEC_MISMATCH',
  REPAIR_ARTIFACT_MISMATCH: 'W6B_REPAIR_ARTIFACT_MISMATCH',
  INSTALL_TX_FAILED: 'W6B_INSTALL_TX_FAILED',
  TX_STATE_MISSING: 'W6B_TX_STATE_MISSING',
  LOAD_REJECTED: 'W6B_LOAD_ADMISSION_REJECTED',
  DUMP_REJECTED: 'W6B_DUMP_CONFIG_SCHEMA_REJECTED',
});

export class W6BAdmissionError extends Error {
  constructor(code, reason, extra = {}) {
    super(`[W6B ${code}] ${reason}`);
    this.name = 'W6BAdmissionError';
    this.code = code;
    this.reason = reason;
    this.extra = extra;
  }
}

function productionState() { return loadProductionState(); }

/** DSH owns its published/source-checkout catalog and the corresponding source target.
 * Resolve from the running installation, never from a fish registry or scope prefix.
 */
function nativeOfficialTargets() {
  try {
    const configured=loadProductionState().installAnchor;
    const req=configured?createRequire(configured):process.env.FISH_HAND_DSH_ROOT
      ?createRequire(join(resolve(process.env.FISH_HAND_DSH_ROOT),'package.json')):createRequire(import.meta.url);
    const boot=req('@deepseek-ai/dsh-app-boot');
    const anchor=req.resolve('@deepseek-ai/dsh/package.json');
    const {officialBundleInstallTarget}=req(join(dirname(req.resolve('@deepseek-ai/dsh-plugin-manager')),'types/official-install-target.js'));
    const names=[...new Set([...boot.OPTIONAL_BUNDLES,...boot.OFFICIAL_ON_DEMAND_CATALOG.map(r=>r.packageName)])];
    const version=boot.getDshRuntimeVersion();
    return names.flatMap(name=>{
      try{return [{name,...officialBundleInstallTarget(name,anchor,version)}];}
      catch{return [];}// An unavailable workspace component cannot authorize itself or block other native targets.
    });
  }catch{return [];}
}
export function nativeOfficialSpecs(args,spec=null) {
  const operation=classifyPnpmArgs(args,spec);
  if(!['install','update'].includes(operation.op)||!operation.specs.length)return false;
  const targets=nativeOfficialTargets();
  return operation.specs.every(raw=>targets.some(t=>raw===t.spec));
}

function profileConf(dir) {
  try { return assertProfileAllowed(dir); }
  catch (error) {
    throw new W6BAdmissionError(W6B.UNKNOWN_PROFILE, String(error?.message ?? error));
  }
}

/** 调用栈片段：证明准入是被真实宿主副本函数调用，而非外部模拟。 */
function callerStack() {
  return new Error().stack.split(/\r?\n/).slice(2, 6).map((l) => l.trim());
}

// profile 边界由 assertProfileAllowed 校验（路径边界，不是测试白名单）

// ================================================================ ① 规格解析与精确绑定

/**
 * 逐个解析 pnpm 参数中的实际安装规格。
 * 区分命令、带值选项、等号选项与 -- 后的规格；覆盖市场和原生入口使用的形式。
 */
export function parseInstallSpecs(args, spec = null) {
  const specs = [];
  let subcommand = null;
  const values = new Set(['--dir','-C','--prefix','--filter','-F','--registry','--store-dir','--virtual-store-dir','--reporter','--config','--workspace-dir']);
  const list = [...(Array.isArray(args) ? args : [])];
  for (let i=0;i<list.length;i++) {
    const a=list[i];
    if (typeof a !== 'string' || a === '') continue;
    if (a === '--') { specs.push(...list.slice(i+1)); break; }
    if (values.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (subcommand === null) { subcommand=a; continue; }
    specs.push(a);
  }
  if (typeof spec==='string' && spec && !specs.includes(spec)) specs.push(spec);
  return { subcommand, specs };
}

/** 规格身份解析（尽力而为，仅用于诊断与版本核对；绑定以逐字相等为准）。 */
export function parseSpecIdentity(raw) {  if (/^(git\+|git:|github:|https?:|ssh:)/i.test(raw)) return { kind: 'remote', name: null, version: null };
  if (/^(file|link):/i.test(raw)) return { kind: 'local', name: null, version: null };
  const m = /^(@[^/@\s]+\/)?([^@/\s]+)(?:@([^@\s]+))?$/.exec(raw);
  if (m) {
    const name = (m[1] ?? '') + m[2];
    if (!productionState().candidates?.[name] && !m[1] && !/^[a-z@/][a-z0-9._@/-]*$/i.test(name)) {
      return { kind: 'unknown', name: null, version: null };
    }
    return { kind: 'registry', name, version: m[3] ?? null };
  }
  return { kind: 'unknown', name: null, version: null };
}

/**
 * 定点收口 ①：把每个实际安装规格绑定到**准确的批准对象**。
 * 返回 { bound: [{candidate, spec}], rejected: [{spec, code, reason}] }。
 * 绑定规则（不再有任何子串匹配）：
 *   - 规格**逐字等于**候选的登记规格（本次已审产物的精确规格）→ 绑定成立；
 *   - registry 形态 name[@version]：
 *       名字未登记（含同名前缀包）→ SPEC_NOT_BOUND；
 *       名字已登记但版本不同 → VERSION_MISMATCH（其他版本）；
 *       名字已登记且版本相同但仍非产物规格 → SPEC_NOT_ARTIFACT
 *         （真正交给包管理器的规格必须对应本次已审产物，裸名/registry 解析不是已审产物）；
 *   - 其他形态（远程/本地/未知）无逐字匹配 → SPEC_NOT_BOUND。
 */
export function bindSpecs(rawSpecs, candidates) {
  const bound = [];
  const rejected = [];
  for (const raw of rawSpecs) {
    const exact = Object.values(candidates).find((c) => c.spec === raw);
    if (exact) {
      if (exact.approved !== true) {
        rejected.push({ spec: raw, code: W6B.NOT_APPROVED,
          reason: `规格绑定的候选 ${exact.packageName} 未获批准（approved=false）` });
      } else {
        bound.push({ candidate: exact, spec: raw });
      }
      continue;
    }
    const id = parseSpecIdentity(raw);
    const c = id.kind === 'registry' ? candidates[id.name] : null;
    if (id.kind === 'registry' && c) {
      if (c.approved !== true) {
        rejected.push({ spec: raw, code: W6B.NOT_APPROVED,
          reason: `规格指向的候选 ${id.name} 未获批准（approved=false）` });
      } else if (id.version !== null && id.version !== c.version) {
        rejected.push({ spec: raw, code: W6B.VERSION_MISMATCH,
          reason: `其他版本：${id.name}@${id.version}，已批准对象是 ${id.name}@${c.version}` });
      } else {
        rejected.push({ spec: raw, code: W6B.SPEC_NOT_ARTIFACT,
          reason: `规格不是本次已审产物的登记规格（已审产物规格=${c.spec}）；`
            + '真正交给包管理器的规格必须对应本次已审产物' });
      }
      continue;
    }
    rejected.push({ spec: raw, code: W6B.SPEC_NOT_BOUND,
      reason: id.kind === 'registry'
        ? `安装规格指向未登记的包名：${id.name ?? raw}`
        : `安装规格不逐字对应任何已审产物：${raw.slice(0, 200)}` });
  }
  return { bound, rejected };
}

// ================================================================ ④ 操作分类

const MUTATING = new Map([
  ['add', 'install'],
  ['install', 'install-or-repair'],
  ['update', 'update'], ['upgrade', 'update'], ['up', 'update'],
  ['remove', 'remove'], ['rm', 'remove'], ['uninstall', 'remove'], ['un', 'remove'],
  ['link', 'install'], ['import', 'unknown'], ['dedupe', 'unknown'], ['patch-commit', 'unknown'],
]);
const READONLY = new Set(['list', 'ls', 'why', 'outdated', 'view', 'info', 'search',
  'find', 'owners', 'whois', 'logs', 'license']);

/**
 * 定点收口 ④：区分 install / update / remove / repair / 只读 / 未知可变更命令。
 * 返回 { op, subcommand }。裸 `pnpm install`（无规格）= repair（内核自身用它修复
 * node_modules，见 dsh-plugin-manager lib/index.js:742 repair = ["install", ...]）。
 */
export function classifyPnpmArgs(args, spec = null) {
  const { subcommand, specs } = parseInstallSpecs(args, spec);
  if (subcommand === null) return { op: 'empty', subcommand: null, specs };
  if (subcommand === 'store' && specs.length===1 && specs[0]==='path')
    return { op:'readonly', subcommand, specs };
  if (READONLY.has(subcommand)) return { op: 'readonly', subcommand, specs };
  const kind = MUTATING.get(subcommand);
  if (kind === 'install') return { op: 'install', subcommand, specs };
  if (kind === 'install-or-repair') {
    return specs.length === 0
      ? { op: 'repair', subcommand, specs }
      : { op: 'install', subcommand, specs };
  }
  if (kind === 'update') return { op: 'update', subcommand, specs };
  if (kind === 'remove') return { op: 'remove', subcommand, specs };
  return { op: 'unknown', subcommand, specs };
}

/**
 * 依赖规格身份（仅用于「同名改版本 / 同名改来源」的诊断与区分；绑定仍以逐字相等为准）。
 * 支持隔离环境真实出现的三种形态：file:<tgz>、git+file://<repo>#<commit>、registry 版本串。
 */
export function depSpecIdentity(raw) {
  const value = String(raw ?? '');
  const git = /^git\+file:\/\/(.*?)(?:#(.*))?$/i.exec(value);
  if (git) return { kind: 'git', source: git[1], commit: git[2] ?? null, version: null };
  if (/^(git\+|github:|https?:|ssh:)/i.test(value)) {
    return { kind: 'remote', source: value, commit: null, version: null };
  }
  if (/^file:/i.test(value)) {
    const path = value.slice('file:'.length);
    const base = path.split(/[\\/]/).pop() ?? '';
    const vm = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/i.exec(base);
    return { kind: 'file', source: path.split('\\').join('/'), base, version: vm?.[1] ?? null };
  }
  if (/^[\^~]?\d+\.\d+\.\d+/.test(value) || ['latest', 'next', '*'].includes(value)) {
    return { kind: 'registry', source: null, commit: null, version: value };
  }
  return { kind: 'unknown', source: value, commit: null, version: null };
}

/**
 * 「对应制品」身份核对（只读既有记录，不新增哈希口径）：
 * 制品目录必须存在，manifest.version 必须等于已批准版本，
 * manifest.contentHash 必须等于 W5 审查记录里的 contentHash。
 */
function artifactIdentity(c) {
  const dir = c?.artifactDir ?? null;
  if (!dir || !existsSync(dir)) {
    return { ok: false, reason: `制品目录不存在：${String(dir)}`, contentHash: null };
  }
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `制品清单不存在：${manifestPath}`, contentHash: null };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const reviewedHash = c.admission?.w5Manifest?.contentHash ?? null;
    if (manifest.version !== c.version) {
      return { ok: false, contentHash: manifest.contentHash ?? null,
        reason: `制品版本 ${String(manifest.version)} 与已批准版本 ${String(c.version)} 不一致` };
    }
    if (reviewedHash !== null && manifest.contentHash !== reviewedHash) {
      return { ok: false, contentHash: manifest.contentHash ?? null,
        reason: '制品 contentHash 与 W5 审查记录不一致（已审制品被替换）' };
    }
    return { ok: true, contentHash: manifest.contentHash ?? null, reason: null };
  } catch (error) {
    return { ok: false, contentHash: null,
      reason: `制品清单不可解析：${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/**
 * repair：受管对象仍精确绑定制品并复用批准；既有非受管依赖交给原生修复，
 * 不追溯审批。市场准备阶段先解析缺失/过期锁，将新工具版本交给统一流程。
 * 损坏的受管登记不能冒充非受管依赖。前置层和执行器共用此判断。
 */
export function repairCheck(profileDir) {
  const candidates = productionState().candidates ?? {};
  const deps = (() => {
    try {
      return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))?.dependencies ?? {};
    } catch { return {}; }
  })();
  const findings = [];
  for (const name of Object.keys(deps).sort()) {
    const declared = String(deps[name]);
    const c = candidates[name];
    const row = {
      name, declared, expectedSpec: c?.spec ?? null, approvedVersion: c?.version ?? null,
      registered: !!c, approved: c?.approved === true,
      specBound: false, artifactOk: null, admissionAllow: null, approvalAllow: null,
      reusedExistingApproval: false, code: null, reason: null,
    };
    if (!c) {
      const managed=(productionState().problems??[]).find(r=>r.name===name&&!r.skipped);
      if(managed) {
        row.code=W6B.REPAIR_ARTIFACT_MISMATCH;
        row.reason='受管依赖的登记产物无法验证，不能当成非受管依赖修复';
        findings.push(row);continue;
      }
      // Existing unmanaged dependencies belong to native repair, not retroactive approval.
      row.nativeRepair=true;
      row.reason = '既有非受管依赖，由原生包管理器修复';
      findings.push(row);
      continue;
    }
    if (c.approved !== true) {
      row.code = W6B.REPAIR_UNAPPROVED_DEP;
      row.reason = `依赖 ${name} 未获批准（approved=false）`;
      findings.push(row);
      continue;
    }
    if (declared !== c.spec) {
      const got = depSpecIdentity(declared);
      const want = depSpecIdentity(c.spec);
      row.declaredIdentity = got;
      row.expectedIdentity = want;
      const versionChanged = got.version !== null && want.version !== null && got.version !== want.version;
      const sameSource = got.source !== null && want.source !== null
        && got.source === want.source && got.kind === want.kind;
      if (versionChanged && !sameSource) {
        row.code = W6B.REPAIR_VERSION_MISMATCH;
        row.reason = `同名改版本：依赖声明 ${name}@${String(got.version)}，已审对象是 `
          + `${name}@${String(want.version)}（${String(c.spec)}）`;
      } else if (versionChanged && sameSource) {
        row.code = W6B.REPAIR_VERSION_MISMATCH;
        row.reason = `同名改版本：依赖声明 ${declared}，已审对象规格 ${String(c.spec)}`;
      } else {
        row.code = W6B.REPAIR_SPEC_MISMATCH;
        row.reason = `同名但规格/来源不等于已审产物：依赖声明 ${declared.slice(0, 200)}，`
          + `已审对象规格 ${String(c.spec).slice(0, 200)}`;
      }
      findings.push(row);
      continue;
    }
    row.specBound = true;
    const art = artifactIdentity(c);
    row.artifactOk = art.ok;
    row.artifactContentHash = art.contentHash;
    if (!art.ok) {
      row.code = W6B.REPAIR_ARTIFACT_MISMATCH;
      row.reason = art.reason;
      findings.push(row);
      continue;
    }
    const { admission, approval, gate } = decideFor(c, profileDir);
    row.admissionAllow = admission.allow;
    row.admissionCode = admission.code ?? null;
    row.approvalAllow = approval.allow;
    row.approvalCode = approval.code ?? null;
    row.productionGateVerified = gate?.verified ?? null;
    row.reusedExistingApproval = approval.allow === true;
    if (!admission.allow) {
      row.code = W6B.ADMISSION_REJECTED;
      row.reason = `完整准入未通过：${admission.code}`;
    } else if (!approval.allow) {
      row.code = W6B.APPROVAL_REJECTED;
      row.reason = `锁内批准复核未通过：${approval.code}`;
    }
    findings.push(row);
  }
  const bad = findings.filter((f) => f.code !== null);
  return {
    // 空依赖表的 repair 是 no-op（没有可复活的包）：放行，并以 empty=true 如实标注。
    ok: bad.length === 0,
    empty: findings.length === 0,
    findings, bad,
  };
}

// ================================================================ 准入核心（install/update 共用）

function decideFor(c, profileDir = null) {
  const st = productionState();
  const targetProfile = profileDir ?? st.defaultProfileDir;
  // 制品身份独立取证：现读制品目录 manifest 并与 W5 审查记录复算值比对，
  // 不用 formalDecision.binding.contentHash 自证（否则「决定写什么就认什么」）。
  const art = artifactIdentity(c);
  if (!art.ok) {
    throw new W6BAdmissionError(W6B.ADMISSION_REJECTED,
      `已审制品身份无法独立核实：${art.reason}`, { packageName: c.packageName });
  }
  const declaredHash = c.formalDecision?.binding?.contentHash ?? null;
  if (declaredHash !== art.contentHash) {
    audit({ kind: 'formal-decision-artifact-drift', surface: 'production-gate',
      packageName: c.packageName, artifactHash: art.contentHash, decisionHash: declaredHash,
      note: '正式决定绑定的 contentHash 与实际制品不一致：按实际制品拒绝' });
    throw new W6BAdmissionError(W6B.ADMISSION_REJECTED,
      `正式决定绑定的制品哈希 ${String(declaredHash)} 与实际制品 ${String(art.contentHash)} 不一致`,
      { packageName: c.packageName });
  }
  const binding = validateFormalDecision({
    decision: c.formalDecision,
    request: c.request,
    artifact: {
      artifactPath: c.artifactDir,
      // 实际制品复算值（独立于决定），而不是决定自身写的值
      contentHash: art.contentHash, packageIntegrity:c.admission.packageRecord.packageIntegrity,
      runtimeContentHash:c.admission.packageRecord.runtimeContentHash,
    },
    profileDir: targetProfile,
    mode: st.mode,
    decisionsRoot: st.decisionsRoot,
  });
  if (!binding.ok) {
    throw new W6BAdmissionError(W6B.APPROVAL_REJECTED,
      `正式决定绑定校验未通过：${binding.code} / ${binding.reason}`,
      { bindingChecks: binding.checks, packageName: c.packageName });
  }
  const store = new DecisionStore(c.approval.decisionStoreRoot);
  const admission = runFullAdmission({
    ...c.admission,
    isolationOnly: c.admission.isolationOnly ?? false,
  });
  const approval = reverifyInstallApproval({
    ...c.approval,
    decisionStore: store,
  });
  const gateResult = admission.productionGate;
  audit({ kind: 'formal-decision-verified', surface: 'production-gate',
    packageName: c.packageName, decisionId: c.formalDecision?.id ?? null,
    bindingChecks: binding.checks, mode: st.mode });
  return { admission, approval, gate: gateResult };
}

/** 单个已绑定候选的部署期望值（沿用 W6-A expectedDeployedHashes，不新增哈希口径）。 */
function expectedFor(c, profileDir) {
  return expectedDeployedHashes({
    artifactDir: c.artifactDir,
    dependencySubtree: c.admission.packageRecord.dependencySubtree,
    packageName: c.packageName, packageRecord:c.admission.packageRecord, profileDir,
  });
}

/**
 * 定点收口 ②：安装事务前置段（在宿主锁内、pnpm 之前）。
 * install/update：操作分类 → 逐规格精确绑定 → 原生锁验证 → 快照 → 更新基线 → 完整准入 → 批准复核。
 * remove/repair/readonly/unknown：按 ④ 的边界处理，不进入安装事务。
 * 抛错即拒绝（宿主入口 propagate，绝不默默放行）；成功返回 txState。
 */
export function w6bInstallPrecheck({ surface, args = [], spec = null, context = null, requireNativeLock = true }) {
  if (phaseAt(context) !== 'on') {
    return { allow: true, op: 'delegated', txState: null, delegatedTo: 'dsh-native' };
  }
  const classified = classifyPnpmArgs(args, spec);
  if(nativeOfficialSpecs(args,spec))return {allow:true,op:'native-official',txState:null,delegatedTo:'dsh-native'};
  const profileDir = context?.dir ?? productionState().defaultProfileDir;
  profileConf(profileDir); // 任何包管理操作都只允许台账登记过的隔离 profile
  const lockHeld = isNativeLockHeld(profileDir);
  const base = {
    kind: 'install-gate', surface, op: classified.op, subcommand: classified.subcommand,
    args: [...args], spec, profileDir, lockPath: nativeLockPathOf(profileDir), lockHeld,
    callers: callerStack(),
  };

  // ---- ④ 操作边界 ----
  if (classified.op === 'readonly') {
    audit({ ...base, allow: true, note: '只读 pnpm 子命令：放行，不进入安装事务' });
    return { allow: true, op: 'readonly', txState: null };
  }
  if (classified.op === 'remove') {
    // 卸载不要求新的安装批准（用户定点收口 ④）；不做准入事务，但记录证据。
    audit({ ...base, allow: true, specs: classified.specs,
      note: 'remove/uninstall：不要求新的安装批准，不进入安装事务' });
    return { allow: true, op: 'remove', txState: null };
  }
  if (classified.op === 'repair') {
    const check = repairCheck(profileDir);
    const code = check.ok ? null : (check.bad[0]?.code ?? W6B.REPAIR_UNAPPROVED_DEP);
    audit({ ...base, allow: check.ok, specs: [], repairFindings: check.findings,
      code, emptyRepair: check.empty === true,
      repairBoundExactly: check.findings.every((f) => f.specBound === true),
      reusedExistingApproval: check.findings.every((f) => f.reusedExistingApproval === true),
      note: 'repair：受管对象精确绑定已审制品并复用批准；既有非受管依赖交给原生修复，不补历史审批' });
    if (!check.ok) {
      throw new W6BAdmissionError(code,
        `repair 被拒绝（${code}）：${check.bad.map((b) => `${b.name}→${b.reason}`).join('; ')}`,
        { surface, findings: check.findings, code });
    }
    return { allow: true, op: 'repair', txState: null };
  }
  if (classified.op === 'unknown' || classified.op === 'empty') {
    audit({ ...base, allow: false, code: W6B.UNKNOWN_OPERATION,
      note: '未分类为 install/update/remove/repair/只读 的可变更 pnpm 子命令：默认拒绝，不简单豁免非 add 命令' });
    throw new W6BAdmissionError(W6B.UNKNOWN_OPERATION,
      `宿主 ${surface} 试图执行未分类的 pnpm 子命令：${String(classified.subcommand)}`,
      { surface, args: [...args] });
  }

  // ---- install / update：进入完整安装事务前置段 ----
  const conf = profileConf(profileDir);
  const candidates = productionState().candidates ?? {};
  if (classified.op === 'update' && classified.specs.length === 0) {
    // 裸 update = 全量更新：不绑定任何已审产物，必须拒绝
    audit({ ...base, allow: false, code: W6B.SPEC_NOT_ARTIFACT,
      note: '裸 pnpm update（全量更新）不对应任何本次已审产物：拒绝' });
    throw new W6BAdmissionError(W6B.SPEC_NOT_ARTIFACT,
      '裸 update 不绑定任何已审产物；更新必须逐规格精确绑定本次已审产物', { surface });
  }
  const { bound, rejected } = bindSpecs(classified.specs, candidates);
  const bindingRows = [...bound.map((b) => ({ spec: b.spec, packageName: b.candidate.packageName,
    version: b.candidate.version, bound: true })),
    ...rejected.map((r) => ({ spec: r.spec, bound: false, code: r.code, reason: r.reason }))];
  if (rejected.length > 0) {
    audit({ ...base, allow: false, op: classified.op, code: rejected[0].code,
      rows: bindingRows,
      reason: '存在未绑定到准确批准对象的安装规格；全部规格在 pnpm 前拒绝' });
    throw new W6BAdmissionError(rejected[0].code,
      `宿主 ${surface} 的安装规格未全部绑定到准确批准对象：${rejected.map((r) => `${r.spec.slice(0, 120)} → ${r.code}`).join('; ')}`,
      { surface, rows: bindingRows });
  }
  if (bound.length === 0) {
    audit({ ...base, allow: false, op: classified.op, code: W6B.SPEC_NOT_BOUND, rows: [],
      reason: '没有任何安装规格' });
    throw new W6BAdmissionError(W6B.SPEC_NOT_BOUND,
      `宿主 ${surface} 没有携带任何安装规格`, { surface });
  }
  if (requireNativeLock && !lockHeld) {
    audit({ ...base, allow: false, op: classified.op, code: W6B.LOCK_MISSING, rows: bindingRows,
      reason: `安装未处于原生锁临界区内（${nativeLockPathOf(profileDir)} 不存在）` });
    throw new W6BAdmissionError(W6B.LOCK_MISSING,
      `安装未处于原生锁临界区内（${nativeLockPathOf(profileDir)} 不存在）`, { surface });
  }

  // 完整准入 + 批准复核（每个已绑定候选；任一失败即拒绝，未执行 pnpm）
  const admissionRows = [];
  for (const { candidate: c } of bound) {
    const { admission, approval, gate } = decideFor(c, profileDir);
    admissionRows.push({
      packageName: c.packageName, version: c.version, loadForm: c.loadForm,
      admissionAllow: admission.allow, admissionCode: admission.code,
      approvalAllow: approval.allow, approvalCode: approval.code,
      productionGateVerified: gate.verified,
    });
    if (!admission.allow) {
      audit({ ...base, allow: false, op: classified.op, code: W6B.ADMISSION_REJECTED,
        rows: bindingRows, admissionRows,
        reason: `完整准入未通过：${c.packageName} / ${admission.code}` });
      throw new W6BAdmissionError(W6B.ADMISSION_REJECTED,
        `完整准入未通过：${c.packageName} / ${admission.code}`, { surface, admissionRows });
    }
    if (!approval.allow) {
      audit({ ...base, allow: false, op: classified.op, code: W6B.APPROVAL_REJECTED,
        rows: bindingRows, admissionRows,
        reason: `锁内批准复核未通过：${c.packageName} / ${approval.code}` });
      throw new W6BAdmissionError(W6B.APPROVAL_REJECTED,
        `锁内批准复核未通过：${c.packageName} / ${approval.code}`, { surface, admissionRows });
    }
  }

  // 锁内快照 + 更新前运行时基线（W6-A deployOnce 同序；锁由宿主持有，不重复取锁）
  const packageNames = bound.flatMap((b) => [b.candidate.packageName,
    ...Object.keys(b.candidate.admission.packageRecord.dependencySpecs ?? {})]);
  const snapshot = captureW6Snapshot({
    profileDir, packageNames, registryPath: conf.registryPath,
    snapshotRoot: conf.snapshotRoot,
    id: `${surface.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${Date.now()}`,
  });
  const isUpdate = bound.every((b) => snapshot.packages[b.candidate.packageName]?.exists === true);
  const runtimeBaseline = isUpdate
    ? captureRuntimeBaseline({ profileDir, packageName: bound[0].candidate.packageName,
      depName: Object.keys(bound[0].candidate.admission.packageRecord.dependencySpecs ?? {})[0] ?? '' })
    : null;
  const baselineValid = !isUpdate || runtimeBaseline?.ok === true;

  audit({ ...base, allow: true, op: classified.op, rows: bindingRows, admissionRows,
    snapshotId: snapshot.id, trackedFiles: Object.keys(snapshot.files).length,
    isUpdate, baselineValid,
    note: '安装事务前置段通过：分类+精确绑定+锁验证+快照+基线+完整准入+批准复核（pnpm 前）' });

  const txState = {
    surface, op: classified.op, profileDir, conf, bound,
    snapshot, runtimeBaseline, baselineValid, isUpdate,
    expected: Object.assign({}, ...bound.map((b) => expectedFor(b.candidate, profileDir))),
    startedAt: new Date().toISOString(),
  };
  transactions.set(pathIdentity(profileDir), txState);
  markOperationStart(txState.profileDir);
  return { allow: true, op: classified.op, txState };
}

// ================================================================ ② 事务后置段

const transactions = new Map();
function txFor(context) {
  if (!transactions.size) return null;
  const dir = context?.dir ?? readBodyProfile();
  return transactions.get(pathIdentity(dir)) ?? null;
}
function readBodyProfile() {
  try { return productionState().defaultProfileDir; } catch { return null; }
}
function clearTx(tx) {
  if (tx && transactions.get(pathIdentity(tx.profileDir)) === tx)
    transactions.delete(pathIdentity(tx.profileDir));
}
/**
 * 已处理失败的登记（第三轮定点收口 一.1）：
 * w6bVerifyInstalled 会先消费 currentTx 再做部署校验；校验失败时它已经完成完整恢复并抛错。
 * 若无此登记，服务 catch 只会看到 currentTx=null → handled=false → 又执行宿主局部 restoreFiles，
 * 造成「完整恢复后又局部恢复」。这里按事务 id 记住「该事务的失败已处理」，
 * 让服务 catch 原样传播结果（不重复完整恢复、不局部恢复，恢复失败的原判定也保持不变）。
 */
const handledByProfile = new Map();
/** 准备阶段标记（生产审计） */
/** 准备阶段标记：让失败处理能准确标注失败发生在哪个准备步骤。 */
export function w6bMarkPrepareStage({ surface = null, stage, context = null }) {
  const currentTx = txFor(context);
  if (!currentTx && phaseAt(context) !== 'on') return { marked: false };
  if (!currentTx) return { marked: false };
  currentTx.stageHint = stage;
  audit({ kind: 'prepare-stage', surface: surface ?? currentTx.surface, stage,
    snapshotId: currentTx.snapshot?.id ?? null,
    note: '事务开始后的准备阶段（可能改变磁盘）：已纳入统一失败边界' });
  return { marked: true, stage };
}

// 正式运行路径不含任何测试故障注入

/**
 * 宿主 restoreFiles 的真实调用埋点（补丁注入到方法开头）。
 * 记录实际调用次数与文件清单 —— 「没有执行局部恢复」由这份证据判定，而不是写死的标志位。
 */
export function w6bNoteLocalRestore({ surface = null, files = [], context = null } = {}) {
  const currentTx = txFor(context);
  if (!currentTx) return { callIndex: 0, delegatedTo: 'dsh-native' };
  const localRestoreCalls = (currentTx.localRestoreCalls ?? 0) + 1;
  currentTx.localRestoreCalls = localRestoreCalls;
  audit({ kind: 'local-restore', surface, callIndex: localRestoreCalls,
    files: Array.isArray(files) ? files : [],
    note: '宿主自身的局部 restoreFiles 真实被调用（用于核对是否发生了重复的局部恢复）' });
  return { callIndex: localRestoreCalls };
}

/**
 * 统一事务失败处理（第二轮定点收口 一.1/一.2/一.4 + 第三轮 一.1/一.3）。
 * 事务开始后的**任何**失败（pnpm 异常、非零退出、取消、目标识别失败、部署校验失败、
 * 准备阶段失败）都走这里：同一临界区内 W6-A 完整恢复（restoreW6Snapshot）→
 * 恢复后独立核对（verifyRestoredState 五项）→ 统一判定（recoveryVerdict）。
 * 恢复与独立复核完成后，调用方才可能抛错离开，宿主 change() 才释放原生锁。
 * 原始失败原因完整保留；恢复失败时 verdict=restore-failed 并明确报告。
 */
function failTx(txState, {
  surface, stage, reason, error = null, execResult = null, run = null,
}) {
  const { profileDir, conf, snapshot, bound, runtimeBaseline, baselineValid } = txState;
  const primary = bound[0].candidate;
  const lockHeldAtRecovery = isNativeLockHeld(profileDir);
  const localRestoreCallsBeforeRecovery = txState.localRestoreCalls ?? 0;
  const restoreReport = restoreW6Snapshot(snapshot, { profileDir, reportDir: conf.reportDir });
  const recovered = verifyRestoredState({
    profileDir, registryPath: conf.registryPath, snapshot,
    packageName: primary.packageName,
    depNames: Object.keys(primary.admission.packageRecord.dependencySpecs ?? {}),
    runtimeBaseline, baselineValid,
  });
  const rv = recoveryVerdict({ restoreReport, recovered });
  const originalError = error === null ? null : {
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 1200),
  };
  const txId = snapshot.id;
  handledByProfile.set(pathIdentity(profileDir), {
    txId, surface, stage, verdict: rv.verdict, code: rv.code,
    restoreReport, recovered, rv, at: new Date().toISOString(),
    localRestoreCallsBeforeRecovery,
  });
  audit({
    kind: 'tx-recovery', surface, stage, reason, txId,
    packageName: primary.packageName,
    originalError,

    run: run === null ? null : {
      exitCode: run?.exitCode ?? null, timedOut: run?.timedOut ?? null, kind: run?.kind ?? null,
    },
    lockHeldAtRecovery,
    restoreOk: restoreReport.ok,
    independentlyVerified: recovered.ok,
    verdict: rv.verdict, code: rv.code, failedItems: rv.failedItems,
    items: Object.fromEntries(Object.entries(recovered?.items ?? {}).map(([k, v]) => [k, {
      ok: v?.ok === true,
      ...(k === 'moduleResolution' ? {
        baselineValid: v?.baselineValid ?? null,
        expected: v?.expected ?? null,
        resolvedPlugin: v?.resolvedPlugin ?? null,
        runtimeMismatch: (v?.runtimeCompare ?? []).filter((r) => !r.ok)
          .map((r) => ({ field: r.field, expected: r.expected, actual: r.actual })),
      } : {}),
    }])),
    localRestoreCallsBeforeRecovery,
    nativeLocalRestoreSkipped: localRestoreCallsBeforeRecovery === 0,
    note: '统一事务失败处理：同一临界区内 W6-A 完整恢复 + 恢复后独立核对 + 统一判定；'
      + '恢复与独立复核完成后才随宿主 change() 释放原生锁；'
      + '「恢复前是否已发生宿主局部 restoreFiles」按真实调用计数记录（非写死标志）',
  });
  return {
    restoreReport, recovered, rv, execResult, run, lockHeldAtRecovery, originalError,
    txId, localRestoreCallsBeforeRecovery,
  };
}

/** 组装统一的安装事务失败错误：保留原始原因；恢复失败必须明确写出来。 */
function txError({
  surface, stage, reason, rec, error = null, execResult = null, packageName = null,
}) {
  const verdict = rec.rv.verdict;
  const recoveryClause = verdict === 'rolled-back'
    ? '（配置/运行副本/登记状态已按快照恢复并独立复核通过）'
    : `（恢复未通过：verdict=${verdict}，failedItems=[${rec.rv.failedItems.join(', ') || '快照恢复'}]，`
      + '磁盘状态不可判为已恢复）';
  return new W6BAdmissionError(W6B.INSTALL_TX_FAILED,
    `安装事务失败（${stage}）：${reason}；恢复判定=${verdict}${recoveryClause}`,
    {
      surface, stage, reason,
      txId: rec.txId ?? null,
      originalError: rec.originalError,
      cause: error === null ? null : String(error?.message ?? error).slice(0, 1200),
      recoveryVerdict: rec.rv, restoreReport: rec.restoreReport, recovered: rec.recovered,
      execResult, run: rec.run ?? null, packageName,
      recoveryFailed: verdict !== 'rolled-back',
      lockHeldAtRecovery: rec.lockHeldAtRecovery,
      localRestoreCallsBeforeRecovery: rec.localRestoreCallsBeforeRecovery ?? null,
    });
}

/**
 * 服务 installBundle 的统一失败入口（第二轮定点收口 一）：
 * 宿主在 installBundle 内部 `catch` 里调用它，覆盖 pnpm 抛异常 / 非零退出 / 取消 /
 * 目标识别失败（ambiguous-install、not-bundle、resolveBundleDir 失败）/ 部署校验失败。
 * 返回 { handled, error }：handled=true 表示已做完整恢复，调用方必须抛出 error
 * 且**不得**再执行局部 restoreFiles（避免完整恢复后又局部恢复）。
 * 事务未开始（precheck 之前）时 handled=false，调用方保留宿主原有语义。
 */
export async function w6bServiceInstallFailure({
  surface, context = null, error = null, run = null, stopped = false,
}) {
  const currentTx = txFor(context);
  const failedTxId = error?.extra?.txId ?? error?.txId ?? null;
  const lastHandled = failedTxId
    ? handledByProfile.get(pathIdentity(context?.dir ?? currentTx?.profileDir ?? readBodyProfile())) : null;
  if (!currentTx && phaseAt(context) !== 'on' && !(failedTxId && lastHandled?.txId === failedTxId))
    return { handled: false };
  try {
  // ① 该失败是否**已由本事务的 w6bVerifyInstalled 完整处理过**（第三轮定点收口 一.1）：
  //    verify 先消费 currentTx 再做部署校验，校验失败时已完成完整恢复并抛错；
  //    这里按事务 id 识别，原样传播（不重复完整恢复、不局部恢复、恢复失败的原判定不变）。
  if (failedTxId !== null && lastHandled?.txId === failedTxId) {
    audit({
      kind: 'tx-already-handled', surface,
      txId: failedTxId,
      stage: error?.extra?.stage ?? lastHandled.stage,
      verdict: lastHandled.verdict,
      recoveryFailed: lastHandled.verdict !== 'rolled-back',
      localRestoreCallsBeforeRecovery: lastHandled.localRestoreCallsBeforeRecovery,
      lockHeldNow: isNativeLockHeld(context?.dir ?? ''),
      note: '该事务的失败已在 w6bVerifyInstalled 内完成完整恢复并抛错：原样传播结果，'
        + '不再重复完整恢复，也不执行宿主局部 restoreFiles（恢复失败的原判定保持不变）',
    });
    return {
      handled: true, alreadyHandled: true,
      stage: error?.extra?.stage ?? lastHandled.stage,
      error, // 原样传播，不包裹、不覆盖恢复判定
      originalError: error?.extra?.originalError ?? null,
      recoveryVerdict: lastHandled.rv,
      restoreReport: lastHandled.restoreReport,
      recovered: lastHandled.recovered,
      lockHeldAtRecovery: true,
      nativeLocalRestoreSkipped: true,
      localRestoreCallsBeforeRecovery: lastHandled.localRestoreCallsBeforeRecovery,
    };
  }
  const txState = currentTx;
  if (!txState) {
    return { handled: false, error, stage: null,
      note: '事务未开始（事务前置段之前失败）：无快照可恢复，保持宿主原有语义' };
  }
  clearTx(txState); // Consume only this profile; finish counting after recovery.
  const stage = inferServiceFailureStage({ error, run, stopped, txState });
  const reason = String(error?.message ?? error ?? '宿主失败').slice(0, 600);
  // 失败发生时（恢复之前）的真实磁盘状态：证明「磁盘已改变、尚未进入部署校验便失败」，
  // 而不是靠恢复结果反推。只读检查，不新增哈希口径。
  const candidateName = txState.bound[0].candidate.packageName;
  const packageDir = join(txState.profileDir, 'node_modules', ...candidateName.split('/'));
  const diskAtFailure = {
    packageDirExists: existsSync(packageDir),
    installedVersion: existsSync(join(packageDir, 'package.json'))
      ? (() => { try { return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version ?? null; }
        catch { return null; } })()
      : null,
    declaredSpec: (() => {
      try {
        return JSON.parse(readFileSync(join(txState.profileDir, 'package.json'), 'utf8'))
          .dependencies?.[candidateName] ?? null;
      } catch { return null; }
    })(),
  };
  audit({
    kind: 'tx-failure', surface, stage, profileDir: txState.profileDir,
    op: txState.op, snapshotId: txState.snapshot?.id ?? null, txId: txState.snapshot?.id ?? null,
    stageHint: txState.stageHint ?? null,
    original: {
      name: error?.name ?? null,
      code: error?.code ?? null,
      message: String(error?.message ?? error ?? '').slice(0, 1200),
    },
    run: run === null ? null : {
      exitCode: run?.exitCode ?? null, timedOut: run?.timedOut ?? null, kind: run?.kind ?? null,
    },
    stopped: stopped === true,
    diskAtFailure,
    // 准备阶段是否真的写盘：approveBuilds 会把 allowBuilds 写成 true
    workspaceAtFailure: (() => {
      try {
        const text = readFileSync(join(txState.profileDir, 'pnpm-workspace.yaml'), 'utf8');
        return {
          allowBuildsTrue: (text.match(/:\s*true\b/g) ?? []).length,
          hasAllowBuilds: /allowBuilds\s*:/.test(text),
        };
      } catch { return { allowBuildsTrue: 0, hasAllowBuilds: false, unreadable: true }; }
    })(),
    lockHeld: isNativeLockHeld(txState.profileDir),
    note: '事务开始后、部署校验之前的宿主失败：保留原始失败原因与失败瞬间的磁盘状态，进入统一 W6-A 完整恢复',
  });
  const rec = failTx(txState, { surface, stage, reason, error, run });
  const wrapped = txError({ surface, stage, reason, rec, error, execResult: run,
    packageName: txState.bound[0].candidate.packageName });
  return {
    handled: true, stage, error: wrapped,
    txId: rec.txId,
    originalError: rec.originalError,
    recoveryVerdict: rec.rv, restoreReport: rec.restoreReport, recovered: rec.recovered,
    lockHeldAtRecovery: rec.lockHeldAtRecovery,
    nativeLocalRestoreSkipped: rec.localRestoreCallsBeforeRecovery === 0,
    localRestoreCallsBeforeRecovery: rec.localRestoreCallsBeforeRecovery,
  };
  } finally { endBodyOperation(currentTx); }
}

/** 宿主失败阶段判定（只用宿主自己的错误形态与准备阶段标记，不猜测）。 */
function inferServiceFailureStage({ error = null, run = null, stopped = false, txState = null }) {
  const code = error?.code ?? null;
  if (code === 'ambiguous-install' || code === 'not-bundle' || code === 'not-a-bundle'
    || code === 'incompatible-version' || code === 'invalid-spec') {
    return 'target-identification';
  }
  if (error?.name === 'InstallCancelledError' || stopped === true) return 'cancelled';
  if (run !== null && (run?.exitCode !== 0 || run?.timedOut === true)) return 'install-pnpm';
  // 准备阶段（approveBuilds / readRestoredFiles）失败：由补丁在进入该阶段时打标；
  // 只在错误形态无法归类时使用，避免 pnpm/识别阶段的失败被残留标记带偏。
  if (txState?.stageHint && /^prepare-/.test(txState.stageHint)) return txState.stageHint;
  const message = String(error?.message ?? '');
  if (/cannot resolve profile bundle|not-a-bundle|not-bundle|ambiguous-install/i.test(message)) {
    return 'target-identification';
  }
  return 'install-pnpm';
}

/**
 * 清理事务状态（第二轮定点收口 一.3）：宿主在 installBundle 的 `finally` 里调用，
 * 覆盖所有退出路径（含事务开始后、pnpm 之前就被宿主提前拒绝的路径，
 * 例如 already-installed / approveBuilds / readRestoredFiles 抛错）。
 * 已经由失败处理或成功登记消费掉的事务不会被重复清理（cleared=false）。
 */
export function w6bClearServiceTx({ surface = null, reason = null, context = null } = {}) {
  const currentTx = txFor(context);
  if (!currentTx) return { cleared: false };
  const tx = currentTx;
  clearTx(tx);
  try { audit({
    kind: 'tx-clear', surface: surface ?? tx.surface, reason,
    profileDir: tx.profileDir, snapshotId: tx.snapshot?.id ?? null,
    note: '退出路径清理安装事务状态：不残留可被后续调用误消费的事务（该路径未发生磁盘变更）',
  });
  return { cleared: true, snapshotId: tx.snapshot?.id ?? null };
  } finally { endBodyOperation(tx); }
}

/**
 * 定点收口 ②：安装事务后置段（宿主锁内、pnpm 之后、selectBundle/publishAndReload 之前）。
 * - pnpm 非零退出 → 恢复 + 独立核对 + 统一判定 → 抛 W6B_INSTALL_TX_FAILED；
 * - 部署后内容校验（expectedDeployedHashes 口径）失败 → 同上；
 * - 全部通过 → 独立进程复核 → 登记 installed（active=false）→ 返回 {allow, registryEntries}。
 * 使「pnpm 成功但部署校验失败且磁盘真变」的反例真实发生（与 W6-A failInject.deployStage 同型）。
 */
export async function w6bVerifyInstalled({ surface, name = null, context = null, execResult = null }) {
  const currentTx = txFor(context);
  if (!currentTx && phaseAt(context) !== 'on') return { allow: true, delegatedTo: 'dsh-native' };
  const txState = currentTx;
  if (!txState) {
    // Native manager has already checked existence, bundle metadata and compatibility.
    if(name&&nativeOfficialTargets().some(t=>t.name===name))return {allow:true,delegatedTo:'dsh-native'};
    throw new W6BAdmissionError(W6B.TX_STATE_MISSING,
      `宿主 ${surface} 在没有安装事务前置段的情况下要求部署后校验`, { surface, name });
  }
  clearTx(txState); // Do not expose off until validation and registration finish.
  try {
  const { profileDir, conf, bound, snapshot, expected } = txState;
  const primary = bound[0].candidate;
  const packageNames = [primary.packageName,
    ...Object.keys(primary.admission.packageRecord.dependencySpecs ?? {})];

  const failIf = (stage, reason, execResult2 = execResult) => {
    const rec = failTx(txState, { surface, stage, reason, execResult: execResult2, run: execResult2 });
      throw txError({ surface, stage, reason, rec, execResult: execResult2,
      packageName: primary.packageName });
  };

  // ---- pnpm 执行结果（timedOut 与 exitCode 都算失败）----
  const exitCode = execResult?.exitCode;
  if ((typeof exitCode !== 'number' || exitCode !== 0) || execResult?.timedOut === true) {
    failIf('install-pnpm',
      `宿主执行器返回 exitCode=${String(exitCode)}，timedOut=${String(execResult?.timedOut)}`);
  }

  // 正式运行路径不含部署后损坏注入

  // ---- 部署后内容校验（verifyDeployedContent，W6-A 既有口径）----
  const deployed = verifyDeployedContent({ profileDir, expected, packageNames });
  audit({
    kind: 'tx-verify', surface, packageName: primary.packageName,
    deployedOk: deployed.ok, rows: Object.fromEntries(Object.entries(deployed.rows).map(([k, v]) =>
      [k, { ok: v.ok, ...(v.missing ? {missing:v.missing,modified:v.modified,unexpected:v.unexpected,generated:v.generated} : {}), ...(v.reason?{reason:v.reason}:{}) }])),
    note: '部署后内容校验：node_modules 运行文件与已打包产物/依赖闭包比对（在 selectBundle/publishAndReload 之前）',
  });
  if (!deployed.ok) {
    failIf('deployed-content',
      '部署内容不一致：'+JSON.stringify(Object.fromEntries(Object.entries(deployed.rows)
        .filter(([,row])=>!row.ok).map(([name,row])=>[name,{missing:row.missing,modified:row.modified,unexpected:row.unexpected,reason:row.reason}]))));
  }

  // ---- 独立进程复核 + 登记 installed（绝不登记 active）----
  const registryEntries = [];
  for (const { candidate: c } of bound) {
    registryEntries.push(registrySet(conf.registryPath, c.packageName, {
      state: 'installed',
      active: false,
      version: c.version,
      sourceTreeHash: c.sourceTreeHash,
      packageIntegrity: c.packageIntegrity,
      deployedContentHash: deployed.rows[c.packageName]?.actual ?? null,
      spec: c.spec,
      installedVia: surface,
      note: 'W6-B 宿主入口事务登记：真实宿主运行时激活未验证，只登记 installed，不登记 active',
    }));
  }
  audit({
    kind: 'tx-registered', surface, packageNames: bound.map((b) => b.candidate.packageName),
    registryPath: conf.registryPath, state: 'installed', active: false,
    note: '安装事务完成：快照+绑定+准入+批准复核+实际安装+部署校验+独立复核，登记 installed',
  });
  return { allow: true, registryEntries, deployed, snapshotId: snapshot.id };
  } finally { endBodyOperation(txState); }
}

/**
 * CLI 事务（runPluginCommand 用）：前置段 → exec（宿主真实执行器）→ 后置段，一气呵成。
 * exec 由补丁闭包提供（调用宿主自己的 runProfilePnpm），返回值原样交还宿主语义。
 * remove/repair/readonly 不进入安装事务，但仍真实执行 exec 并原样返回执行器结果；
 * remove 成功后把已登记候选的隔离注册表记为 removed（不要求新的安装批准）。
 */
export async function w6bRunInstallTransaction({
  surface, args = [], spec = null, context = null, requireNativeLock = true, exec,
}) {
  if (phaseAt(context) !== 'on') {
    // 退出干预：仍真实执行原生 exec，原样返回执行器结果与异常，绝不伪装成功。
    return { precheck: { delegatedTo: 'dsh-native' }, execResult: await exec(),
      verify: null, delegatedTo: 'dsh-native' };
  }
  const pre = w6bInstallPrecheck({ surface, args, spec, context, requireNativeLock });
  if (!pre.txState) {
    const execResult = await exec();
    if (pre.op === 'remove' && execResult?.exitCode === 0) {
      const removedSpecs = parseInstallSpecs(args, spec).specs;
      const candidates = productionState().candidates ?? {};
      const conf = productionState().profiles?.[context?.dir ?? productionState().defaultProfileDir];
      for (const raw of removedSpecs) {
        const id = parseSpecIdentity(raw);
        if (id.kind === 'registry' && candidates[id.name] && conf) {
          registrySet(conf.registryPath, id.name, {
            state: 'removed', active: false,
            note: `卸载完成（via ${surface}）：不要求新的安装批准；隔离注册表同步移除`,
          });
          audit({ kind: 'remove-registry', surface, packageName: id.name,
            registryPath: conf.registryPath, note: 'remove 成功后同步隔离注册表为 removed' });
        }
      }
    }
    return { precheck: pre, execResult, verify: null };
  }
  let execResult = null;
  try {
    try {
      execResult = await exec();
    } catch (error) {
      const rec = failTx(pre.txState, { surface, stage: 'install-pnpm',
        reason: `宿主执行器抛出异常：${String(error?.message ?? error).slice(0, 300)}`, error });
      endBodyOperation(pre.txState);
      throw txError({ surface, stage: 'install-pnpm',
        reason: `宿主执行器抛出异常：${String(error?.message ?? error).slice(0, 300)}`,
        rec, error, packageName: pre.txState.bound[0].candidate.packageName });
    }
    const verify = await w6bVerifyInstalled({ surface, context, execResult });
    return { precheck: pre, execResult, verify };
  } finally {
    clearTx(pre.txState); // Only the exact owning transaction is cleared.
    endBodyOperation(pre.txState);
  }
}

// ================================================================ 执行器层双保险 gate

/**
 * 执行器层（runProfilePnpm / runPnpm）：直接调用执行器绕过入口的路径也必须执行准入。
 * 与入口事务的关系：入口已跑完整事务时这里会重复一次准入（纯函数，幂等无害），
 * 但**不做**快照/登记/恢复 —— 那些属于入口事务的职责，执行器层不重复取快照。
 */
export function w6bAssertInstall({ surface, args = [], spec = null, context = null, requireNativeLock = true }) {
  const currentTx = txFor(context);
  if (!currentTx && phaseAt(context) !== 'on') return { allow: true, delegatedTo: 'dsh-native' };
  if(nativeOfficialSpecs(args,spec))return {allow:true,op:'native-official',delegatedTo:'dsh-native'};
  if(currentTx && samePath(context?.dir,currentTx.profileDir) && isNativeLockHeld(currentTx.profileDir)) {
    const request=classifyPnpmArgs(args);
    if(['install','update'].includes(request.op) && request.specs.length===currentTx.bound.length
      && request.specs.every(s=>currentTx.bound.some(b=>(b.spec??b.candidate.spec)===s))
      && currentTx.bound.every(b=>verifyInstallPackage(b.candidate.admission.packageRecord).ok))
      return {allow:true,op:request.op,reusedTransaction:true};
  }
  const classified = classifyPnpmArgs(args, spec);
  const profileDir = context?.dir ?? productionState().defaultProfileDir;
  profileConf(profileDir); // 执行器层同样只允许台账登记过的隔离 profile
  const base = {
    kind: 'executor-gate', surface, op: classified.op, subcommand: classified.subcommand,
    args: [...args], spec, profileDir, callers: callerStack(),
  };
  if (classified.op === 'readonly' || classified.op === 'remove') {
    audit({ ...base, allow: true,
      note: '执行器层：只读/remove 不要求安装批准（用户定点收口 ④）' });
    return { allow: true, op: classified.op };
  }
  if (classified.op === 'repair') {
    const check = repairCheck(profileDir);
    const code = check.ok ? null : (check.bad[0]?.code ?? W6B.REPAIR_UNAPPROVED_DEP);
    audit({ ...base, allow: check.ok, repairFindings: check.findings, code });
    if (!check.ok) {
      throw new W6BAdmissionError(code,
        `执行器层 repair 被拒绝（${code}）：${check.bad.map((b) => `${b.name}→${b.reason}`).join('; ')}`,
        { surface, findings: check.findings, code });
    }
    return { allow: true, op: 'repair' };
  }
  if (classified.op === 'unknown' || classified.op === 'empty') {
    audit({ ...base, allow: false, code: W6B.UNKNOWN_OPERATION });
    throw new W6BAdmissionError(W6B.UNKNOWN_OPERATION,
      `执行器层未分类 pnpm 子命令：${String(classified.subcommand)}`, { surface });
  }
  if (classified.op === 'update' && classified.specs.length === 0) {
    audit({ ...base, allow: false, code: W6B.SPEC_NOT_ARTIFACT });
    throw new W6BAdmissionError(W6B.SPEC_NOT_ARTIFACT,
      '执行器层：裸 update 不绑定任何已审产物', { surface });
  }
  const lockHeld = isNativeLockHeld(profileDir);
  const { bound, rejected } = bindSpecs(classified.specs, productionState().candidates ?? {});
  const rows = [...bound.map((b) => ({ packageName: b.candidate.packageName, bound: true })),
    ...rejected.map((r) => ({ spec: r.spec, bound: false, code: r.code }))];
  if (rejected.length > 0) {
    audit({ ...base, allow: false, code: rejected[0].code, rows });
    throw new W6BAdmissionError(rejected[0].code,
      `执行器层规格绑定失败：${rejected.map((r) => r.code).join(', ')}`, { surface, rows });
  }
  for (const { candidate: c } of bound) {
    const { admission, approval } = decideFor(c, profileDir);
    rows.push({ packageName: c.packageName, admissionAllow: admission.allow,
      approvalAllow: approval.allow });
    if (!admission.allow) {
      audit({ ...base, allow: false, code: W6B.ADMISSION_REJECTED, rows });
      throw new W6BAdmissionError(W6B.ADMISSION_REJECTED,
        `执行器层完整准入未通过：${c.packageName} / ${admission.code}`, { surface, rows });
    }
    if (!approval.allow) {
      audit({ ...base, allow: false, code: W6B.APPROVAL_REJECTED, rows });
      throw new W6BAdmissionError(W6B.APPROVAL_REJECTED,
        `执行器层批准复核未通过：${c.packageName} / ${approval.code}`, { surface, rows });
    }
  }
  if (requireNativeLock && !lockHeld) {
    audit({ ...base, allow: false, code: W6B.LOCK_MISSING, rows });
    throw new W6BAdmissionError(W6B.LOCK_MISSING,
      `执行器层：安装未处于原生锁临界区内（${nativeLockPathOf(profileDir)} 不存在）`,
      { surface, rows });
  }
  audit({ ...base, allow: true, rows, lockHeld,
    note: '执行器层双保险：分类+绑定+准入+批准复核通过（快照/登记/恢复属于入口事务，此处不重复）' });
  return { allow: true, op: classified.op, rows, lockHeld };
}

// Native lifecycle belongs to DSH, independently of the installation ledger.
// Retain these exports for older callers; no registry reads, approvals or writes.
// 纯透传：无论身体开关 on/off 都不干预；保留 phase 门以保持所有 w6b* 导出的一致性。
export function w6bAssertSelect({name,enabled}={}) {
  if (phaseAt(null) !== 'on') return {allow:true,name,enabled,delegatedTo:'dsh-native'};
  return {allow:true,name,enabled,delegatedTo:'dsh-native'};
}
export function w6bAssertPublish({surface}={}) {
  if (phaseAt(null) !== 'on') return {allow:true,surface,selected:[],delegatedTo:'dsh-native'};
  return {allow:true,surface,selected:[],delegatedTo:'dsh-native'};
}
export function w6bAssertLoad({surface}={}) {
  if (phaseAt(null) !== 'on') return {allow:true,surface,findings:[],delegatedTo:'dsh-native'};
  return {allow:true,surface,findings:[],delegatedTo:'dsh-native'};
}
export function w6bAssertDump() {
  if (phaseAt(null) !== 'on') return {allow:true,code:null,unapproved:[],findings:[],delegatedTo:'dsh-native'};
  return {allow:true,code:null,unapproved:[],findings:[],delegatedTo:'dsh-native'};
}

export { w6bBootWire, wiringEntryNames, readApprovalHostEntry, APPROVAL_ROUTES } from './w6-boot.mjs';
