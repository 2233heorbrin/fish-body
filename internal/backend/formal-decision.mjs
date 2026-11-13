/**
 * 正式候选 · 正式批准决定（绑定具体插件 / 制品 / 目标范围 / 权限）
 *
 * 关键约束：**任意 productionApproval=true 文件不构成通用放行依据**。
 * 决定必须由审批端点（fish-body-approval → orchestrator）为某个 pending 请求生成，
 * 并在放行前逐字段复核：requestId、pluginId、packageName、version、spec、
 * artifactPath、contentHash、targetProfile、approvedScopes、六维 authorization、
 * bindingFingerprint、决定文件确实位于受管 decisionsRoot 且未被撤销。
 *
 * isolation mode 使用独立测试决定（带 testData），生产门必须实测拒绝；
 * production mode 要求真实决定。隔离回归不得预先写入任何生产决定。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Text } from './lib/w6-utils.mjs';
import {
  assertNotTestData, isTestData, validateAuthorizationGrants,
} from './lib/decision.mjs';
import { samePath } from './lib/path-identity.mjs';
import { SCHEMAS } from './lib/w4w5-utils.mjs';

export const FORMAL_SCHEMA = 'fish-hand-formal-decision/v1';
export const APPROVAL_SOURCE = 'fish-body-approval-ui';

/** 确定性序列化（递归排序键，避免 JSON.stringify replacer 过滤嵌套字段）。 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function fingerprint(d) {
  const b = d.binding ?? {};
  return sha256Text(stable({
    requestId: d.requestId, pluginId: d.pluginId, packageName: d.packageName,
    version: d.version, spec: d.spec,
    artifactPath: b.artifactPath, contentHash: b.contentHash,
    targetProfile: b.targetProfile, approvedScopes: d.approvedScopes,
    authorization: d.authorization,
    ...(b.source ? {source:b.source} : {}),
    ...(d.injectionAssessment ? {injectionAssessment:d.injectionAssessment} : {}),
    ...(b.packageIntegrity ? {packageIntegrity:b.packageIntegrity,runtimeContentHash:b.runtimeContentHash} : {}),
  }));
}

/** 由审批端点调用：为具体 pending 请求生成绑定决定（只在内存中构造，落库由 orchestrator 负责）。 */
export function createFormalDecision({
  request, artifact, approvedBy, approvedScopes, authorization,
  targetProfile, mode = 'production', at = new Date().toISOString(),
}) {
  if (!request?.requestId || !request?.packageName || !request?.spec) {
    throw new Error('[FH_DECISION_BAD_REQUEST] 缺少 requestId / packageName / spec');
  }
  if (!artifact?.artifactPath || !artifact?.contentHash) {
    throw new Error('[FH_DECISION_BAD_ARTIFACT] 缺少 artifactPath / contentHash');
  }
  if (!targetProfile) throw new Error('[FH_DECISION_UNBOUND] 缺少目标 Profile');
  if (!approvedBy) throw new Error('[FH_DECISION_NO_APPROVER] 缺少真实审批主体 approvedBy');
  const doc = {
    schema: FORMAL_SCHEMA,
    id: `fd-${request.requestId}`,
    requestId: request.requestId,
    pluginId: request.pluginId ?? request.packageName,
    packageName: request.packageName,
    version: request.version ?? '0',
    spec: request.spec,
    binding: {
      artifactPath: artifact.artifactPath,
      contentHash: artifact.contentHash,
      targetProfile: String(targetProfile ?? ''),
      grantedScopes: approvedScopes,
      ...(request.source?.subdir ? {source:{upstreamUrl:request.source.upstreamUrl,pinnedCommit:request.source.pinnedCommit,subdir:request.source.subdir}} : {}),
      ...(artifact.packageIntegrity ? {packageIntegrity:artifact.packageIntegrity,runtimeContentHash:artifact.runtimeContentHash} : {}),
    },
    approvedScopes,
    authorization,
    source: APPROVAL_SOURCE,
    approvedBy,
    status: 'active',
    at,
  };
  if (mode === 'production') {
    doc.productionApproval = true;
  } else {
    doc.testData = { simulated: true, isolationOnly: true, nonProduction: true };
  }
  // 留胃形态（W3 判混合）：人格/记忆维必需。必须与 W4 用同一口径，
  // 否则同一份授权在 W4 通过、在这里被判「无依据多授予」。
  doc.mixedHold = request.mixedHold === true;
  doc.injectionAssessment=request.injectionAssessment??null;
  doc.authorizationAudit = validateAuthorizationGrants(authorization, approvedScopes, {
    loadForm: request.loadForm ?? 'tool',
    injectionAssessment: request.injectionAssessment ?? null,
    mixedHold: doc.mixedHold,
  });
  doc.bindingFingerprint = fingerprint(doc);
  doc.asLegacyDecision = {
    schema: mode==='production'?'hand-decision/v1':SCHEMAS.DECISION,
    id: doc.id,
    requestId: doc.requestId,
    kind: 'approve',
    status: 'active',
    wholePackageApproved: true,
    approvedScopes,
    authorization,
    authorizationAudit: doc.authorizationAudit,
    binding: doc.binding,
    productionApproval: mode === 'production',
    ...(doc.testData ? { testData: doc.testData } : {}),
    at,
  };
  return doc;
}

/**
 * 放行前的逐字段绑定校验。任一失败即拒绝；不因 productionApproval=true 而跳过任何一项。
 */
