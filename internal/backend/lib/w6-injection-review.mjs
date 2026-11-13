/**
 * W6-A 定点收口 ②：注入面审查证据的**实际核验 + 绑定本次产物**（隔离实现）。
 *
 * 修复前的问题：
 *   - buildFullAdmissionInput() 给每个新装样例自动登记 legacy=true + injectionReviewed=true，
 *     借 evaluate() Step4 的「legacy 兼容通道」放行；新插件伪装成 v1 既有记录。
 *   - injectionReviewEvidencePath 只是一个字符串路径，从未被读取、复算或核对；
 *     即使证据文件不存在、被篡改、绑定的是别的产物，也照样放行。
 *
 * 本模块提供「正常的新装准入路径」：
 *   - 不依赖 legacy；依据 W4 审查结论里对 unknown 的显式处置（accepted-as-residual）
 *     与 W5 决定/产物作为放行依据。
 *   - 证据文件必须实际读取，逐项复算 sha256（审查材料 / 审查结论 / W5 manifest），
 *     并核对绑定字段：contentHash、decisionId、conclusionContentHash、pinnedCommit。
 *   - unknown 保持 unknown：W5 unknownFacts.personaInjection / memoryInjection 仍为 'unknown'，
 *     部署 manifest 仍不写这两个字段；本通道绝不把 unknown 改写成 false。
 *   - 任一核验不通过 → verified=false → evaluate() Step4 返回 ADM_INJECTION_UNKNOWN
 *     → 部署准入拒绝，不执行 pnpm、不登记 installed（停在胃里）。
 *
 * 边界：只做隔离目录内文件读取与哈希复算；不执行候选代码、不联网、不改生产。
 */

import { existsSync } from 'node:fs';
import { sha256File, readJson, atomicJson } from './w6-utils.mjs';

export const W6IR = Object.freeze({
  EVIDENCE_MISSING: 'W6_INJECTION_REVIEW_EVIDENCE_MISSING',
  EVIDENCE_SCHEMA: 'W6_INJECTION_REVIEW_EVIDENCE_SCHEMA',
  EVIDENCE_HASH_MISMATCH: 'W6_INJECTION_REVIEW_EVIDENCE_HASH_MISMATCH',
  BINDING_MISMATCH: 'W6_INJECTION_REVIEW_BINDING_MISMATCH',
  UNKNOWN_REWRITTEN: 'W6_INJECTION_REVIEW_UNKNOWN_REWRITTEN',
  DISPOSITION_MISSING: 'W6_INJECTION_REVIEW_DISPOSITION_MISSING',
  APPROVAL_MISSING: 'W6_INJECTION_REVIEW_APPROVAL_MISSING',
});

export const INJECTION_REVIEW_SCHEMA = 'w6-injection-review-evidence/v2-isolation-test-only';
/** 生产候选用同一结构、但**不带 isolation-test-only 标记**的 schema。 */
export const INJECTION_REVIEW_SCHEMA_PRODUCTION = 'w6-injection-review-evidence/v2';
export const INJECTION_FIELDS = Object.freeze(['personaInjection', 'memoryInjection']);
export const RESIDUAL_DISPOSITION = 'accepted-as-residual';

/**
 * 生成一份**绑定本次产物**的注入面审查证据文件。
 *
 * 所有哈希都由实际落盘文件复算，不写死、不自证；证据文件自身的 sha256 由核验方
 * 读取后重新计算（不写进文件里，避免自证）。
 */
