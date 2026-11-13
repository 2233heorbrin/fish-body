/** Existing six-dimensional approval and immutable decision store.
 * Source/review/scope/script-grants are bound together. Static capability hits are
 * investigation leads; persona/memory authorization follows actual reviewed behavior.
 * Production and isolated simulation are explicitly distinguished; old records remain readable.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEMAS, ProbeError, hashOf, atomicJson, readJson,
} from './w4w5-utils.mjs';

export const DECISION_KINDS = Object.freeze([
  'approve', 'reject', 'continue-analysis', 'partial-adaptation',
]);

export const AUTH_DIMENSIONS = Object.freeze([
  'firstHostCodeExecution',
  'toolReplacement',
  'credentialAccess',
  'externalActions',
  'personaMemoryChange',
  'buildScripts',
]);

export const AUTH_DIMENSION_LABELS = Object.freeze({
  firstHostCodeExecution: '首次宿主代码执行',
  toolReplacement: '工具替换',
  credentialAccess: '账号访问',
  externalActions: '对外动作',
  personaMemoryChange: '人格/记忆变更',
  buildScripts: '构建脚本',
});

export const DEC = Object.freeze({
  BAD_KIND: 'DEC_BAD_KIND',
  REVIEW_INCOMPLETE: 'DEC_REVIEW_INCOMPLETE',
  UNKNOWN_NOT_ACCEPTED: 'DEC_UNKNOWN_NOT_ACCEPTED',
  MIXED_HOLD: 'DEC_MIXED_HOLD_IN_STOMACH',
  AUTH_INCOMPLETE: 'DEC_AUTH_INCOMPLETE',
  AUTH_SCOPE_INCONSISTENT: 'DEC_AUTH_SCOPE_INCONSISTENT',
  PARTIAL_PARTS_MISSING: 'DEC_PARTIAL_PARTS_MISSING',
  CONTINUE_NOT_APPROVAL: 'DEC_CONTINUE_NOT_APPROVAL',
  BINDING_MISMATCH: 'DEC_BINDING_MISMATCH',
  TEST_DATA_PRODUCTION: 'DEC_TEST_DATA_NOT_FOR_PRODUCTION',
  REUSED_ID: 'DEC_REUSED_ID',
  BAD_DECISION: 'DEC_BAD_DECISION',
  NOT_APPROVING: 'DEC_NOT_APPROVING',
  // 本轮收口：授权必须真正参与放行（不能只比 detail 数组）
  AUTH_REQUIRED_NOT_GRANTED: 'DEC_AUTH_REQUIRED_NOT_GRANTED',
  AUTH_UNKNOWN_NOT_DEPLOYABLE: 'DEC_AUTH_UNKNOWN_NOT_DEPLOYABLE',
  AUTH_GRANT_WITHOUT_SCOPE: 'DEC_AUTH_GRANT_WITHOUT_SCOPE',
});

const SCOPE_ARRAY_KEYS = ['capabilities', 'replaces', 'credentialScopes'];
const SCOPE_BOOL_KEYS = ['externalSideEffects', 'installScripts'];
const ARRAY_AUTH_DIMS = ['firstHostCodeExecution', 'toolReplacement', 'credentialAccess'];

/**
 * 实际加载形态：宿主是否会加载并执行该插件的代码。
 *   tool / service / ui / bundle / library / unknown → 会执行（unknown 保守按会执行）
 *   data-only → 纯数据/静态资源，宿主不执行其代码
 * 注意：这与「有没有工具能力」完全无关。纯服务、纯 UI 插件 capabilities 可以是 []，
 * 但宿主仍要 import / 挂载，因此仍需要首次宿主代码执行授权。
 */
export const LOAD_FORMS = Object.freeze([
  'tool', 'service', 'ui', 'bundle', 'library', 'data-only', 'unknown',
]);
const HOST_EXECUTES_FORMS = new Set(['tool', 'service', 'ui', 'bundle', 'library', 'unknown']);

export function hostExecutesCode(loadForm) {
  return HOST_EXECUTES_FORMS.has(loadForm ?? 'unknown');
}