export function validateFormalDecision({
  decision, request, artifact, profileDir, mode = 'production', decisionsRoot,
}) {
  const checks = {};
  const fail = (code, reason) => ({ ok: false, code, reason, checks });

  checks.schema = decision?.schema === FORMAL_SCHEMA;
  if (!checks.schema) return fail('FH_DECISION_SCHEMA', '不是正式决定 schema');

  checks.approvalSource = decision.source === APPROVAL_SOURCE && !!decision.approvedBy;
  if (!checks.approvalSource) return fail('FH_DECISION_SOURCE', '决定不是由审批端点生成或缺少审批主体');

  checks.statusActive = decision.status === 'active' && decision.invalidated !== true;
  if (!checks.statusActive) return fail('FH_DECISION_INACTIVE', '决定已失效或被撤销');

  if (mode === 'production') {
    checks.productionApproval = decision.productionApproval === true && !isTestData(decision);
    if (!checks.productionApproval) return fail('FH_DECISION_SIMULATED', '生产路径缺少真实批准');
    try { assertNotTestData(decision); checks.notTestData = true; }
    catch { return fail('FH_DECISION_TEST_DATA', '生产门拒绝该决定'); }
  } else {
    checks.testDecision = isTestData(decision) === true;
    let rejected = false;
    try { assertNotTestData(decision); } catch { rejected = true; }
    checks.productionGateRejectsTestDecision = rejected;
    if (!checks.testDecision || !rejected) {
      return fail('FH_DECISION_ISOLATION', '隔离模式必须使用测试决定且生产门实测拒绝');
    }
  }

  // 决定必须真实存在于受管 decisionsRoot，且内容一致（防止任意文件通用放行）
  const storedPath = decisionsRoot
    ? join(decisionsRoot, `${decision.id}.json`) : null;
  checks.decisionFilePresent = !!storedPath && existsSync(storedPath);
  if (!checks.decisionFilePresent) return fail('FH_DECISION_NOT_STORED', '决定不在受管决定目录');
  const stored = JSON.parse(readFileSync(storedPath, 'utf8'));
  checks.storedIdentityMatches = stored.bindingFingerprint === decision.bindingFingerprint
    && stored.requestId === decision.requestId;
  if (!checks.storedIdentityMatches) return fail('FH_DECISION_MISMATCH', '决定文件与传入决定不一致');

  // 逐字段绑定（最关键：任何一项对不上都拒绝）
  const b = decision.binding ?? {};
  checks.bindingComplete = !!(b.artifactPath && b.contentHash && b.targetProfile
    && decision.bindingFingerprint);
  if (!checks.bindingComplete) return fail('FH_DECISION_UNBOUND', '决定未绑定制品/目标范围');
  checks.requestIdMatches = decision.requestId === request?.requestId;
  checks.pluginMatches = decision.pluginId === (request?.pluginId ?? request?.packageName)
    && decision.packageName === request?.packageName;
  checks.versionMatches = decision.version === request?.version;
  checks.specMatches = decision.spec === request?.spec;
  checks.artifactPathMatches = samePath(b.artifactPath, artifact?.artifactPath);
  checks.contentHashMatches = b.contentHash === artifact?.contentHash
    && (!b.packageIntegrity || (b.packageIntegrity===artifact?.packageIntegrity && b.runtimeContentHash===artifact?.runtimeContentHash));
  checks.targetProfileMatches = samePath(b.targetProfile, String(profileDir ?? ''));
  checks.sourceMatches = b.source ? stable(b.source)===stable({upstreamUrl:request?.source?.upstreamUrl,pinnedCommit:request?.source?.pinnedCommit,subdir:request?.source?.subdir}) : !request?.source?.subdir;
  checks.fingerprintMatches = fingerprint(decision) === decision.bindingFingerprint;
  const bindingKeys = ['requestIdMatches', 'pluginMatches', 'versionMatches', 'specMatches',
    'sourceMatches', 'artifactPathMatches', 'contentHashMatches', 'targetProfileMatches', 'fingerprintMatches'];
  if (bindingKeys.some((k) => checks[k] !== true)) {
    return fail('FH_DECISION_BINDING_MISMATCH', `绑定字段不一致：${bindingKeys.filter((k) => !checks[k]).join(', ')}`);
  }

  // 权限范围：不得扩大 grantedScopes；六维授权逐维复算
  checks.scopesBound = !!request?.grantedScopes
    && stable(decision.approvedScopes) === stable(request.grantedScopes)
    && stable(b.grantedScopes) === stable(request.grantedScopes);
  if (!checks.scopesBound) return fail('FH_DECISION_SCOPE_EXPANDED', '批准范围与请求范围不一致');
  const audit = validateAuthorizationGrants(decision.authorization, decision.approvedScopes, {
    loadForm: request?.loadForm ?? 'tool', injectionAssessment: decision.injectionAssessment ?? null,
    // 与创建时同口径复算（决定里已记录是否留胃形态）
    mixedHold: decision.mixedHold === true,
  });
  checks.authorizationValid = Object.values(audit).every((d) => d?.ok !== false)
    && stable(audit) === stable(decision.authorizationAudit);
  if (!checks.authorizationValid) return fail('FH_DECISION_AUTH_INVALID', '六维授权复算不一致');

  return {
    ok: true, code: null, checks,
    decisionView: decision.asLegacyDecision ?? decision,
    note: '正式决定已逐字段绑定具体插件/制品/目标 profile/范围/权限，不构成通用放行依据',
  };
}
