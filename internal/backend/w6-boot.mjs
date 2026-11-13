/**
 * 正式候选 · 启动接线（宿主启动路径上的唯一接线点）
 *
 * 解决三件事，全部在**宿主真实启动路径**上完成，不依赖测试手动设环境变量：
 *   ① 配置发现：<hostRoot>/fish-hand-config/plugin-admission-state.json（按落位推导）；
 *      发现后通过 setStateConfigPath() 告诉 gate，不改环境变量。
 *   ② 入口消费：读 approval-host-entry.json，校验后把审批入口作为 insert 行
 *      并入宿主本次启动的 patch 层，由宿主 Loader 自己 import + apply(ctx)。
 *   ③ 审批服务随原生 Loader 加载；普通组件启停与加载不要求鱼审批。
 *
 * 边界：本模块不做任何 install / 写运行态动作，不 import 鱼人格 / 记忆 / 思考模块。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit, deployedConfigPath, setStateConfigPath } from './production-state.mjs';
import { readBodyPhase } from './lib/body-switch.mjs';

/** 部署清单里的审批入口包名（deploy/deploy.mjs 同值）。 */
export const HOST_PACKAGE = '@deepseek-ai/fish-hand-approval-host';
export const ENTRY_FILENAME = 'approval-host-entry.json';
export const ENTRY_SCHEMA = 'fish-hand-approval-host-entry/v2';
/** 审批入口自己注册的路由；鱼的身体（/api/fish-body/*）由既有入口负责，不在此重复注册。 */
export const APPROVAL_ROUTES = Object.freeze([
  { path: '/api/fish-hand/pending', methods: ['GET', 'POST'] },
  { path: '/api/fish-hand/review', methods: ['POST'] },
  { path: '/api/fish-hand/approve', methods: ['POST'] },
  { path: '/api/fish-hand/reject', methods: ['POST'] },
  { path: '/api/fish-hand/status', methods: ['GET'] },
]);
export const BODY_ROUTE_PREFIX = '/api/fish-body/';

/** 配置目录：与 deployedConfigPath() 同源（<hostRoot>/fish-hand-config）。 */
export function handConfigDir() {
  return dirname(deployedConfigPath());
}

/** 部署根（<hostRoot>）：配置目录的上一级。 */
export function hostRootDir() {
  return dirname(handConfigDir());
}

const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();

/**
 * 读取并校验审批入口声明。
 * 校验失败一律返回 ok:false + problems，由调用方决定「拒绝启动」还是「不接线」。
 */
export function readApprovalHostEntry({ configDir = handConfigDir() } = {}) {
  const path = join(configDir, ENTRY_FILENAME);
  const base = { path, configDir, entry: null, entryPath: null, entryUrl: null, problems: [] };
  if (!existsSync(path)) {
    return { ...base, ok: false, code: 'FH_ENTRY_MISSING', problems: ['缺少审批入口声明'] };
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ...base, ok: false, code: 'FH_ENTRY_UNREADABLE',
      problems: [`审批入口声明不可解析：${String(error?.message ?? error)}`] };
  }
  const problems = [];
  if (doc?.schema !== ENTRY_SCHEMA) problems.push(`schema 不符：${String(doc?.schema)}`);
  if (doc?.package !== HOST_PACKAGE) problems.push(`包名不符：${String(doc?.package)}（只允许 ${HOST_PACKAGE}）`);
  const rawEntry = typeof doc?.entry === 'string' ? doc.entry : '';
  if (!rawEntry) problems.push('缺少 entry');
  const hostRoot = dirname(configDir);
  const entryPath = rawEntry
    ? (isAbsolute(rawEntry) ? resolve(rawEntry) : resolve(hostRoot, rawEntry)) : null;
  if (entryPath && !existsSync(entryPath)) problems.push(`入口文件不存在：${entryPath}`);
  // 落位必须是本 hostRoot 下 node_modules 里的**该包自身**
  const expectedDir = join(hostRoot, 'node_modules', ...HOST_PACKAGE.split('/'));
  if (entryPath && norm(dirname(entryPath)) !== norm(expectedDir)) {
    problems.push(`入口不在约定落位：${dirname(entryPath)}（应为 ${expectedDir}）`);
  }
  if (entryPath && existsSync(entryPath)) {
    const pkgJson = join(dirname(entryPath), 'package.json');
    if (!existsSync(pkgJson)) problems.push('入口所在目录缺少 package.json');
    else {
      try {
        const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
        if (meta?.name !== HOST_PACKAGE) problems.push(`落位包 package.json name 不符：${String(meta?.name)}`);
      } catch (error) {
        problems.push(`落位包 package.json 不可解析：${String(error?.message ?? error)}`);
      }
    }
  }
  // 不重复注册鱼的身体路由：声明里出现 /api/fish-body/* 即视为越界
  const routes = Array.isArray(doc?.routes) ? doc.routes : [];
  const declared = routes.map((r) => (typeof r === 'string' ? r : r?.path)).filter(Boolean);
  const overlap = declared.filter((p) => String(p).startsWith(BODY_ROUTE_PREFIX));
  if (overlap.length > 0) problems.push(`审批入口不得注册鱼的身体路由：${overlap.join(', ')}`);
  const missing = APPROVAL_ROUTES.map((r) => r.path).filter((p) => !declared.includes(p));
  if (missing.length > 0) problems.push(`审批入口路由声明缺失：${missing.join(', ')}`);

  const ok = problems.length === 0;
  return {
    ...base, ok, code: ok ? null : 'FH_ENTRY_INVALID', doc,
    entry: ok ? doc : null,
    entryPath: ok ? entryPath : null,
    entryUrl: ok ? pathToFileURL(entryPath).href : null,
    relativeEntry: ok ? relative(hostRoot, entryPath).replace(/\\/g, '/') : null,
    problems,
  };
}