/** 加载形态由编排挂到 record 上；缺省保守取 unknown（按宿主会执行处理）。 */
export function deriveLoadForm(record) {
  const value = record?.loadForm;
  return typeof value === 'string' && LOAD_FORMS.includes(value) ? value : 'unknown';
}

/**
 * 「既有授权记录」是否可用于免除本次首次宿主代码执行授权。
 * 必须同时满足：显式 granted、带证据路径、且与当前对象是同一固定提交 + 同一内容哈希。
 * 对象改变（新提交 / 新版本 / 内容漂移）后旧授权不得套用。
 */
export function hasPriorGrant(prior, binding) {
  if (!prior || prior.firstHostCodeExecution !== true) return false;
  if (typeof prior.evidencePath !== 'string' || prior.evidencePath.trim() === '') return false;
  if (!binding) return false;
  if ((prior.subdir??'') !== (binding.subdir??'')) return false;
  if (prior.pinnedCommit && prior.pinnedCommit !== binding.pinnedCommit) return false;
  if (prior.contentHash && prior.contentHash !== binding.contentHash) return false;
  if (!prior.pinnedCommit && !prior.contentHash) return false;
  return true;
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const sortedCopy = (v) => (Array.isArray(v) ? [...v].sort() : []);

function sameArray(a, b) {
  const aa = sortedCopy(a);
  const bb = sortedCopy(b);
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

/**
 * 授权决定的「关键字段」：六维 granted / detail / basis / note。
 * 忽略 label 等固定展示文本；输入既可以是原始 authorization，也可以是
 * 已落库的 decision.authorization，两者算出的指纹必须一致。
 * 该函数供 computeBinding 使用，让「改 granted 也改不动旧决定」成为硬约束。
 */
export function authorizationKeyFields(authorization) {
  const out = {};
  for (const dim of AUTH_DIMENSIONS) {
    const item = authorization?.[dim] ?? {};
    out[dim] = {
      granted: item.granted ?? null,
      detail: Array.isArray(item.detail) ? sortedCopy(item.detail) : (item.detail ?? null),
      basis: typeof item.basis === 'string' ? item.basis : '',
      note: typeof item.note === 'string' ? item.note : '',
      ...(item.dependencies !== undefined ? { dependencies: item.dependencies } : {}),
    };
  }
  return out;
}

/**
 * 决定绑定的「本次准确对象」。scopeFingerprint 把批准范围也绑进来：
 * 只要范围扩大/缩小，旧决定立即失效。
 *
 * 本轮收口新增 authorizationFingerprint：授权决定的关键字段同样是绑定对象，
 * 任何一维 granted/detail/basis/note 被改，旧决定都不能继续套用。
 */
export function computeBinding({
  record, approvedScopes = null, kind, derivedParts = null,
  conclusionContentHash = null, authorization = null,
}) {
  const source = record?.source ?? {};
  const reviewRef = record?.review?.conclusionRef ?? {};
  // 决定类型与部分适配的文件选择也进指纹：两次选不同文件的「部分适配」
  // 不是同一个决定，不能互相套用，也不能被幂等逻辑误判为重复。
  const scope = approvedScopes === null
    ? { kind, derivedParts }
    : { kind, derivedParts, approvedScopes };
  const pinnedCommit = source.pinnedCommit ?? null;
  return {
    requestId: record.id,
    packageName: record.packageName,
    upstreamUrl: source.upstreamUrl ?? null,
    pinnedCommit,
    ...(source.subdir ? {subdir:source.subdir} : {}),
    pinnedCommitIsFull: typeof pinnedCommit === 'string' && /^[0-9a-f]{40}$/i.test(pinnedCommit),
    contentHash: source.contentHash ?? null,
    reviewContentHash: reviewRef.reviewContentHash ?? null,
    conclusionContentHash: conclusionContentHash ?? reviewRef.contentHash ?? null,
    scopeFingerprint: hashOf(scope),
    authorizationFingerprint: authorization === null
      ? null : hashOf(authorizationKeyFields(authorization)),
    // W6-A：授权「依据」也进绑定。改加载形态或既有授权记录 → 旧决定失效。
    // 从 record 读取，保证 createDecision / verifyArtifact / reverifyReady 用的是同一份对象，
    // 不需要给每个调用点新增参数（避免两套判据漂移）。
    loadForm: deriveLoadForm(record),
    priorAuthorizationFingerprint: record?.priorAuthorization
      ? hashOf(record.priorAuthorization) : null,
  };
}

export function compareBinding(approved, actual) {
  const mismatches = [];
  for (const key of Object.keys(approved)) {
    if (approved[key] !== actual[key]) {
      mismatches.push({ field: key, approved: approved[key], actual: actual[key] ?? null });
    }
  }
  return { match: mismatches.length === 0, mismatches };
}

/** 隔离模拟批准的识别与生产门。 */
export function isTestData(decision) {
  const t = decision?.testData;
  return t?.simulated === true && t?.isolationOnly === true && t?.nonProduction === true;
}

export function assertNotTestData(decision) {
  if (isTestData(decision)) {
    throw new ProbeError(DEC.TEST_DATA_PRODUCTION,
      '该决定标记为隔离模拟测试数据（simulated/isolationOnly/nonProduction），禁止用于生产接入');
  }
  if (decision?.productionApproval !== true) {
    throw new ProbeError(DEC.TEST_DATA_PRODUCTION,
      '缺少显式 productionApproval=true 的生产批准标记，拒绝作为生产决定使用');
  }
  return true;
}

function normalizeAuthorization(authorization) {
  const out = {};
  for (const dim of AUTH_DIMENSIONS) {
    const item = authorization[dim];
    out[dim] = {
      label: AUTH_DIMENSION_LABELS[dim],
      granted: item.granted,
      detail: Array.isArray(item.detail) ? sortedCopy(item.detail) : (item.detail ?? null),
      basis: typeof item.basis === 'string' ? item.basis : '',
      note: typeof item.note === 'string' ? item.note : '',
      ...(item.dependencies !== undefined ? { dependencies: item.dependencies } : {}),
    };
  }
  return out;
}

function validateAuthorization(authorization, kind) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new ProbeError(DEC.AUTH_INCOMPLETE, 'authorization 必须是含 6 个维度的对象');
  }
  for (const dim of AUTH_DIMENSIONS) {
    const item = authorization[dim];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProbeError(DEC.AUTH_INCOMPLETE, `缺少授权维度 ${dim}`);
    }
    const g = item.granted;
    if (g !== true && g !== false && g !== 'unknown') {
      throw new ProbeError(DEC.AUTH_INCOMPLETE,
        `${dim}.granted 只能是 true / false / 'unknown'，实际 ${JSON.stringify(g)}`);
    }
    if (ARRAY_AUTH_DIMS.includes(dim) && item.detail !== undefined && !isStringArray(item.detail)) {
      throw new ProbeError(DEC.AUTH_INCOMPLETE, `${dim}.detail 必须是字符串数组`);
    }
    if (g === true && (typeof item.basis !== 'string' || item.basis.trim() === '')) {
      throw new ProbeError(DEC.AUTH_INCOMPLETE, `${dim} 授予 true 必须写明 basis`);
    }
    if (g === true && (kind === 'reject' || kind === 'continue-analysis')) {
      throw new ProbeError(DEC.CONTINUE_NOT_APPROVAL,
        `${kind} 不得授予任何权限；${dim}.granted=true 属于变相批准`);
    }
  }
  const extra = Object.keys(authorization).filter((k) => !AUTH_DIMENSIONS.includes(k));
  if (extra.length > 0) {
    throw new ProbeError(DEC.AUTH_INCOMPLETE, `未知授权维度：${extra.join(', ')}`);
  }
}

