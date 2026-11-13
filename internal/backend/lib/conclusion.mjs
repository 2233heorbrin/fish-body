/** Review facts are immutable history. Conclusions may resolve facts with explicit
 * behavioral/configuration evidence, or retain unknown with a documented disposition.
 * Re-reviews are immutable content-addressed records; human authorization stays in decisions.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  SCHEMAS, ProbeError, sha256File, atomicJson, readJson, exists,
} from './w4w5-utils.mjs';

export const CON = Object.freeze({
  REVIEW_MISSING: 'CON_REVIEW_MISSING',
  DISPOSITION_INCOMPLETE: 'CON_DISPOSITION_INCOMPLETE',
  DISPOSITION_BAD: 'CON_DISPOSITION_BAD',
  UNKNOWN_DOWNGRADE: 'CON_UNKNOWN_DOWNGRADE',
  CONCLUSION_HAS_AUTHORIZATION: 'CON_CONCLUSION_HAS_AUTHORIZATION',
  ALREADY_PRESENT: 'CON_ALREADY_PRESENT',
  BAD_STATE: 'CON_BAD_STATE',
});

export const UNKNOWN_DISPOSITIONS = Object.freeze(['accepted-as-residual', 'still-unknown', 'verified']);

/**
 * 便捷函数：生成「全部显式接受为残留风险」的处置（不是「改成 false」）。
 *
 * 本轮收口③：它**不是业务默认行为**，只供测试或明确知情的调用方主动调用，
 * 且调用点必须自己把它作为 unknownDispositions 显式传入正式审查接口。
 * recordReviewConclusion 内部绝不调用本函数。
 */
export function acceptAllAsResidual(reviewDoc, basis = '隔离审查：静态材料已复核；该项无运行时取证，作为残留风险显式接受，留待 W6 安装门与运行时取证') {
  return (reviewDoc.unknowns ?? []).map((u) => ({
    field: u.field,
    originalStatus: 'unknown',
    disposition: 'accepted-as-residual',
    basis: `${basis}（字段：${u.field}）`,
  }));
}

function validateDispositions(reviewDoc, dispositions) {
  const fields = (reviewDoc.unknowns ?? []).map((u) => u.field);
  if (!Array.isArray(dispositions)) {
    throw new ProbeError(CON.DISPOSITION_INCOMPLETE, 'unknownDispositions 必须是数组');
  }
  const byField = new Map();
  for (const item of dispositions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProbeError(CON.DISPOSITION_BAD, '每条处置必须是对象');
    }
    if (typeof item.field !== 'string' || !fields.includes(item.field)) {
      throw new ProbeError(CON.DISPOSITION_INCOMPLETE,
        `处置字段 ${String(item.field)} 不在 W3 的 unknown 清单中：${fields.join(', ')}`);
    }
    if (byField.has(item.field)) {
      throw new ProbeError(CON.DISPOSITION_BAD, `字段 ${item.field} 重复处置`);
    }
    // 硬约束：不能把 unknown 改写成已判定
    if (item.originalStatus !== 'unknown') {
      throw new ProbeError(CON.UNKNOWN_DOWNGRADE,
        `${item.field}.originalStatus 必须是 'unknown'；审查结论不得把 unknown 改判为确定值`);
    }
    if (!UNKNOWN_DISPOSITIONS.includes(item.disposition)) {
      throw new ProbeError(CON.DISPOSITION_BAD,
        `${item.field}.disposition 只能是 ${UNKNOWN_DISPOSITIONS.join(' / ')}`);
    }
    if (['accepted-as-residual', 'verified'].includes(item.disposition)
      && (typeof item.basis !== 'string' || item.basis.trim() === '')) {
      throw new ProbeError(CON.DISPOSITION_BAD,
        `${item.field} 接受为残留风险必须写明 basis（不能无依据放行）`);
    }
    if (item.disposition === 'verified' && typeof item.value !== 'boolean') {
      throw new ProbeError(CON.DISPOSITION_BAD, 'verified 处置需要 boolean value 与依据');
    }
    byField.set(item.field, item);
  }
  const missing = fields.filter((f) => !byField.has(f));
  if (missing.length > 0) {
    throw new ProbeError(CON.DISPOSITION_INCOMPLETE,
      `以下 unknown 未给出显式处置：${missing.join(', ')}`);
  }
  // 按 W3 原顺序返回，便于比对「unknowns 未被改写」
  return fields.map((f) => ({
    field: f,
    originalStatus: 'unknown',
    disposition: byField.get(f).disposition,
    ...(byField.get(f).disposition === 'verified' ? { value: byField.get(f).value } : {}),
    basis: typeof byField.get(f).basis === 'string' ? byField.get(f).basis : '',
  }));
}

