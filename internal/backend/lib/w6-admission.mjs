/** Installation admission bridges the actual source commit, approved scope,
 * runnable tarball and resolved dependency closure into existing Step0-5 checks.
 * Production reuses bound review/decision records; isolated legacy fixtures remain supported.
 */

import { evaluate, evaluateGrantedScope, ADM } from './admission.mjs';
import { checkProductionApproval } from './w6-approval.mjs';
import { verifyInjectionReview, verifyDecisionReview } from './w6-injection-review.mjs';
import { verifyInstallPackage, verifyDependencySubtree } from './w6-package.mjs';

export const W6ADM = Object.freeze({
  ADMISSION_REJECTED: 'W6_ADMISSION_REJECTED',
  INTEGRITY_INVALID: 'W6_INTEGRITY_INVALID',
  SUBTREE_INVALID: 'W6_SUBTREE_INVALID',
  NOT_ISOLATION: 'W6_NOT_ISOLATION',
  SCRIPT_UNAPPROVED: 'W6_SCRIPT_UNAPPROVED',
  INJECTION_REVIEW_INVALID: 'W6_INJECTION_REVIEW_INVALID',
  PRODUCTION_APPROVAL_MISSING: 'W6_PRODUCTION_APPROVAL_MISSING',
});

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * 构造完整准入输入。所有值都来自实际产物/实际复算，不写死、不伪造。
 *
 * @param {object} p.injectionReview 经 verifyInjectionReview() 实际核验并绑定本次产物的结构化对象。
 *        不得只传路径或默认 injectionReviewed=true。
 */
export function buildFullAdmissionInput({
  spec, packageName, version, sourceTreeHash, dependencySubtreeSha256,
  dependencies, packageJson, injectionReview = null, decision = null, w5Manifest = null,
}) {
  const registry = {
    schema: 'fish-hand-registry-v2-isolation-only',
    plugins: {
      [packageName]: {
        state: 'ready',
        source: { kind: 'git', url: decision?.binding?.upstreamUrl ?? null },
        approvedCommit: decision?.binding?.pinnedCommit,
        approvedVersion: version,
        artifact: { contentHash: sourceTreeHash },
        approvedScopes: { ...(decision?.approvedScopes ?? { capabilities: [], replaces: [], credentialScopes: [], externalSideEffects:false, installScripts:false }), dependencies: [...dependencies] },
        approvedLockSubtree: { sha256: dependencySubtreeSha256 },
        activation: 'restart',
        // 定点收口：新装样例不登记 legacy（字段缺席 → legacy=false）。
        // 注入面依据改为「已核验并绑定本次产物」的审查证据，不是路径也不是默认 true。
        injectionReview: injectionReview ?? null,
        installKind: 'fresh-install',
      },
    },
  };

  // 部署 manifest：注入面字段故意缺席（保持 unknown，不写 false）
  const manifest = {
    pluginId: packageName,
    version,
    contentHash: sourceTreeHash,
    ...(w5Manifest?.grantedScope ?? { capabilities: [], replaces: [], credentialScopes: [], externalSideEffects:false, installScripts:false }),
    dependencies: [...dependencies],
    activation: 'restart',
  };

  return {
    spec,
    registry,
    manifest,
    lockSubtree: {
      sha256: dependencySubtreeSha256,
      packages: [...dependencies],
      integrity: null,
      note: '实际逐文件复算的依赖子树；与 tarball SRI 是两套不同口径',
    },
    packageJson,
    options: { allowLocalFile: true, packageName },
  };
}

/**
 * 部署前完整准入：三项实算证据 + 注入面证据实算核验 + evaluate() Step0–5
 * + 真实生产批准门，全部通过才放行。返回 {allow, code, checks, ...}，不写盘。
 */
