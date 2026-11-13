/**
 * 「鱼的身体」总开关 · 只读桥接层（W1）
 *
 * bundle Profile 的唯一事实来源：原生 package.json 的 dsh.profile.bundles 选择。
 * 旧直接加载 Profile 仍读 cordis.patch.yml；两种原生部署形态不建立第二套持久化开关。
 * 进程内「在途身体操作数」用于把「已停用但还有安装事务未收尾」表达为 closing。
 *
 * 零外部依赖：只用 node 内置模块（fs / path / url）。
 * 绝不误关：文件读不到、解析不出、disabled 是 !!js 表达式 → 一律 on。
 * 判定口径（契约）：
 *   - 顶层（列 0 的 "- " 项）中最后一个 id===fish-body 的非 insert 项：
 *       disabled===true → off；disabled===false / 缺失 → on；!!js 表达式字符串 → 保守 on；
 *   - 顶层 "- insert:" 内的 fish-body 子项自带 disabled:true → 也算 off；
 *   - off 且本进程活跃身体操作数 > 0 → 'closing'。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BODY_ENTRY_ID = 'fish-body';

function bodyBundleSelection(profileDir) {
  if (!profileDir) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) return null;
    if (!Object.hasOwn(manifest.dependencies ?? {}, BODY_ENTRY_ID) && !bundles.includes(BODY_ENTRY_ID)) return null;
    return { enabled: bundles.includes(BODY_ENTRY_ID) };
  } catch { return null; }
}

/** Same native installation/selection identity used by manager and startup hooks. */
export function bodyUsesBundle(profileDir) {
  return bodyBundleSelection(profileDir) !== null;
}

/* ------------------------------------------------------------------ 进程内在途计数（跨模块实例共享） */

const SLOT = Symbol.for('fish-body.switch.v1');

function shared() {
  let slot = globalThis[SLOT];
  if (!slot || !(slot.ops instanceof Map)) {
    slot = { ops: new Map() };
    globalThis[SLOT] = slot;
  }
  slot.closing ??= new Map();
  slot.listeners ??= new Map();
  slot.idle ??= new Map();
  return slot;
}
const opTable = () => shared().ops;

function keyOf(profileDir) {
  if (profileDir === null || profileDir === undefined || profileDir === '') return '';
  try {
    let path = resolve(String(profileDir).replace(/\\/g, '/'));
    if (existsSync(path)) path = realpathSync.native(path);
    path = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? path.toLowerCase() : path;
  } catch {
    return String(profileDir);
  }
}

export function markOperationStart(profileDir) {
  const map = opTable();
  const key = keyOf(profileDir);
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  notifyBodyPhase({ profileDir });
  return next;
}

export function markOperationEnd(profileDir) {
  const map = opTable();
  const key = keyOf(profileDir);
  const n = map.get(key) ?? 0;
  if (n <= 1) map.delete(key);
  else map.set(key, n - 1);
  if (n <= 1) {
    for (const resolve of shared().idle.get(key) ?? []) resolve();
    shared().idle.delete(key);
  }
  notifyBodyPhase({ profileDir });
  return Math.max(0, n - 1);
}

export function activeOperationCount(profileDir) {
  return opTable().get(keyOf(profileDir)) ?? 0;
}

/** Per-profile observers own only their existing resources, not a second switch. */
export function observeBodyPhase(hints, listener) {
  const key = keyOf(locatePatch(hints).profileDir);
  const rows = shared().listeners.get(key) ?? new Set();
  shared().listeners.set(key, rows);
  const row = { hints, listener, pending: Promise.resolve() };
  rows.add(row);
  row.pending = Promise.resolve(listener(readBodyPhase(hints)));
  row.pending.catch(() => {});
  return () => { rows.delete(row); if (!rows.size) shared().listeners.delete(key); };
}

export function notifyBodyPhase(hints) {
  const key = keyOf(locatePatch(hints).profileDir);
  const waits = [];
  for (const row of shared().listeners.get(key) ?? []) {
    const update = () => row.listener(readBodyPhase(row.hints));
    row.pending = row.pending.then(update, update);
    // Counter finalizers are synchronous; the native switch awaits this result.
    row.pending.catch(() => {});
    waits.push(row.pending);
  }
  const result = Promise.all(waits);
  result.catch(() => {});
  return result;
}