function validateApprovedScopesShape(scopes) {
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
    throw new ProbeError(DEC.AUTH_SCOPE_INCONSISTENT, 'approve/partial-adaptation 必须给出 approvedScopes 对象');
  }
  for (const key of SCOPE_ARRAY_KEYS) {
    if (!isStringArray(scopes[key])) {
      throw new ProbeError(DEC.AUTH_SCOPE_INCONSISTENT, `approvedScopes.${key} 必须是字符串数组`);
    }
  }
  for (const key of SCOPE_BOOL_KEYS) {
    if (scopes[key] !== true && scopes[key] !== false) {
      throw new ProbeError(DEC.AUTH_SCOPE_INCONSISTENT, `approvedScopes.${key} 必须是 true/false`);
    }
  }
}

/**
 * 六维授权与准入形状双向绑定，防止「记录说没批准、准入却放行」的漂移。
 */
function validateAuthScopeConsistency(authorization, scopes) {
  const problems = [];
  const checks = [
    ['capabilities', 'firstHostCodeExecution'],
    ['replaces', 'toolReplacement'],
    ['credentialScopes', 'credentialAccess'],
  ];
  for (const [scopeKey, dim] of checks) {
    if (!sameArray(scopes[scopeKey], authorization[dim].detail ?? [])) {
      problems.push(`approvedScopes.${scopeKey} 与 authorization.${dim}.detail 不一致`);
    }
  }
  if (scopes.externalSideEffects !== (authorization.externalActions.granted === true)) {
    problems.push('approvedScopes.externalSideEffects 与 authorization.externalActions 不一致');
  }
  if (scopes.installScripts !== (authorization.buildScripts.granted === true)) {
    problems.push('approvedScopes.installScripts 与 authorization.buildScripts 不一致');
  }
  if (problems.length > 0) {
    throw new ProbeError(DEC.AUTH_SCOPE_INCONSISTENT, problems.join('；'), { problems });
  }
}

