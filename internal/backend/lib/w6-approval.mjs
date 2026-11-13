/**
 * W6-A 定点收口 ①：安装前批准复核（唯一权威实现，隔离实现）。
 *
 * 修复前的问题：
 *   - w6-admission.mjs 的 ⑦ 只检查 isTestData(decision) 标记；
 *     非模拟决定走 else 分支直接给 true + note 'n/a'，即「缺批准按不适用放行」。
 *   - w6-deploy.mjs 在同一锁内 pnpm 之前，没有把 W4/W5 落库的**真实决定 / ready 记录 /
 *     决定存储 / 已审产物**接进复核，等于只凭 testData 标记放行。
 *
 * 本模块在**同一原生安装锁内、执行 pnpm 前**被调用，复用既有机制（不另写一套判据）：
 *   - assertUsableForArtifact(decision, decisionStore) → 决定存在 / kind / status / 失效记录
 *   - decision.wholePackageApproved → 是否构成整包批准（拒绝、继续分析都不算）
 *   - validateAuthorizationGrants() → 六维 granted 与「实际申请范围」逐维核对
 *   - reverifyReady() → 唯一权威 ready 复核，内含决定有效性 / computeBinding 比对 /
 *     产物登记路径 / verifyArtifact 逐文件复算 + 授权范围
 *   - 安装对象与批准对象对应 → 源码树哈希 / W5 contentHash / 决定绑定 contentHash / version
 *   - 生产批准校验：隔离路径必须模拟决定且生产门实测拒绝；非隔离路径必须
 *     assertNotTestData() 通过（真实 productionApproval），缺批准不能按「不适用」放行。
 *
 * 只读：不写盘、不追加 history、不失效决定、不执行候选代码。
 */

import {
  assertUsableForArtifact, assertNotTestData, isTestData, DEC,
  validateAuthorizationGrants, deriveLoadForm,
} from './decision.mjs';
import { readJson } from './w6-utils.mjs';
import { reverifyReady } from './pipeline.mjs';
import { SCHEMAS } from './w4w5-utils.mjs';

export const W6APR = Object.freeze({
  DECISION_MISSING: 'W6_APPROVAL_DECISION_MISSING',
  DECISION_INVALID: 'W6_APPROVAL_DECISION_INVALID',
  NOT_WHOLE_PACKAGE: 'W6_APPROVAL_NOT_WHOLE_PACKAGE_APPROVED',
  AUTH_UNSATISFIED: 'W6_APPROVAL_AUTHORIZATION_UNSATISFIED',
  BINDING_MISMATCH: 'W6_APPROVAL_BINDING_MISMATCH',
  ARTIFACT_INVALID: 'W6_APPROVAL_ARTIFACT_INVALID',
  OBJECT_MISMATCH: 'W6_APPROVAL_OBJECT_MISMATCH',
  PRODUCTION_APPROVAL_MISSING: 'W6_APPROVAL_PRODUCTION_MISSING',
  NOT_ISOLATION: 'W6_APPROVAL_NOT_ISOLATION',
  READY_INVALIDATED: 'W6_APPROVAL_READY_INVALIDATED',
});

/**
 * 生产批准门（**唯一权威实现**）：准入与安装前复核都调用本函数，不各写一套。
 *
 * 修复前的缺陷：非模拟决定走 else 分支直接 `checks...=true` + note='n/a'，
 * 即「缺批准按不适用放行」。本函数对非隔离路径**必须**真实调用 assertNotTestData()，
 * 缺 productionApproval 一律拒绝；隔离路径则要求模拟决定且生产门实测拒绝。
 */
