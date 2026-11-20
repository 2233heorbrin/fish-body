/**
 * 手·组件页「来源插件启动/关闭」原生开关适配（C 职责，契约 v1.1）
 *
 * ===== 真实只读核查结论（开发时核查，运行时不扫盘、不读凭据）=====
 * 宿主确实存在原生插件开关 API，但它挂在宿主 pluginManager 的 remote service 单例上，
 * fish-body 插件侧拿不到可调用句柄，故对 fish-body 判定为「原生接口缺口」。
 * 详见导出的 NATIVE_API_PROBE.evidence —— 每条含查过的位置与判定理由。
 *
 * 与「函数导出 + 恒返回 unavailable 假装实现」的区别：
 *  - 唯一真实通道是「本次调用显式传入的 bridge」：readPluginSwitchState(pluginId, bridge) /
 *    setPluginSwitch(pluginId, enabled, bridge)。接线方（A）在每个 ctx 调用时把自己的桥作为
 *    末参显式传入；模块是单例 import，绝不靠 global 槽决定本次用哪个桥，避免多 ctx 串用。
 *  - 不传 bridge 时回退 globalThis[NATIVE_BRIDGE_SLOT]（仅为旧探针/旧接线兼容）。一旦显式传入
 *    一个桥，无论死活都只用这一个：活的用它，非活（如该 ctx 已被新实例接管）走自身缺口，
 *    绝不借 global 槽、绝不借别的 ctx 的管理器。
 *  - 未接桥接前 / 传入非活桥时的缺口对象带具体证据，供前端显示缺口说明、供主模型区分
 *    「已接通」与「阻塞」。缺口对象里带 attachRequirement 说明接线方式。
 *
 * 数据纪律：enabled=原生启用选择（不明为 null，绝不用 fish_hand active 代替）；
 * runtime=实际运行反馈（无证据恒 'unknown'，不伪造健康探测）；registered=fish_hand 手登记
 * （仅登记≠安装≠挂载）。installed=宿主真实已安装，是能否操作的唯一门；enabled/操作结果/runtime
 * 三者分开，任何单一字段不得同时表示"配置已选中"和"实际正常运行"。
 * 不在后台代用户启用任何组件、不写 Profile / cordis.patch.yml、不安装卸载、不批量联动。
 * 可操作性按宿主真实归属（readOnlyReason / 原生条目）判定，不按 pluginId 名字猜脑/身体；
 * 用户明确点击关闭身体时沿用原生页面的卸载语义，本模块不强留页面、不另造审批。
 */

/** 全局共享槽（与 body-switch 的 Symbol.for 共享模式一致，避免多份实例各造开关）。 */
export const NATIVE_BRIDGE_SLOT = Symbol.for('fish-body.plugin-switch.native-bridge.v1');

/**
 * 真实只读核查证据（固化开发时核查结论，运行时只读该常量，不触碰文件系统/凭据）。
 * bridge 形状：
 *   readState(pluginId) -> Promise<{nativeId?,installed?,enabled?,runtime?,registered?,readOnlyReason?,source?,message?}>
 *     installed=宿主真实已安装（boolean，能否操作的唯一门）；readOnlyReason=宿主/组件真实只读归属
 *     （非空字符串=宿主标记只读或内置不可独立开关；由真实归属给出，不靠名字猜）；
 *     registered=fish_hand 手登记（仅登记，绝不当安装门）；nativeId=解析后的真实原生 ID。
 *   setEnabled(nativeId, enabled:boolean) -> Promise<{ok:boolean,message?}>
 *     第一参数是 readState 解析后的 nativeId，不是未经转换的请求 pluginId。
 */