/**
 * 「实际申请范围 + 实际加载形态 + 既有授权记录」→「所需授权维度」的推导。
 * 来源只能是产物/批准范围声明、审查结论的注入评估、加载形态与既有授权记录，
 * 不能由 granted 反推，否则就成了「授权自己证明自己」。
 *
 * W6-A：firstHostCodeExecution 不再看 capabilities 数量。
 *   - 宿主会执行代码的加载形态（tool/service/ui/bundle/library/unknown）→ 必需；
 *   - 只有 data-only（纯数据、宿主不执行代码）→ 不必需；
 *   - 同一对象此前已显式授权且带证据 → 本次不必重复索取（priorGrantApplied）。
 */
export function requiredAuthorization(scopes, context = {}) {
  const {
    injectionAssessment = null,
    loadForm = 'unknown',
    priorAuthorization = null,
    binding = null,
    mixedHold = false,
  } = context ?? {};
  const priorGrantApplied = hasPriorGrant(priorAuthorization, binding);
  return {
    firstHostCodeExecution: hostExecutesCode(loadForm) && !priorGrantApplied,
    toolReplacement: scopes.replaces.length > 0,
    credentialAccess: scopes.credentialScopes.length > 0,
    externalActions: scopes.externalSideEffects === true,
    // 留胃形态（W3 判定为混合）本意就是「可能改变人格/记忆」，
    // 因此这一维对留胃对象**始终必需**：要装就得出具显式授权，不能默认放行。
    personaMemoryChange: scopes.personaMemoryChange === true
      || injectionAssessment?.personaInjection === true
      || injectionAssessment?.memoryInjection === true,
    buildScripts: scopes.installScripts === true,
  };
}

/**
 * 本轮收口①：授权必须真正参与放行。
 *
 * 原有 validateAuthScopeConsistency 只比对 detail 数组与 scopes 形状，
 * 因此「capabilities 非空但 firstHostCodeExecution.granted=false」仍会生成
 * wholePackageApproved=true 的可部署批准。本函数补上 granted 与申请范围的核对：
 *   - 任一维 granted='unknown'：授权未定，不得生成可部署批准；
 *   - 申请范围所必需的维度 granted!==true：所需授权缺失，拒绝；
 *   - 无对应申请项却 granted=true：无依据多授予，拒绝。
 *
 * 返回逐维 audit 供决定落库，便于事后核对「授权确实参与过放行」。
 */
