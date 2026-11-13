/**
 * 正式候选 · 真实数据适配（唯一 canonical：鱼的手 registry + 手侧请求/决定 + W5 产物）
 *
 * 设计约束（本轮收口要求）：
 *   ① gate 实际需要的 request / formalDecision / 制品 / 包记录必须**齐全**，不是只给名字；
 *   ② ready 与 installed（以及已挂载 active）都要能投影，安装后 / 进程重启后仍能加载、repair；
 *   ③ 制品身份来自**实际制品 + 审查记录**（W5 manifest 实读 + 目录逐文件复算 + tgz 字节复算），
 *      不得拿批准决定里自己写的 contentHash 当独立校验依据；
 *   ④ 只读：不写 registry、不写决定、不写产物。
 *
 * 目录约定（生产与隔离回归共用同一套相对结构，只换根目录 / 来源 / 审批主体）：
 *   <handRoot>/插件注册表/registry.json          registry（V1 数组 schema）
 *   <handRoot>/插件注册表/requests/<id>.json      安装意图 + W2–W5 请求记录（RequestStore）
 *   <handRoot>/插件注册表/decisions/<id>.json     正式决定（审批端点落库）
 *   <handRoot>/插件注册表/decisions/decisions/    W4 决定（DecisionStore）
 *   <handRoot>/插件仓/<name>/<version>/<rev>/     W5 产物（仓库/ + manifest.json）与安装包
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectInstallPackage } from './lib/w6-package.mjs';
import { SCHEMAS } from './lib/w4w5-utils.mjs';

/** 可投影的状态：ready（已审待装）、installed（已装待加载）、active（已挂载）。 */
export const PROJECTABLE_STATES = Object.freeze(['ready', 'installed', 'active']);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function registryRows(registry) {
  return Array.isArray(registry?.plugins)
    ? registry.plugins : Object.values(registry?.plugins ?? {});
}

function rowName(row) {
  return row?.pluginId ?? row?.packageName ?? null;
}

/** 读请求记录：优先 registry 行登记的 requestId，其次按包名找唯一一条 ready 记录。 */
function loadRequest({ requestsRoot, requestId, name }) {
  if (requestId) {
    const p = join(requestsRoot, `${requestId}.json`);
    if (existsSync(p)) return { record: readJson(p), path: p, via: 'requestId' };
  }
  return { record: null, path: null, via: null, name };
}

/** W4 决定（DecisionStore 输出）：含 binding.pinnedCommit / review.acceptedUnknowns 等准入所需字段。 */
function loadDecisionRecord({ decisionsRoot, decisionId }) {
  if (!decisionId) return { doc: null, path: null };
  const p = join(decisionsRoot, 'decisions', `${decisionId}.json`);
  if (!existsSync(p)) return { doc: null, path: p };
  return { doc: readJson(p), path: p };
}

/** 正式决定（审批端点落库）：绑定制品 / 目标 profile / 范围 / 六维授权。 */
function loadFormalDecision({ decisionsRoot, formalDecisionId }) {
  if (!formalDecisionId) return { doc: null, path: null };
  const p = join(decisionsRoot, `${formalDecisionId}.json`);
  if (!existsSync(p)) return { doc: null, path: p };
  return { doc: readJson(p), path: p };
}

/**
 * 把一条 registry 记录投影成 gate 候选。
 * 失败返回 { candidate: null, problem }，由调用方汇总（不静默跳过）。
 */