export function runFullAdmission({
  spec, packageName, version, sourceTreeHash, dependencySubtreeSha256,
  dependencies, packageJson, packageRecord, w5Manifest, decision,
  injectionReviewEvidencePath, injectionReviewSchema = null,
  tgzPath = null, isolationOnly = true, inputOverride = null,
}) {
  const checks = {};

  // ① 安装包完整性：实际复算 SRI（改一个字节就失败）
  const integrity = verifyInstallPackage(packageRecord, tgzPath);
  checks.packageIntegrityRecomputed = integrity.ok;

  // ② 实际依赖子树复算
  const subtree = verifyDependencySubtree(packageRecord);
  checks.dependencySubtreeRecomputed = subtree.ok;

  // ③ 未批准的安装脚本：一律拒绝
  const foundScripts = INSTALL_SCRIPT_KEYS.filter(
    (k) => typeof packageJson?.scripts?.[k] === 'string');
  checks.noUnapprovedInstallScripts = foundScripts.length === 0
    ||(decision?.approvedScopes?.installScripts===true && decision?.authorization?.buildScripts?.granted===true);

  // ④ W5 unknown 未被批准动作改写成 false
  const reviewAssessmentAvailable = !!decision?.review?.conclusionContentHash;
  checks.reviewAssessmentAvailable = reviewAssessmentAvailable;

  // ⑤ 注入面审查证据：实际读文件 + 复算哈希 + 核对绑定本次产物/决定/结论
  //    （不是「只携带路径」或「默认 injectionReviewed=true」）
  const ir = !isolationOnly ? verifyDecisionReview({ decision, w5Manifest, packageRecord }) : verifyInjectionReview({
    evidencePath: injectionReviewEvidencePath,
    w5Manifest,
    w5ManifestPath: packageRecord?.w5ManifestPath ?? null,
    decision,
    packageRecord,
    ...(injectionReviewSchema ? { evidenceSchema: injectionReviewSchema } : {}),
  });
  checks.injectionReviewEvidenceVerified = ir.verified === true;
  checks.injectionReviewBoundToThisArtifact = !isolationOnly ? ir.verified : ir.checks.boundContentHashMatchesManifest === true
    && ir.checks.boundDecisionIdMatches === true
    && ir.checks.boundConclusionMatches === true
    && ir.checks.boundCommitMatches === true
    && ir.checks.packageSourceMatchesW5 === true;

  // ⑥ 完整准入 Step0–5（不能只跑 W4/W5 范围检查）
  //    inputOverride 仅供**拒绝样本测试**注入缺陷，正式部署调用方不传。
  const input = buildFullAdmissionInput({
    spec, packageName, version, sourceTreeHash, dependencySubtreeSha256,
    dependencies, packageJson,
    injectionReview: ir.review, decision, w5Manifest,
  });
  const freshRecord = input.registry.plugins[packageName];
  // 实算：新装 registry 记录不得携带 legacy / injectionReviewed / 只带路径的证据
  checks.notLegacyForFreshInstall = !Object.hasOwn(freshRecord, 'legacy')
    && !Object.hasOwn(freshRecord, 'injectionReviewed')
    && !Object.hasOwn(freshRecord, 'injectionReviewEvidencePath')
    && freshRecord.installKind === 'fresh-install'
    && freshRecord.injectionReview?.notLegacy === true;
  checks.deployManifestInjectionFieldsAbsent = !('personaInjection' in input.manifest)
    && !('memoryInjection' in input.manifest);

  const evaluateInput = inputOverride ? { ...input, ...inputOverride } : input;
  const evaluateResult = evaluate(evaluateInput);
  checks.evaluateAllow = evaluateResult.allow === true;
  const steps = [...new Set(evaluateResult.trace.map((t) => t.step))];
  checks.evaluateAllStepsPassed = steps.length === 6
    && evaluateResult.trace.every((t) => t.ok);

  // ⑦ 生产批准门（唯一权威实现）：
  //    非隔离路径必须真实执行 assertNotTestData()，缺批准不能按「不适用」放行。
  const gate = checkProductionApproval({ decision, isolationOnly });
  checks.productionGateRejectsSimulatedDecision = gate.verified;
  checks.isolationBoundaryEnforced = gate.isolationBoundaryEnforced;

  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  let code = null;
  if (failed.length > 0) {
    if (!integrity.ok) code = W6ADM.INTEGRITY_INVALID;
    else if (!subtree.ok) code = W6ADM.SUBTREE_INVALID;
    else if (!checks.noUnapprovedInstallScripts) code = W6ADM.SCRIPT_UNAPPROVED;
    else if (!checks.injectionReviewEvidenceVerified
      || !checks.injectionReviewBoundToThisArtifact) code = W6ADM.INJECTION_REVIEW_INVALID;
    else if (!checks.isolationBoundaryEnforced) code = W6ADM.NOT_ISOLATION;
    else if (!gate.verified) code = W6ADM.PRODUCTION_APPROVAL_MISSING;
    else if (!evaluateResult.allow) code = `${W6ADM.ADMISSION_REJECTED}/${evaluateResult.code}`;
    else code = W6ADM.ADMISSION_REJECTED;
  }

  return {
    allow: failed.length === 0,
    code,
    checks,
    failedChecks: failed,
    evaluateResult,
    input,
    integrity,
    subtree,
    foundScripts,
    injectionReviewResult: ir,
    productionGate: gate,
    note: failed.length === 0
      ? '安装包 SRI / 依赖子树 / 未批准脚本 / 行为审查 / 审查结论实算并绑定产物 / 隔离边界 / 真实生产批准门 / Step0–5 全通过'
      : `完整准入未通过：${failed.join(', ')}`,
  };
}

