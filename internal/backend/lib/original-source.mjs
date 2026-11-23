// Original bytes and the user's update channel are separate identities. The
// native host uses pnpm's resolver API to keep both; it owns lock/recovery.
import { readInstalledSource as readDirectInstalledSource } from './market-direct-source.mjs';

export function originalSourceOptions(original, sourcePreservationVersion) {
  if (!original || /^(?:file|link):/i.test(original.requestedSpec ?? '')) return undefined;
  if (sourcePreservationVersion !== 1) throw Object.assign(
    new Error('FH_SOURCE_PRESERVATION_UNAVAILABLE: 原包远端来源保留需要匹配的宿主扩展'),
    {code:'FH_SOURCE_PRESERVATION_UNAVAILABLE'});
  return {fixedPackageSources:[original]};
}

/**
 * 来源判定（W2 纠正①的权威入口）：返回「已成功安装的真实来源记录」或 null。
 * file|link 不再因 originalSourceOptions 返回 undefined 而丢失来源判定——直装与兼容分析
 * 共用本读取逻辑。普通 repository 声明不构成来源；generation/未登记开发 link 也不构成。
 * 与「分析批准」完全分离：本函数只读当前安装与登记/受管记录，不建任务、不生成模型请求、
 * 不伪造 formalDecision/analysisApproved。
 *
 * @param {object} args {frameworkRoot, profileDir, packageName, spec, registryRows?}
 * @returns {object|null} 来源记录 {sourceKind,sourceStatus,targetProfile,packageName,
 *   linkRealPath,contentIdentity,updateChannel,origin,formalDecisionId?}
 */
export function installedSourceRecord({ frameworkRoot, profileDir, packageName, spec, registryRows = [] } = {}) {
  return readDirectInstalledSource({ frameworkRoot, profileDir, packageName, installedSpec: spec, registryRows });
}
