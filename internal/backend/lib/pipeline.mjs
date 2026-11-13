/**
 * W4 → W5 串联编排（隔离实现，不含 W6 安装与激活）
 *
 *   awaiting-approval（W3 结束态）
 *     → [W4-a] 审查结论落库（独立动作；批准不能代替）
 *     → [W4-b] 用户决定落库（approve / reject / continue-analysis / partial-adaptation）
 *     → adapting（仅 approve / partial-adaptation 推进；拒绝与继续分析保持 awaiting-approval）
 *     → [W5] 版本化 artifact + manifest + 内容清单 + 实际复算哈希
 *     → [W5] 产物校验（逐文件复算 + 决定绑定 + 授权范围）
 *     → ready（只有 审查完成 + 授权满足 + 产物验证通过 三者同时成立）
 *
 * ready 之后**不安装、不激活**。installGate（dist.integrity / lockSubtree 的
 * evaluate() 全量校验）明确标 unknown，留 W6。
 *
 * 本轮收口（GPT 复现缺陷②）：readyStage 与 runW4W5 的 ready 提前返回统一走
 * reverifyReady() 这一唯一权威实现——只有「当前对象 / 决定有效性 / 授权范围 /
 * 实际产物」四项仍一致才返回 already-ready，并返回真实 verification；
 * 复核只读、不写盘、不追加 history；任一失效抛 PIPE_READY_INVALIDATED，
 * 旧 ready 状态不得作为有效凭据。
 */

import { samePath } from './path-identity.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { transition } from './state.mjs';
import {
  recordReviewConclusion, finalizeReview, CON,
} from './conclusion.mjs';
import {
  createDecision, assertNotTestData, computeBinding, compareBinding,
  assertUsableForArtifact, hostExecutesCode, DEC,
} from './decision.mjs';
import { buildArtifact, verifyArtifact, ART } from './artifact.mjs';
import { ProbeError, atomicJson, readJson, SCHEMAS } from './w4w5-utils.mjs';

export const PIPE = Object.freeze({
  NOT_ADAPTING: 'PIPE_NOT_ADAPTING',
  READY_BLOCKED: 'PIPE_READY_BLOCKED',
  // 本轮收口②：ready 幂等复核失败，旧 ready 状态不得作为有效凭据
  READY_INVALIDATED: 'PIPE_READY_INVALIDATED',
});

/**
 * 隔离用的模拟批准输入（六维授权 + 准入形状，两者严格一致）。
 *
 * W6-A：firstHostCodeExecution.granted 不再由 capabilities 数量决定。
 * 它由「实际加载形态」决定：纯服务 / UI / bundle 插件即使 capabilities=[]，
 * 宿主仍会加载并执行其代码，因此模拟批准同样必须授予首次宿主代码执行。
 * 若同一对象已有 priorAuthorization（免除本次授权），调用方显式传
 * firstHostCodeExecutionGranted:false，避免被判为「无依据多授予」。
 */
export function simulatedApproval({
  capabilities = [], replaces = [], credentialScopes = [],
  externalSideEffects = false, installScripts = false,
  loadForm = 'tool', firstHostCodeExecutionGranted = null,
} = {}) {
  const hostGrant = firstHostCodeExecutionGranted !== null
    ? firstHostCodeExecutionGranted : hostExecutesCode(loadForm);
  return {
    authorization: {
      firstHostCodeExecution: {
        granted: hostGrant, detail: [...capabilities],
        basis: `隔离模拟批准：首次宿主代码执行依据实际加载形态 ${loadForm}`
          + '（宿主是否执行插件代码）与既有授权记录判定，与工具能力数量无关',
        note: `loadForm=${loadForm}；capabilities=${capabilities.length} 项（仅记录，不参与必需性判定）`,
      },
      toolReplacement: {
        granted: replaces.length > 0, detail: [...replaces],
        basis: '隔离模拟批准：工具替换逐项记录（本样例无替换）',
      },
      credentialAccess: {
        granted: credentialScopes.length > 0, detail: [...credentialScopes],
        basis: '隔离模拟批准：不授予账号访问',
      },
      externalActions: {
        granted: externalSideEffects, detail: externalSideEffects ? ['external'] : [],
        basis: '隔离模拟批准：对外动作单独记授权，默认不授予',
      },
      personaMemoryChange: {
        granted: false, detail: [],
        basis: '注入面保持 unknown，静态材料不能证明没有注入；本轮不授予人格/记忆变更',
      },
      buildScripts: {
        granted: installScripts, detail: installScripts ? ['approved'] : [],
        basis: '隔离模拟批准：构建脚本单独记授权，默认不授予',
      },
    },
    approvedScopes: {
      capabilities: [...capabilities],
      replaces: [...replaces],
      credentialScopes: [...credentialScopes],
      externalSideEffects,
      installScripts,
    },
  };
}