export function checkProductionApproval({ decision, isolationOnly = true }) {
  const simulated = isTestData(decision);
  let ok = false;
  let code = null;
  const mode = isolationOnly ? 'isolation' : 'production';
  if (isolationOnly) {
    let rejected = false;
    if (simulated) {
      try { assertNotTestData(decision); } catch (e) {
        rejected = e.code === DEC.TEST_DATA_PRODUCTION;
        code = e.code ?? e.name;
      }
    }
    ok = simulated === true && rejected === true;
  } else {
    // 关键修复：不再写 n/a。缺批准（null / 无 productionApproval / 模拟决定）一律拒绝。
    try {
      assertNotTestData(decision);
      ok = true;
    } catch (e) {
      code = e.code ?? e.name;
    }
  }
  const boundaryOk = !simulated || isolationOnly === true;
  return {
    ok: ok && boundaryOk,
    code: ok && !boundaryOk ? W6APR.NOT_ISOLATION : (ok ? null : (code ?? W6APR.PRODUCTION_APPROVAL_MISSING)),
    mode,
    simulatedDecision: simulated,
    verified: ok,
    isolationBoundaryEnforced: boundaryOk,
    productionErrorCode: code,
    note: mode === 'production'
      ? '非隔离路径执行真实生产批准校验；缺批准拒绝，不按「不适用」放行'
      : '隔离路径只允许模拟决定，且生产门 assertNotTestData 必须实测拒绝',
  };
}

