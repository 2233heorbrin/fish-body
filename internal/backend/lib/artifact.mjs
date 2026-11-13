/**
 * W5「已审产物」（隔离实现）——版本化 artifact / manifest / 内容清单 / 实际复算哈希
 *
 * 硬约束（用户本轮要求）：
 *   1. 只从饭目录做**字节复制**（readFileSync → writeFileSync）。
 *      不 import 候选代码、不跑构建/打包/安装生命周期脚本、不解析依赖、不联网。
 *   2. contentHash 由**实际落盘产物**复算（算法与 upstream.mjs 的 treeHash 完全一致），
 *      因此「审查对象（上游哈希）= 批准对象（决定绑定）= 实际产物（产物哈希）」可逐字比对。
 *   3. 产物被修改后不得继续用旧批准：verifyArtifact 逐文件复算，任何漂移 → 不放行。
 *   4. 新提交 / 新版本保留独立记录：目录 <id>/<version>/<commit 前 12 位>/，
 *      索引只追加，绝不覆盖旧目录或旧 manifest。
 *   5. 只有「审查完成 + 授权满足 + 产物验证通过」才允许进 ready（由 pipeline.mjs 收口）。
 *      依赖解析、dist.integrity、锁子树、注入面等保持 unknown，不伪造数据过关。
 *   6. manifest 的授权范围字段是「本次授予的边界」，不是「对插件的事实断言」：
 *      externalSideEffects=false 表示本次不授予对外动作，不等于认定插件没有该能力。
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  SCHEMAS, ProbeError, sha256File, treeHashOf, hashOf,
  atomicJson, readJson, exists,
} from './w4w5-utils.mjs';
import {
  computeBinding, compareBinding, assertUsableForArtifact, DEC,
} from './decision.mjs';
import { evaluateGrantedScope } from './admission.mjs';

export const ART = Object.freeze({
  BINDING_MISMATCH: 'ART_BINDING_MISMATCH',
  REVIEW_INCOMPLETE: 'ART_REVIEW_INCOMPLETE',
  SOURCE_MISSING: 'ART_SOURCE_MISSING',
  UPSTREAM_DRIFT: 'ART_UPSTREAM_DRIFT',
  SELECTED_FILE_MISSING: 'ART_SELECTED_FILE_MISSING',
  ALREADY_PRESENT: 'ART_ALREADY_PRESENT',
  CONTENT_DRIFT: 'ART_CONTENT_DRIFT',
  NOT_BUILT: 'ART_NOT_BUILT',
  SCOPE_NOT_SATISFIED: 'ART_SCOPE_NOT_SATISFIED',
  BAD_MANIFEST: 'ART_BAD_MANIFEST',
});

const safeRelPath = (p) => typeof p === 'string' && p.length > 0
  && !p.includes('..') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p);

/** 递归复算目录内所有文件的逐文件 sha256（Buffer 直算，二进制安全）。 */
export function recomputeFiles(warehouseDir) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // 采集清单来自 git 跟踪的文件（git ls-tree），`.git` 从来不属于内容。
        // 复算若把 .git 也算进来，任何 Git 来源在造产物时都会被判「上游漂移」。
        if (entry.name === '.git') continue;
        walk(full, rel);
      } else {
        const buf = readFileSync(full);
        out.push({ path: rel, bytes: buf.length, sha256: sha256File(full) });
      }
    }
  };
  walk(warehouseDir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/**
 * 产物目录。默认 `root/hand/插件仓/...`（隔离回归沿用）。
 * 传入 pluginsRoot 时直接落在该 canonical 目录（生产 = 鱼的手/插件仓），
 * 避免在 鱼的手 下再造一层 hand 平行目录。
 */
export function artifactDirFor(root, { artifactId, version, revision }, { pluginsRoot = null } = {}) {
  return join(pluginsRoot ?? join(root, 'hand'), '插件仓', artifactId, version, revision);
}

function artifactIdentity({ record, decision, sourceDoc }) {
  const partial = decision.kind === 'partial-adaptation';
  const artifactId = partial
    ? `${record.packageName}-partial-${hashOf(decision.derivedParts.selectedFiles).slice(7, 15)}`
    : record.packageName;
  const versionRaw = sourceDoc.versionFromManifest;
  const version = typeof versionRaw === 'string' && versionRaw.trim() !== ''
    ? versionRaw : 'unversioned';
  const revision = String(record.source.pinnedCommit).slice(0, 12) + (record.source.subdir ? '-'+hashOf(record.source.subdir).slice(7,19) : '');
  return {
    artifactId, version, revision,
    versionStatus: typeof versionRaw === 'string' ? 'from-manifest' : 'absent-not-fabricated',
    kind: partial ? 'partial' : 'whole-package',
  };
}

function appendArtifactIndex(root, entry, pluginsRoot = null) {
  const path = join(pluginsRoot ?? join(root, 'hand'), '插件仓', 'artifacts.json');
  let doc = { schema: 'hand-artifact-index/v1', at: null, rows: [] };
  if (existsSync(path)) doc = readJson(path);
  if (!Array.isArray(doc.rows)) doc.rows = [];
  if (!doc.rows.some((r) => r.artifactId === entry.artifactId
    && r.version === entry.version && r.revision === entry.revision)) {
    doc.rows.push(entry);
  }
  doc.at = new Date().toISOString();
  atomicJson(path, doc);
  return doc;
}

/** 从审查事实推导「产物声明的授权边界」，不是抄批准范围（否则范围检查成假检查）。 */
function declaredScopeFromReview(conclusionDoc, sourceDoc) {
  const caps = [...new Set((conclusionDoc.conclusion.capabilities ?? [])
    .filter((c) => typeof c === 'string'))].sort();
  return {
    capabilities: caps,
    replaces: [],
    credentialScopes: [],
    externalSideEffects: false,
    installScripts: (sourceDoc.installScripts ?? []).length > 0,
  };
}

const UNKNOWN_FACTS = {
  personaInjection: { status: 'unknown', reason: '静态扫描不能证明没有注入；未做运行时取证' },
  memoryInjection: { status: 'unknown', reason: '静态扫描不能证明没有记忆写入；未做运行时取证' },
  transitiveDependencies: { status: 'unknown', reason: '未执行依赖解析，传递依赖子树未固定' },
  distIntegrity: { status: 'unknown', reason: '未获取 dist.integrity；属 W6 安装门' },
  lockSubtree: { status: 'unknown', reason: '未生成锁子树，无法证明依赖面未扩大' },
  runtimeBehavior: { status: 'unknown', reason: '候选代码未执行，运行时行为不可判定' },
  upstreamTrust: { status: 'unknown', reason: '来源身份见 derivedFrom；上游信任需独立审查依据' },
  externalSideEffectsRuntime: { status: 'unknown', reason: '授权不授予对外动作，不等于事实层面不存在' },
};

/**
 * 构建版本化产物。
 *
 * @returns {{status, artifactDir, manifestPath, contentListPath, manifest, contentList, identity, plannedFiles}}
 */
export function buildArtifact({
  root, record, decision, conclusion, decisionStore, at, pluginsRoot = null,
}) {
  assertUsableForArtifact(decision, decisionStore);
  if (record.review?.complete !== true) {
    throw new ProbeError(ART.REVIEW_INCOMPLETE, '审查未完成，不得构建已审产物');
  }

  // ① 决定仍绑定本次对象（对象或范围改变后旧决定失效）
  const actualBinding = computeBinding({
    record, approvedScopes: decision.approvedScopes, kind: decision.kind,
    derivedParts: decision.derivedParts,
    conclusionContentHash: decision.review.conclusionContentHash,
    authorization: decision.authorization,
  });
  const bindingCheck = compareBinding(decision.binding, actualBinding);
  if (!bindingCheck.match) {
    throw new ProbeError(ART.BINDING_MISMATCH,
      `决定绑定的对象/范围已改变，旧决定不得套用：${bindingCheck.mismatches.map((m) => m.field).join(', ')}`,
      { mismatches: bindingCheck.mismatches });
  }

  // ② 读饭目录材料，并复算上游未漂移
  const sourcePath = record.rice?.sourcePath;
  const contentListPath = record.rice?.contentListPath;
  const riceWarehouse = join(record.rice?.dir ?? '', '仓库');
  if (!sourcePath || !contentListPath || !exists(sourcePath) || !exists(contentListPath)
    || !existsSync(riceWarehouse)) {
    throw new ProbeError(ART.SOURCE_MISSING, '饭目录材料不完整，无法构建产物');
  }
  const sourceDoc = readJson(sourcePath);
  const upstreamContentList = readJson(contentListPath);
  const upstreamFiles = recomputeFiles(riceWarehouse);
  const upstreamContentHash = treeHashOf(upstreamFiles);
  const upstreamMatches = upstreamFiles.length === upstreamContentList.fileCount
    && upstreamFiles.every((f, i) => {
      const expected = upstreamContentList.files[i];
      return expected && expected.path === f.path && expected.sha256 === f.sha256;
    })
    && upstreamContentHash === record.source.contentHash
    && upstreamContentHash === decision.binding.contentHash;
  if (!upstreamMatches) {
    throw new ProbeError(ART.UPSTREAM_DRIFT,
      '饭目录内容与审查/批准时登记的内容哈希不一致，旧决定不得继续使用');
  }

  // ③ 决定要复制哪些文件
  const allPaths = upstreamFiles.map((f) => f.path);
  const partial = decision.kind === 'partial-adaptation';
  let selected;
  if (partial) {
    selected = [...decision.derivedParts.selectedFiles].sort();
    const missing = selected.filter((p) => !allPaths.includes(p));
    if (missing.length > 0) {
      throw new ProbeError(ART.SELECTED_FILE_MISSING,
        `部分适配选中的文件不在上游清单：${missing.join(', ')}`);
    }
  } else {
    selected = [...allPaths].sort();
  }
  if (!selected.every(safeRelPath)) {
    throw new ProbeError(ART.SELECTED_FILE_MISSING, '文件路径非法（含路径穿越或绝对路径）');
  }

  const plannedFiles = upstreamFiles.filter((f) => selected.includes(f.path));
  const contentHash = treeHashOf(plannedFiles);
  const identity = artifactIdentity({ record, decision, sourceDoc });
  identity.revision += '-'+hashOf(declaredScopeFromReview(conclusion.doc,sourceDoc)).slice(7,19);
  const artifactDir = artifactDirFor(root, identity, { pluginsRoot });
  const manifestPath = join(artifactDir, 'manifest.json');
  const artifactContentListPath = join(artifactDir, '内容清单.json');
  const warehouseDir = join(artifactDir, '仓库');

  // 两边形状不同：已有 manifest 把决定与文件选择放在 derivedFrom 里，
  // 待写的「wanted」是扁平对象。只按 m.derivedFrom 取会让 wanted.selectedFiles
  // 恒为 undefined → 只要产物目录已存在就永远判「内容不同」（幂等恒失效）。
  const comparable = (m) => ({
    contentHash: m.contentHash,
    kind: m.kind,
    selectedFiles: m.selectedFiles ?? m.derivedFrom?.selectedFiles,
    version: m.version,
    revision: m.revision,
  });

  if (existsSync(manifestPath)) {
    const existing = readJson(manifestPath);
    const wanted = comparable({
      contentHash, decisionId: decision.id, kind: identity.kind,
      selectedFiles: selected, version: identity.version, revision: identity.revision,
    });
    if (JSON.stringify(comparable(existing)) === JSON.stringify(wanted)) {
      return {
        status: 'already-present', artifactDir, manifestPath,
        contentListPath: artifactContentListPath,
        manifest: existing, contentList: readJson(artifactContentListPath),
        identity, plannedFiles,
      };
    }
    throw new ProbeError(ART.ALREADY_PRESENT,
      `产物目录已存在但内容/决定不同（${artifactDir}），拒绝覆盖旧已审产物`);
  }

  const grantedScope = declaredScopeFromReview(conclusion.doc, sourceDoc);
  const contentList = {
    schema: decision.productionApproval?'hand-artifact-content/v1':SCHEMAS.ARTIFACT_CONTENT,
    artifactId: identity.artifactId,
    version: identity.version,
    revision: identity.revision,
    pinnedCommit: record.source.pinnedCommit,
    ...(record.source.subdir ? {subdir:record.source.subdir} : {}),
    fileCount: plannedFiles.length,
    files: plannedFiles,
    treeHash: contentHash,
    upstreamContentHash,
    adaptation: identity.kind,
  };

  const manifest = {
    schema: decision.productionApproval?'hand-artifact-manifest/v1':SCHEMAS.ARTIFACT_MANIFEST,
    artifactId: identity.artifactId,
    version: identity.version,
    versionStatus: identity.versionStatus,
    revision: identity.revision,
    kind: identity.kind,
    createdAt: at ?? new Date().toISOString(),
    // 实际复算的产物哈希
    contentHash,
    contentFiles: plannedFiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
    contentListPath: artifactContentListPath,
    // 授权边界（审查事实推导，非事实断言）
    grantedScope,
    // 未完成项目保持 unknown，不伪造数据过关
    unknownFacts: UNKNOWN_FACTS,
    distIntegrity: { status: 'unknown', value: null, note: '未获取，属 W6 安装门' },
    lockSubtree: { status: 'unknown', sha256: null, note: '未生成，属 W6 安装门' },
    dependencies: [...(sourceDoc.flatDependencies ?? [])].sort(),
    // 审查对象 / 批准对象 / 产物的对应关系
    derivedFrom: {
      requestId: record.id,
      upstreamUrl: record.source.upstreamUrl,
      pinnedCommit: record.source.pinnedCommit,
    ...(record.source.subdir ? {subdir:record.source.subdir} : {}),
      upstreamContentHash,
      reviewPath: conclusion.doc.factsRef.path,
      reviewContentHash: conclusion.doc.factsRef.contentHash,
      conclusionPath: conclusion.path,
      conclusionContentHash: conclusion.contentHash,
      decisionId: decision.id,
      decisionBindingFingerprint: decision.bindingFingerprint,
      selectedFiles: selected,
      excludedFiles: partial ? allPaths.filter((p) => !selected.includes(p)).sort() : [],
      adaptation: identity.kind,
      note: '部分适配产物独立生成；上游饭目录不修改，来源关系逐项保留',
    },
    notExecuted: [
      'import of candidate files', 'npm', 'pnpm', 'build', 'pack',
      'install scripts', 'prepare / lifecycle hooks', 'dependency resolution',
    ],
    buildMethod: 'readFileSync → writeFileSync 字节复制（只读饭目录仓库）',
    ...(decision.productionApproval === true ? {} : { testData: { simulated: true, isolationOnly: true, nonProduction: true } }),
    scopeNote: 'W5 产物不写运行态；ready 由 pipeline 在产物校验与授权检查都通过后才推进',
  };

  // ④ 只做字节复制
  mkdirSync(warehouseDir, { recursive: true });
  for (const f of plannedFiles) {
    const src = join(riceWarehouse, f.path);
    const dst = join(warehouseDir, f.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
  }
  atomicJson(artifactContentListPath, contentList);
  atomicJson(manifestPath, manifest);

  appendArtifactIndex(root, {
    artifactId: identity.artifactId,
    version: identity.version,
    revision: identity.revision,
    requestId: record.id,
    decisionId: decision.id,
    contentHash,
    upstreamContentHash,
    kind: identity.kind,
    manifestPath,
    at: manifest.createdAt,
  }, pluginsRoot);

  return {
    status: 'created', artifactDir, manifestPath,
    contentListPath: artifactContentListPath,
    manifest, contentList, identity, plannedFiles,
  };
}

/**
 * 产物校验：全部基于**实际落盘文件复算**，不读 manifest 自证。
 * 返回 {verified, code, checks, drift, recomputed, scopeCheck}（不抛错，由调用方决定放行）。
 */
export function verifyArtifact({ root, record, decision, artifactDir, decisionStore }) {
  void root;
  const manifestPath = join(artifactDir, 'manifest.json');
  const contentListPath = join(artifactDir, '内容清单.json');
  const warehouseDir = join(artifactDir, '仓库');
  const absent = !existsSync(manifestPath) || !existsSync(contentListPath) || !existsSync(warehouseDir);
  if (absent) {
    return { verified: false, code: ART.NOT_BUILT, checks: { artifactExists: false }, drift: null };
  }
  const manifest = readJson(manifestPath);
  const contentList = readJson(contentListPath);
  if (![SCHEMAS.ARTIFACT_MANIFEST, 'hand-artifact-manifest/v1'].includes(manifest.schema)) {
    return { verified: false, code: ART.BAD_MANIFEST, checks: { manifestSchema: false }, drift: null };
  }

  const actualFiles = recomputeFiles(warehouseDir);
  const actualHash = treeHashOf(actualFiles);
  const listedMatch = actualFiles.length === contentList.fileCount
    && actualFiles.every((f, i) => {
      const e = contentList.files[i];
      return e && e.path === f.path && e.bytes === f.bytes && e.sha256 === f.sha256;
    });
  const manifestMatch = actualHash === manifest.contentHash
    && actualHash === contentList.treeHash
    && JSON.stringify(manifest.contentFiles) === JSON.stringify(
      actualFiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })));

  // 与批准对象对应
  const decisionMatch = manifest.derivedFrom?.pinnedCommit === decision.binding.pinnedCommit
    && (decisionStore ? !decisionStore.isInvalidated(decision.id) : true)
    && decision.status === 'active';
  const bindingCheck = compareBinding(decision.binding, computeBinding({
    record, approvedScopes: decision.approvedScopes, kind: decision.kind,
    derivedParts: decision.derivedParts,
    conclusionContentHash: decision.review.conclusionContentHash,
    authorization: decision.authorization,
  }));

  // 整包：产物哈希必须等于上游/批准内容哈希；部分适配：必须等于选中文件的复算哈希
  const sourceDoc = readJson(record.rice.sourcePath);
  const upstreamContentList = readJson(record.rice.contentListPath);
  const upstreamSelected = upstreamContentList.files
    .filter((f) => (manifest.derivedFrom?.selectedFiles ?? []).includes(f.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const expectedFromUpstream = treeHashOf(upstreamSelected);
  const objectMatch = decision.kind === 'partial-adaptation'
    ? actualHash === expectedFromUpstream && actualHash !== decision.binding.contentHash
    : actualHash === decision.binding.contentHash && actualHash === record.source.contentHash;

  const scopeCheck = evaluateGrantedScope({
    manifest,
    scope: manifest.grantedScope,
    approvedScopes: decision.approvedScopes ?? {},
    packageJson: sourceDoc.packageJson,
  });

  const checks = {
    artifactExists: true,
    manifestSchema: true,
    fileListRecomputedEqual: listedMatch,
    contentHashRecomputedEqual: manifestMatch,
    objectMatchesApproval: objectMatch,
    decisionUsable: decisionMatch,
    bindingStillMatches: bindingCheck.match,
    scopeCheckOk: scopeCheck.ok === true && scopeCheck.unknownFields.length === 0,
  };
  const verified = Object.values(checks).every(Boolean);
  const drift = !listedMatch || !manifestMatch || !objectMatch
    ? {
      reason: '产物落盘内容与 manifest / 内容清单 / 批准对象不一致',
      actualHash,
      manifestHash: manifest.contentHash,
      expectedFromUpstream,
      approvedHash: decision.binding.contentHash,
    }
    : null;
  return {
    verified,
    code: verified ? null : ART.CONTENT_DRIFT,
    checks,
    drift,
    recomputed: { fileCount: actualFiles.length, contentHash: actualHash, files: actualFiles },
    scopeCheck,
    bindingCheck,
  };
}

export { DEC };