/** 拒绝 / 继续分析：六维一律 unknown，不授予任何权限。 */
export function simulatedNonApproval() {
  const dim = (label) => ({ granted: 'unknown', detail: [], basis: '', note: label });
  return {
    authorization: {
      firstHostCodeExecution: dim('首次宿主代码执行：未决定'),
      toolReplacement: dim('工具替换：未决定'),
      credentialAccess: dim('账号访问：未决定'),
      externalActions: dim('对外动作：未决定'),
      personaMemoryChange: dim('人格/记忆变更：未决定'),
      buildScripts: dim('构建脚本：未决定'),
    },
    approvedScopes: null,
  };
}

/**
 * 本轮收口②：ready 幂等复核的**唯一权威实现**（readyStage 与 runW4W5 共用）。
 *
 * 只读，不写任何盘文件、不改运行态、不失效决定：
 *   ① 决定有效性：kind 构成批准、status=active、未被 invalidate；
 *   ② 当前对象与决定绑定：computeBinding 含 authorizationFingerprint，
 *      对象 / 范围 / 授权关键字段任一改变都不 match；
 *   ③ 产物登记路径与实际目录一致；
 *   ④ 实际产物逐文件复算 + 授权范围检查（verifyArtifact 只读）。
 *
 * 四项全部一致才 ok=true；任一不满足，调用方必须拒绝把旧 ready 当有效凭据。
 */
