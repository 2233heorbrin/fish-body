/**
 * 准入判定库（隔离实现，不接生产）
 *
 * 设计依据：工作块插件统一接入-技术设计.md §3「准入判定顺序」。
 * 纯函数、无 IO、无副作用，便于单测覆盖。
 *
 * 核心约束（来自已确认的产品决策与上一轮结论）：
 *   1. 同来源不能单独放行 —— 来源只在 Step4「已批准能力集合」可复用时起作用，
 *      Step1~3（版本 / 完整性 / 依赖面）每次都必须重算。
 *   2. 固定 commit / 固定 hash 不等于批准 —— 它们只满足「可定位到已审对象」，
 *      仍必须在 registry 里有该对象对应的 approved 记录。
 *   3. 旧版兼容只针对「明确登记的既有记录」（legacy === true 且显式登记了判定所需字段）；
 *      未知插件不能因字段缺省而被当成「没有该能力」放行。
 *   4. 未经审查的信息一律 unknown，unknown 不得当作 false 处理。
 */

export const ADM = Object.freeze({
  OK: null,
  SPEC_UNPINNED: 'ADM_SPEC_UNPINNED',
  SPEC_GIT_UNPINNED: 'ADM_SPEC_GIT_UNPINNED',
  SPEC_LOCAL_DISALLOWED: 'ADM_SPEC_LOCAL_DISALLOWED',
  NO_APPROVAL: 'ADM_NO_APPROVAL',
  VERSION_MISMATCH: 'ADM_VERSION_MISMATCH',
  HASH_MISMATCH: 'ADM_HASH_MISMATCH',
  HASH_UNAVAILABLE: 'ADM_HASH_UNAVAILABLE',
  DEPS_CHANGED: 'ADM_DEPS_CHANGED',
  DEPS_UNKNOWN: 'ADM_DEPS_UNKNOWN',
  LOCK_SUBTREE_MISSING: 'ADM_LOCK_SUBTREE_MISSING',
  FIELD_INVALID: 'ADM_FIELD_INVALID',
  SCOPE_EXPANDED: 'ADM_SCOPE_EXPANDED',
  SCOPE_UNKNOWN: 'ADM_SCOPE_UNKNOWN',
  INJECTION_UNKNOWN: 'ADM_INJECTION_UNKNOWN',
  INJECTION_REVIEW_UNVERIFIED: 'ADM_INJECTION_REVIEW_UNVERIFIED',
  SCRIPTS_UNAPPROVED: 'ADM_SCRIPTS_UNAPPROVED',
  LEGACY_UNVERIFIED: 'ADM_LEGACY_UNVERIFIED',
});

/** 需要「另行确认」的范围项：任何新增都构成范围扩大。 */
const SCOPE_KEYS = ['capabilities', 'replaces', 'credentialScopes'];
/** 布尔型范围项：true 必须被显式批准。 */
const BOOL_SCOPE_KEYS = ['externalSideEffects', 'installScripts'];
/** 注入类范围项：false 才算「已审查且确认没有」；缺省/unknown 一律不放行。 */
const INJECTION_KEYS = ['personaInjection', 'memoryInjection'];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEX_COMMIT = /^[0-9a-f]{7,40}$/i;
const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * 解析安装 spec，归一化成可直接判定的形态。
 * 解析不出的形态一律视为「未固定」，不放行。
 */
