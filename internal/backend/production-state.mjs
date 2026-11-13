import { AsyncLocalStorage } from 'node:async_hooks';
const profileState = new AsyncLocalStorage();
export function withStateConfig(path, operation) { return profileState.run({path: resolve(path)}, operation); }
import { pathIdentity } from './lib/path-identity.mjs';
/**
 * 正式候选 · 生产状态视图（唯一 canonical：鱼的手 registry + 请求/决定 + W5 产物）
 *
 * 运行路径不引用隔离台账、样例包、临时目录或固定测试 profile 白名单。
 *
 * 配置发现（启动路径，不依赖测试手动设环境变量）：
 *   ① setStateConfigPath() 显式设定（宿主接线在本进程内调用）；
 *   ② FISH_HAND_STATE 环境变量（显式覆盖，供隔离复核与运维临时指向）；
 *   ③ 部署位置约定：本模块随包落在 <hostRoot>/node_modules/@deepseek-ai/<pkg>/，
 *      配置落在 <hostRoot>/fish-hand-config/plugin-admission-state.json。
 *   三者都没有就 fail-closed 抛 FH_STATE_MISSING（不猜默认路径）。
 *
 * 两种 mode：
 *   - production：由 registry-adapter 从真实 registry / 请求记录 / 正式决定 / W5 产物构建候选。
 *   - isolation：同样走 registry-adapter；仅当显式给出 testStatePath 时回退到预拼装视图
 *     （供 gate 机械行为探针使用，不代表数据链路；每次加载都会在审计里标注来源）。
 *
 * 刷新语义：视图按数据源签名（registry / requests / decisions / artifacts 的 stat 摘要）失效，
 * 不再永久使用首次缓存 —— 安装后、批准后、进程重启后都能看到最新 registry 与决定。
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProductionCandidates } from './registry-adapter.mjs';

const ENV = 'FISH_HAND_STATE';
/** 部署位置约定（deploy/deploy.mjs 写同一位置）。 */
export const HAND_CONFIG_DIRNAME = 'fish-hand-config';
export const STATE_CONFIG_FILENAME = 'plugin-admission-state.json';
let cached = null;
let explicitConfigPath = null;

/** 本包所在 hostRoot 下的约定配置路径（不读环境变量，纯按落位推导）。 */
export function deployedConfigPath() {
  // <hostRoot>/node_modules/@deepseek-ai/<pkg>/ → ../../../ = <hostRoot>/
  return fileURLToPath(new URL(
    `../../../${HAND_CONFIG_DIRNAME}/${STATE_CONFIG_FILENAME}`, import.meta.url));
}

/** 显式设定配置路径（宿主接线调用；不是环境变量）。传 null 清除。 */
export function setStateConfigPath(path) {
  explicitConfigPath = path ? resolve(String(path)) : null;
  cached = null;
  return explicitConfigPath;
}

/** 当前生效的配置路径；找不到即 fail-closed。 */
export function resolveStateConfigPath() {
  const scoped = profileState.getStore()?.path;
  if (scoped) { if (!existsSync(scoped)) throw new Error('[FH_STATE_MISSING] Profile configuration missing'); return scoped; }
  const candidates = [];
  if (explicitConfigPath) candidates.push(explicitConfigPath);
  if (process.env[ENV]) candidates.push(resolve(process.env[ENV]));
  candidates.push(deployedConfigPath());
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(`[FH_STATE_MISSING] 找不到生产状态配置（按序尝试）：${candidates.join(' / ')}`);
}

/** 当前生效的配置路径（解析失败返回 null，用于审计与自检）。 */
export function stateConfigPath() {
  try { return resolveStateConfigPath(); } catch { return null; }
}

/* ------------------------------------------------------------------ 数据源签名（缓存失效依据） */

function fileSig(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch { return 'missing'; }
}

function dirSig(root) {
  try {
    const names = readdirSync(root).sort();
    return names.map((n) => {
      const st = statSync(join(root, n));
      return `${n}=${st.isDirectory() ? 'd' : st.size}:${Math.round(st.mtimeMs)}`;
    }).join(',');
  } catch { return 'missing'; }
}