export function reverifyReady({
  root, record, decision, artifactDir = null, decisionStore = null,
}) {
  const reasons = [];
  let verification = null;
  let bindingCheck = null;

  // ① 决定有效性
  try {
    assertUsableForArtifact(decision, decisionStore);
  } catch (e) {
    reasons.push(`决定有效性：${e.code ?? e.name}`);
  }

  // ② 当前对象 / 决定绑定（含授权关键字段）
  if (decision?.binding) {
    bindingCheck = compareBinding(decision.binding, computeBinding({
      record, approvedScopes: decision.approvedScopes, kind: decision.kind,
      derivedParts: decision.derivedParts,
      conclusionContentHash: decision.review?.conclusionContentHash ?? null,
      authorization: decision.authorization,
    }));
    if (!bindingCheck.match) {
      reasons.push(`决定绑定不一致：${bindingCheck.mismatches.map((m) => m.field).join(', ')}`);
    }
  } else {
    reasons.push('决定有效性：缺少决定绑定，无法确认批准对象');
  }

  // ③ 产物登记路径与实际目录一致
  const registered = record?.artifact?.path ?? null;
  const target = artifactDir ?? registered;
  if (!target || typeof target !== 'string') {
    reasons.push('产物路径缺失：record.artifact.path 与实际 artifactDir 都为空');
  } else if (registered && !samePath(registered, target)) {
    reasons.push(`产物路径不一致：登记=${registered}，实际=${target}`);
  }

  // ④ 实际产物复算 + 授权范围（verifyArtifact 只读，绝不写盘）
  if (target && typeof target === 'string') {
    try {
      verification = verifyArtifact({ root, record, decision, artifactDir: target, decisionStore });
      if (!verification.verified) {
        const failed = Object.entries(verification.checks ?? {})
          .filter(([, ok]) => !ok).map(([k]) => k);
        reasons.push(`实际产物校验未通过：${verification.code ?? 'unknown'}`
          + (failed.length ? `（${failed.join(', ')}）` : ''));
      }
      const sc = verification.scopeCheck;
      if (!sc || sc.ok !== true || (sc.unknownFields ?? []).length > 0) {
        reasons.push(`授权范围检查未通过：${sc?.code ?? 'unknown'}`);
      }
    } catch (e) {
      reasons.push(`实际产物复核异常：${e.code ?? e.name}: ${String(e.message).slice(0, 140)}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    verification,
    bindingCheck,
    artifactDir: target,
    reverifiedAt: new Date().toISOString(),
    wroteAnything: false,
  };
}

/** 幂等复核时定位该 ready 记录对应的决定（优先用产物 manifest 登记的 decisionId）。 */
function findReadyDecision(decisionStore, record) {
  const current = record?.decision?.id ?? record?.decisionId;
  if (current && decisionStore?.load(current)) return decisionStore.load(current);
  const artifactDir = record?.artifact?.path;
  if (artifactDir && existsSync(join(artifactDir, 'manifest.json'))) {
    try {
      const manifest = readJson(join(artifactDir, 'manifest.json'));
      const id = manifest?.derivedFrom?.decisionId;
      const found = id && decisionStore ? decisionStore.load(id) : null;
      if (found) return found;
    } catch { /* manifest 不可读时落到按请求查找 */ }
  }
  if (!decisionStore) return null;
  const rows = decisionStore.findByRequest(record.id)
    .filter((d) => ['approve', 'partial-adaptation'].includes(d.kind));
  return rows.find((d) => d.status === 'active') ?? rows[0] ?? null;
}

/** W4-a：审查结论。审查已完成时短路，不重写记录。 */
export function reviewStage({
  root, store, record, reviewedBy, unknownDispositions, conclusionFields, at, productionReview = false,
}) {
  if (record.review?.complete === true && record.review?.conclusionRef?.path) {
    const path = record.review.conclusionRef.path;
    return {
      status: 'already-present',
      conclusion: {
        doc: readJson(path),
        path,
        contentHash: record.review.conclusionRef.contentHash,
        reviewContentHash: record.review.conclusionRef.reviewContentHash,
        status: 'already-present',
      },
      record,
      note: '审查已完成：复用既有审查结论，不覆盖记录',
    };
  }
  const conclusion = recordReviewConclusion({
    root, record, reviewedBy, unknownDispositions, conclusionFields, at, productionReview,
  });
  const updated = finalizeReview(record, conclusion);
  store.save(updated);
  return { status: conclusion.status, conclusion, record: updated };
}

/** W4-b：决定落库。同一决定重复提交 → already-present，不推进、不覆盖。 */
export function decisionStage({
  root, store, decisionStore, record, conclusion, kind,
  authorization, approvedScopes, derivedParts, note, at, productionApproval = false,
}) {
  void root;
  const candidate = createDecision({
    record, conclusion, kind, authorization, approvedScopes, derivedParts, note, at,
    productionApproval,
  });
  const existing = decisionStore.findSame({
    requestId: candidate.requestId,
    kind: candidate.kind,
    bindingFingerprint: candidate.bindingFingerprint,
  });
  if (existing && record.state!=='awaiting-approval') {
    return {
      status: 'already-present',
      decision: existing,
      record,
      note: '同一决定（同对象 + 同范围）重复处理：不覆盖决定、不追加 history、不重复推进状态',
    };
  }
  decisionStore.save(candidate);
  let updated = record;
  // 只有从未批准状进入 adapting 时才迁移；已在 adapting（W5 失败后重跑）保持原状态，
  // 否则会撞「adapting → adapting」非法迁移，重跑永远出不去。
  if ((kind === 'approve' || kind === 'partial-adaptation')
    && record.state === 'awaiting-approval') {
    updated = transition(record, 'adapting', {
      note: `W4 决定=${kind}（${productionApproval?'生产授权':'隔离模拟授权'}），进入 W5 产物构建；未安装`,
    });
    store.save(updated);
  }
  // reject / continue-analysis：状态保持 awaiting-approval，不推进、不建产物
  return { status: 'created', decision: candidate, record: updated };
}

/** W5-a：构建版本化产物。 */
export function artifactStage({ root, record, decision, conclusion, decisionStore, at, pluginsRoot = null }) {
  return buildArtifact({ root, record, decision, conclusion, decisionStore, at, pluginsRoot });
}

/**
 * W5-b：只有三重前置全部成立才写 ready。
 * 失败 → failed(admission) + 落盘失败证据，绝不写 ready。
 */
export function readyStage({ root, store, record, decision, artifact, conclusion, decisionStore }) {
  void conclusion;
  if (record.state === 'ready') {
    // 本轮收口②：不再无条件信任 state。重新验证当前对象 / 决定有效性 /
    // 授权范围 / 实际产物，四项仍一致才允许返回 already-ready。
    const recheck = reverifyReady({
      root, record, decision,
      artifactDir: artifact?.artifactDir ?? null,
      decisionStore,
    });
    if (!recheck.ok) {
      throw new ProbeError(PIPE.READY_INVALIDATED,
        `ready 状态不得作为有效凭据：${recheck.reasons.join('；')}`,
        { recheck, verification: recheck.verification, reasons: recheck.reasons });
    }
    return {
      status: 'already-ready', record,
      verification: recheck.verification,
      recheck,
      note: '幂等复核通过（当前对象 / 决定有效性 / 授权范围 / 实际产物四项重新验证一致）；不追加 history、不覆盖决定与产物',
    };
  }
  if (record.state !== 'adapting') {
    throw new ProbeError(PIPE.NOT_ADAPTING,
      `只有 adapting 状态才允许进入 ready，当前 ${record.state}（未批准/被拒绝/继续分析都不能放行）`);
  }
  const verification = verifyArtifact({
    root, record, decision, artifactDir: artifact.artifactDir, decisionStore,
  });
  const scopeOk = verification.scopeCheck?.ok === true
    && verification.scopeCheck.unknownFields.length === 0;
  if (!verification.verified || !scopeOk) {
    const code = verification.code ?? ART.SCOPE_NOT_SATISFIED;
    // 旧决定不得继续使用：追加失效记录（不删改原决定文件）
    const invalidatedPath = decisionStore
      ? decisionStore.invalidate(decision.id,
        `W5 产物校验/授权检查未通过（${code}）；批准对象与实际产物不再对应`)
      : null;
    const failurePath = join(root, `产物校验失败-${record.id}.json`);
    atomicJson(failurePath, {
      schema: SCHEMAS.ARTIFACT_FAILURE,
      requestId: record.id,
      at: new Date().toISOString(),
      code,
      checks: verification.checks ?? null,
      scopeCheck: verification.scopeCheck ?? null,
      drift: verification.drift ?? null,
      decisionInvalidated: invalidatedPath !== null,
      decisionInvalidatedPath: invalidatedPath,
      wroteReady: false,
      wroteInstalled: false,
      wroteActive: false,
    });
    const failed = transition(record, 'failed', {
      stage: 'admission', code, note: 'W5 产物校验或授权范围检查未通过，拒绝进入 ready',
    });
    store.save(failed);
    throw new ProbeError(PIPE.READY_BLOCKED,
      `不得进入 ready：${code}（证据：${failurePath}）`,
      { verification, failurePath });
  }

  const prepared = {
    ...record,
    decisionId:decision.id,
    admission: {
      allow: true,
      code: null,
      at: new Date().toISOString(),
      gate: 'w4w5-ready-scope',
      scopeCheck: verification.scopeCheck,
      installGate: {
        status: 'unknown',
        deferredTo: 'W6',
        notEvaluated: true,
        reason: 'dist.integrity / lockSubtree / 传递依赖未取证；完整 evaluate() 安装准入留 W6，本轮不安装',
      },
      note: 'ready 的「授权满足」仅指批准范围覆盖产物声明；不等于安装准入 evaluate() 全量通过',
    },
    artifact: {
      verified: true,
      contentHash: verification.recomputed.contentHash,
      path: artifact.artifactDir,
      manifestPath: artifact.manifestPath,
      contentListPath: artifact.contentListPath,
    },
  };
  const ready = transition(prepared, 'ready', {
    note: 'W4 审查完成 + 授权满足 + W5 产物复算校验通过 → ready（未安装、未激活）',
  });
  store.save(ready);
  return { status: 'ready', record: ready, verification };
}

/**
 * 一次性串起 W4/W5。W2/W3 由调用方先跑（processRequest），本函数不重做。
 *
 * @returns {{status, review, decision, artifact, ready, record}}
 */
export function runW4W5({
  root, store, decisionStore, record,
  reviewedBy, unknownDispositions, conclusionFields,
  kind = 'approve', authorization, approvedScopes, derivedParts,
  note = '', stopAfter = null, at, decisionOverride = null,
  productionApproval = false, artifactOptions = null, productionReview = false,
}) {
  if (record.state === 'ready') {
    // 本轮收口②：与 readyStage 共用同一份重验实现，不另写一套判据。
    const decision = decisionOverride ?? findReadyDecision(decisionStore, record);
    const recheck = reverifyReady({
      root, record, decision,
      artifactDir: record.artifact?.path ?? null,
      decisionStore,
    });
    if (!recheck.ok) {
      throw new ProbeError(PIPE.READY_INVALIDATED,
        `ready 状态不得作为有效凭据：${recheck.reasons.join('；')}`,
        { recheck, verification: recheck.verification, reasons: recheck.reasons });
    }
    return {
      status: 'already-ready', record, decision,
      verification: recheck.verification,
      recheck,
      note: '幂等复核通过（四项重新验证一致）；不重复推进、不追加 history、不覆盖任何记录',
    };
  }
  const review = reviewStage({
    root, store, record, reviewedBy, unknownDispositions, conclusionFields, at, productionReview,
  });
  if (stopAfter === 'review') return { status: 'stopped-after-review', review, record: review.record };

  const decision = decisionStage({
    root, store, decisionStore, record: review.record, conclusion: review.conclusion,
    kind, authorization, approvedScopes, derivedParts, note, at, productionApproval,
  });
  if (stopAfter === 'decision') {
    return { status: 'stopped-after-decision', review, decision, record: decision.record };
  }
  if (decision.status === 'already-present' && decision.record.state === 'ready') {
    // 第三处提前返回同样必须重验，不能因为「决定已存在」就跳过产物校验。
    const recheck = reverifyReady({
      root, record: decision.record, decision: decision.decision,
      artifactDir: decision.record.artifact?.path ?? null,
      decisionStore,
    });
    if (!recheck.ok) {
      throw new ProbeError(PIPE.READY_INVALIDATED,
        `ready 状态不得作为有效凭据：${recheck.reasons.join('；')}`,
        { recheck, verification: recheck.verification, reasons: recheck.reasons });
    }
    return {
      status: 'already-ready', review, decision, record: decision.record,
      verification: recheck.verification, recheck,
    };
  }
  // 拒绝 / 继续分析：保持 awaiting-approval，不构建产物（混合样例继续留胃）
  if (!['approve', 'partial-adaptation'].includes(kind)) {
    return {
      status: 'held', review, decision, record: decision.record,
      note: `决定 ${kind} 不构成整包批准；状态保持 ${decision.record.state}，不生成 artifact`,
    };
  }

  const artifact = artifactStage({
    root, record: decision.record, decision: decision.decision,
    conclusion: review.conclusion, decisionStore, at, ...(artifactOptions ?? {}),
  });
  const ready = readyStage({
    root, store, record: decision.record, decision: decision.decision,
    artifact, conclusion: review.conclusion, decisionStore,
  });
  return {
    status: 'ready', review, decision, artifact, ready,
    record: ready.record,
  };
}

export { CON, DEC, ART, assertNotTestData };