export function validateAuthorizationGrants(authorization, scopes, context = null) {
  // 兼容旧调用：第三参数过去直接传 injectionAssessment（含 personaInjection/memoryInjection）。
  // 现在传 { injectionAssessment, loadForm, priorAuthorization, binding }。
  const opts = (context && typeof context === 'object'
    && ('loadForm' in context || 'priorAuthorization' in context
      || 'binding' in context || 'injectionAssessment' in context
      || 'mixedHold' in context))
    ? context
    : { injectionAssessment: context };
  const {
    injectionAssessment = null,
    loadForm = 'unknown',
    priorAuthorization = null,
    binding = null,
    mixedHold = false,
  } = opts;
  const required = requiredAuthorization(scopes, {
    injectionAssessment, loadForm, priorAuthorization, binding, mixedHold,
  });
  const priorGrantApplied = hasPriorGrant(priorAuthorization, binding);
  const audit = {};
  const problems = [];
  for (const dim of AUTH_DIMENSIONS) {
    const item = authorization[dim];
    const g = item.granted;
    const need = required[dim] === true;
    audit[dim] = { label: AUTH_DIMENSION_LABELS[dim], required: need, granted: g };
    if (dim === 'firstHostCodeExecution') {
      // 把「依据加载形态 + 既有授权记录」写成可审计字段，明确不是按 capabilities 数量判定。
      audit[dim].loadForm = loadForm;
      audit[dim].hostExecutesCode = hostExecutesCode(loadForm);
      audit[dim].priorGrantApplied = priorGrantApplied;
      audit[dim].capabilitiesCount = scopes.capabilities.length;
      audit[dim].basisKind = 'load-form + prior-authorization (not capability-count)';
    }
    if (g === 'unknown') {
      problems.push(`${AUTH_DIMENSION_LABELS[dim]}（${dim}）授权未定（granted='unknown'），不得生成可部署批准`);
      continue;
    }
    if (need && g !== true) {
      problems.push(`${AUTH_DIMENSION_LABELS[dim]}（${dim}）为实际申请范围所必需，但 granted=${g}`);
    }
    if (!need && g === true && dim !== 'personaMemoryChange') {
      problems.push(`${AUTH_DIMENSION_LABELS[dim]}（${dim}）授予 true，但批准范围无对应申请项（无依据多授予）`);
    }
  }
  if (problems.length > 0) {
    const code = problems.some((p) => p.includes('授权未定'))
      ? DEC.AUTH_UNKNOWN_NOT_DEPLOYABLE
      : (problems.some((p) => p.includes('所必需'))
        ? DEC.AUTH_REQUIRED_NOT_GRANTED : DEC.AUTH_GRANT_WITHOUT_SCOPE);
    throw new ProbeError(code, problems.join('；'), { audit, problems });
  }
  return audit;
}

function normalizeScopes(s) {
  return {
    capabilities: sortedCopy(s.capabilities),
    replaces: sortedCopy(s.replaces),
    credentialScopes: sortedCopy(s.credentialScopes),
    externalSideEffects: s.externalSideEffects === true,
    installScripts: s.installScripts === true,
    ...(s.personaMemoryChange!==undefined?{personaMemoryChange:s.personaMemoryChange===true}:{}),
  };
}