function validateInjectionAssessment(assessment) {
  for (const field of ['personaInjection', 'memoryInjection']) {
    const value = assessment?.[field];
    if (value !== 'unknown' && typeof value !== 'boolean') {
      throw new ProbeError(CON.UNKNOWN_DOWNGRADE,
        `${field} 必须为 boolean 或 unknown；确定结论需提供行为审查依据`);
    }
  }
  return assessment;
}

/**
 * 产出审查结论文档并落盘（幂等：同内容不覆盖；不同内容拒绝覆盖）。
 *
 * @returns {{doc, path, contentHash, reviewContentHash, status}}
 */
export function recordReviewConclusion({
  root, record, reviewedBy = 'isolation-test-reviewer',
  unknownDispositions, conclusionFields = {}, at, productionReview = false,
}) {
  void root;
  const reviewPath = record?.stomach?.reviewPath;
  if (!reviewPath || !existsSync(reviewPath)) {
    throw new ProbeError(CON.REVIEW_MISSING,
      '找不到 W3 的 review.json；必须先完成入饭与胃材料生成，批准不能代替内容审查');
  }
  const reviewDoc = readJson(reviewPath);
  if (reviewDoc.schema !== 'stomach-review-material/v1') {
    throw new ProbeError(CON.REVIEW_MISSING, `review.json schema 不对：${reviewDoc.schema}`);
  }

  // 本轮收口③：省略 / null 一律拒绝，绝不在业务默认路径里自动接受全部 unknown。
  // 「接受残留风险」是审查判断，必须由调用方逐项显式给出，不能由接口代劳。
  if (unknownDispositions === undefined || unknownDispositions === null) {
    throw new ProbeError(CON.DISPOSITION_INCOMPLETE,
      '正式审查接口必须显式给出完整的 unknownDispositions；省略输入不得默认全接受（acceptAllAsResidual 仅由调用方主动调用）');
  }
  const dispositions = validateDispositions(reviewDoc, unknownDispositions);

  // 结论里绝不允许夹带用户授权字段
  for (const key of ['authorization', 'granted', 'approved', 'approvedScopes', 'decision']) {
    if (Object.hasOwn(conclusionFields, key)) {
      throw new ProbeError(CON.CONCLUSION_HAS_AUTHORIZATION,
        `审查结论不得包含用户授权字段 ${key}；授权只在 decisions/<id>.json 落库`);
    }
  }

  const injectionAssessment = validateInjectionAssessment(
    conclusionFields.injectionAssessment ?? {
      personaInjection: 'unknown',
      memoryInjection: 'unknown',
      note: '静态材料不能证明没有注入；保持 unknown，不因审查完成或批准而改判',
    },
  );

  if (Object.values(injectionAssessment).some(v => typeof v === 'boolean')
    && !conclusionFields.basis?.trim()) throw new ProbeError(CON.DISPOSITION_BAD, '确定的注入判断必须提供 basis');
  const reviewContentHash = sha256File(reviewPath);
  const facts = reviewDoc.facts ?? {};
  const candidates = reviewDoc.candidates ?? {};
  const acceptedAsResidual = dispositions
    .filter((d) => ['accepted-as-residual', 'verified'].includes(d.disposition)).map((d) => d.field);
  const stillUnknown = dispositions
    .filter((d) => d.disposition === 'still-unknown').map((d) => d.field);

  const doc = {
    schema: productionReview ? 'stomach-review-conclusion/v1' : SCHEMAS.CONCLUSION,
    requestId: record.id,
    at: at ?? new Date().toISOString(),
    reviewedBy,
    // 生产审查结论不带隔离测试标记；隔离回归保持默认
    ...(productionReview === true ? {} : { testData: { simulated: true, isolationOnly: true, nonProduction: true } }),
    factsRef: {
      path: reviewPath,
      contentHash: reviewContentHash,
      schema: reviewDoc.schema,
    },
    // 事实只引用与摘要，不重写 W3 材料
    factsSummary: {
      pinnedCommit: facts.pinnedCommit,
      contentHash: facts.contentHash,
      upstreamUrl: facts.upstreamUrl,
      fileCount: facts.fileCount,
      staticHitCounts: facts.staticHitCounts,
      strongInjectionCounts: facts.strongInjectionCounts,
      installScripts: facts.installScripts,
      flatDependencies: facts.flatDependencies,
      shape: candidates.shape,
      capabilities: (candidates.capabilities ?? []).map((c) => c.value),
      risks: (candidates.risks ?? []).map((r) => r.value),
    },
    // 审查判断（独立于用户授权）
    conclusion: {
      shape: conclusionFields.shape ?? candidates.shape,
      capabilities: conclusionFields.capabilities
        ?? (candidates.capabilities ?? []).map((c) => c.value),
      risks: conclusionFields.risks
        ?? (candidates.risks ?? []).map((r) => r.value),
      injectionAssessment,
      requiresHumanReview: false,
      reviewComplete: true,
      basis: conclusionFields.basis
        ?? '复核 W3 静态事实与候选判断；未做运行时取证，注入面与依赖面保持 unknown',
      note: '本文件只记录审查判断；用户授权在 decisions/<id>.json 单独落库',
    },
    // unknown 逐项处置：原状态一律 'unknown'
    unknownDispositions: dispositions,
    unknownsUnchanged: true,
    acceptedAsResidual,
    stillUnknown,
    // 未完成项目保持 unknown，不伪造数据
    residualUnknowns: {
      transitiveDependencies: { status: 'unknown', reason: '未执行依赖解析' },
      distIntegrity: { status: 'unknown', reason: '未获取 dist.integrity；属 W6 安装门' },
      lockSubtree: { status: 'unknown', reason: '未生成锁子树' },
      runtimeBehavior: { status: 'unknown', reason: '候选代码未执行' },
      upstreamTrust: { status: 'unknown', reason: productionReview ? '来源身份见 factsRef；信任判断以审查依据为准' : '隔离测试来源'  },
      personaInjection: { status: 'unknown', reason: '静态扫描不能证明没有注入' },
      memoryInjection: { status: 'unknown', reason: '静态扫描不能证明没有记忆写入' },
    },
    authorizationSeparate: true,
    decisionRef: null,
    scopeNote: '胃只写审查结论，不写运行态 state/history；运行态唯一真源是 requests/<id>.json',
  };

  const signature = JSON.stringify({ ...doc, at: null });
  const suffix = Buffer.from(record.id).toString('hex');
  const path = join(dirname(reviewPath), `审查结论-${suffix}-${createHash('sha256').update(signature).digest('hex').slice(0, 16)}.json`);
  if (existsSync(path)) {
    const existing = readJson(path);
    const existingHash = sha256File(path);
    // 用「文档内容指纹」比较：忽略 at 时间戳，其余字段一致即同一结论
    const comparable = (d) => JSON.stringify({
      ...d, at: null, factsRef: { ...d.factsRef, contentHash: d.factsRef.contentHash },
    });
    if (comparable(existing) === comparable(doc)) {
      return { doc: existing, path, contentHash: existingHash, reviewContentHash, status: 'already-present' };
    }
    throw new ProbeError(CON.ALREADY_PRESENT,
      `审查结论已存在且内容不同（${path}），拒绝覆盖；如需重新审查应新建请求`);
  }
  atomicJson(path, doc);
  return { doc, path, contentHash: sha256File(path), reviewContentHash, status: 'created' };
}