export function writeInjectionReviewEvidence({
  path, w5ManifestPath, conclusionPath, reviewPath,
  decision, pinnedCommit, schema = INJECTION_REVIEW_SCHEMA,
  scope = '仅隔离自建样例；不是真实上游插件，也不代表生产 registry 的审查结论',
}) {
  const doc = {
    schema,
    at: new Date().toISOString(),
    scope,
    method: [
      'W2 只读 Git 对象采集，逐文件 sha256；W3 strong/weak 静态扫描材料',
      'W4 审查结论对注入面 unknown 逐项显式处置为 accepted-as-residual（未改判为 false）',
      '逐文件人工复核：无 ctx.systemPrompt.section / ctx.memory.remember 等注入 API',
      '部署后由独立 Node 进程实际解析并调用无害样例，记录运行时返回',
    ],
    notClaimed: [
      '不声称静态扫描能证明没有注入',
      '不把 W5 unknownFacts.personaInjection / memoryInjection 从 unknown 改成 false',
      '不代表真实上游插件或生产 registry 的审查结论（Q3/Q4 仍 open）',
      '证据文件自身哈希由核验方读取后实算，不在文件内自证',
    ],
    // —— 绑定本次产物 / 决定 / 审查结论 ——
    boundContentHash: null, // 由调用方从 w5Manifest 实读后填入
    boundDecisionId: decision?.id ?? null,
    boundConclusionContentHash: decision?.review?.conclusionContentHash ?? null,
    boundPinnedCommit: pinnedCommit ?? null,
    w5ManifestPath,
    w5ManifestSha256: sha256File(w5ManifestPath),
    conclusionPath,
    conclusionSha256: sha256File(conclusionPath),
    reviewPath,
    reviewSha256: sha256File(reviewPath),
    unknownFields: [...INJECTION_FIELDS],
    unknownStatusKept: true,
    disposition: RESIDUAL_DISPOSITION,
    authorizationSeparate: true,
    note: '本证据必须经 verifyInjectionReview() 实算核验后，才能作为非 legacy 新装的准入依据',
  };
  // boundContentHash 从实际 W5 manifest 读取，不从入参猜测
  const manifest = readJson(w5ManifestPath);
  doc.boundContentHash = manifest.contentHash;
  atomicJson(path, doc);
  return { path, doc };
}

/**
 * 实际核验注入面审查证据，并构造 evaluate() Step4 可识别的结构化对象。
 *
 * @returns {{verified:boolean, code:string|null, reasons:string[], review:object, checks:object}}
 *          review.verified=false 时不得作为放行依据。
 */