/** 构造一份决定（纯构造 + 校验，不落库）。 */
export function createDecision({
  record, conclusion, kind, authorization, approvedScopes = null,
  derivedParts = null, note = '', at, productionApproval = false,
}) {
  if (!record || !DECISION_KINDS.includes(kind)) {
    throw new ProbeError(DEC.BAD_KIND,
      `未知决定类型 ${String(kind)}；允许：${DECISION_KINDS.join(' / ')}`);
  }

  // ① 批准不能代替内容审查
  if (record.review?.complete !== true || !record.review?.conclusionRef) {
    throw new ProbeError(DEC.REVIEW_INCOMPLETE,
      '审查未完成或缺少独立审查结论；必须先完成内容审查，批准不能代替审查');
  }
  if (!conclusion?.doc || ![SCHEMAS.CONCLUSION, 'stomach-review-conclusion/v1'].includes(conclusion.doc.schema)
    || !conclusion.path || !conclusion.contentHash) {
    throw new ProbeError(DEC.REVIEW_INCOMPLETE,
      '缺少有效审查结论文档（批准不能代替内容审查）');
  }
  if (conclusion.doc.unknownsUnchanged !== true || conclusion.doc.authorizationSeparate !== true) {
    throw new ProbeError(DEC.REVIEW_INCOMPLETE,
      '审查结论必须声明 unknowns 未被改写、且不含用户授权');
  }

  // ② unknown 处置由审查结论给出；决定本身不改任何 unknown
  const unknowns = Array.isArray(record.review.unknowns) ? record.review.unknowns : [];
  const accepted = Array.isArray(record.review.acceptedUnknowns) ? record.review.acceptedUnknowns : [];
  const open = unknowns.filter((u) => !accepted.includes(u));
  if (open.length > 0) {
    throw new ProbeError(DEC.UNKNOWN_NOT_ACCEPTED,
      `仍有未显式处置的 unknown：${open.join(', ')}；不得靠批准把 unknown 改成 false`,
      { open });
  }

  // ③ 混合形态留胃的本意是「不得静默改变人格/记忆」，不是「永远不许装」：
  //    留胃对象整包批准时，必须显式授权「人格/记忆变更」这一维；没给就仍然拒绝。


  validateAuthorization(authorization, kind);

  let scopes = null;
  let wholePackageApproved = false;
  let authorizationAudit = null;
  if (kind === 'approve' || kind === 'partial-adaptation') {
    // 顺序有意义：先做原有形状一致性检查（保留 AUTH_SCOPE_INCONSISTENT 的错误码优先级），
    // 再核对 granted 与「实际申请范围」，最后才允许生成可部署批准。
    validateApprovedScopesShape(approvedScopes);
    validateAuthScopeConsistency(authorization, approvedScopes);
    scopes = normalizeScopes(approvedScopes);
    // W6-A：首次宿主代码执行的必需性由加载形态 + 既有授权记录判定，
    // 与 approvedScopes.capabilities 的数量无关。prior 必须绑定同一对象才生效。
    const loadForm = deriveLoadForm(record);
    const priorAuthorization = record?.priorAuthorization ?? null;
    const priorBindingProbe = {
      pinnedCommit: record?.source?.pinnedCommit ?? null,
      subdir: record?.source?.subdir ?? '',
      contentHash: record?.source?.contentHash ?? null,
    };
    authorizationAudit = validateAuthorizationGrants(authorization, scopes, {
      injectionAssessment: conclusion?.doc?.conclusion?.injectionAssessment ?? null,
      loadForm, priorAuthorization, binding: priorBindingProbe,
      // 留胃对象：人格/记忆维必需，缺授权不放行
      mixedHold: record.holdInStomach === true,
    });
    wholePackageApproved = kind === 'approve';
  }

  let parts = null;
  if (kind === 'partial-adaptation') {
    const files = derivedParts?.selectedFiles;
    if (!isStringArray(files) || files.length === 0 || files.some((f) => f.trim() === '')) {
      throw new ProbeError(DEC.PARTIAL_PARTS_MISSING,
        'partial-adaptation 必须给出非空 selectedFiles（字符串数组）');
    }
    if (files.some((f) => f.includes('..') || f.startsWith('/') || /^[A-Za-z]:/.test(f))) {
      throw new ProbeError(DEC.PARTIAL_PARTS_MISSING,
        'selectedFiles 不得含路径穿越或绝对路径');
    }
    parts = {
      selectedFiles: sortedCopy(files),
      excludedFiles: isStringArray(derivedParts.excludedFiles)
        ? sortedCopy(derivedParts.excludedFiles) : [],
      reason: typeof derivedParts.reason === 'string' ? derivedParts.reason : '',
    };
  }

  const binding = computeBinding({
    record, approvedScopes: scopes, kind, derivedParts: parts,
    conclusionContentHash: conclusion.contentHash,
    authorization,
  });
  const id = `dec-${record.id}-${hashOf({ requestId: record.id, kind, binding }).slice(7, 19)}`;

  return {
    schema: productionApproval?'hand-decision/v1':SCHEMAS.DECISION,
    id,
    requestId: record.id,
    kind,
    at: at ?? new Date().toISOString(),
    binding,
    bindingFingerprint: hashOf(binding),
    authorization: normalizeAuthorization(authorization),
    // 逐维核对结果：证明 granted 确实参与了本次放行，不是只比了 detail 数组
    authorizationAudit,
    approvedScopes: scopes,
    review: {
      reviewPath: record.stomach?.reviewPath ?? null,
      conclusionPath: conclusion.path,
      conclusionContentHash: conclusion.contentHash,
      unknownsSnapshot: [...unknowns],
      acceptedUnknowns: [...accepted],
      unknownsUnchanged: true,
    },
    wholePackageApproved,
    derivedParts: parts,
    // 生产决定：由审批端点（真实审批主体）生成，不带 testData 标记，显式 productionApproval=true。
    // 隔离回归保持默认模拟标记；生产门 assertNotTestData 仍会逐条拒绝模拟决定。
    ...(productionApproval === true
      ? { productionApproval: true }
      : {
        testData: {
          simulated: true,
          isolationOnly: true,
          nonProduction: true,
          note: '隔离测试中的模拟批准；不得导入生产注册表。生产接入需显式 productionApproval=true 且通过 assertNotTestData()',
        },
      }),
    note,
    status: 'active',
  };
}