/**
 * 把审查结论挂到请求记录上（只改 review 字段，不改 state/history）。
 *
 * 关键点：`unknowns` **原样保留**，`acceptedUnknowns` 只列审查结论里显式接受的字段。
 * `complete: true` 表示「审查流程完成」，不代表所有 unknown 已解决。
 */
export function finalizeReview(record, conclusion) {
  if (record.state !== 'awaiting-approval') {
    throw new ProbeError(CON.BAD_STATE,
      `审查结论只能在 awaiting-approval 阶段落库，当前 ${record.state}`);
  }
  if (![SCHEMAS.CONCLUSION, 'stomach-review-conclusion/v1'].includes(conclusion?.doc?.schema) || !conclusion.path || !conclusion.contentHash) {
    throw new ProbeError(CON.REVIEW_MISSING, '缺少有效审查结论');
  }
  const unknowns = [...(record.review?.unknowns ?? [])];
  const acceptedList = (conclusion.doc.acceptedAsResidual ?? [])
    .filter((f) => unknowns.includes(f));
  const updated = {
    ...record,
    review: {
      complete: true,
      unknowns,
      acceptedUnknowns: acceptedList,
      conclusionRef: {
        path: conclusion.path,
        contentHash: conclusion.contentHash,
        reviewPath: conclusion.doc.factsRef.path,
        reviewContentHash: conclusion.doc.factsRef.contentHash,
      },
    },
  };
  // 不变量自查：状态/history/stage 与 unknown 状态都没被动过
  if (updated.state !== record.state || updated.history !== record.history
    || updated.stage !== record.stage) {
    throw new ProbeError(CON.BAD_STATE, 'finalizeReview 不得改变 state/history/stage');
  }
  if (updated.review.unknowns.length !== unknowns.length
    || updated.review.unknowns.some((u, i) => u !== unknowns[i])) {
    throw new ProbeError(CON.UNKNOWN_DOWNGRADE, 'unknowns 必须原样保留');
  }
  return updated;
}