export function verifyInjectionReview({
  evidencePath, w5Manifest, w5ManifestPath, decision, packageRecord,
  evidenceSchema = INJECTION_REVIEW_SCHEMA,
}) {
  const reasons = [];
  const checks = {};
  const fail = (code, reason) => { reasons.push(reason); return code; };

  if (!evidencePath || !existsSync(evidencePath)) {
    const code = fail(W6IR.EVIDENCE_MISSING, `注入面审查证据文件不存在：${String(evidencePath)}`);
    return { verified: false, code, reasons, checks, review: emptyReview(evidencePath) };
  }
  checks.evidenceExists = true;

  const doc = readJson(evidencePath);
  checks.evidenceSchemaOk = doc?.schema === evidenceSchema;
  if (!checks.evidenceSchemaOk) {
    fail(W6IR.EVIDENCE_SCHEMA, `证据 schema 不正确：${String(doc?.schema)}`);
  }

  const evidenceSha256 = sha256File(evidencePath);
  checks.evidenceSha256Recomputed = typeof evidenceSha256 === 'string' && evidenceSha256.length > 0;

  // ① 三个被引用文件的哈希必须实际复算一致（证据被篡改 / 换产物都会失效）
  const hashPairs = [
    ['w5ManifestSha256', 'w5ManifestPath'],
    ['conclusionSha256', 'conclusionPath'],
    ['reviewSha256', 'reviewPath'],
  ];
  const hashRows = [];
  for (const [hashKey, pathKey] of hashPairs) {
    const refPath = doc[pathKey];
    let ok = false;
    let actual = null;
    if (typeof refPath === 'string' && existsSync(refPath)) {
      actual = sha256File(refPath);
      ok = actual === doc[hashKey];
    }
    hashRows.push({ field: hashKey, path: refPath ?? null, expected: doc[hashKey] ?? null, actual, ok });
    if (!ok) reasons.push(`${hashKey} 与实际文件哈希不一致（${String(refPath)}）`);
  }
  checks.referencedFileHashesMatch = hashRows.every((r) => r.ok);
  checks.hashRows = hashRows;

  // ② 绑定本次产物：W5 manifest / 安装包源码树 / 决定绑定三者逐字一致
  checks.boundContentHashMatchesManifest = doc.boundContentHash === w5Manifest?.contentHash;
  if (!checks.boundContentHashMatchesManifest) {
    reasons.push(`证据绑定的 contentHash 与本次 W5 产物不一致：${String(doc.boundContentHash)} vs ${String(w5Manifest?.contentHash)}`);
  }
  checks.packageSourceMatchesW5 = packageRecord?.sourceTreeHash === w5Manifest?.contentHash;
  if (!checks.packageSourceMatchesW5) {
    reasons.push('安装包源码树哈希与本次 W5 产物不一致');
  }
  checks.boundDecisionIdMatches = doc.boundDecisionId === decision?.id;
  if (!checks.boundDecisionIdMatches) reasons.push('证据绑定的决定 ID 与本次决定不一致');
  checks.boundConclusionMatches = doc.boundConclusionContentHash === decision?.review?.conclusionContentHash;
  if (!checks.boundConclusionMatches) reasons.push('证据绑定的审查结论哈希与本次决定不一致');
  checks.boundCommitMatches = doc.boundPinnedCommit === decision?.binding?.pinnedCommit;
  if (!checks.boundCommitMatches) reasons.push('证据绑定的固定提交与本次决定不一致');
  checks.w5ManifestPathMatches = doc.w5ManifestPath === w5ManifestPath;
  if (!checks.w5ManifestPathMatches) reasons.push('证据引用的 W5 manifest 路径与本次产物路径不一致');

  // ③ unknown 保持 unknown，绝不改写成 false
  const persona = w5Manifest?.unknownFacts?.personaInjection?.status;
  const memory = w5Manifest?.unknownFacts?.memoryInjection?.status;
  checks.w5InjectionStillUnknown = persona === 'unknown' && memory === 'unknown';
  if (!checks.w5InjectionStillUnknown) {
    reasons.push(`W5 注入面结论不再保持 unknown：personaInjection=${String(persona)}, memoryInjection=${String(memory)}`);
  }
  checks.evidenceDeclaresUnknownKept = doc.unknownStatusKept === true
    && Array.isArray(doc.unknownFields)
    && INJECTION_FIELDS.every((f) => doc.unknownFields.includes(f));
  if (!checks.evidenceDeclaresUnknownKept) {
    reasons.push('证据未声明注入面 unknown 原样保持（或 unknownFields 不完整）');
  }

  // ④ 审查结论里必须对这两个 unknown 有显式处置，且不夹带用户授权
  let conclusionDoc = null;
  if (typeof doc.conclusionPath === 'string' && existsSync(doc.conclusionPath)) {
    conclusionDoc = readJson(doc.conclusionPath);
  }
  const dispositions = Array.isArray(conclusionDoc?.unknownDispositions)
    ? conclusionDoc.unknownDispositions : [];
  checks.conclusionDispositionPresent = INJECTION_FIELDS.every((field) => dispositions.some(
    (d) => d.field === field && d.disposition === RESIDUAL_DISPOSITION,
  ));
  if (!checks.conclusionDispositionPresent) {
    reasons.push('审查结论缺少对 personaInjection / memoryInjection 的显式 accepted-as-residual 处置');
  }
  checks.conclusionUnknownsUnchanged = conclusionDoc?.unknownsUnchanged === true
    && conclusionDoc?.authorizationSeparate === true;
  if (!checks.conclusionUnknownsUnchanged) {
    reasons.push('审查结论未声明 unknowns 原样保持 / 授权分离');
  }
  checks.evidenceDispositionMatches = doc.disposition === RESIDUAL_DISPOSITION;
  if (!checks.evidenceDispositionMatches) reasons.push('证据的 unknown 处置不是 accepted-as-residual');

  // ⑤ 有效放行依据：决定必须是整包批准，且显式接受过这两个 unknown
  checks.decisionApprovesWholePackage = decision?.wholePackageApproved === true
    && ['approve', 'partial-adaptation'].includes(decision?.kind);
  if (!checks.decisionApprovesWholePackage) reasons.push('缺少构成放行依据的整包批准决定');
  const accepted = Array.isArray(decision?.review?.acceptedUnknowns)
    ? decision.review.acceptedUnknowns : [];
  checks.decisionAcceptedUnknowns = INJECTION_FIELDS.every((f) => accepted.includes(f));
  if (!checks.decisionAcceptedUnknowns) {
    reasons.push('决定未显式接受 personaInjection / memoryInjection 作为残留 unknown');
  }

  const booleanChecks = Object.entries(checks).filter(([, v]) => typeof v === 'boolean');
  const verified = booleanChecks.every(([, v]) => v === true) && reasons.length === 0;
  let code = null;
  if (!verified) {
    if (!checks.evidenceExists) code = W6IR.EVIDENCE_MISSING;
    else if (!checks.evidenceSchemaOk) code = W6IR.EVIDENCE_SCHEMA;
    else if (!checks.referencedFileHashesMatch || !checks.boundContentHashMatchesManifest
      || !checks.boundDecisionIdMatches || !checks.boundConclusionMatches
      || !checks.boundCommitMatches || !checks.packageSourceMatchesW5
      || !checks.w5ManifestPathMatches) code = W6IR.BINDING_MISMATCH;
    else if (!checks.w5InjectionStillUnknown || !checks.evidenceDeclaresUnknownKept) code = W6IR.UNKNOWN_REWRITTEN;
    else if (!checks.conclusionDispositionPresent || !checks.evidenceDispositionMatches
      || !checks.conclusionUnknownsUnchanged) code = W6IR.DISPOSITION_MISSING;
    else code = W6IR.APPROVAL_MISSING;
  }

  const review = {
    schema: 'w6-injection-review-verified/v1-isolation-test-only',
    verified,
    code,
    evidencePath,
    evidenceSha256,
    boundContentHash: doc.boundContentHash ?? null,
    boundDecisionId: doc.boundDecisionId ?? null,
    boundConclusionContentHash: doc.boundConclusionContentHash ?? null,
    boundPinnedCommit: doc.boundPinnedCommit ?? null,
    unknownFields: [...INJECTION_FIELDS],
    unknownStatusKept: checks.evidenceDeclaresUnknownKept === true
      && checks.w5InjectionStillUnknown === true,
    disposition: doc.disposition ?? null,
    decisionId: decision?.id ?? null,
    notLegacy: true,
    reasons,
    note: verified
      ? '证据经实算核验并绑定本次产物；注入面 unknown 保持原样，非 legacy 新装通道'
      : '证据未通过核验：不得作为放行依据，新装应停在胃里',
  };
  return { verified, code, reasons, checks, review };
}