export const NATIVE_API_PROBE = Object.freeze({
  available: false,
  verdict: '宿主已安装 dsh-plugin-manager 确有原生开关 API，但均挂在宿主 ctx.remote.pluginManager 这个 remote service 实例上；fish-body 的 inject 未注入 remote，插件侧拿不到该实例，纯 import 只得到 PluginManager 类而非运行实例。因此对 fish-body 判定为原生接口缺口。',
  evidence: Object.freeze([
    Object.freeze({
      location: 'internal/backend/lib/body-switch.mjs',
      finding: '只控制 fish-body 自身：BODY_ENTRY_ID="fish-body"，读写 cordis.patch.yml 与 bundle 选择，phase∈on/closing/off；不写原生插件状态，不是来源插件启停接口。',
    }),
    Object.freeze({
      location: 'index.js:15',
      finding: 'export const inject = ["connection","sessionController"]；未注入 remote / pluginManager，fish-body 插件 ctx 无 pluginManager 句柄。',
    }),
    Object.freeze({
      location: 'internal/backend/lib/body-manager-patch.mjs',
      finding: 'patchBodyManager()/patchBodyManagerClient() 是对宿主 dsh-plugin-manager 源码做文本替换打补丁，植入 runBodySwitchChange 收尾钩子；其中 setPluginEnabled(entryId,enabled)/setBundleEnabled 是宿主 manager 内部自身调用，不是 fish-body 对外暴露的开关接口。',
    }),
    Object.freeze({
      location: 'internal/backend-entry.js:44',
      finding: "req.resolve('@deepseek-ai/dsh-plugin-manager') 仅用于 installTransactionExtensionVersion∈[1,2] 检查；官方 rc.5 无该扩展（code FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE），不提供插件侧开关句柄。",
    }),
    Object.freeze({
      location: '宿主安装目录 versions/0.2.1-rc.5/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js',
      finding: 'PluginManager extends TypertRemoteService，super(ctx,"pluginManager")；listPlugins()（约1665行，返回 entryId/patchId/moduleName/enabled/readOnlyReason）、setPluginEnabled(id,enabled)（约1939行，内部 writePluginEnabled+reload）、setBundleEnabled(name,enabled)（约1965行）都是 @Remote 方法，只能通过 ctx.remote.pluginManager 调用。',
    }),
    Object.freeze({
      location: '缺口判定',
      finding: '以上原生开关方法需 ctx.remote.pluginManager 运行实例；fish-body 未 inject remote，纯 import 该包仅取得 PluginManager 类、无插件 ctx 运行实例，故 fish-body 侧无可调用的原生开关通道。未找到 fish-body 自身暴露的等价接口。',
    }),
  ]),
  attachRequirement: '若 A 在 index.js 注入 remote：把「本 ctx 的」ctx.remote.pluginManager 适配成 bridge（readState 用 listPlugins() 的条目：nativeId=解析后的真实 entryId/pluginId/moduleName、installed 必须由宿主真实安装条目判定而不是用手登记代替、enabled=原生启用选择、runtime 无真实反馈恒 unknown、registered=fish_hand 手登记、readOnlyReason=宿主/组件真实只读归属字符串或空；setEnabled 的第一参数必须是 readState 解析后的 nativeId，调 setPluginEnabled 并返回 ok）。关键：调用 readPluginSwitchState(pluginId, bridge) / setPluginSwitch(pluginId, enabled, bridge) 时把这个本 ctx 的桥作为末参「显式传入」，模块单例 import 下绝不靠 global 槽决定本次用哪个桥，避免多 ctx 串用；该 ctx 无 remote 或被新实例接管时传一个非活桥或不传，本模块走自身缺口、绝不借别的 ctx。不传 bridge 时回退 globalThis[Symbol.for("fish-body.plugin-switch.native-bridge.v1")]（仅旧探针兼容）。内置组件（如 utility.sha256）不可独立开关由宿主 readOnlyReason/installed 真实归属体现，不靠 pluginId 名字黑名单。',
});

/** 可信的 pluginId 形状（loader entryId / packageName）；只做形状校验，不按名字禁脑/身体。 */
const PLAUSIBLE_ID = /^[A-Za-z0-9][A-Za-z0-9._@/:-]{1,120}$/;
const RUNTIME_VALUES = Object.freeze(['running', 'stopped', 'error']);

/**
 * 解析「本次调用」要用的桥。模块是单例 import，绝不靠 global 槽决定本次用哪个 ctx 的桥。
 * - provided=true：调用方显式传了 bridge 参数（哪怕传 undefined/null）——只用这一个，
 *   非活即返回 bridge:null 走自身缺口，绝不回退 global、绝不借别的 ctx 的管理器。
 * - provided=false（未传该参数）：回退 globalThis[NATIVE_BRIDGE_SLOT]（旧探针/旧接线兼容）。
 * 活桥判定：readState/setEnabled 均为函数；若宿主/A 带 isAlive() 或 isAlive===false 声明
 * 该 ctx 已被新实例接管，则判非活。
 */
function resolveBridge(provided, explicit) {
  const scope = provided ? 'explicit' : 'global';
  let candidate = null;
  if (provided) {
    candidate = explicit;
  } else {
    try { candidate = globalThis[NATIVE_BRIDGE_SLOT]; } catch { candidate = null; }
  }
  if (!candidate || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
    return { bridge: null, scope, reason: 'missing' };
  }
  if (typeof candidate.readState !== 'function' || typeof candidate.setEnabled !== 'function') {
    return { bridge: null, scope, reason: 'bad-shape' };
  }
  try {
    if ((typeof candidate.isAlive === 'function' && !candidate.isAlive()) || candidate.isAlive === false) {
      return { bridge: null, scope, reason: 'stale' };
    }
  } catch {
    return { bridge: null, scope, reason: 'stale' };
  }
  return { bridge: candidate, scope, reason: 'ok' };
}

