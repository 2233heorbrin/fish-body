/* fish-body · 直装来源登记与「真实已安装来源」读取（维护源，可审计）
 * 职责：为「普通市场直装入手仓 → 真实受管来源记录 → 市场原渠道更新」提供唯一、共用的来源读取逻辑。
 *
 * 硬约束（W2 收口 #309 纠正①② + 跨组契约第 3/4 节 + Codex #315 退回 #3）：
 *   - 只读当前安装 + 只写饭仓直装来源登记表；不下载、不跑脚本、不改 Profile、不建分析任务、
 *     不伪造 formalDecision/analysisApproved。
 *   - 来源必须是「已成功安装的真实记录」：关联 targetProfile / 包名 / 当前 link realpath /
 *     实际版本内容身份。普通 repository 声明（包清单里 self-declared 的 repository）不算来源。
 *   - link realpath 必须落在手仓「插件仓」目录内；仓外任意 link 一律拒登记（#315 #3 反例）。
 *   - 内容身份实时读取当前安装（版本 + 目录树哈希）并与登记基线比对；改版本/改字节判漂移，
 *     返回真实当前值，绝不回读登记里的旧 version/contentHash（#315 #3 反例）。
 *   - 原渠道更新目标直接取受管记录里的 GitHub ref/subdir 或 npm registry/spec，不查 catalog、
 *     不把 GitHub 换成同名 npm latest；requestedRef 与 resolvedCommit 分离、固定 pin 不追默认分支。
 *   - generation link 与未登记的开发 link 一律不接管（保持原生行为）；禁止伪造 .generations/live/ 段。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathIdentity } from './path-identity.mjs';
import { atomicJson, treeHashOf } from './w6-utils.mjs';
import { packageFiles } from './w6-package.mjs';
import { parseGithubUrl, normalizeSubdir } from './source-fetch.mjs';

const SCHEMA = 'rice-source/v1';
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const safeJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const safePkg = (n) => (String(n ?? '').replace(/^@/, '').replace(/[\\/]/g, '+').replace(/[^A-Za-z0-9._+-]/g, '_') || 'unnamed');

export const SOURCE_STATUS = Object.freeze(['collected', 'downloaded-pinned', 'registration-only', 'material-absent']);
export const isLinkSpec = (s) => /^link:/i.test(String(s ?? ''));
export const isGenerationLink = (s) => isLinkSpec(s) && /(?:^|[\\/])\.generations[\\/]live[\\/]/i.test(String(s));

/** 直装登记表根：<frameworkRoot>/饭/直装来源。与 rice-model 的 scanSources 天然兼容（递归找 来源.json）。 */
export function directSourceRoot(frameworkRoot) {
  return frameworkRoot ? join(frameworkRoot, '饭', '直装来源') : null;
}

/** 手仓插件仓根：<frameworkRoot>/鱼的手/插件仓（可由 adapter 传权威 pluginsRoot 覆盖）。 */
export function warehouseRoot(frameworkRoot) {
  return frameworkRoot ? join(frameworkRoot, '鱼的手', '插件仓') : null;
}

