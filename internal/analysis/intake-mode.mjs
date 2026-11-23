// 胃的「 intake 模式」权威定义与持久化默认模式读取点。
// 三模式标识全程为 off / compatibility / reverse：tasks.mjs 的任务模式白名单与前端
// modeChoices 必须与此完全一致，故在此处单点定义、后端共用。
//
// 边界（与 W2 跨 Agent 共享契约一致）：
// - off = 关闭胃：新安装/更新直装跳过分析、零胃分析、零模型请求；不建分析任务、
//   不产 plan/materials、不伪造 approval。胃关 ≠ 身体关。
// - 该模块的持久化默认模式只影响「新请求」的权威判定，绝不改写已有任务。
// - backend-entry.js 的 conf.mode='production' 是部署模式，与本模块无关，勿混。
import fs from 'node:fs';
import path from 'node:path';

/** 三模式白名单：后端 task.mode 与前端 modeChoices 的唯一真源。顺序即 UI 展示顺序。 */
export const INTAKE_MODES = Object.freeze(['off', 'compatibility', 'reverse']);
/** 系统默认：未显式选择、且无持久化默认时采用（保留既有行为，兼容拆分）。 */
export const DEFAULT_INTAKE_MODE = 'compatibility';
/** 既有配置存储 fish-body-state.json 中承载「用户默认工作模式」的字段名。
 *  与部署字段 mode 区分，避免把 production/isolation 误当胃模式。需与前端约定此键名。 */
export const INTAKE_MODE_KEY = 'intakeMode';
const STATE_FILENAME = 'fish-body-state.json';

/**
 * 从既有配置存储读取持久化的用户默认工作模式。
 * @param source 可为 profileDir 字符串（读取 <dir>/fish-body-state.json）、已加载的配置对象，或 null。
 * @returns 合法三模式之一；缺文件/缺字段/非法值一律返回 null（绝不把不可信配置注入白名单）。
 */
export function readPersistedIntakeMode(source) {
  let raw = null;
  try {
    if (typeof source === 'string' && source) {
      raw = JSON.parse(fs.readFileSync(path.join(source, STATE_FILENAME), 'utf8').replace(/^\uFEFF/, ''));
    } else if (source && typeof source === 'object' && !Array.isArray(source)) {
      raw = source;
    }
  } catch { raw = null; }
  const value = raw?.[INTAKE_MODE_KEY];
  return INTAKE_MODES.includes(value) ? value : null;
}

/**
 * 新请求的权威模式判定：显式请求 > 持久化默认 > 系统默认。
 * 只用于「新请求」起点（例如 create），不参与已选中/已确认任务的任何行为。
 */
export function resolveIntakeMode({ explicit = null, persisted = null, fallback = DEFAULT_INTAKE_MODE } = {}) {
  if (INTAKE_MODES.includes(explicit)) return explicit;
  if (INTAKE_MODES.includes(persisted)) return persisted;
  return INTAKE_MODES.includes(fallback) ? fallback : DEFAULT_INTAKE_MODE;
}

/** 普通安装意图种类（市场 / CLI 直装）：这类入口固定 off，绝不读持久化分析模式。 */
export const INSTALL_KINDS = Object.freeze(['market', 'cli']);

/**
 * 安装意图分流（Codex #315 #2 / W2 共享契约 §2）：把「普通安装意图」与「显式分析意图」分开判定。
 * 解决"胃里选了 compatibility/reverse 就污染市场普通安装"的问题——普通市场/CLI 安装已有明确
 * 安装意图，固定直装 off；只有显式分析请求才读分析模式。判定优先级：
 *   ① explicitIntakeMode 合法：入口携带并受理后固定的请求选择 → 用它（intent=explicit）。
 *   ② installKind ∈ INSTALL_KINDS（市场/CLI 普通安装）：固定 off → 完全不读持久化配置（intent=install）。
 *   ③ 其余（显式分析入口 / 历史未声明调用）：persisted > fallback 的分析默认模式（intent=analysis）。
 * 返回 {mode,intent,source} 供调用方/审计如实记录判定依据；不在此处建任务、不产 plan/materials、
 * 不伪造 approval。纵向链市场入口应显式传 installKind:'market' 以命中 ②。
 * @returns {{mode:string, intent:'explicit'|'install'|'analysis', source:string}}
 */
export function resolveInstallIntent({ explicitIntakeMode = null, installKind = null, persisted = null, fallback = DEFAULT_INTAKE_MODE } = {}) {
  if (INTAKE_MODES.includes(explicitIntakeMode)) {
    return { mode: explicitIntakeMode, intent: 'explicit', source: 'request' };
  }
  if (INSTALL_KINDS.includes(installKind)) {
    return { mode: 'off', intent: 'install', source: 'install-kind' };
  }
  return { mode: resolveIntakeMode({ persisted, fallback }), intent: 'analysis', source: 'analysis-default' };
}