export function parseSpec(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { raw: raw ?? '', kind: 'invalid', pinned: false, reason: '空 spec' };
  }
  const text = raw.trim();

  if (text.startsWith('file:') || text.startsWith('.') || /^[A-Za-z]:[\\/]/.test(text)) {
    const tail = text.replace(/^file:/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    const guess = tail.replace(/-\d+\.\d+\.\d+.*$/, '');
    return { raw: text, kind: 'file', pinned: true, name: guess || null, version: null,
      reason: '本地路径，仅隔离测试允许' };
  }

  if (text.startsWith('git+') || /^https?:\/\/.*\.git(?:#|$)/.test(text) || text.startsWith('github:')) {
    const hashIndex = text.indexOf('#');
    const commit = hashIndex >= 0 ? text.slice(hashIndex + 1) : '';
    const repo = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
    return {
      raw: text,
      kind: 'git',
      repo,
      commit: commit || null,
      // 只有 7~40 位 hex 才算固定提交；分支名、tag、语义化范围都不算
      pinned: HEX_COMMIT.test(commit),
      name: nameFromRepo(repo),
      version: null,
      reason: HEX_COMMIT.test(commit) ? '固定提交' : '未固定提交（分支/tag/缺省）',
    };
  }

  if (/^https?:\/\//.test(text) || text.endsWith('.tgz') || text.endsWith('.tar.gz')) {
    return { raw: text, kind: 'tarball', pinned: true, name: nameFromTarball(text), version: null,
      reason: 'tarball，需 integrity 才能判完整性' };
  }

  // npm 规格：name 或 name@range
  const at = text.lastIndexOf('@');
  const hasScope = text.startsWith('@');
  let name = text;
  let version = null;
  if (at > 0 && !(hasScope && at === text.indexOf('@'))) {
    name = text.slice(0, at);
    version = text.slice(at + 1) || null;
  }
  const pinned = version !== null && EXACT_VERSION.test(version);
  return {
    raw: text, kind: 'npm', name, version,
    pinned,
    reason: pinned ? '精确版本' : (version === null ? '未指定版本（等价 latest）' : `范围/浮动版本 ${version}`),
  };
}

function nameFromRepo(repo) {
  const cleaned = repo.replace(/^git\+/, '').replace(/^github:/, '').replace(/\.git$/, '').replace(/\/$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 1] : cleaned;
}

function nameFromTarball(url) {
  const file = url.split('/').pop() ?? '';
  const m = file.match(/^(.*?)-\d+\.\d+\.\d+/);
  return m ? m[1] : file.replace(/\.(tgz|tar\.gz)$/, '');
}

/* ------------------------------------------------------------------ *
 * 严格字段读取
 *
 * 教训（GPT 复现的缺陷）：不能用「宽松转数组 / 宽松转布尔」来读安全字段。
 *   - asArray(undefined) → [] 会让「未声明」变成「没有」，直接放行；
 *   - `shipped === true` 判断会让 "unknown" / null / 0 全部漏过。
 * 旧版这里曾有 asArray / isReviewed / isUnknown 三个宽松 helper，
 * 已全部删除——它们正是缺陷来源，留着会被下一个改动重新用上。
 * ------------------------------------------------------------------ */

const ABSENT = 'absent';
const OK = 'ok';
const INVALID = 'invalid';

/** 严格读取字符串数组字段。 */
function readStringArrayField(obj, key) {
  if (!obj || typeof obj !== 'object') return { status: ABSENT };
  if (!Object.hasOwn(obj, key)) return { status: ABSENT };
  const value = obj[key];
  if (value === undefined) return { status: ABSENT };
  if (!Array.isArray(value)) {
    return { status: INVALID, detail: `应为字符串数组，实际 ${describeType(value)}` };
  }
  const bad = value.filter((item) => typeof item !== 'string');
  if (bad.length > 0) {
    return { status: INVALID, detail: `数组含 ${bad.length} 个非字符串元素（首个：${describeType(bad[0])}）` };
  }
  return { status: OK, value: [...value] };
}

/** 严格读取布尔字段：只接受 true / false。 */
function readBooleanField(obj, key) {
  if (!obj || typeof obj !== 'object') return { status: ABSENT };
  if (!Object.hasOwn(obj, key)) return { status: ABSENT };
  const value = obj[key];
  if (value === undefined) return { status: ABSENT };
  if (value === true || value === false) return { status: OK, value };
  return { status: INVALID, detail: `只接受 true/false，实际 ${describeType(value)}` };
}

/** 严格读取非空字符串（用于哈希）。null 视作「未提供」，非字符串视作非法。 */
function readHashField(obj, key) {
  if (!obj || typeof obj !== 'object') return { status: ABSENT };
  const value = obj?.[key];
  if (value === undefined || value === null) return { status: ABSENT };
  if (typeof value !== 'string' || value.trim() === '') {
    return { status: INVALID, detail: `应为非空字符串，实际 ${describeType(value)}` };
  }
  return { status: OK, value };
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${JSON.stringify(value.slice(0, 24))})`;
  return `${typeof value}(${String(value).slice(0, 16)})`;
}

/**
 * Step4 的「已授予范围」部分（独立导出，供 W4/W5 复用）。
 *
 * 为什么单独抽出来：
 *   - 安装准入 evaluate() 的 Step2/Step3 需要 dist.integrity / lockSubtree，
 *     那是 W6 部署时才存在的证据。W4/W5 阶段不安装、不解析依赖，不能伪造这些值过关。
 *   - 因此 W4/W5 只用本函数判定「批准范围是否覆盖产物声明」，把完整性与
 *     依赖解析、注入面明确标为 unknown / deferred，而不是写成通过。
 *   - 同一判据只有一个实现：evaluate() 的 Step4 也调用本函数，避免两套规则漂移。
 *
 * 边界：只判定 SCOPE_KEYS / BOOL_SCOPE_KEYS 与安装脚本；
 *   **不包含** INJECTION_KEYS（人格/记忆注入面在 W4/W5 保持 unknown，
 *   静态扫描不能证明「没有注入」，批准按钮更不能把它改判成 false）。
 *
 * manifest 的授权范围字段语义是「本次授予的边界」，不是「对插件的事实断言」：
 *   externalSideEffects=false 表示「本次不授予对外动作」，不等于认定插件没有该能力。
 *
 * @returns {{ok:boolean, code:string|null, reason:string, pendingScopes:string[], unknownFields:string[]}}
 */
export function evaluateGrantedScope({ manifest, scope, approvedScopes = {}, packageJson = null }) {
  const surface = scope ?? manifest;
  const unknownFields = [];
  const fail = (code, reason, pending = []) => ({
    ok: false, code, reason, pendingScopes: pending, unknownFields,
  });

  for (const key of SCOPE_KEYS) {
    const shippedField = readStringArrayField(surface, key);
    if (shippedField.status === INVALID) {
      return fail(ADM.FIELD_INVALID, `manifest.${key} 非法：${shippedField.detail}`);
    }
    const approvedField = readStringArrayField(approvedScopes, key);
    if (approvedField.status === INVALID) {
      return fail(ADM.FIELD_INVALID, `注册表 approvedScopes.${key} 非法：${approvedField.detail}`);
    }
    if (shippedField.status === ABSENT) { unknownFields.push(key); continue; }
    const approvedList = approvedField.status === OK ? approvedField.value : [];
    const added = shippedField.value.filter((item) => !approvedList.includes(item));
    if (added.length > 0) {
      return fail(ADM.SCOPE_EXPANDED, `${key} 新增未批准项：${added.join(', ')}`,
        added.map((v) => `${key}:${v}`));
    }
  }

  for (const key of BOOL_SCOPE_KEYS) {
    const field = readBooleanField(surface, key);
    if (field.status === INVALID) {
      return fail(ADM.FIELD_INVALID, `manifest.${key} 非法：${field.detail}`);
    }
    if (field.status === ABSENT) { unknownFields.push(key); continue; }
    const approvedField = readBooleanField(approvedScopes, key);
    if (approvedField.status === INVALID) {
      return fail(ADM.FIELD_INVALID, `注册表 approvedScopes.${key} 非法：${approvedField.detail}`);
    }
    if (field.value === true && approvedField.value !== true) {
      const code = key === 'installScripts' ? ADM.SCRIPTS_UNAPPROVED : ADM.SCOPE_EXPANDED;
      return fail(code, `${key} 为 true 但未被批准`, [`${key}:true`]);
    }
  }

  // 脚本检测：即使 manifest 说没有，package.json 里有也必须拦
  const scripts = packageJson?.scripts ?? {};
  const foundScripts = INSTALL_SCRIPT_KEYS.filter((k) => typeof scripts[k] === 'string');
  if (foundScripts.length > 0 && approvedScopes.installScripts !== true) {
    return fail(ADM.SCRIPTS_UNAPPROVED,
      `包内含安装脚本（${foundScripts.join(', ')}）但未获批准`,
      foundScripts.map((s) => `installScripts:${s}`));
  }

  // ok=true 只表示「没有范围扩大、字段合法」。字段缺省（unknownFields）
  // 交给调用方处置：evaluate() 会在 INJECTION 检查之后统一用 ADM_SCOPE_UNKNOWN 拒绝，
  // 以保持原有错误码优先级；W4/W5 则把缺省视为「授权不满足」，不伪造通过。
  return {
    ok: true,
    code: null,
    reason: '授权范围未扩大',
    pendingScopes: [],
    unknownFields,
  };
}

/**
 * 主判定函数。
 *
 * @param {object} input
 * @param {string} input.spec            安装规格原文（如 'pkg@1.2.3'、'git+https://...#sha'）
 * @param {object} input.registry        手侧注册表 { plugins: { [name]: record } }
 * @param {object} [input.manifest]      artifact manifest（来自手的插件仓）
 * @param {object} [input.lockSubtree]   实际依赖解析结果 { packages: string[], sha256?: string }
 * @param {object} [input.packageJson]   待装包的 package.json（用于脚本检测，可选）
 * @param {object} [input.options]
 * @param {boolean} [input.options.allowLocalFile] 是否允许本地路径（仅隔离测试）
 * @param {string}  [input.options.integrity]      安装侧给出的完整性值（pnpm dist.integrity）
 */
export function evaluate(input) {
  const {
    spec: rawSpec,
    registry,
    manifest = null,
    lockSubtree = null,
    packageJson = null,
    options = {},
  } = input ?? {};

  const trace = [];
  const spec = parseSpec(rawSpec);
  if(spec.kind==='file' && options.packageName) spec.name=options.packageName;
  const plugins = registry?.plugins ?? {};
  const record = spec.name ? plugins[spec.name] : undefined;
  const legacy = record?.legacy === true;

  const reject = (step, code, reason, extra = {}) => {
    trace.push({ step, ok: false, code });
    return {
      allow: false,
      code,
      reason,
      step,
      spec,
      pendingScopes: extra.pendingScopes ?? [],
      requiresRestart: false,
      unknown: extra.unknown ?? [],
      trace,
    };
  };
  const pass = (step, note) => trace.push({ step, ok: true, code: null, note });

  // ---------- Step 0：固定审查对象与安装内容 ----------
  if (spec.kind === 'invalid') {
    return reject(0, ADM.SPEC_UNPINNED, '无法解析的安装规格');
  }
  if (spec.kind === 'file' && options.allowLocalFile !== true) {
    return reject(0, ADM.SPEC_LOCAL_DISALLOWED, '本地路径安装不属于正式入口，禁止放行');
  }
  if (spec.kind === 'git' && !spec.pinned) {
    return reject(0, ADM.SPEC_GIT_UNPINNED, `git 规格未固定到提交：${spec.reason}`);
  }
  if (spec.kind === 'npm' && !spec.pinned) {
    return reject(0, ADM.SPEC_UNPINNED, `版本未固定：${spec.reason}`);
  }
  if (!record) {
    // 固定 commit / hash 只解决「可定位」，不解决「已批准」
    return reject(0, ADM.NO_APPROVAL,
      `注册表中没有 ${spec.name ?? spec.raw} 的批准记录；固定提交或固定哈希不等于批准`);
  }
  if (record.state === 'rejected') {
    return reject(0, ADM.NO_APPROVAL, `该插件在注册表中已被标记为 rejected`);
  }
  pass(0, `spec=${spec.kind}；已登记于注册表（state=${record.state ?? '未知'}）`);

  // ---------- Step 1：版本一致 ----------
  const approvedVersion = record.approvedVersion ?? null;
  if (spec.kind === 'git') {
    if (!record.approvedCommit || record.approvedCommit.toLowerCase() !== spec.commit.toLowerCase()) {
      return reject(1, ADM.VERSION_MISMATCH,
        `提交未获批准：spec=${spec.commit}；已批准=${record.approvedCommit ?? '无'}`);
    }
  } else if (spec.kind === 'npm') {
    if (!approvedVersion) {
      return reject(1, ADM.NO_APPROVAL, '注册表缺少 approvedVersion，无法证明版本一致性');
    }
    if (spec.version !== approvedVersion) {
      return reject(1, ADM.VERSION_MISMATCH, `版本不一致：spec=${spec.version}；已批准=${approvedVersion}`);
    }
  }
  pass(1, `版本一致：${spec.kind === 'git' ? spec.commit : (spec.version ?? approvedVersion)}`);

  // ---------- Step 2：完整性一致 ----------
  const expectedHash = record.artifact?.contentHash ?? null;
  const actualHash = options.integrity ?? manifest?.contentHash ?? lockSubtree?.integrity ?? null;
  if (!expectedHash) {
    return reject(2, ADM.NO_APPROVAL, '注册表未登记 contentHash，无法证明装的就是审过的内容');
  }
  if (!actualHash) {
    return reject(2, ADM.HASH_UNAVAILABLE, '安装侧与 manifest 都没有可复算的完整性值');
  }
  if (String(expectedHash) !== String(actualHash)) {
    return reject(2, ADM.HASH_MISMATCH, `完整性不一致：实际=${actualHash}；已批准=${expectedHash}`);
  }
  pass(2, 'contentHash 一致');

  // ---------- Step 3：依赖面一致 ----------
  const approvedScopes = record.approvedScopes ?? {};

  const approvedDepsField = readStringArrayField(approvedScopes, 'dependencies');
  if (approvedDepsField.status === INVALID) {
    return reject(3, ADM.FIELD_INVALID, `注册表 approvedScopes.dependencies 非法：${approvedDepsField.detail}`);
  }
  const approvedDeps = approvedDepsField.status === OK ? approvedDepsField.value : [];

  const depField = readStringArrayField(manifest, 'dependencies');
  if (depField.status === INVALID) {
    return reject(3, ADM.FIELD_INVALID, `manifest.dependencies 非法：${depField.detail}`);
  }
  if (depField.status === ABSENT) {
    if (!legacy) {
      // 缺省 = unknown，不能当作「没有依赖」放行
      return reject(3, ADM.DEPS_UNKNOWN, 'manifest 未声明 dependencies，依赖面为 unknown');
    }
    pass(3, 'legacy 记录：依赖面按 v1 语义（无声明即视为已登记基线）');
  } else {
    const extra = depField.value.filter((d) => !approvedDeps.includes(d));
    if (extra.length > 0) {
      return reject(3, ADM.DEPS_CHANGED, `新增依赖：${extra.join(', ')}`);
    }
    pass(3, `依赖面一致（${depField.value.length} 项）`);
  }

  // 锁子树：登记了就必须核对；未登记且非 legacy 也不能跳过。
  // 缺陷修复点（GPT 复现）：此前 lockSubtree=null 会同时绕开两条判断直接放行。
  const approvedSubtree = readHashField(record.approvedLockSubtree, 'sha256');
  if (approvedSubtree.status === INVALID) {
    return reject(3, ADM.FIELD_INVALID, `注册表 approvedLockSubtree.sha256 非法：${approvedSubtree.detail}`);
  }
  const actualSubtree = readHashField(lockSubtree, 'sha256');
  if (actualSubtree.status === INVALID) {
    return reject(3, ADM.FIELD_INVALID, `lockSubtree.sha256 非法：${actualSubtree.detail}`);
  }
  if (approvedSubtree.status === OK) {
    if (actualSubtree.status !== OK) {
      return reject(3, ADM.LOCK_SUBTREE_MISSING,
        '注册表已登记依赖子树哈希，但本次未提供实际子树——不能跳过核对');
    }
    if (actualSubtree.value !== approvedSubtree.value) {
      return reject(3, ADM.DEPS_CHANGED, '锁子树与审查时登记的子树不一致（传递依赖发生变化）');
    }
    pass(3, '锁子树一致');
  } else if (!legacy) {
    return reject(3, ADM.LOCK_SUBTREE_MISSING,
      '注册表未登记依赖子树哈希，无法证明依赖面未扩大');
  } else {
    pass(3, 'legacy 记录：未登记子树，按 v1 语义放行');
  }

  // ---------- Step 4：授权范围 ----------
  // SCOPE_KEYS / BOOL_SCOPE_KEYS / 安装脚本检测抽到 evaluateGrantedScope()，
  // 与 W4/W5 共用同一判据；这里只保留 INJECTION_KEYS 与最终 unknown 汇总。
  const granted = evaluateGrantedScope({ manifest, approvedScopes, packageJson });
  if (!granted.ok) {
    return reject(4, granted.code, granted.reason, { pendingScopes: granted.pendingScopes });
  }
  const unknownFields = granted.unknownFields;

  /**
   * 注入面字段缺省（保持 unknown）时的两条合法通道：
   *  ① legacy 兼容：仅用于**明确登记的既有 v1 记录**（legacy===true 且显式 injectionReviewed）。
   *     新装样例不得走这条；W6-A 定点收口已把新装入口里的 legacy=true 去掉。
   *  ② 正常新装：携带经**实际核验并绑定本次产物**的审查证据 record.injectionReview。
   *     要求 verified=true、boundContentHash 与 manifest.contentHash 逐字一致、
   *     unknown 原样保持、处置为 accepted-as-residual、且该字段在 unknownFields 内。
   *     证据对象由 w6-injection-review.mjs 读文件+复算哈希产出，evaluate() 只校验结构，
   *     不接受「只带一个路径」或「默认 injectionReviewed=true」。
   * 两条通道都不把 unknown 改写成 false。任何一条都不满足 → 拒绝（停在胃里）。
   */
  const reviewEvidence = record.injectionReview ?? null;
  const evidenceChannelOk = (key) => {
    if (legacy) return false; // legacy 与正常新装互斥；新装不得伪装 legacy
    if (!reviewEvidence || reviewEvidence.verified !== true) return false;
    if (reviewEvidence.reviewedFields?.includes(key)
      && typeof reviewEvidence.assessment?.[key]==='boolean') {
      return reviewEvidence.boundContentHash===manifest?.contentHash;
    }
    if (reviewEvidence.unknownStatusKept !== true) return false;
    if (reviewEvidence.disposition !== 'accepted-as-residual') return false;
    if (typeof reviewEvidence.boundContentHash !== 'string'
      || reviewEvidence.boundContentHash !== manifest?.contentHash) return false;
    return Array.isArray(reviewEvidence.unknownFields)
      && reviewEvidence.unknownFields.includes(key);
  };

  for (const key of INJECTION_KEYS) {
    const field = readBooleanField(manifest, key);
    if (field.status === INVALID) {
      return reject(4, ADM.FIELD_INVALID, `manifest.${key} 非法：${field.detail}`);
    }
    const legacyReviewed = legacy && record.injectionReviewed === true;
    // 缺省 = 未审查；只有显式 true/false 才算审查过
    if (field.status === ABSENT) {
      if (legacyReviewed) continue;
      if (evidenceChannelOk(key)) continue;
      const hasEvidenceShape = reviewEvidence !== null;
      return reject(4,
        hasEvidenceShape ? ADM.INJECTION_REVIEW_UNVERIFIED : ADM.INJECTION_UNKNOWN,
        hasEvidenceShape
          ? `${key} 的注入面审查证据未通过实算核验 / 未绑定本次产物 / unknown 被改写，不得按「没有该能力」处理`
          : `${key} 未被显式审查（缺失，视为 unknown），不能按「没有该能力」处理`);
    }
    if (field.value === true) {
      const approvedField = readBooleanField(approvedScopes, key);
      if (approvedField.value !== true) {
        return reject(4, ADM.SCOPE_EXPANDED, `${key} 为 true 但未被批准`,
          { pendingScopes: [`${key}:true`] });
      }
    }
  }

  if (unknownFields.length > 0) {
    return reject(4, ADM.SCOPE_UNKNOWN,
      `授权范围字段缺省，视为 unknown：${unknownFields.join(', ')}`);
  }
  pass(4, '授权范围未扩大');

  // ---------- Step 5：激活条件 ----------
  const activation = manifest?.activation ?? record.activation ?? 'restart';
  const requiresRestart = activation === 'restart';
  pass(5, `activation=${activation}${requiresRestart ? '（需重启确认，安装后可 installed，但不得登记 active）' : ''}`);

  return {
    allow: true,
    code: ADM.OK,
    reason: requiresRestart
      ? '全部校验通过；安装后需用户确认重启才可登记 active'
      : '全部校验通过',
    step: 5,
    spec,
    pendingScopes: [],
    requiresRestart,
    unknown: [],
    trace,
  };
}