/** 目标路径是否落在插件仓范围内（含仓根本身）。仓外任意 link 不得登记为受管来源。 */
export function isWithinWarehouse(candidate, pluginsRoot) {
  if (!candidate || !pluginsRoot) return false;
  const rel = relative(resolve(String(pluginsRoot).replace(/\//g, sep)), resolve(String(candidate).replace(/\//g, sep)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !/^[A-Za-z]:/.test(rel));
}

/** 当前 node_modules/<pkg> 的真实路径（link 本体 realpath）。会话/仓依赖不绑死临时宿主。 */
export function currentLinkRealPath(profileDir, packageName) {
  if (!profileDir || !packageName) return null;
  const segs = String(packageName).split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..' || /[\\]/.test(s))) return null;
  const target = join(profileDir, 'node_modules', ...segs);
  if (!existsSync(target)) return null;
  try { return realpathSync.native(target).replace(/\\/g, '/'); } catch { return null; }
}

/** 从已安装包清单读实际版本（只证明装了什么，不证明来源历史）。 */
export function installedVersion(profileDir, packageName) {
  if (!profileDir || !packageName) return null;
  const segs = String(packageName).split('/').filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..' || /[\\]/.test(s))) return null;
  const doc = safeJson(join(profileDir, 'node_modules', ...segs, 'package.json'));
  return doc?.version ?? null;
}

/** 实时读取当前安装的真实内容身份（版本 + 目录树哈希）。这是 #315 #3「改字节仍读旧值」的修复点。 */
export function liveContentIdentity(profileDir, packageName, linkRealPath) {
  const version = installedVersion(profileDir, packageName);
  const root = linkRealPath ?? currentLinkRealPath(profileDir, packageName);
  let contentHash = null, fileCount = null, integrity = null;
  if (root && isDir(root)) {
    try {
      const files = packageFiles(root);
      contentHash = treeHashOf(files);
      fileCount = files.length;
    } catch { /* 目录暂不可读 → 视为无基线，交由调用方判漂移 */ }
    const doc = safeJson(join(root, 'package.json'));
    integrity = doc?.dist?.integrity ?? null;
  }
  return { version, contentHash, fileCount, integrity, linkRealPath: root };
}

function contentDrift(baseline = {}, live = {}) {
  const same = (a, b) => (a ?? null) === (b ?? null);
  return !same(baseline.version, live.version) || !same(baseline.contentHash, live.contentHash);
}

function sourceKindOf({ sourceUrl, registryUrl, sourceSpec, installedSpec }) {
  if (/github\.com[:/]/i.test(String(sourceUrl ?? '')) || /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(String(sourceSpec ?? ''))) return 'github';
  if (text(registryUrl) || /^npm:/i.test(String(sourceSpec ?? ''))) return 'npm';
  if (/^https?:\/\/registry\.npmjs\.org\//i.test(String(sourceUrl ?? ''))) return 'npm';
  // 直装入手仓的默认来源：用户从市场按包名安装，原渠道就是 npm registry。
  if (/^link:/i.test(String(installedSpec ?? ''))) return 'npm';
  return text(sourceUrl) ? 'other' : 'npm';
}

function updateChannelOf(kind, { sourceUrl, sourceCommit, requestedRef, resolvedCommit, sourceSubdir,
  registryUrl, sourceSpec, npmSpec, packageName, version }) {
  if (kind === 'github') {
    const url = text(sourceUrl) || text(sourceSpec)?.replace(/^github:/, 'https://github.com/').replace(/^git\+/, '').split('#')[0] || null;
    // Codex #318 阻塞1：更新选择器必须是「用户原始请求」——浮动 ref/branch/tag 持续跟踪，
    // 显式 40-hex commit pin 原样保留；resolvedCommit / sourceCommit 只是「已装内容身份」，
    // 绝不能进更新选择器，否则浮动分支被冻结成已装 commit（分支不再更新）。
    const resolved = text(resolvedCommit) || text(sourceCommit) || null;
    const requested = text(requestedRef) || null;
    const isPin = !!requested && /^[0-9a-f]{40}$/i.test(requested.trim());
    const refKind = isPin ? 'pin' : (requested ? 'ref' : 'default');
    return { kind: 'github', sourceUrl: url, requestedRef: requested,
      resolvedCommit: resolved, refKind,
      // ref = 用户原始请求选择器；无请求留空表示跟默认分支。绝不用 resolved 冻结。
      ref: requested, sourceSubdir: text(sourceSubdir) || '' };
  }
  if (kind === 'npm') {
    // range/registry 原样保留交消费者，不能只记录后忽略（#318 阻塞1 npm 侧）。
    const spec = text(npmSpec) || text(sourceSpec) || (packageName && version ? `${packageName}@${version}` : text(packageName));
    return { kind: 'npm', registryUrl: text(registryUrl) || null, spec, npmSpec: spec };
  }
  return { kind, sourceUrl: text(sourceUrl) || null, spec: text(npmSpec ?? sourceSpec) || null };
}

/**
 * 直装成功后登记来源（registration-only）。只写饭仓，零胃分析、零模型请求、零正式决定。
 * installedSpec 必须是 link: 且不是 generation link；link realpath 必须落在插件仓内，否则拒绝。
 * @returns {object} 登记来源记录（含 updateChannel、实时内容身份基线）。
 */
export function registerDirectSource({ frameworkRoot, profileDir, packageName, installedSpec, sourceSpec = null,
  sourceUrl = null, sourceCommit = null, requestedRef = null, resolvedCommit = null, sourceSubdir = '',
  registryUrl = null, npmSpec = null, version = null, contentHash = null, integrity = null,
  bodyPath = null, pluginsRoot = null, revision = null, id = null, mode = 'off' } = {}) {
  if (!frameworkRoot || !profileDir || !packageName) throw Object.assign(
    new Error('FH_DIRECT_SOURCE_ARGUMENT: 登记需要 frameworkRoot/profileDir/packageName'), { code: 'FH_DIRECT_SOURCE_ARGUMENT' });
  if (!isLinkSpec(installedSpec) || isGenerationLink(installedSpec)) throw Object.assign(
    new Error('FH_DIRECT_SOURCE_NOT_MANAGED_LINK: 直装来源只登记真实受管 link: 包'), { code: 'FH_DIRECT_SOURCE_NOT_MANAGED_LINK' });
  const linkRealPath = currentLinkRealPath(profileDir, packageName);
  if (!linkRealPath) throw Object.assign(
    new Error('FH_DIRECT_SOURCE_NOT_INSTALLED: 当前 Profile 未安装该 link: 包，不能登记来源'), { code: 'FH_DIRECT_SOURCE_NOT_INSTALLED' });
  const root = pluginsRoot || warehouseRoot(frameworkRoot);
  if (!isWithinWarehouse(linkRealPath, root)) throw Object.assign(
    new Error('FH_DIRECT_SOURCE_OUTSIDE_WAREHOUSE: link 本体不在手仓插件仓内，不能登记为受管来源'), { code: 'FH_DIRECT_SOURCE_OUTSIDE_WAREHOUSE' });
  if (bodyPath && (!isWithinWarehouse(bodyPath, root) || pathIdentity(bodyPath) !== pathIdentity(linkRealPath))) throw Object.assign(
    new Error('FH_DIRECT_SOURCE_BODY_MISMATCH: 安装本体路径与登记 bodyPath 不一致'), { code: 'FH_DIRECT_SOURCE_BODY_MISMATCH' });
  const kind = sourceKindOf({ sourceUrl, registryUrl, sourceSpec: npmSpec ?? sourceSpec, installedSpec });
  // 内容身份以实时读取为准；contentHash 入参只作校验基线提示，绝不直接落库当权威值。
  const live = liveContentIdentity(profileDir, packageName, linkRealPath);
  // 提示漂移但不阻断登记：登记的是「当前真实已安装」身份，旧基线不能冒充当前值。
  const baselineDrift = !!contentHash && !!live.contentHash && String(contentHash) !== String(live.contentHash);
  const recordId = text(id) || revision || `${safePkg(packageName)}-${(pathIdentity(linkRealPath) || '').split('/').slice(-2).join('-')}`;
  const record = {
    schema: SCHEMA,
    sourceKind: kind,
    sourceStatus: 'registration-only',
    id: recordId,
    packageName,
    targetProfile: pathIdentity(profileDir) || profileDir,
    installedSpec,
    linkRealPath,
    bodyPath: bodyPath ? String(bodyPath).replace(/\\/g, '/') : linkRealPath,
    pluginsRoot: root ? String(root).replace(/\\/g, '/') : null,
    contentIdentity: { version: live.version ?? version ?? null, contentHash: live.contentHash ?? null,
      fileCount: live.fileCount, integrity: live.integrity ?? integrity ?? null, linkRealPath },
    updateChannel: updateChannelOf(kind, { sourceUrl, sourceCommit, requestedRef, resolvedCommit, sourceSubdir,
      registryUrl, sourceSpec, npmSpec, packageName, version: live.version ?? version }),
    registrationMode: mode,
    // 明确未采集分析材料：绝不冒充「已保存材料」；要分析走独立采集路径。
    materialStatus: 'material-absent',
    basis: '普通市场直装入手仓；只登记真实已安装来源身份，未进行胃分析、未生成模型请求、未生成正式决定',
    registeredAt: new Date().toISOString(),
  };
  const dir = join(directSourceRoot(frameworkRoot), safePkg(packageName), recordId.replace(/[^A-Za-z0-9._+-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, '来源.json'), record);
  return record;
}

function scanRegistrations(frameworkRoot) {
  const root = directSourceRoot(frameworkRoot);
  const out = [];
  if (!root || !isDir(root)) return out;
  for (const pkgDir of readdirSync(root)) {
    const pkgBase = join(root, pkgDir);
    if (!isDir(pkgBase)) continue;
    for (const idDir of readdirSync(pkgBase)) {
      const file = join(pkgBase, idDir, '来源.json');
      const doc = safeJson(file);
      if (doc && doc.schema === SCHEMA && doc.sourceStatus === 'registration-only') out.push(doc);
    }
  }
  return out;
}

function normalizedFromRegistration(doc, profileDir, installedSpec, linkRealPath) {
  // 实时复算内容身份；与登记基线不一致时以实时值为准并标 contentDrift=true。
  const live = liveContentIdentity(profileDir, doc.packageName, linkRealPath);
  const baseline = doc.contentIdentity ?? {};
  return {
    sourceKind: doc.sourceKind,
    sourceStatus: doc.sourceStatus,
    packageName: doc.packageName,
    targetProfile: doc.targetProfile,
    installedSpec: doc.installedSpec ?? installedSpec,
    linkRealPath: doc.linkRealPath ?? linkRealPath,
    bodyPath: doc.bodyPath ?? linkRealPath,
    pluginsRoot: doc.pluginsRoot ?? null,
    contentIdentity: live,
    contentDrift: contentDrift(baseline, live),
    registeredContentIdentity: baseline,
    updateChannel: doc.updateChannel ?? null,
    registrationMode: doc.registrationMode ?? 'off',
    materialStatus: doc.materialStatus ?? 'material-absent',
    id: doc.id,
    origin: 'registration-only',
  };
}

/**
 * 兼容分析路径的受管行（带 formalDecisionId/requestId）→ 标准化来源记录。
 * 只用于「读取来源后接回原渠道更新」，不在此处新建/批准任何决定。
 */
function normalizedFromRegistry(row, profileDir, installedSpec, linkRealPath) {
  const sourceUrl = row.sourceUrl ?? null;
  const kind = /github\.com[:/]/i.test(String(sourceUrl ?? '')) ? 'github' : 'npm';
  const live = liveContentIdentity(profileDir, row.packageName, linkRealPath);
  return {
    sourceKind: kind,
    sourceStatus: row.sourceStatus ?? 'downloaded-pinned',
    packageName: row.packageName,
    targetProfile: row.targetProfile ?? null,
    installedSpec: row.spec ?? installedSpec,
    linkRealPath,
    bodyPath: linkRealPath,
    contentIdentity: live,
    contentDrift: contentDrift({ version: row.version, contentHash: row.contentHash }, live),
    updateChannel: updateChannelOf(kind, { sourceUrl, sourceCommit: row.sourceCommit, requestedRef: row.sourceCommit,
      resolvedCommit: row.sourceCommit, sourceSubdir: row.sourceSubdir,
      registryUrl: row.registryUrl, sourceSpec: row.sourceSpec ?? row.spec, npmSpec: row.sourceSpec ?? row.spec,
      packageName: row.packageName, version: row.version }),
    requestId: row.requestId ?? null,
    formalDecisionId: row.formalDecisionId ?? null,
    id: row.packageName,
    origin: 'formal-registry',
  };
}

/**
 * 读取「当前已安装的真实受管来源」。这是直装与兼容分析共用的一致读取逻辑。
 * 三源交叉：当前 installSpec（link:本体）＋ targetProfile ＋ 登记记录/受管行的 link realpath 与内容身份。
 * 普通开发 link / generation link / 未登记 link → null（保持原生行为，不误接管）。
 * 普通 repository 声明（包清单 self-declared）不构成来源。
 */
export function readInstalledSource({ frameworkRoot, profileDir, packageName, installedSpec, registryRows = [] } = {}) {
  if (!isLinkSpec(installedSpec) || isGenerationLink(installedSpec) || !profileDir || !packageName) return null;
  const linkRealPath = currentLinkRealPath(profileDir, packageName);
  if (!linkRealPath) return null;
  const pid = pathIdentity(profileDir);
  const lid = pathIdentity(linkRealPath);
  // ① 直装登记记录：来源 + 仓路径 + 当前安装三者对应才成立。
  for (const doc of scanRegistrations(frameworkRoot)) {
    if (doc.packageName !== packageName) continue;
    if (pid && doc.targetProfile && pathIdentity(doc.targetProfile) !== pid) continue;
    if (doc.linkRealPath && pathIdentity(doc.linkRealPath) !== lid) continue;
    if (doc.installedSpec && doc.installedSpec !== installedSpec) continue;
    if (!isWithinWarehouse(linkRealPath, doc.pluginsRoot || warehouseRoot(frameworkRoot))) continue;
    return normalizedFromRegistration(doc, profileDir, installedSpec, linkRealPath);
  }
  // ② 兼容分析受管行：必须有正式决定绑定，且 targetProfile / spec 对应。
  for (const row of registryRows) {
    if (row.packageName !== packageName) continue;
    if (!row.formalDecisionId || !row.requestId) continue;
    if (row.spec && row.spec !== installedSpec) continue;
    if (row.targetProfile && pid && pathIdentity(row.targetProfile) !== pid) continue;
    return normalizedFromRegistry(row, profileDir, installedSpec, linkRealPath);
  }
  return null;
}

/**
 * 只读查询（#318 阻塞A，供补位后端 analyze-installed 编排调用）：列出当前 Profile 下
 * 「已直装入手仓、仍能实时解析」的登记来源。用记录自带的 installedSpec 做实时解析
 * （realpath 必须仍在插件仓内、targetProfile 匹配、内容身份实时复算），调用方不必自行拼 spec。
 * @returns {Array<object>} 每项含 packageName/installedSpec/sourceSpec/来源 ref|commit|subdir/bodyPath/contentIdentity 等
 */
export function listDirectSources({ frameworkRoot, profileDir } = {}) {
  if (!frameworkRoot || !profileDir) return [];
  const pid = pathIdentity(profileDir);
  const out = [];
  for (const doc of scanRegistrations(frameworkRoot)) {
    if (pid && doc.targetProfile && pathIdentity(doc.targetProfile) !== pid) continue;
    const rec = readInstalledSource({ frameworkRoot, profileDir, packageName: doc.packageName,
      installedSpec: doc.installedSpec, registryRows: [] });
    if (!rec || rec.origin !== 'registration-only') continue;
    const ch = rec.updateChannel ?? {};
    out.push({
      packageName: doc.packageName,
      installedSpec: doc.installedSpec,
      sourceSpec: doc.updateChannel?.spec ?? doc.installedSpec ?? null,
      sourceKind: rec.sourceKind,
      sourceUrl: ch.sourceUrl ?? null,
      requestedRef: ch.requestedRef ?? null,
      resolvedCommit: ch.resolvedCommit ?? null,
      ref: ch.ref ?? null,
      refKind: ch.refKind ?? 'default',
      sourceSubdir: ch.sourceSubdir ?? '',
      registryUrl: ch.registryUrl ?? null,
      npmSpec: ch.npmSpec ?? null,
      bodyPath: rec.bodyPath ?? null,
      linkRealPath: rec.linkRealPath ?? null,
      pluginsRoot: rec.pluginsRoot ?? null,
      targetProfile: rec.targetProfile ?? null,
      contentIdentity: rec.contentIdentity ?? null,
      contentDrift: rec.contentDrift ?? false,
      materialStatus: rec.materialStatus ?? 'material-absent',
      sourceStatus: rec.sourceStatus ?? 'registration-only',
      updateChannel: rec.updateChannel ?? null,
      id: rec.id ?? doc.id ?? null,
    });
  }
  return out;
}

/** listDirectSources 的单条按 pluginId 查询（packageName 或记录 id 命中）。 */
export function findInstalledByPluginId({ frameworkRoot, profileDir, pluginId } = {}) {
  if (!pluginId) return null;
  return listDirectSources({ frameworkRoot, profileDir })
    .find((r) => r.packageName === pluginId || r.id === pluginId) ?? null;
}

/** 市场 seam 用它判断某个 link 是否为本模块登记的受管 link（不是 generation/开发 link）。 */
export function isDirectManagedLink(args) {
  const rec = readInstalledSource(args);
  return !!rec && rec.origin === 'registration-only' && rec.sourceStatus === 'registration-only';
}

/** 直接交现有更新执行链的原渠道更新目标；不查 catalog、不换源。 */
export function directUpdateTarget(record) {
  if (!record?.updateChannel) return null;
  return { ...record.updateChannel };
}

/** 解析 GitHub 原始意图：owner/repo、requestedRef、subdir 分离，包名留给真实 manifest。 */
function parseGithubIntent(spec) {
  let s = String(spec).replace(/^git\+/, '');
  const hashAt = s.indexOf('#');
  let hash = hashAt >= 0 ? s.slice(hashAt + 1) : '';
  let base = hashAt >= 0 ? s.slice(0, hashAt) : s;
  let sourceSubdir = '';
  const pathMatch = /(?:^|&)path:\/?(.+)$/i.exec(hash);
  if (pathMatch) { sourceSubdir = normalizeSubdir(decodeURIComponent(pathMatch[1])); hash = hash.slice(0, pathMatch.index); }
  let requestedRef = text(hash);
  // /tree/<ref>/<sub> 形式：拆出 ref/subdir，再交给 parseGithubUrl 校验 owner/repo。
  const tree = /\/tree\/([^/]+)(?:\/(.+))?$/.exec(base);
  if (tree) {
    if (!requestedRef) requestedRef = decodeURIComponent(tree[1]);
    if (!sourceSubdir && tree[2]) sourceSubdir = normalizeSubdir(decodeURIComponent(tree[2]));
    base = base.slice(0, tree.index);
  }
  const url = base.replace(/^github:\/?/, 'https://github.com/');
  const parsed = parseGithubUrl(url, { ...(requestedRef ? { ref: requestedRef } : {}), ...(sourceSubdir ? { subdir: sourceSubdir } : {}) });
  return { sourceUrl: parsed.webUrl, owner: parsed.owner, repo: parsed.repo,
    requestedRef: parsed.ref ?? requestedRef, sourceSubdir: parsed.subdir ?? '', sourceSpec: spec };
}

/**
 * 从原始安装意图解析登记所需的来源字段。github ref/subdir 与 npm registry/spec 原样保留，
 * 不查 catalog、不做同名 npm 替换。供 adapter 在 deploy 成功后调用 registerDirectSource。
 * 注意：GitHub 意图不含 packageName（真实包名从已安装 manifest 读取，绝不拿 owner/repo 冒充）。
 */
export function directInstallIntent(raw, { registryUrl = null } = {}) {
  const spec = text(raw);
  if (!spec) return null;
  if (/^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(spec)) {
    const parsed = parseGithubIntent(spec);
    return { packageName: null, sourceUrl: parsed.sourceUrl, requestedRef: parsed.requestedRef,
      resolvedCommit: null, sourceCommit: null, sourceSubdir: parsed.sourceSubdir,
      sourceSpec: spec, registryUrl: null };
  }
  const m = /^(@[^/\s]+\/[^@\s]+|[^@/:\s]+)(?:@([^\s]+))?$/.exec(spec);
  if (!m) return null;
  return { packageName: m[1], version: m[2] ?? null, registryUrl, sourceSpec: spec, npmSpec: spec,
    sourceUrl: null, requestedRef: null, resolvedCommit: null, sourceCommit: null, sourceSubdir: '' };
}