/** Called around DSH's existing change()/lock/reload, never writes selection. */
export async function runBodySwitchChange({ profileDir, enabled, operation, changed = () => {} }) {
  const hints = { profileDir }, key = keyOf(profileDir);
  const token = {};
  if (!enabled) {
    const pending = shared().closing.get(key) ?? new Set();
    pending.add(token); shared().closing.set(key, pending);
  }
  try {
    changed();
    await notifyBodyPhase(hints);
    if (!enabled && activeOperationCount(profileDir)) {
      await new Promise(resolve => {
        const waits = shared().idle.get(key) ?? new Set();
        waits.add(resolve); shared().idle.set(key, waits);
      });
    }
    return await operation();
  } finally {
    const pending = shared().closing.get(key);
    pending?.delete(token);
    if (pending?.size === 0) shared().closing.delete(key);
    await notifyBodyPhase(hints);
    changed();
  }
}

export async function withBodyOperation(profileDir, fn) {
  markOperationStart(profileDir);
  try { return await fn(); }
  finally { markOperationEnd(profileDir); }
}

/* ------------------------------------------------------------------ patch 路径定位（只读） */

function defaultStateConfigPath() {
  // 与 production-state.deployedConfigPath() 同落位约定（本模块不 import 它，保持零依赖）。
  try {
    return fileURLToPath(new URL(
      '../../../fish-hand-config/plugin-admission-state.json', import.meta.url));
  } catch { return null; }
}

function defaultProfileFromState(stateConfigPath) {
  if (!stateConfigPath) return null;
  try {
    const doc = JSON.parse(readFileSync(stateConfigPath, 'utf8'));
    return typeof doc?.defaultProfileDir === 'string' && doc.defaultProfileDir
      ? doc.defaultProfileDir : null;
  } catch { return null; }
}

function locatePatch(hints) {
  if (typeof hints.patchPath === 'string' && hints.patchPath) {
    return { patchPath: hints.patchPath,
      profileDir: (typeof hints.profileDir === 'string' && hints.profileDir)
        ? hints.profileDir : dirname(hints.patchPath) };
  }
  if (typeof hints.profileDir === 'string' && hints.profileDir) {
    return { patchPath: join(hints.profileDir, 'cordis.patch.yml'),
      profileDir: hints.profileDir };
  }
  if (typeof hints.absoluteConfigPath === 'string' && hints.absoluteConfigPath) {
    const dir = dirname(hints.absoluteConfigPath);
    return { patchPath: join(dir, 'cordis.patch.yml'), profileDir: dir };
  }
  const fallback = defaultProfileFromState(hints.stateConfigPath);
  if (fallback) {
    return { patchPath: join(fallback, 'cordis.patch.yml'), profileDir: fallback };
  }
  return { patchPath: null,
    profileDir: (typeof hints.profileDir === 'string' && hints.profileDir) ? hints.profileDir : null };
}

/* ------------------------------------------------------------------ cordis.patch.yml 轻量只读解析 */

/** 去掉行尾 `# 注释`（值里不含带引号的 #，真实配置与 writePluginEnabled 产物均满足）。 */
function stripComment(s) {
  const text = String(s ?? '');
  const hit = text.search(/\s+#/);
  return (hit === -1 ? text : text.slice(0, hit)).trim();
}

function unquote(s) {
  return stripComment(s).replace(/^['"]|['"]$/g, '');
}

/** disabled 是否字面为布尔 true；!!js 表达式/其它字符串一律保守不算禁用。 */
function disabledIsTrue(raw) {
  if (raw === null || raw === undefined) return false;
  const v = String(raw).trim();
  if (/^!!js\b/.test(v)) return false;
  const bare = stripComment(v);
  return bare === 'true' || bare === "'true'" || bare === '"true"';
}

function isJsExpression(raw) {
  return raw !== null && raw !== undefined && /^\s*!!js\b/.test(String(raw));
}

/** 顶层（列 0 的 "- " 项）分块；块标量内容都有缩进，不会被列 0 规则误判。 */
function topLevelItems(text) {
  const items = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^-(\s|$)/.test(line)) {
      current = { lines: [line] };
      items.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return items;
}

function itemInfo(item) {
  const lines = item.lines;
  const first = lines[0] ?? '';
  const isInsert = /^-\s*insert\s*:/.test(first)
    || lines.some((l) => /^  insert\s*:/.test(l));
  let id = null;
  const headId = /^-\s*id\s*:\s*(.*)$/.exec(first);
  if (headId) id = unquote(headId[1]);
  if (id === null) {
    for (const l of lines) {
      const m = /^  id\s*:\s*(.*)$/.exec(l);
      if (m) { id = unquote(m[1]); break; }
    }
  }
  let disabledRaw = null;
  for (const l of lines) {
    const m = /^  disabled\s*:\s*(.*)$/.exec(l);
    if (m) { disabledRaw = m[1]; break; }
  }
  if (disabledRaw === null) {
    const head = /^-\s*disabled\s*:\s*(.*)$/.exec(first);
    if (head) disabledRaw = head[1];
  }
  return { isInsert, id, disabledRaw, lines };
}

/** insert 块内 id===fish-body 的子项是否自带 `disabled: true`（block 形式，与真实文件一致）。 */
function insertFishBodyDisabledTrue(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s+)-\s+id\s*:\s*(.*)$/.exec(lines[i]);
    if (!m || unquote(m[2]) !== BODY_ENTRY_ID) continue;
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      const nextItem = /^(\s+)-\s/.exec(l);
      if (nextItem && nextItem[1].length <= indent) break;
      const mDis = /^(\s+)disabled\s*:\s*(.*)$/.exec(l);
      if (mDis && mDis[1].length > indent && disabledIsTrue(mDis[2])) return true;
    }
  }
  return false;
}