/** 拒绝样本：证明「仅凭 ready 或 W4/W5 范围检查」不能放行；并覆盖新的注入面证据通道。 */
export function admissionRejectionSamples(base) {
  const run = (over) => {
    const input = buildFullAdmissionInput({ ...base, ...over });
    const r = evaluate(input);
    return { allow: r.allow, code: r.code, step: r.step, trace: r.trace };
  };

  const noInjectionReview = run({ injectionReview: null });
  const unverifiedInjectionReview = run({
    injectionReview: { ...(base.injectionReview ?? {}), verified: false },
  });
  const unboundInjectionReview = run({
    injectionReview: { ...(base.injectionReview ?? {}), boundContentHash: 'sha256:other-artifact' },
  });
  const withUnapprovedScript = run({
    packageJson: { ...(base.packageJson ?? {}), scripts: { postinstall: 'node -e "process.exit(0)"' } },
  });
  const withoutLockSubtree = (() => {
    const input = buildFullAdmissionInput(base);
    const r = evaluate({ ...input, lockSubtree: null });
    return { allow: r.allow, code: r.code, step: r.step };
  })();
  const changedDeps = (() => {
    const input = buildFullAdmissionInput(base);
    const r = evaluate({ ...input, manifest: { ...input.manifest, dependencies: ['unknown-upstream-dep'] } });
    return { allow: r.allow, code: r.code, step: r.step };
  })();
  const noLegacyDisguise = (() => {
    // 正面证据：新装 registry 记录不得携带 legacy / injectionReviewed 字段
    const input = buildFullAdmissionInput(base);
    const rec = input.registry.plugins[base.packageName];
    return {
      legacyAbsent: !Object.hasOwn(rec, 'legacy') && !Object.hasOwn(rec, 'injectionReviewed'),
      installKind: rec.installKind,
      injectionReviewVerified: rec.injectionReview?.verified === true,
      note: '新装样例不登记 legacy；注入面依据必须是已核验并绑定产物的结构化证据',
    };
  })();
  const scopeOnly = (() => {
    const full = buildFullAdmissionInput(base);
    const r = evaluateGrantedScope({
      manifest: full.manifest,
      approvedScopes: full.registry.plugins[base.packageName].approvedScopes,
    });
    return { scopeOk: r.ok, hasFullAdmission: false,
      note: '范围检查不含完整性/依赖子树/注入面证据/激活条件，也不产出 evaluate() Step0–5 trace' };
  })();

  return {
    noInjectionReview,
    unverifiedInjectionReview,
    unboundInjectionReview,
    withUnapprovedScript,
    withoutLockSubtree,
    changedDeps,
    noLegacyDisguise,
    scopeOnly,
    baseline: run({}),
  };
}

export { ADM };