/** 缺口说明：区分「本 ctx 显式传入的桥非活」与「无桥」，绝不声称已接通。 */
function gapMessage(res, tail) {
  const head = res.scope === 'explicit'
    ? '本 ctx 显式传入的原生桥为非活状态（' + res.reason + '；该 ctx 可能无 remote 或已被新实例接管），本次走自身缺口，未借用 global 槽或其他 ctx 的管理器。'
    : '未发现可调用的原生插件开关接口（证据见 evidence）。';
  return head + tail;
}

/** 给每个显式桥分配稳定身份，供在途去重按 ctx 隔离（A/B 同 ID 并发互不误判重复）。 */
const BRIDGE_IDS = (() => { try { return new WeakMap(); } catch { return null; } })();
let bridgeSeq = 0;
function bridgeScopeKey(res) {
  if (res.scope !== 'explicit' || !res.bridge) return 'g';
  if (!BRIDGE_IDS) return 'b-inline';
  let id = BRIDGE_IDS.get(res.bridge);
  if (!id) { id = 'b' + (++bridgeSeq); BRIDGE_IDS.set(res.bridge, id); }
  return id;
}

function errText(error) {
  const raw = (error && (error.message ?? error.code)) ?? error;
  try { return String(raw).slice(0, 300); } catch { return 'unknown-error'; }
}

/**
 * 纯逻辑：pluginId 形状校验 → 原生身份映射/拒绝原因。只校验形状，不按名字禁脑/身体；
 * 内置/只读组件的不可操作性由宿主真实归属 readOnlyReason 决定（见 read/set）。
 * @returns {{ok:boolean, nativeId?:string, reason?:string}} reason∈'empty-id'|'unmappable-id'
 */
export function classifyPluginTarget(pluginId) {
  const id = typeof pluginId === 'string' ? pluginId.trim() : '';
  if (!id) return { ok: false, reason: 'empty-id' };
  if (!PLAUSIBLE_ID.test(id)) return { ok: false, reason: 'unmappable-id' };
  return { ok: true, nativeId: id };
}

function baseReadOnly(pluginId) {
  return {
    pluginId: pluginId ?? null,
    nativeId: null,
    installed: false,
    enabled: null,
    runtime: 'unknown',
    registered: false,
    source: pluginId ?? null,
    message: '',
  };
}

/**
 * 只读核实：本次调用是否存在可用的原生开关桥接。
 * 传 bridge → 只判断这一个（provided=true，非活即 false，不借 global）；
 * 不传 → 回退 global 槽（兼容旧探针）。
 */
export function isNativeSwitchAvailable(bridge) {
  const res = resolveBridge(arguments.length > 0, bridge);
  return res.bridge !== null;
}

/**
 * 只读核实单个插件的原生启用选择 / 安装映射 / 运行反馈 / fish_hand 登记。
 * 四者分开；任何字段都不同时表示"配置已选中"和"实际正常运行"。
 */
export async function readPluginSwitchState(pluginId, bridge) {
  const base = baseReadOnly(pluginId);
  const scope = resolveBridge(arguments.length > 1, bridge);
  if (!scope.bridge) {
    return {
      ...base,
      code: 'native-api-unavailable',
      evidence: NATIVE_API_PROBE.evidence,
      message: gapMessage(scope, 'enabled=null 表示原生启用选择不明，runtime=unknown 表示无实际运行反馈；fish_hand 登记（registered）只表示已登记，不等于已安装、已挂载或运行正常。'),
    };
  }
  const target = classifyPluginTarget(pluginId);
  if (!target.ok) {
    return { ...base, message: 'pluginId 为空或身份映射不明，未给出可执行启停项。' };
  }
  try {
    const raw = await scope.bridge.readState(target.nativeId);
    const data = raw && typeof raw === 'object' ? raw : {};
    const enabled = data.enabled === true ? true : data.enabled === false ? false : null;
    const runtime = RUNTIME_VALUES.includes(data.runtime) ? data.runtime : 'unknown';
    const readOnlyReason = typeof data.readOnlyReason === 'string' && data.readOnlyReason.trim()
      ? data.readOnlyReason.trim() : '';
    const head = typeof data.message === 'string' && data.message ? data.message + '；' : '';
    const readOnlyNote = readOnlyReason
      ? '宿主标记该组件为只读/内置（' + readOnlyReason + '），本入口不提供独立启停；'
      : '';
    return {
      pluginId,
      nativeId: typeof data.nativeId === 'string' && data.nativeId ? data.nativeId : target.nativeId,
      installed: data.installed === true,
      enabled,
      runtime,
      registered: !!data.registered,
      source: typeof data.source === 'string' && data.source ? data.source : (pluginId ?? null),
      message: head + readOnlyNote + '已按宿主已安装接口读取原生启用选择；runtime=unknown 表示无真实运行反馈，registered 仅为 fish_hand 手登记、不等于已安装或挂载。',
    };
  } catch (error) {
    return { ...base, code: 'read-state-failed', message: '读取宿主原生插件状态失败：' + errText(error) };
  }
}