function analyzePatch(text) {
  let lastOverrideOff = false;   // 最后一个非 insert 的 fish-body 覆盖项：disabled===true
  let lastOverrideExpr = false;  // 最后一个覆盖项的 disabled 是 !!js 表达式（保守 on）
  let overrideCount = 0;
  let insertChildOff = false;
  for (const item of topLevelItems(text)) {
    const info = itemInfo(item);
    if (!info.isInsert) {
      if (info.id === BODY_ENTRY_ID) {
        overrideCount += 1;
        lastOverrideExpr = isJsExpression(info.disabledRaw);
        lastOverrideOff = disabledIsTrue(info.disabledRaw);
      }
      continue;
    }
    if (insertFishBodyDisabledTrue(info.lines)) insertChildOff = true;
  }
  const off = lastOverrideOff || insertChildOff;
  let reason;
  if (off) {
    const parts = [];
    if (lastOverrideOff) parts.push('顶层最后一个 fish-body 覆盖项 disabled: true');
    if (insertChildOff) parts.push('顶层 insert 内的 fish-body 子项 disabled: true');
    reason = `off: ${parts.join('；')}`;
  } else if (lastOverrideExpr) {
    reason = 'on (conservative): 最后一个 fish-body 覆盖项的 disabled 是 !!js 表达式，保守视为启用';
  } else if (overrideCount > 0) {
    reason = 'on: 最后一个 fish-body 覆盖项未禁用（disabled=false 或缺失）';
  } else {
    reason = 'on: 未发现 fish-body 禁用覆盖（默认启用）';
  }
  return { off, reason };
}

/* ------------------------------------------------------------------ 对外契约 */

/**
 * 只读解析 profile 的 cordis.patch.yml。
 * @param hints { profileDir, patchPath, absoluteConfigPath, stateConfigPath }
 * @returns { phase, active, profileDir, patchPath, reason }
 *   phase ∈ 'on' | 'closing' | 'off'；active = (phase === 'on')。
 */
export function readBodyPhase(hints = {}) {
  const h = hints && typeof hints === 'object' ? hints : {};
  const loc = locatePatch(h);
  const bundle = bodyBundleSelection(loc.profileDir);
  let off = false;
  let reason;
  if (bundle) {
    off = !bundle.enabled;
    reason = `${off ? 'off' : 'on'}: 原生 Profile bundle fish-body ${off ? '未选择' : '已选择'}`;
  } else if (!loc.patchPath) {
    reason = 'on (fail-safe): 无法定位 cordis.patch.yml（缺少 profileDir/patchPath/stateConfigPath 线索）';
  } else {
    let text = null;
    try {
      if (!existsSync(loc.patchPath)) throw new Error('ENOENT');
      text = readFileSync(loc.patchPath, 'utf8');
    } catch { text = null; }
    if (text === null) {
      reason = `on (fail-safe): 读取 ${loc.patchPath} 失败`;
    } else {
      const a = analyzePatch(text);
      off = a.off;
      reason = a.reason;
    }
  }
  const ops = activeOperationCount(loc.profileDir);
  let phase = off ? 'off' : 'on';
  if (shared().closing.get(keyOf(loc.profileDir))?.size || (phase === 'off' && ops > 0)) {
    phase = 'closing';
    reason = `${reason}; closing: 当前 Profile 有 ${ops} 个在途身体操作，等待原生关闭完成`;
  }
  return {
    phase,
    active: phase === 'on',
    operations: ops,
    profileDir: loc.profileDir ?? null,
    patchPath: loc.patchPath ?? null,
    reason,
  };
}

export function bodyPhase(hints = {}) {
  return readBodyPhase(hints).phase;
}

/** 供状态端点用；无 hints 时按包落位推导状态配置，再取 defaultProfileDir。 */
export function describeBodySwitch(hints = {}) {
  const h = hints && typeof hints === 'object' ? { ...hints } : {};
  if (!h.stateConfigPath) h.stateConfigPath = defaultStateConfigPath();
  return readBodyPhase(h);
}