/** registry / 请求 / 正式决定 / W4 决定 / 产物 / 配置文件 任一变化都会换签名 → 视图重建。 */
function stateSignature(conf, configPath) {
  const decisions = conf.decisionsRoot ?? '';
  return [
    `cfg=${configPath}`,
    `cfgsig=${fileSig(configPath)}`,
    `mode=${conf.mode ?? ''}`,
    `reg=${fileSig(conf.registryPath ?? '')}`,
    `req=${dirSig(conf.requestsRoot ?? '')}`,
    `dec=${dirSig(decisions)}`,
    `dec4=${dirSig(join(decisions, 'decisions'))}`,
    `art=${dirSig(conf.artifactsRoot ?? '')}`,
    `test=${fileSig(conf.testStatePath ?? '')}`,
  ].join('#');
}

/* ------------------------------------------------------------------ 配置规范化 */

const REQUIRED = ['registryPath', 'artifactsRoot', 'decisionsRoot', 'profileRoot',
  'snapshotRoot', 'reportDir', 'auditPath'];

function normalizeConfig(raw) {
  const missing = REQUIRED.filter((k) => !raw[k]);
  if (missing.length > 0) throw new Error(`[FH_STATE_INCOMPLETE] 缺少配置：${missing.join(', ')}`);
  const conf = { ...raw };
  // 请求记录目录默认与 registry 同层（canonical：鱼的手/插件注册表/requests）
  conf.requestsRoot = raw.requestsRoot ?? join(dirname(raw.registryPath), 'requests');
  // 归档根（registry 所在分区的上一级 = 鱼的手）
  conf.handRoot = raw.handRoot ?? dirname(dirname(raw.registryPath));
  // 默认目标 profile：显式给出优先，否则取 profileRoot 下唯一的有效 profile
  conf.defaultProfileDir = raw.defaultProfileDir ?? firstProfile(raw.profileRoot);
  if (!conf.defaultProfileDir) {
    throw new Error(`[FH_STATE_INCOMPLETE] 无法确定 defaultProfileDir（profileRoot=${raw.profileRoot}）`);
  }
  conf.mode = raw.mode ?? 'production';
  return conf;
}

function firstProfile(profileRoot) {
  try {
    const profiles=readdirSync(profileRoot).map(n=>join(profileRoot,n)).filter(d=>existsSync(join(d,'package.json')));
    return profiles.length===1?profiles[0]:null;
  } catch { /* 交给调用方报错 */ }
  return null;
}

/** profile 目录 → 该 profile 的注册表配置（remove 后同步 registry 用）。 */
function profileMap(conf) {
  const map = {};
  try {
    for (const n of readdirSync(conf.profileRoot)) {
      const dir = resolve(join(conf.profileRoot, n));
      if (existsSync(join(dir, 'package.json'))) {
        map[dir] = { registryPath: conf.registryPath, profileDir: dir };
      }
    }
  } catch { /* 空表即不放行任何 profile 级写回 */ }
  return map;
}

/** 路径边界校验：profile 必须位于配置的 profileRoot 下，且是真实目录；不再用测试白名单。 */
export function assertProfileAllowed(profileDir) {
  const conf = loadProductionState();
  const root = pathIdentity(conf.profileRoot);
  const target = resolve(String(profileDir ?? ''));
  if (!root || !pathIdentity(target)?.startsWith(root + '/') || !existsSync(join(target, 'package.json'))) {
    throw new Error(`[FH_PROFILE_OUT_OF_BOUND] profile 不在受管根目录或不是有效 profile：${target}`);
  }
  return {
    profileDir: target,
    registryPath: conf.registryPath,
    snapshotRoot: conf.snapshotRoot,
    reportDir: conf.reportDir,
  };
}

/** 规范化配置（启动路径与审计共用；只读配置文件，不构建候选视图）。 */
function readNormalizedConfig() {
  const path = resolveStateConfigPath();
  return { conf: normalizeConfig(JSON.parse(readFileSync(path, 'utf8'))), path };
}

/** 生产审计（结构化 JSONL）；隔离复核时写入各自主机的 logs。
 *  只读配置、不构建候选视图：启动接线阶段也能记录（避免为了打日志先把整个 registry 读一遍）。 */