/* 在途去重：同一 (nativeId, requested) 只允许一个在途请求，防重复提交。 */
const INFLIGHT_SLOT = Symbol.for('fish-body.plugin-switch.inflight.v1');
function inflightTable() {
  let table;
  try { table = globalThis[INFLIGHT_SLOT]; } catch { table = null; }
  if (!table || !(table instanceof Map)) {
    table = new Map();
    try { globalThis[INFLIGHT_SLOT] = table; } catch { /* 无 globalThis 时退化为局部实例 */ }
  }
  return table;
}

/**
 * 提交目标来源插件的开关请求。只操作用户点击的单个插件；不批量、不安装卸载、不写 Profile、
 * 不自动启用脑/身体。返回 state 仅表示本次请求结果（on/off/error），不表示运行正常。
 */
export async function setPluginSwitch(pluginId, enabled, bridge) {
  const requested = enabled === true;
  const result = { pluginId: pluginId ?? null, requested, state: 'error', message: '' };
  const scope = resolveBridge(arguments.length > 2, bridge);
  if (!scope.bridge) {
    result.code = 'native-api-unavailable';
    result.evidence = NATIVE_API_PROBE.evidence;
    result.message = gapMessage(scope, '未提交任何开关请求，也未写入 Profile 或第二份配置。');
    return result;
  }
  const target = classifyPluginTarget(pluginId);
  if (!target.ok) {
    result.code = 'unmappable-target';
    result.message = 'pluginId 为空或身份映射不明，未提交开关请求。';
    return result;
  }
  let current;
  try {
    current = await scope.bridge.readState(target.nativeId);
  } catch (error) {
    result.code = 'read-state-failed';
    result.message = '提交前读取原生状态失败，未提交开关请求：' + errText(error);
    return result;
  }
  if (!current || typeof current !== 'object') {
    result.code = 'read-state-failed';
    result.message = '提交前未取得宿主原生状态条目，未提交开关请求。';
    return result;
  }
  // 只读/内置组件按宿主真实归属拒绝（不按 pluginId 名字猜）；登记状态与能否操作无关。
  const readOnlyReason = typeof current.readOnlyReason === 'string' && current.readOnlyReason.trim()
    ? current.readOnlyReason.trim() : '';
  if (readOnlyReason) {
    result.code = 'read-only-component';
    result.message = '宿主标记该组件为只读/内置（' + readOnlyReason + '），本入口不提供独立启停，未提交开关请求。';
    return result;
  }
  // 能否操作的唯一门是宿主真实已安装 installed（不是 fish_hand 手登记 registered）。
  if (current.installed !== true) {
    result.code = 'not-installed';
    result.message = '目标未在宿主实际安装（installed≠true）或身份映射不成立，未提交开关请求。';
    return result;
  }
  // 传给宿主的是 readState 解析后的真实 nativeId，不是未经转换的请求 pluginId。
  const nativeId = typeof current.nativeId === 'string' && current.nativeId
    ? current.nativeId : target.nativeId;
  // 在途去重按 ctx 隔离：key 带本桥作用域，A/B 并发同 ID 各自到本 ctx、互不误判重复。
  const key = bridgeScopeKey(scope) + '|' + nativeId + '|' + String(requested);
  const table = inflightTable();
  if (table.has(key)) {
    result.code = 'duplicate-in-flight';
    result.message = '同一插件的开关请求正在处理中，已忽略重复点击。';
    return result;
  }
  table.set(key, true);
  try {
    const outcome = await scope.bridge.setEnabled(nativeId, requested);
    if (outcome && outcome.ok === false) {
      result.code = 'native-call-failed';
      result.message = '原生开关请求失败：' + (outcome.message || '宿主未给出原因');
      return result;
    }
    result.state = requested ? 'on' : 'off';
    const head = outcome && typeof outcome.message === 'string' && outcome.message ? outcome.message + '；' : '';
    result.message = head + '已提交' + (requested ? '启动' : '关闭') + '开关请求，实际加载状态需刷新只读状态入口确认；本结果仅表示请求已提交，不代表运行正常。';
    return result;
  } catch (error) {
    result.code = 'native-call-failed';
    result.message = '原生开关调用失败：' + errText(error);
    return result;
  } finally {
    table.delete(key);
  }
}