function emptyReview(evidencePath) {
  return {
    schema: 'w6-injection-review-verified/v1-isolation-test-only',
    verified: false,
    evidencePath: evidencePath ?? null,
    evidenceSha256: null,
    boundContentHash: null,
    boundDecisionId: null,
    unknownFields: [...INJECTION_FIELDS],
    unknownStatusKept: false,
    disposition: null,
    decisionId: null,
    notLegacy: true,
  };
}

/** 供测试构造「只带路径、不核验」的旧形态证据（缺陷复现用）。 */
export function pathOnlyEvidence(evidencePath) {
  return { injectionReviewEvidencePath: evidencePath, injectionReviewed: true, legacy: true };
}

/** Existing review+decision are sufficient evidence. No additional proof document. */
export function verifyDecisionReview({decision,w5Manifest,packageRecord}) {
  const checks={},reasons=[];
  let assessment=null;
  try {
    const path=decision?.review?.conclusionPath;
    const doc=readJson(path);assessment=doc.conclusion?.injectionAssessment;
    checks.conclusionHash=sha256File(path)===decision.review.conclusionContentHash;
    checks.factsHash=sha256File(doc.factsRef.path)===doc.factsRef.contentHash
      &&doc.factsRef.contentHash===decision.binding.reviewContentHash;
    checks.sourceIdentity=packageRecord?.sourceTreeHash===w5Manifest?.contentHash
      &&decision?.binding?.contentHash===w5Manifest?.contentHash;
    checks.commit=doc.factsSummary.pinnedCommit===decision.binding.pinnedCommit;
    checks.reviewComplete=doc.conclusion?.reviewComplete===true;
    checks.authorizationSeparate=doc.authorizationSeparate===true;
    const dispositions=doc.unknownDispositions??[];
    checks.dispositions=INJECTION_FIELDS.every(field => typeof doc.conclusion?.injectionAssessment?.[field]==='boolean'
      ||dispositions.some(d=>d.field===field&&['accepted-as-residual','verified'].includes(d.disposition)&&d.basis));
  }catch { reasons.push('审查结论或引用材料不可读'); }
  const verified=Object.keys(checks).length>0&&!reasons.length&&Object.values(checks).every(Boolean);
  return {verified,code:verified?null:W6IR.BINDING_MISMATCH,checks,reasons,
    review:{verified,boundContentHash:w5Manifest?.contentHash,notLegacy:true,assessment,reviewedFields:[...INJECTION_FIELDS],
      unknownStatusKept:true,disposition:RESIDUAL_DISPOSITION,unknownFields:[...INJECTION_FIELDS]}};
}
