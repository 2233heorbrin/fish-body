// Codex#318「从已装插件进入分析」后端编排：
//   已装来源身份 → 按该已装项真实材料采集/复用 → 建分析 → 建任务。
// 本层只做真实编排与边界校验：
//   - 不自动切换已装插件；
//   - 不建 off 任务（off 是直装，mode 严格 compatibility/reverse）；
//   - 不调 confirm / 不写批准，不伪造 analysisApproved/confirmation；
//   - 真 DSH 插件的原生 E2E 由纵向链在隔离宿主执行，本层提供可测函数与真实测试数字。
// 纵向链独占的 market-direct-source.mjs / source-fetch.mjs 与 analysis/service.mjs
// 全部惰性动态 import 或经 deps 注入，便于隔离单测且不依赖并行 Agent 的改动进度。

import fs from 'node:fs';
import path from 'node:path';

// 与 intake-mode.mjs 的三值白名单对齐：这里只放「进入分析」的两值，off 明确拒绝。
const ANALYSIS_MODES = Object.freeze(['compatibility', 'reverse']);
const HEX_COMMIT = /^[0-9a-f]{7,40}$/i;

const fail = reason => ({ ok: false, error: reason instanceof Error ? reason.message : String(reason) });
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const realpathOf = value => fs.realpathSync.native(value);

async function defaultFindInstalled({ frameworkRoot, profileDir, pluginId }) {
  const mod = await import('../backend/lib/market-direct-source.mjs');
  if (typeof mod.findInstalledByPluginId !== 'function') {
    throw new Error('来源查询接口尚未就绪：纵向链需在 market-direct-source.mjs 导出只读 findInstalledByPluginId');
  }
  return mod.findInstalledByPluginId({ frameworkRoot, profileDir, pluginId });
}

async function defaultSourceFetch() {
  return import('../backend/lib/source-fetch.mjs');
}

async function defaultAnalysisAction(args, scope) {
  const { analysisToolAction } = await import('./service.mjs');
  return analysisToolAction(args, scope);
}

/**
 * 从已装来源进入兼容/逆向分析。
 *
 * @param {object} input
 * @param {string} input.frameworkRoot 框架根
 * @param {string} input.profileDir 当前 Profile
 * @param {string} [input.pluginId] 主身份（包名或登记 id）
 * @param {string} [input.nativeId] DSH 原生插件 id（附带回退）
 * @param {string} [input.packageName] 包名（附带回退）
 * @param {'compatibility'|'reverse'} input.mode
 * @param {object} [input.deps] 可注入依赖 {findInstalledByPluginId, sourceFetch:{fetchSourceToRice,recordRiceSource}, analysisToolAction, realpathSync}
 * @returns {Promise<{ok:true,taskId:string,analysisId:string,pluginId:string|null,materialPath:string,channel:string}|{ok:false,error:string}>}
 */