/**
 * 兼容旧调用的审批入口身份集合（不再用于加载准入）：只含声明里那一个入口（URL 与原生路径两种写法）。
 * 声明无效时返回空集合（fail-closed：不放行任何东西）。
 */
export function wiringEntryNames() {
  const entry = readApprovalHostEntry();
  if (!entry.ok) return new Set();
  return new Set([entry.entryUrl, entry.entryPath]);
}

/** 从状态配置推导框架根与手根（不猜测：registry 位置是 canonical 事实）。 */
export function frameRootsOf(config) {
  const registryPath = config?.registryPath;
  if (!registryPath) throw new Error('[FH_WIRING_INCOMPLETE] 状态配置缺少 registryPath');
  const handRoot = config.handRoot ?? dirname(dirname(registryPath));
  return { handRoot, frameworkRoot: config.frameworkRoot ?? dirname(handRoot) };
}

/**
 * 宿主启动接线：在 prepareProfilePatches（含加载准入门）之前调用。
 *
 * 返回值是**并入审批入口行之后**的 patch 层；调用方必须用返回值继续组合。
 * 未安装鱼手准入（既无配置也无入口）时原样返回，保持内核原行为。
 */
export function w6bBootWire({ absoluteConfigPath = null, patches = [], ctx = null, binName = 'dsh' } = {}) {
  const configDir = handConfigDir();
  const statePath = deployedConfigPath();

  // 「鱼的身体」总开关：只读 profile 的 cordis.patch.yml（不写、不改原生状态）。
  // profileDir 优先级：ctx.profileContext.patchPath/.dir → dirname(absoluteConfigPath)/cordis.patch.yml
  // → state 配置里的 defaultProfileDir。mountRootInclude(4133) 与 recompose(3802) 都经过这里，同一判定同时生效。
  let pc = null;
  try { pc = ctx?.get?.('profileContext') ?? null; } catch { pc = null; }
  const bodyPatchPath = (typeof pc?.patchPath === 'string' && pc.patchPath)
    ? pc.patchPath
    : (typeof absoluteConfigPath === 'string' && absoluteConfigPath
      ? join(dirname(absoluteConfigPath), 'cordis.patch.yml') : null);
  const bodyProfileDir = (typeof pc?.dir === 'string' && pc.dir)
    ? pc.dir : (bodyPatchPath ? dirname(bodyPatchPath) : null);
  const bodySwitch = readBodyPhase({
    profileDir: bodyProfileDir,
    patchPath: bodyPatchPath,
    absoluteConfigPath,
    stateConfigPath: statePath,
  });
  // off：退出干预，恢复 DSH 原生启动行为 —— 不插入审批入口行、不注入配置、不写 boot-wire 审计。
  if (bodySwitch.phase === 'off') return patches;

  const entry = readApprovalHostEntry({ configDir });

  if (!existsSync(statePath)) {
    if (entry.ok) {
      // 半装状态：入口在、配置缺 → fail-closed，不静默跳过
      throw new Error(`[FH_WIRING_INCOMPLETE] 审批入口已落位但缺少生产状态配置：${statePath}`);
    }
    return patches;
  }

  // ① 配置发现（进程内注入，不写环境变量）
  setStateConfigPath(statePath);

  if (!entry.ok) {
    try {
      audit({ kind: 'boot-wire-refused', binName, configPath: statePath, ...entry });
    } catch { /* 审计失败不掩盖接线失败 */ }
    throw new Error(`[FH_WIRING_ENTRY_INVALID] ${entry.problems.join('; ')}`);
  }

  const config = JSON.parse(readFileSync(statePath, 'utf8'));
  const { handRoot, frameworkRoot } = frameRootsOf(config);
  const row = {
    id: 'fish-hand-approval-host',
    name: entry.entryUrl,
    config: {
      frameworkRoot,
      stateConfigPath: statePath,
      mode: config.mode ?? 'production',
      // 审批入口（W2）与状态端点据此只读解析同一个 cordis.patch.yml；closing 时标注正在关闭。
      bodyProfileDir: bodySwitch.profileDir,
      bodyPatchPath: bodySwitch.patchPath,
      ...(bodySwitch.phase === 'closing' ? { bodyPhase: 'closing' } : {}),
    },
  };
  const present = patches.some((p) => (Array.isArray(p?.insert) ? p.insert : [])
    .some((r) => r?.id === row.id || r?.name === row.name || r?.name === entry.entryPath));
  const out = present ? [...patches] : [...patches, { insert: [row] }];

  try {
    audit({
      kind: 'boot-wire', binName, profileConfig: absoluteConfigPath,
      configPath: statePath, entryPath: entry.entryPath, frameworkRoot, handRoot,
      inserted: !present, rows: out.length,
      routes: APPROVAL_ROUTES.map((r) => r.path),
      ctxProfileDir: ctx?.get?.('profileContext')?.dir ?? null,
    });
  } catch { /* 审计失败不阻断启动 */ }
  void handRoot;
  return out;
}