/**
 * 决定存储：一个决定一个 JSON 文件，原子写；索引只追加，不覆盖。
 * 失效采用 append 一个 `<id>.invalidated.json`，不改原决定文件。
 */
export class DecisionStore {
  constructor(root) {
    this.dir = join(root, 'decisions');
    this.indexPath = join(this.dir, 'index.json');
    mkdirSync(this.dir, { recursive: true });
  }

  pathOf(id) { return join(this.dir, `${id}.json`); }

  save(decision) {
    const p = this.pathOf(decision.id);
    if (existsSync(p)) {
      throw new ProbeError(DEC.REUSED_ID, `决定 ${decision.id} 已存在，拒绝覆盖`);
    }
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(decision, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
    let index = { schema: 'hand-decision-index/v1', at: null, rows: [] };
    if (existsSync(this.indexPath)) index = readJson(this.indexPath);
    if (!Array.isArray(index.rows)) index.rows = [];
    if (!index.rows.some((r) => r.id === decision.id)) {
      index.rows.push({
        id: decision.id, requestId: decision.requestId, kind: decision.kind,
        at: decision.at, bindingFingerprint: decision.bindingFingerprint,
        status: decision.status, testData: decision.productionApproval !== true,
      });
    }
    index.at = new Date().toISOString();
    atomicJson(this.indexPath, index);
    return decision;
  }

  load(id) {
    const p = this.pathOf(id);
    return existsSync(p) ? readJson(p) : null;
  }

  list() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.endsWith('.invalidated.json'))
      .map((f) => readJson(join(this.dir, f)));
  }

  findByRequest(requestId) {
    return this.list().filter((d) => d.requestId === requestId);
  }

  findSame({ requestId, kind, bindingFingerprint }) {
    return this.findByRequest(requestId)
      .find((d) => d.kind === kind && d.bindingFingerprint === bindingFingerprint) ?? null;
  }

  invalidatedPath(id) { return join(this.dir, `${id}.invalidated.json`); }
  isInvalidated(id) { return existsSync(this.invalidatedPath(id)); }

  /** 追加失效记录，绝不覆盖或删除原决定。 */
  invalidate(id, reason) {
    const decision = this.load(id);
    if (!decision) return null;
    const path = this.invalidatedPath(id);
    if (!existsSync(path)) {
      atomicJson(path, {
        schema: 'hand-decision-invalidation/v1',
        decisionId: id,
        requestId: decision.requestId,
        at: new Date().toISOString(),
        reason,
        originalStatus: decision.status,
        note: '原决定文件保留不动；本文件只追加失效事实',
      });
    }
    return path;
  }
}

/** W4 给 W5 用的决定状态检查。 */
export function assertUsableForArtifact(decision, store) {
  if (!decision || ![SCHEMAS.DECISION, 'hand-decision/v1'].includes(decision.schema)) {
    throw new ProbeError(DEC.BAD_DECISION, '缺少有效决定');
  }
  if (decision.status !== 'active' || (store && store.isInvalidated(decision.id))) {
    throw new ProbeError(DEC.BAD_DECISION, `决定 ${decision.id} 已失效，不得继续构建产物`);
  }
  if (!['approve', 'partial-adaptation'].includes(decision.kind)) {
    throw new ProbeError(DEC.NOT_APPROVING,
      `决定类型 ${decision.kind} 不构成产物构建授权（拒绝 / 继续分析都不等于批准）`);
  }
  return true;
}