export async function analyzeInstalledFromSource({
  frameworkRoot, profileDir, pluginId, nativeId, packageName, mode, deps = {},
} = {}) {
  try {
    if (!frameworkRoot || typeof frameworkRoot !== 'string') return fail('frameworkRoot 必填');
    if (!profileDir || typeof profileDir !== 'string') return fail('profileDir 必填');
    if (!ANALYSIS_MODES.includes(mode)) {
      return fail('mode 必须是 compatibility 或 reverse；off 表示直装、不进入分析任务');
    }

    const findInstalled = deps.findInstalledByPluginId ?? defaultFindInstalled;
    const analysisAction = deps.analysisToolAction ?? defaultAnalysisAction;
    const realpath = deps.realpathSync ?? realpathOf;

    // ① 身份解析：pluginId 主，nativeId/packageName 附带回退。
    // 只用纵向链摊平记录，不自己拼 installedSpec、不自己解析来源登记文件。
    let found = null;
    for (const id of [pluginId, nativeId, packageName].map(text).filter(Boolean)) {
      found = await findInstalled({ frameworkRoot, profileDir, pluginId: id });
      if (found) break;
    }
    if (!found) {
      return fail('未找到当前 Profile 下该插件的已装受管来源；请先在市场直装该插件后重试');
    }

    const sourcePackageName = text(found.packageName) ?? text(packageName) ?? text(pluginId) ?? null;
    const sourceSpec = text(found.sourceSpec) ?? text(found.npmSpec) ?? '';
    const sourceUrl = text(found.sourceUrl) ?? '';
    const isGithub = text(found.sourceKind) === 'github'
      || /^https?:\/\/github\.com\//i.test(sourceUrl)
      || /^github:/i.test(sourceSpec);

    let materialPath;
    let channel;
    let collectedEntry = null;

    if (isGithub) {
      // ②a GitHub 来源：按该已装项本次实际来源/提交采集（fetchSourceToRice 内部对已采材料 reused，不重采）。
      if (!sourceUrl) return fail('已装 GitHub 来源缺少 sourceUrl，无法定位材料');
      const fetchArgs = {
        frameworkRoot,
        url: sourceUrl,
        revision: HEX_COMMIT.test(text(found.resolvedCommit) ?? '') ? text(found.resolvedCommit) : null,
        ref: text(found.requestedRef) ?? text(found.ref) ?? null,
        subdir: text(found.sourceSubdir) ?? null,
      };
      const sourceFetch = deps.sourceFetch ?? await defaultSourceFetch();
      const fetchFn = deps.fetchSourceToRice ?? sourceFetch.fetchSourceToRice;
      const recordFn = deps.recordRiceSource ?? sourceFetch.recordRiceSource;
      const entry = await fetchFn(fetchArgs);
      await recordFn({ frameworkRoot, entry, riceDir: entry.entryDir, packageName: sourcePackageName });
      if (!entry.repoDir) return fail('材料采集未返回仓库目录（repoDir）');
      // repoDir 是完整仓库；subdir（fetch 实际采集值，found 摊平记录兜底）才是本次已装子包范围。
      // materialPath 必须收窄到子包，否则 worker 会扫整仓、纳入兄弟包与仓根材料。
      const repoRoot = realpath(entry.repoDir);
      const subdir = text(entry.subdir) ?? text(found.sourceSubdir) ?? '';
      if (subdir) {
        const segments = subdir.split('/').filter(Boolean);
        materialPath = path.join(repoRoot, ...segments);
        // 纵深防御：拼接结果与 realpath 后都必须仍落在仓库根内（normalizeSubdir 已在采集侧净化 subdir）。
        const rel = path.relative(repoRoot, materialPath);
        if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          return fail('已装子包路径越出仓库范围：' + subdir);
        }
        materialPath = realpath(materialPath);
        const rel2 = path.relative(repoRoot, materialPath);
        if (!rel2 || rel2 === '..' || rel2.startsWith('..' + path.sep) || path.isAbsolute(rel2)) {
          return fail('已装子包 realpath 越出仓库范围：' + subdir);
        }
      } else {
        materialPath = repoRoot; // 仓库根来源：subdir 为空，整仓即子包，保持原行为不回归
      }
      collectedEntry = entry;
      channel = 'github';
    } else {
      // ②b npm 来源（市场默认）：直接用真实已装落盘字节 bodyPath，非手工 symlink。
      // worker 会如实标注 'exact scoped bytes; no upstream commit claim'。
      const bodyPath = text(found.bodyPath);
      if (!bodyPath) return fail('已装 npm 来源缺少 bodyPath，无法定位已装材料');
      if (!path.isAbsolute(bodyPath)) return fail('已装 bodyPath 必须是绝对路径');
      materialPath = realpath(bodyPath);
      channel = 'npm';
    }

    if (!materialPath || !fs.statSync(materialPath).isDirectory()) {
      return fail('材料路径不是可分析目录：' + materialPath);
    }

    // ③ 建分析：analysisSource.kind='local' 指向真实材料目录（worker 只读该目录字节）。
    const analyzeResult = await analysisAction({
      action: 'analyze',
      analysisType: 'initial',
      analysisSource: { kind: 'local', path: materialPath },
    }, { frameworkRoot, profileDir });
    if (!analyzeResult?.ok) {
      return fail('分析未成功：' + (analyzeResult?.error ?? analyzeResult?.result?.error ?? '分析入口返回失败'));
    }
    const analysisId = analyzeResult.result?.analysisId;
    if (!analysisId) return fail('分析成功但未返回 analysisId');

    // ④ 建任务（同步）：mode 决定兼容/逆向；不切插件、不建 off、不 confirm。
    const taskResult = await analysisAction({
      action: 'task',
      taskOperation: 'create',
      taskMode: mode,
      analysisId,
    }, { frameworkRoot, profileDir });
    if (!taskResult?.ok) {
      return fail('创建任务未成功：' + (taskResult?.error ?? taskResult?.result?.error ?? '任务入口返回失败'));
    }
    const taskId = taskResult.result?.taskId;
    if (!taskId) return fail('任务创建成功但未返回 taskId');

    return {
      ok: true,
      taskId,
      analysisId,
      pluginId: text(pluginId) ?? sourcePackageName ?? text(found.id) ?? null,
      materialPath,
      channel,
      ...(collectedEntry?.head ? { collectedCommit: collectedEntry.head } : {}),
    };
  } catch (error) {
    return fail(error);
  }
}

export default analyzeInstalledFromSource;