export function audit(row) {
  const { conf } = readNormalizedConfig();
  const path = conf.auditPath;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({
    at: new Date().toISOString(), pid: process.pid, ...row,
  }) + '\n', 'utf8');
}

/**
 * 构建 gate 需要的同形状状态对象（candidates / problems / registryPath / snapshotRoot / reportDir）。
 * 只在这里做数据源适配，准入/授权/锁/恢复逻辑逐字复用隔离验证实现。
 */
export function loadProductionState({ force = false } = {}) {
  const { conf, path: configPath } = readNormalizedConfig();
  const signature = stateSignature(conf, configPath);
  if (!force && cached && cached.signature === signature) return cached;

  const view = buildView(conf);

  cached = {
    ...conf,
    ...view,
    configPath,
    profiles: profileMap(conf),
    profileRoot: resolve(conf.profileRoot),
    signature,
    loadedAt: new Date().toISOString(),
    refreshes: (force || !cached) ? (cached?.refreshes ?? 0) + 1 : (cached?.refreshes ?? 0),
  };
  // 视图来源与投影问题写入审计（便于事后核对「连的是哪套数据」）
  try {
    mkdirSync(dirname(conf.auditPath), { recursive: true });
    appendFileSync(conf.auditPath, JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, kind: 'state-load',
      source: cached.source, mode: conf.mode, configPath,
      candidates: Object.keys(cached.candidates), problems: cached.problems,
      registryRows: cached.registryRows, refreshes: cached.refreshes,
    }) + '\n', 'utf8');
  } catch { /* 审计不可写不阻断准入判定本身 */ }
  return cached;
}

function buildView(conf) {
  if (conf.mode === 'production' || !conf.testStatePath) {
    const built = buildProductionCandidates({
      handRoot: conf.handRoot,
      registryPath: conf.registryPath,
      requestsRoot: conf.requestsRoot,
      artifactsRoot: conf.artifactsRoot,
      decisionsRoot: conf.decisionsRoot,
      injectionReviewSchema: conf.injectionReviewSchema ?? null,
    });
    return {
      source: 'registry-adapter',
      candidates: built.candidates,
      problems: built.problems,
      registryRows: built.registryRows,
    };
  }
  // 仅 gate 机械行为探针使用的预拼装视图（数据链路验收不采用此路径）
  if (!existsSync(conf.testStatePath)) {
    throw new Error('[FH_TEST_STATE_MISSING] isolation mode 需要 testStatePath');
  }
  const testView = JSON.parse(readFileSync(conf.testStatePath, 'utf8'));
  return {
    source: 'preassembled-test-state',
    candidates: testView.candidates ?? {},
    problems: [],
    registryRows: null,
  };
}

/**
 * 既有插件兼容：state=active 且没有决定绑定的行（utility.sha256 / 两个既有开关插件等）。
 * 它们不受新准入影响；本设计只决定「能不能装 / 能不能挂载」，不改变已挂载插件的工具可见性。
 */
export function legacyPluginNames() {
  const conf = loadProductionState();
  const out = new Set();
  try {
    const registry = JSON.parse(readFileSync(conf.registryPath, 'utf8'));
    const rows = Array.isArray(registry.plugins)
      ? registry.plugins : Object.values(registry.plugins ?? {});
    for (const row of rows) {
      const name = row?.pluginId ?? row?.packageName;
      // 既有 registry 行可能只写 status（V1 数组 schema），新行写 state；两者都认。
      const st = row?.state ?? row?.status ?? null;
      if (st === 'active' && !row?.decisionId && !row?.formalDecisionId && name) {
        out.add(name);
      }
    }
  } catch { /* registry 不可用时 fail-closed：不额外放行任何行 */ }
  return out;
}

/** 显式刷新（批准后 / 安装后调用；不依赖调用方也能靠签名自动失效）。 */
export function refreshProductionState() { return loadProductionState({ force: true }); }

/** 测试辅助：切换配置后清空缓存（不进入生产运行路径）。 */
export function resetProductionStateForTest() { cached = null; }