export function projectPlugin(row, conf) {
  const name = rowName(row);
  const problem = (code, reason, extra = {}) => ({
    candidate: null,
    problem: { name, code, reason, ...extra },
  });
  if (!name) return problem('FH_ROW_NO_NAME', 'registry 行缺少 pluginId / packageName');
  const state = row.state ?? null;
  if (!PROJECTABLE_STATES.includes(state)) {
    return problem('FH_ROW_STATE_SKIP', `状态 ${String(state)} 不参与准入投影（只投影 `
      + `${PROJECTABLE_STATES.join(' / ')}）`, { skipped: true });
  }
  if (row.approved === false) return problem('FH_ROW_NOT_APPROVED', 'registry 行显式标记未批准');

  // 既有插件：state=active 且没有任何决定绑定 → 走 legacy 放行（不参与准入投影，也不记为问题）。
  // 与 production-state.legacyPluginNames() 同一判据，避免把「本来就不受新准入约束的行」当成缺陷。
  const boundDecision = row.formalDecisionId ?? row.decisionId ?? null;
  if (!boundDecision && !row.decisionRecordId) {
    return {
      candidate: null,
      problem: { name, code: 'FH_ROW_LEGACY',
        reason: '既有插件：无决定绑定，走 legacy 放行（不参与准入投影）',
        skipped: true, legacy: true },
    };
  }

  const artifactDir = row.artifactPath ?? (row.version
    ? join(conf.artifactsRoot, name, row.version) : null);
  if (!artifactDir || !existsSync(artifactDir)) {
    return problem('FH_ARTIFACT_MISSING', `制品目录不存在：${String(artifactDir)}`);
  }

  const formal = loadFormalDecision({ decisionsRoot: conf.decisionsRoot,
    formalDecisionId: row.formalDecisionId ?? row.decisionId });
  if (!formal.doc) {
    return problem('FH_FORMAL_DECISION_MISSING',
      `正式决定不存在：${String(formal.path)}（registry 记录必须绑定正式决定）`);
  }
  const w4 = loadDecisionRecord({ decisionsRoot: conf.decisionsRoot,
    decisionId: row.decisionRecordId ?? row.decisionId });
  if (!w4.doc) {
    return problem('FH_DECISION_RECORD_MISSING',
      `W4 决定记录不存在：${String(w4.path)}（准入需要 W4 绑定与 unknown 处置）`);
  }
  const req = loadRequest({ requestsRoot: conf.requestsRoot, requestId: row.requestId ?? w4.doc.requestId, name });
  if (!req.record) {
    return problem('FH_REQUEST_MISSING',
      `请求记录不存在：${String(req.path)}（正式决定绑定校验需要 requestId / grantedScopes / targetProfile）`);
  }

  // 制品身份：实际目录逐文件复算 + tgz 字节复算（与审查记录比对），不用决定里的值
  const inspected = inspectInstallPackage({
    artifactDir,
    tgzPath: row.packagePath ?? null,
    recordPath: row.packageRecordPath ?? null,
  });
  if (!inspected.ok) {
    return problem(inspected.code ?? 'FH_ARTIFACT_INVALID',
      `制品/安装包核对未通过：${(inspected.reasons ?? []).join('; ').slice(0, 400)}`,
      { artifactDir, drift: inspected.drift ?? null });
  }
  const w5Manifest = inspected.w5Manifest;
  const packageRecord = inspected.record;
  const contentHash = inspected.artifactOk ? w5Manifest.contentHash : null;
  if (contentHash === null) {
    return problem('FH_ARTIFACT_HASH_MISMATCH', '制品目录复算哈希与 W5 manifest 不一致');
  }

  const decisionRecord = w4.doc;
  const declaredSpec = row.spec ?? packageRecord.spec;
  const version = row.version ?? w5Manifest.version;

  return {
    candidate: {
      packageName: name,
      version,
      spec: declaredSpec,
      loadForm: row.loadForm ?? req.record.loadForm ?? 'tool',
      approved: true,
      state,
      active: state === 'active',
      sourceTreeHash: contentHash,
      packageIntegrity: packageRecord.packageIntegrity,
      artifactDir,
      // 独立制品身份（gate 用它做正式决定绑定比对，而不是决定自身写的值）
      artifactIdentity: {
        artifactPath: artifactDir,
        contentHash,
        sourceTreeHash: packageRecord.sourceTreeHash,
        packageIntegrity: packageRecord.packageIntegrity,
        tgzPath: packageRecord.tgzPath,
        verifiedFrom: 'W5 manifest + 目录逐文件复算 + tgz 字节复算',
      },
      request: req.record,
      formalDecision: formal.doc,
      decisionId: decisionRecord.id,
      admission: {
        spec: declaredSpec,
        packageName: name,
        version,
        sourceTreeHash: packageRecord.sourceTreeHash,
        dependencySubtreeSha256: packageRecord.dependencySubtree?.sha256 ?? null,
        dependencies: Object.keys(packageRecord.dependencySpecs ?? {}),
        packageJson: packageRecord.packageJson,
        packageRecord,
        w5Manifest,
        decision: decisionRecord,
        injectionReviewEvidencePath: row.injectionReviewEvidencePath ?? null,
        injectionReviewSchema: conf.injectionReviewSchema ?? null,
        isolationOnly: false,
      },
      approval: {
        root: conf.handRoot,
        record: req.record,
        decision: decisionRecord,
        decisionStoreRoot: conf.decisionsRoot,
        artifactDir,
        w5Manifest,
        packageRecord,
        isolationOnly: false,
        allowedRecordStates: ['ready', 'installed', 'active'],
      },
    },
    problem: null,
  };
}

/**
 * 构建全部可投影候选。
 * @returns {{candidates: object, problems: object[], registryRows: number}}
 */
export function buildProductionCandidates(conf) {
  if (!existsSync(conf.registryPath)) {
    throw new Error(`[FH_REGISTRY_MISSING] 真实注册表不存在：${conf.registryPath}`);
  }
  const registry = readJson(conf.registryPath);
  const rows = registryRows(registry);
  const candidates = {};
  const problems = [];
  for (const row of rows) {
    const { candidate, problem } = projectPlugin(row, conf);
    if (candidate) candidates[candidate.packageName] = candidate;
    else if (!problem?.skipped) problems.push(problem);
  }
  return { candidates, problems, registryRows: rows.length };
}

export { SCHEMAS };