/** 重新核对当前批准状态、授权、绑定和产物。纯只读，不写盘、不改记录。 */
export function reverifyInstallApproval({
  root = null, record = null, decision = null, decisionStore = null,
  artifactDir = null, w5Manifest = null, packageRecord = null,
  isolationOnly = true, allowedRecordStates = ['ready'],
}) {
  const checks = {};
  const reasons = [];

  // ① 决定存在且 schema 正确（缺决定必须拒绝，不能沿用旧批准 / 默认放行）
  checks.decisionPresent = !!decision && [SCHEMAS.DECISION,'hand-decision/v1'].includes(decision.schema);
  if (!checks.decisionPresent) reasons.push('缺少有效批准决定（decision=null / schema 不正确）');

  // ② 决定有效性：kind / status / 失效记录（复用 W4 给 W5 用的权威检查）
  let decisionValid = false;
  try {
    assertUsableForArtifact(decision, decisionStore);
    decisionValid = true;
  } catch (e) {
    reasons.push(`决定有效性未通过：${e.code ?? e.name}`
      + '（拒绝 / 继续分析 / 已失效 / status 非 active 都不构成批准）');
  }
  checks.decisionUsable = decisionValid;

  // ③ 是否构成整包批准（reject / continue-analysis 不算；partial-adaptation 须显式批准）
  checks.wholePackageApproved = decision?.wholePackageApproved === true
    && (decision?.kind === 'approve' || decision?.kind === 'partial-adaptation');
  if (!checks.wholePackageApproved) reasons.push('决定未构成整包批准（wholePackageApproved!=true）');

  // ④ 六维授权逐维核对 granted 与实际申请范围（不能只比 detail 数组 / 只看 testData）
  let authorizationAudit = null;
  let authOk = false;
  try {
    const scopes = decision?.approvedScopes ?? null;
    const authorization = decision?.authorization ?? null;
    if (!scopes || !authorization) throw new Error('决定缺少 approvedScopes / authorization');
    const ctx = {
      loadForm: deriveLoadForm(record),
      priorAuthorization: record?.priorAuthorization ?? null,
      binding: {
        pinnedCommit: record?.source?.pinnedCommit ?? decision?.binding?.pinnedCommit ?? null,
        contentHash: record?.source?.contentHash ?? decision?.binding?.contentHash ?? null,
      },
      injectionAssessment: record?.review?.conclusionRef?.path
        ? readJson(record.review.conclusionRef.path)?.conclusion?.injectionAssessment : null,
    };
    authorizationAudit = validateAuthorizationGrants(authorization, scopes, ctx);
    // 与决定落库时的逐维 audit 对照，防止「改 granted 却没改 audit」的绕过
    const stored = decision?.authorizationAudit ?? null;
    if (stored) {
      for (const dim of Object.keys(authorizationAudit)) {
        if ((dim !== 'personaMemoryChange' && stored[dim]?.required !== authorizationAudit[dim].required)
          || stored[dim]?.granted !== authorizationAudit[dim].granted) {
          throw new Error(`authorizationAudit.${dim} 与决定落库值不一致`);
        }
      }
    }
    authOk = true;
  } catch (e) {
    reasons.push(`授权复核未通过：${e.code ?? e.message}`);
  }
  checks.authorizationGrantsSatisfied = authOk;

  // ⑤ 唯一权威 ready 复核：决定有效性 / 绑定 / 产物路径 / 逐文件复算 / 授权范围
  let recheck = null;
  try {
    recheck = reverifyReady({
      root, record, decision,
      artifactDir: artifactDir ?? record?.artifact?.path ?? null,
      decisionStore,
    });
    if (!recheck.ok) reasons.push(...recheck.reasons.map((r) => `ready 复核：${r}`));
  } catch (e) {
    recheck = { ok: false, reasons: [String(e.code ?? e.message)],
      verification: null, bindingCheck: null };
    reasons.push(`ready 复核异常：${e.code ?? e.message}`);
  }
  checks.readyStillValid = recheck.ok === true;
  checks.bindingStillMatches = recheck.bindingCheck?.match === true;
  if (!checks.bindingStillMatches) reasons.push('决定绑定与当前对象 / 范围 / 授权关键字段不匹配');
  checks.artifactRecomputed = recheck.verification?.verified === true
    && recheck.verification?.scopeCheck?.ok === true
    && (recheck.verification?.scopeCheck?.unknownFields?.length ?? 0) === 0;
  if (!checks.artifactRecomputed) reasons.push('实际产物逐文件复算或授权范围检查未通过');

  // ⑥ 当前批准状态（防止拿 awaiting-approval / failed 的记录去安装）
  //    安装/更新要求 ready；已装配后的 repair 与加载准入显式允许 installed / active
  //    （调用方传入 allowedRecordStates，默认只有 ready，既有语义不变）。
  checks.recordStateReady = allowedRecordStates.includes(record?.state);
  if (!checks.recordStateReady) {
    reasons.push(`运行态不在允许集合内：${String(record?.state)}`
      + `（允许 ${allowedRecordStates.join(' / ')}）`);
  }

  // ⑦ 安装对象与批准对象 / 已审产物对应（三种哈希口径中的源码树口径）
  const w5Hash = w5Manifest?.contentHash ?? null;
  const pkgHash = packageRecord?.sourceTreeHash ?? null;
  const boundHash = decision?.binding?.contentHash ?? null;
  checks.installObjectMatchesApproved = !!w5Hash && pkgHash === w5Hash && boundHash === w5Hash
    && packageRecord?.version === w5Manifest?.version;
  if (!checks.installObjectMatchesApproved) {
    reasons.push('安装包源码树哈希 / W5 contentHash / 决定绑定 contentHash / version 未逐字对应');
  }

  // ⑧ 生产批准校验：唯一权威实现 checkProductionApproval()
  const gate = checkProductionApproval({ decision, isolationOnly });
  checks.productionApprovalVerified = gate.verified;
  checks.isolationBoundaryEnforced = gate.isolationBoundaryEnforced;
  if (!gate.verified) reasons.push(`${gate.mode} 路径生产批准校验未通过：${gate.code ?? 'unknown'}`);
  if (!gate.isolationBoundaryEnforced) reasons.push('隔离模拟决定被用于非隔离路径');

  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  let code = null;
  if (failed.length > 0) {
    if (!checks.decisionPresent) code = W6APR.DECISION_MISSING;
    else if (!checks.decisionUsable) code = W6APR.DECISION_INVALID;
    else if (!checks.wholePackageApproved) code = W6APR.NOT_WHOLE_PACKAGE;
    else if (!checks.authorizationGrantsSatisfied) code = W6APR.AUTH_UNSATISFIED;
    else if (!checks.bindingStillMatches) code = W6APR.BINDING_MISMATCH;
    else if (!checks.artifactRecomputed || !checks.readyStillValid) code = W6APR.ARTIFACT_INVALID;
    else if (!checks.installObjectMatchesApproved) code = W6APR.OBJECT_MISMATCH;
    else if (!checks.isolationBoundaryEnforced) code = W6APR.NOT_ISOLATION;
    else if (!checks.productionApprovalVerified) code = W6APR.PRODUCTION_APPROVAL_MISSING;
    else code = W6APR.READY_INVALIDATED;
  }
  if (code === null && !gate.ok) code = gate.code ?? W6APR.PRODUCTION_APPROVAL_MISSING;

  return {
    allow: failed.length === 0,
    code,
    checks,
    failedChecks: failed,
    reasons,
    recheck,
    authorizationAudit,
    productionGate: gate,
    note: failed.length === 0
      ? '当前批准状态 / 授权 / 绑定 / 产物 / 生产门均在同一安装锁内、pnpm 前重新核对通过'
      : `安装前批准复核未通过：${failed.join(', ')}`,
  };
}
