/* fish-body · Host half
 * 通过真实 connection.fetch 端点提供固定分区元数据与「打开文件夹」动作。
 * 展示与打开共用同一份 SECTIONS 映射；前端只提交 section id，不传路径。
 */

import { stat } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { mountProfileData } from './internal/profile-data.js'
import { bodyProfileData } from './internal/body-data.js'
import * as localSwitch from './internal/backend/lib/body-switch.mjs'
import { prepareBackend } from './internal/backend-entry.js'
import { INTAKE_MODES, DEFAULT_INTAKE_MODE, INTAKE_MODE_KEY } from './internal/analysis/intake-mode.mjs'
import { analyzeInstalledFromSource } from './internal/analysis/installed-analysis.mjs'
import { overview as riceOverview, publicSources, listRiceSources, findRiceSource, attachInstallToSources } from './internal/backend/lib/rice-model.mjs'
import { checkVersionAsync, checkVersionsBatch } from './internal/backend/lib/version-check.mjs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const name = 'fish-body'
/* 静态 inject 只保留稳定必需服务。remote 是可选宿主服务：静态声明会让缺该服务的宿主在
   Fiber._refresh 阶段判定依赖缺失、epoch=INACTIVE，导致整个 apply 不执行、身体页 0 路由。
   改为运行时 ctx.get('remote') 探测，拿不到就走 C 模块的缺口证据，不拖垮其余分区。 */
export const inject = ['connection', 'sessionController']

/* 唯一一份映射：id → 标题 / 说明 / 真实目录。对象键顺序即设置页分段顺序。 */
/* Root comes from the body's Profile binding; fishRoot is an upgrade input. */
const DEFAULT_FISH_ROOT = ''
/* 分区 id → 目录名。根目录变化时直接拼接，避免"替换基准变了但原路径没变"的错。
   rice/stomach/hand 保留原 ID 与真实目录映射；overview/settings 是纯界面导航，无目录。 */
const SECTION_FOLDERS = Object.freeze({ rice: '饭', hand: '鱼的手', stomach: '鱼的胃' })
/* 契约 v1.1：五项顺序固定。仅 rice/stomach/hand 有真实目录；overview/settings 无目录 path:null。 */
const SECTIONS = {
  overview: {
    title: '总览',
    description: '汇总饭、胃、手各分区的状态。',
    path: null,
    noFolder: true
  },
  rice: {
    title: '饭·来源',
    description: '保存插件上游源码与下载材料。',
    path: null
  },
  stomach: {
    title: '胃·分析',
    description: '存放插件分析、拆分与适配产物。',
    path: null
  },
  hand: {
    title: '手·组件',
    description: '管理工具插件及其运行相关目录。',
    path: null
  },
  settings: {
    title: '设置与帮助',
    description: '目录绑定、诊断与帮助。',
    path: null,
    noFolder: true
  }
}

/* SHA-256 是身体内置能力：随包校验和释放，不再解析独立运行包。 */
const SHA256_GATE_CONFIG = Object.freeze({ pluginId: 'utility.sha256', toolName: 'utility_sha256' })

/* 插件开关后端去重：同一 ctx 内同一 pluginId 的在途请求只接受一次（前端禁点 + C 模块内部去重之外的第三层）。
   按 ctx 隔离：A/B 各有 remote 并发同一 pluginId 时互不误判重复，各自只到本 ctx 管理器。 */
const PLUGIN_SWITCH_INFLIGHT = new WeakMap()

/* 原生桥接实例按 ctx 绑定：每个 apply/ctx 拥有自己的实例，互不覆盖。
   WeakMap 让 ctx 卸载后条目可回收；globalThis[slot] 仍是 C 模块读取的唯一入口，
   但方法入口核对「槽里是否仍是我」，被新实例接管后旧实例自动失效、不再触碰旧管理器。 */
const NATIVE_BRIDGE_BY_CTX = new WeakMap()

/* 宿主真实运行反馈 PluginInfo.fiberPhase → 契约 runtime；无证据一律 unknown，不把 enabled 当运行。 */
function fiberPhaseToRuntime(phase) {
  if (phase === 'active') return 'running'
  if (phase === 'failed') return 'error'
  if (phase === 'unloading') return 'stopped'
  return 'unknown'
}

/* 运行门校验/加载失败：按运行门口径只记录错误码，绝不影响分区接口。
   ctx.logger 可能是函数式(cordis)或对象式，两种都兜底，最后落到 console.error。 */
function reportSha256Failure(ctx, error) {
  const code = (error && (error.code || error.message)) || 'FH_GATE_UNKNOWN'
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('fish-hand-runtime-gate') : ctx?.logger
    if (logger && typeof logger.error === 'function') logger.error(code)
    else if (logger && typeof logger.warn === 'function') logger.warn('fish-body: SHA-256 运行门失败：' + code)
    else console.error('[fish-hand-runtime-gate] ' + code)
  } catch {
    console.error('[fish-hand-runtime-gate] ' + code)
  }
}

/* 默认激活器：加载身体包内运行门并调用 activateRuntimePlugin
   （校验随包代码哈希 -> import 内部入口 -> module.apply -> 返回 dispose）。
   动态 import 让内部运行门故障只影响本工具；config.gateModule / config.activate
   是隔离测试注入点；生产默认加载身体包内的运行门。 */
function defaultActivate(config) {
  return async (target, gateConfig) => {
    const mod = config.gateModule ?? (await import('./internal/runtime-gate.js'))
    if (!mod || typeof mod.activateRuntimePlugin !== 'function') {
      throw new Error('fish-hand-runtime-gate: activateRuntimePlugin 不可用')
    }
    return mod.activateRuntimePlugin(target, gateConfig)
  }
}

/* 把 utility_sha256 的注册/释放收归 fish-body 自身的 cordis 生命周期：
   - 原生「鱼的身体」开关关闭 -> 插件 apply 不被调用 / 被 dispose -> inject 子 ctx 的
     effect 清理函数运行 -> 工具释放。无需在插件内再读开关状态。
   - 沿用 fish-hand-approval-host 的 ctx.inject(['tools'], child => child.effect(...))
     动态挂载；静态 inject 保持 ['connection','sessionController']，避免 tools 服务
     未就绪时整个插件加载失败（回归要求 A）。
   - 挂载点放在两个分区 register(...) 之后；校验/加载失败被隔离在此 effect 内，
     只影响 SHA-256 工具，不影响 /api/fish-body/sections 与 /open。 */
function mountSha256(ctx, config = {}, bridge = null, hints = {}) {
  const activate = typeof config.activate === 'function' ? config.activate : defaultActivate(config)
  const mount = (target) => {
    // 同步 effect：activate 可返回 dispose 或 Promise<dispose>，两者 cordis 均支持。
    const start = () => target.effect(() => {
      let result
      try {
        result = activate(target, SHA256_GATE_CONFIG)
      } catch (error) {
        reportSha256Failure(target, error)
        return () => {}
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (cleanup) => (typeof cleanup === 'function' ? cleanup : () => {}),
          (error) => { reportSha256Failure(target, error); return () => {} }
        )
      }
      return typeof result === 'function' ? result : () => {}
    })
    if (!bridge) { start(); return }
    let release = null
    const stop = bridge.observeBodyPhase(hints, async state => {
      if (state.phase === 'off' && release) {
        const dispose = release; release = null
        await dispose()
      } else if (state.phase === 'on' && !release) {
        release = start()
      }
    })
    target.effect(() => () => stop())
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], mount)
  } else if (typeof ctx.effect === 'function' && ctx.tools && typeof ctx.tools.register === 'function') {
    mount(ctx)
  } else {
    reportSha256Failure(ctx, { code: 'FH_GATE_NO_TOOLS_MOUNT' })
  }
}

function register(ctx, path, methods, fetch) {
  ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }))
}

function jsonResponse(request, value, status = 200) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

/* 手页只读状态的 pluginId 候选来自 registry 登记（登记≠运行/安装）；逐个交给 C 的只读核实，
   缺口时 C 会返回 native-api-unavailable + 证据，绝不伪造运行反馈。 */
function registeredPluginIds(root) {
  try {
    const file = join(root, '鱼的手', '插件注册表', 'registry.json')
    if (!existsSync(file)) return []
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const rows = Array.isArray(doc?.plugins) ? doc.plugins : Object.values(doc?.plugins ?? {})
    const out = []
    const seen = new Set()
    for (const row of rows) {
      const id = row?.pluginId ?? row?.packageName
      if (typeof id === 'string' && id.trim() && !seen.has(id.trim())) {
        seen.add(id.trim()); out.push(id.trim())
      }
    }
    return out
  } catch { return [] }
}

/* 同一登记项的 pluginId/packageName/entryId/nativeId 可能不同，原生侧又用另一个身份。
   从 registry 构造「一个身份 → 同项其它身份」别名表，供桥接解析时把登记 ID 扩展到可匹配原生的身份；
   只读清单，不触发任何安装/下载/脚本。 */
function registryIdentityAliases(root) {
  const aliases = new Map()
  try {
    const file = join(root, '鱼的手', '插件注册表', 'registry.json')
    if (!existsSync(file)) return aliases
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const rows = Array.isArray(doc?.plugins) ? doc.plugins : Object.values(doc?.plugins ?? {})
    for (const row of rows) {
      const ids = [row?.pluginId, row?.packageName, row?.entryId, row?.nativeId, row?.name]
        .filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      for (const a of ids) {
        if (!aliases.has(a)) aliases.set(a, new Set())
        for (const b of ids) if (b !== a) aliases.get(a).add(b)
      }
    }
  } catch {}
  return aliases
}

/* 尽力适配宿主原生插件管理器：运行时探测 ctx 的 remote.pluginManager，按 C 的 bridge 形状
   挂到共享槽即转真实路径；拿不到就保持 C 的缺口证据，不伪造、不写 Profile。
   实例归属每个 ctx：先释放本 ctx 的旧实例（仅当槽里仍是它），再挂新实例并登记 effect 释放；
   两个独立 ctx 各有实例，绝不互相覆盖，也不在释放旧实例时删掉已接管的新实例。 */
function tryAttachNativeBridge(ctx, mod, aliases = new Map()) {
  try {
    if (!mod?.NATIVE_BRIDGE_SLOT) return null
    const slot = mod.NATIVE_BRIDGE_SLOT
    // 按需顺序读取候选，取第一个具备 listPlugins/setPluginEnabled 的对象后立即停止，
    // 不再读后续路径：先求值全部 Cordis 属性会让后续属性访问抛错时连已找到的有效服务一起丢掉。
    // listBundles/setBundleEnabled 是 bundle 分支的可选能力，不作共同门槛。
    function pickManager() {
      const probes = [
        () => ctx?.get?.('pluginManager'),         // 宿主真实路径：Cordis 本地服务
        () => ctx?.pluginManager,                  // 宿主工具直接取法
        () => ctx?.get?.('remote')?.pluginManager, // 原路径保留兼容
        () => ctx?.remote?.pluginManager,          // 原路径保留兼容
      ]
      for (const probe of probes) {
        let m
        try { m = probe() } catch { continue }      // 单个路径读取失败不影响后续
        if (m && typeof m.listPlugins === 'function' && typeof m.setPluginEnabled === 'function') return m
      }
      return null
    }
    const manager = pickManager()
    if (!manager || typeof manager.listPlugins !== 'function' || typeof manager.setPluginEnabled !== 'function') return null

    /* fish_hand 手登记身份集合（登记≠安装≠挂载）：只用于 registered 显示，绝不当操作门。 */
    const registeredIds = new Set()
    for (const [key, others] of aliases) {
      registeredIds.add(key)
      for (const value of others) registeredIds.add(value)
    }

    /* 已在册且仍存活的本 ctx 实例：直接复用，避免重复挂载/重复 effect。
       跨 ctx 绝不看 global 槽（会被别的 ctx 覆盖），只看本 ctx 的 WeakMap 登记与自身存活标志。 */
    const existing = NATIVE_BRIDGE_BY_CTX.get(ctx)
    if (existing && existing.slot === slot && existing.record.alive) return existing.bridge
    const record = { alive: true }

    /* 登记 ID → 原生条目的唯一匹配。宿主 listPlugins 行为 PluginInfo{entryId,moduleName,meta,enabled,fiberPhase,readOnlyReason|patchId}；
       listBundles 行为 BundleInfo{name,enabled,installed,readOnlyReason}。登记的 utility.sha256/包名/bundle 名
       与原生 entryId 可能不同，故按多字段精确匹配；命中 0 个按未安装，>1 个判无法确定、拒绝操作。 */
    const resolve = async (requestId) => {
      const id = typeof requestId === 'string' ? requestId.trim() : ''
      if (!id) return { found: false, ambiguous: false }
      /* 请求身份（可能是登记 pluginId，也可能是 readState 解析出的原生 ID）扩展到同项其它身份，
         让「登记 pluginId=test.registered、packageName=test.pkg、原生 pluginId=test.pkg」这类
         跨空间映射能匹配上；候选去重，同一登记项的多身份只算一次命中。 */
      const candidateIds = new Set([id])
      for (const alt of (aliases.get(id) ?? [])) candidateIds.add(alt)
      const plugins = await manager.listPlugins()
      const rows = Array.isArray(plugins) ? plugins : Object.values(plugins ?? {})
      const hits = []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const ids = [row.entryId, row.moduleName, row.pluginId, row.id, row.name,
          row.meta?.name, row.meta?.id, row.localizedName].filter((v) => typeof v === 'string' && v)
        if (ids.some((v) => candidateIds.has(v))) hits.push({ kind: 'plugin', row, nativeId: row.entryId ?? id })
      }
      // bundle 只有在普通 plugin 未命中时才补充，避免同名条目既算 plugin 又算 bundle 造成假歧义。
      if (hits.length === 0 && typeof manager.listBundles === 'function') {
        const bundles = await manager.listBundles()
        const brows = Array.isArray(bundles) ? bundles : Object.values(bundles ?? {})
        for (const row of brows) {
          if (!row || typeof row !== 'object') continue
          const ids = [row.name, row.id, row.meta?.name, row.meta?.id].filter((v) => typeof v === 'string' && v)
          if (ids.some((v) => candidateIds.has(v))) hits.push({ kind: 'bundle', row, nativeId: row.name ?? id })
        }
      }
      if (hits.length === 0) return { found: false, ambiguous: false }
      if (hits.length > 1) return { found: false, ambiguous: true }
      return { found: true, ambiguous: false, ...hits[0] }
    }

    /* 存活判定只看本 ctx 的登记记录，不看 global 槽：A/B 各有 remote 时各自桥都判活，
       互不因对方占用 global 槽而被误判失效；本 ctx 卸载或重建时旧 record.alive 置 false 才失效。 */
    const active = () => record.alive && NATIVE_BRIDGE_BY_CTX.get(ctx)?.record === record
    const bridge = {
      /* 身份令牌：路由层可核对 C 模块当前拿到的实例是否就是本 ctx 挂的那一个。 */
      __ownerCtx: ctx,
      /* C 的 resolveBridge 用 isAlive() 判显式传入的桥是否为活；非活则本次走自身缺口、不借别的 ctx。 */
      isAlive: active,
      async readState(pluginId) {
        if (!active()) return { nativeId: pluginId, installed: false, enabled: null, runtime: 'unknown', registered: false, source: 'stale-bridge',
          message: '该桥接实例已被新实例接管，未使用旧管理器状态。' }
        let match
        try { match = await resolve(pluginId) } catch {
          return { nativeId: pluginId, installed: false, enabled: null, runtime: 'unknown', registered: false, source: 'native-read-failed', message: '读取宿主原生插件列表失败，状态未确认。' }
        }
        if (!match.found) {
          return { nativeId: pluginId, installed: false, enabled: null, runtime: 'unknown', registered: false, source: 'native.listPlugins',
            message: match.ambiguous ? '多个原生条目匹配该登记 ID，无法确定目标，未作任何操作。' : '未找到对应的原生条目，可能未安装或身份映射不成立。' }
        }
        const row = match.row
        const readOnly = typeof row.readOnlyReason === 'string' && row.readOnlyReason.trim()
          ? row.readOnlyReason.trim() : ''
        /* installed 是唯一操作门，必须尊重宿主真实安装字段：
           - bundle 有 installed 字段（BundleInfo.installed），只有真实为 true 才算已安装；
           - plugin 的 PluginInfo 无 installed 字段，条目存在即视为已安装。
           registered 保持 fish_hand 手登记本义，与安装/挂载无关；readOnlyReason 空串表示无真实只读归属。 */
        const installed = match.kind === 'bundle' ? row.installed === true : true
        return {
          nativeId: match.nativeId,
          installed,
          enabled: row.enabled === true ? true : row.enabled === false ? false : null,
          runtime: match.kind === 'plugin' ? fiberPhaseToRuntime(row.fiberPhase) : 'unknown',
          registered: registeredIds.has(pluginId),
          readOnlyReason: readOnly,
          source: match.kind === 'bundle' ? 'native.listBundles' : 'native.listPlugins'
        }
      },
      async setEnabled(pluginId, enabled) {
        if (!active()) return { ok: false, message: '该桥接实例已被新实例接管，未提交旧管理器开关请求。' }
        let match
        try { match = await resolve(pluginId) } catch {
          return { ok: false, message: '提交前解析原生身份失败，未提交开关请求。' }
        }
        if (!match.found) {
          return { ok: false, message: match.ambiguous ? '多个原生条目匹配该登记 ID，无法确定目标，未提交。' : '未找到对应的原生条目，未提交开关请求。' }
        }
        const row = match.row
        if (typeof row.readOnlyReason === 'string' && row.readOnlyReason) {
          return { ok: false, message: '宿主标记该项只读（' + row.readOnlyReason + '），未提交开关请求；请到原生插件页操作。' }
        }
        // 传给原生的是解析后的 nativeId，不是未经转换的登记 pluginId。
        // bundle 与普通 plugin 是两套原生 API，绝不互相回落：bundle 缺 setBundleEnabled 时
        // 直接判不支持、不提交，避免误把 bundle 名当 plugin entryId 调 setPluginEnabled。
        if (match.kind === 'bundle') {
          if (typeof manager.setBundleEnabled !== 'function') {
            return { ok: false, message: '该项是 bundle，宿主未提供 setBundleEnabled，不支持独立开关，未提交任何请求。' }
          }
        } else if (typeof manager.setPluginEnabled !== 'function') {
          return { ok: false, message: '宿主未提供 setPluginEnabled，未提交任何请求。' }
        }
        const out = await (match.kind === 'bundle'
          ? manager.setBundleEnabled(match.nativeId, enabled)
          : manager.setPluginEnabled(match.nativeId, enabled))
        if (out && typeof out === 'object') {
          const failed = out.ok === false || out.saved === false || out.application === 'failed'
            || out.application === 'cancelled' || (out.runtime && out.runtime.ok === false)
          if (failed) return { ok: false, message: typeof out.message === 'string' ? out.message : '宿主未接受开关请求' }
        }
        return { ok: true, message: typeof out?.message === 'string' ? out.message : '' }
      }
    }

    /* 替换本 ctx 旧实例：先把旧 record 判死（其 isAlive() 立刻false），再让位新桥。
       global 槽删除仍仅当槽里仍是旧桥本人，绝不误删已接管的别的 ctx 实例。 */
    if (existing) {
      existing.record.alive = false
      if (globalThis[slot] === existing.bridge) {
        try { delete globalThis[slot] } catch {}
      }
    }
    globalThis[slot] = bridge
    NATIVE_BRIDGE_BY_CTX.set(ctx, { slot, bridge, record })
    ctx.effect(() => () => {
      record.alive = false
      try {
        if (globalThis[slot] === bridge) delete globalThis[slot]
      } catch {}
      if (NATIVE_BRIDGE_BY_CTX.get(ctx)?.bridge === bridge) NATIVE_BRIDGE_BY_CTX.delete(ctx)
    })
    return bridge
  } catch { return null /* 宿主未暴露该服务：保持 C 的缺口判定 */ }
}

/* C 的 plugin-switch.mjs 动态加载 + 缺口兜底；文件未就绪或接口不全时返回 null，由路由给缺口响应。
   aliases 是 fish_hand 手登记的身份别名表，供桥接把登记 ID 映射到原生身份。 */
async function loadPluginSwitch(ctx, aliases = new Map()) {
  try {
    const mod = await import('./internal/backend/lib/plugin-switch.mjs')
    if (typeof mod?.readPluginSwitchState !== 'function' || typeof mod?.setPluginSwitch !== 'function' || typeof mod?.isNativeSwitchAvailable !== 'function') return null
    /* 必须拿到本 ctx 的桥（无 remote 返回 null），交给路由显式传参；绝不依赖 C 回退 global 槽，
       否则无 remote 的 ctx 会借到别的 ctx 挂到 global 的桥、读写别人的管理器。 */
    const bridge = tryAttachNativeBridge(ctx, mod, aliases)
    return { mod, bridge }
  } catch { return null }
}

/* 由默认映射 + 根目录 + 分区级覆盖，得到本次运行实际使用的分区表。 */
function buildSections(config = {}) {
  const rawRoot = typeof config.fishRoot === 'string' ? config.fishRoot.trim() : ''
  const root = (rawRoot || DEFAULT_FISH_ROOT).replace(/[\\/]+$/, '')
  const out = {}
  for (const [id, entry] of Object.entries(SECTIONS)) {
    // 纯导航项（overview/settings）无目录，绝不在磁盘上拼出不存在的分区路径、也不建数据目录。
    const folder = SECTION_FOLDERS[id]
    out[id] = { ...entry, path: (root && folder && !entry.noFolder) ? join(root, folder) : null }
  }
  const overrides = (config && typeof config.sections === 'object' && config.sections) || {}
  for (const [id, override] of Object.entries(overrides)) {
    if (out[id] && override && typeof override === 'object') out[id] = { ...out[id], ...override }
  }
  return out
}

/* 严格白名单：只认分区表自身的键，任何其它 id 一律拒绝。 */
function resolveSection(sectionsMap, id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(sectionsMap, id)
    ? sectionsMap[id]
    : null
}

/* 回退动作：固定参数启动资源管理器，不拼接 shell 命令、不接受外部路径。 */
function launchExplorer(target) {
  return new Promise((resolve) => {
    let settled = false
    let child = null
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok) } }
    /* 兜底：spawn/error 事件均未到达时按 pid 判定，避免请求永久挂起。 */
    const timer = setTimeout(() => done(!!(child && child.pid !== undefined)), 2000)
    try {
      child = spawn('explorer.exe', [target], { shell: false, detached: true, stdio: 'ignore' })
      child.once('error', () => done(false))
      child.once('spawn', () => done(true))
      child.unref()
    } catch {
      done(false)
    }
  })
}

/* 把宿主 Remote 的失败归成三类，供日志与失败响应的 reason 字段使用。 */
function classifyRemoteFailure(error) {
  const detail = [error && error.code, error && error.message].filter(Boolean).join(' ')
  if (/cancel|abort/i.test(detail)) return { kind: 'cancelled', reason: '打开已取消。' }
  if (/verified Host path|bad-request|non-empty file path/i.test(detail)) {
    return { kind: 'unverified', reason: '路径未通过宿主的桌面路径校验。' }
  }
  return { kind: 'opener', reason: '宿主打开方式失败。' }
}

export async function apply(ctx, config = {}) {
  // The native switch remains authoritative. This projection also tells a
  // startup-only Host's UI that its page unload is waiting for native restart.
  const bridge = config.bodySwitchModule || localSwitch
  const hints = { profileDir: config.profileDir || ctx.get?.('profileContext')?.dir }
  // Native disposal joins exactly this Profile's admitted body operations.
  ctx.effect(() => () => localSwitch.runBodySwitchChange({ profileDir: hints.profileDir, enabled: false, operation: async () => {} }))
  const profileDir = config.profileDir || ctx.get?.('profileContext')?.dir
  const data = bodyProfileData({ ...ctx.get?.('profileContext'), dir: profileDir }, config)
  let backend = null
  await mountProfileData(ctx, data, { prepare: async state => {
    if (backend && backend.root !== state.root) return { status: 'restart-required', error: '新位置已保存；当前流程收尾后请重新加载身体。旧数据未搬迁。' }
    if (!backend) {
      const prepared = prepareBackend(ctx, state)
      await prepared.handle.await()
      if (prepared.handle.state !== 2) throw new Error('FISH_BACKEND_LOAD_FAILED: 身体后端未完成原生加载，请检查宿主服务后重试')
      backend = { ...prepared, root: state.root }
      if ((await prepared.capability).installTransactionExtensionVersion === 1) {
        backend.status = 'ready'; backend.code = null; backend.error = null
      }
    }
    return { status: backend.status, code: backend.code, error: backend.error, backend: 'bundled', configPath: backend.configPath }
  } })
  const sections = () => buildSections({ ...config, fishRoot: data.state().root })
  // 用户默认工作模式（intake mode）读写：复用 per-profile 的 fish-body-state.json（与部署 mode:'production' 分开的 intakeMode 字段）。
  // 读：GET 带出 defaultMode；写：POST {defaultMode} 原子改写后回读。只改当前 profile 的配置，不碰数据根/绑定/其它 profile。
  const intakeConfigPath = () => hints.profileDir ? join(hints.profileDir, 'fish-body-state.json') : null
  const readDefaultMode = () => {
    try {
      const p = intakeConfigPath()
      if (!p || !existsSync(p)) return DEFAULT_INTAKE_MODE
      const conf = JSON.parse(readFileSync(p, 'utf8'))
      return INTAKE_MODES.includes(conf[INTAKE_MODE_KEY]) ? conf[INTAKE_MODE_KEY] : DEFAULT_INTAKE_MODE
    } catch { return DEFAULT_INTAKE_MODE }
  }
  const stateRoute = async request => {
    if (request.method === 'POST') {
      let payload
      try { payload = await request.json() } catch { return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。' }, 400) }
      const mode = payload && payload.defaultMode
      if (!INTAKE_MODES.includes(mode)) {
        return jsonResponse(request, { ok: false, error: `defaultMode 必须是 ${INTAKE_MODES.join('/')} 之一。` }, 400)
      }
      try {
        const p = intakeConfigPath()
        if (!p || !existsSync(p)) return jsonResponse(request, { ok: false, error: 'FISH_BODY_STATE_MISSING' }, 400)
        const conf = JSON.parse(readFileSync(p, 'utf8'))
        conf[INTAKE_MODE_KEY] = mode
        const temp = p + '.tmp'
        writeFileSync(temp, JSON.stringify(conf, null, 2) + '\n')
        renameSync(temp, p)
        return jsonResponse(request, { ok: true, defaultMode: readDefaultMode() })
      } catch (error) { return jsonResponse(request, { ok: false, error: error.message }, 400) }
    }
    const state = bridge.readBodyPhase(hints)
    return jsonResponse(request, { ...state, defaultMode: readDefaultMode(),
      application: state.phase === 'off' ? 'restart-required' : 'applied',
      message: state.phase === 'closing' ? '正在关闭：等待当前身体操作收尾，不再启动新流程。'
        : state.phase === 'off' ? '身体流程和工具已停用；当前页面卸载等待 DSH 原生重新加载或重启生效。'
          : '鱼的身体已开启。'
    })
  }
  if (bridge) register(ctx, '/api/fish-body/state', ['GET', 'HEAD', 'POST'], stateRoute)
  register(ctx, '/api/fish-body/sections', ['GET', 'HEAD'], async (request) => {
    const sectionsMap = sections()
    const entries = Object.keys(sectionsMap).map((id) => ({
      id,
      title: sectionsMap[id].title,
      description: sectionsMap[id].description,
      path: sectionsMap[id].path
    }))
    return jsonResponse(request, { sections: entries })
  })

  register(ctx, '/api/fish-body/open', ['POST'], async (request) => {
    let payload
    try {
      payload = await request.json()
    } catch {
      return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。', path: null }, 400)
    }

    const section = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.section
      : undefined
    const entry = resolveSection(sections(), section)
    if (!entry) {
      return jsonResponse(request, { ok: false, error: '未知的分区 id。', path: null }, 400)
    }

    /* 纯导航项（overview/settings）无目录：不发 open、不建数据目录。 */
    if (!entry.path) {
      return jsonResponse(request, { ok: false, error: '该项是界面导航项，没有可打开的目录。', path: null }, 400)
    }

    /* 只 stat，不 mkdir：目录不存在即返回明确错误。 */
    const target = entry.path
    let info
    try {
      info = await stat(target)
    } catch (error) {
      const code = error && error.code
      const reason = code === 'ENOENT' ? '目录不存在。'
        : code === 'ENOTDIR' ? '路径不是目录。'
          : '无法访问该目录。'
      return jsonResponse(request, { ok: false, error: reason, path: target }, 404)
    }
    if (!info.isDirectory()) {
      return jsonResponse(request, { ok: false, error: '路径不是目录。', path: target }, 404)
    }

    /* 优先宿主 Remote 方法。verifyDesktopPath 经 fs.processPathFromHostPath 校验路径，
       而 dsh-fs-local 对绝对路径直接 resolve，因此宿主分支可能生效；spawn 仅为失败时的兜底。 */
    try {
      const controller = ctx.sessionController
      if (!controller || typeof controller.openWorkspacePath !== 'function') {
        throw new Error('sessionController 不可用')
      }
      await controller.openWorkspacePath({ path: target }, request.signal)
      return jsonResponse(request, { ok: true, path: target })
    } catch (error) {
      const { kind, reason } = classifyRemoteFailure(error)
      /* 有 logger 就记原始错误；同时把归类后的 reason 放进失败响应，供前端展示。 */
      try {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`fish-body: openWorkspacePath 失败(${kind})：${String((error && error.message) || error)}`)
        }
      } catch {}
      const opened = await launchExplorer(target)
      return opened
        ? jsonResponse(request, { ok: true, path: target })
        : jsonResponse(request, { ok: false, error: '无法打开资源管理器。', reason, path: target }, 500)
    }
  })

  /* 契约 v1.1 新增 5 路由。所有饭侧数据从同一份已绑定根目录读取，绝不另设猜测状态。 */
  const frameworkRoot = () => data.state().root

  /* GET 总览：三项摘要来自 rice-model 的实际读取，单项失败只标该项。 */
  register(ctx, '/api/fish-body/overview', ['GET', 'HEAD'], request =>
    jsonResponse(request, riceOverview({ frameworkRoot: frameworkRoot() })))

  /* GET 来源列表：只读已落盘材料，剔内部字段；不触发下载/npm/分析/安装/版本查询。 */
  register(ctx, '/api/fish-body/sources', ['GET', 'HEAD'], request =>
    // profileDir 取自宿主上下文（非硬编码/非探测其他 Profile），供 install 字段只读核实当前安装来源。
    jsonResponse(request, { ok: true, items: publicSources({ frameworkRoot: frameworkRoot(), profileDir: data.profileDir }) }))

  /* POST 手动检查远端版本：只接受已登记来源 id，拒任意 URL/本地路径（防开放代理）。
   * 走异步 checkVersionAsync（与批量同缓存/失败冷却/force/错误口径），避免 execFileSync 阻塞宿主；
   * 可选 force 布尔（手动重试绕过失败冷却与成功缓存），其余字段一律拒收。 */
  register(ctx, '/api/fish-body/check-version', ['POST'], async (request) => {
    let payload
    try { payload = await request.json() } catch {
      return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。' }, 400)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(request, { ok: false, error: '请求参数不合法。' }, 400)
    }
    const id = payload.id
    // 合法登记 id 本身就是 github.com/owner/repo、npm:<pkg>/<id> 这类含斜杠形态，不能用「含斜杠」当拒绝条件。
    // 防开放代理靠 rice-model 的已登记 id 精确核对（findRiceSource 全等匹配）：任意外部 URL/本地路径不在登记集合内即拒。
    if (typeof id !== 'string' || !id.trim() || id.length > 300 || /[\x00-\x1f]/.test(id)) {
      return jsonResponse(request, { ok: false, error: '只接受已登记来源 id。' }, 400)
    }
    const extra = Object.keys(payload).filter((k) => k !== 'id' && k !== 'force')
    if (extra.length || (payload.force !== undefined && typeof payload.force !== 'boolean')) {
      return jsonResponse(request, { ok: false, error: '只接受 id 与可选的 force 布尔参数，不接受链接或路径。' }, 400)
    }
    const sourceId = id.trim()
    const source = findRiceSource({ frameworkRoot: frameworkRoot(), id: sourceId })
    if (!source) {
      return jsonResponse(request, { ok: false, error: '来源 id 未登记；不接受任意链接或路径。' }, 400)
    }
    // 注入安装核实基线：withInstall 仅读 item._install 才产出 result.install；
    // findRiceSource 返回行不带该字段，不注入则生产链路的安装版本比较永远为空。
    // profileDir 取宿主上下文（非硬编码/非探测），与 /sources 路由同口径。
    const [decorated] = attachInstallToSources([source], { frameworkRoot: frameworkRoot(), profileDir: data.profileDir })
    const result = await checkVersionAsync({ frameworkRoot: frameworkRoot(), id: sourceId, source: decorated,
      force: payload.force === true })
    return jsonResponse(request, { ok: true, result })
  })

  /* POST 批量自动检查远端版本（异步、并发受限、raw 去重、缓存/冷却）。
   * 无 body 或仅 {force:boolean}；后端自行 listRiceSources 取全部已登记来源，不接受任意 URL/路径（防开放代理）。
   * 只发只读 GET、不下载/安装/切提交；单项失败不影响其他，结果按来源 id 关联。 */
  register(ctx, '/api/fish-body/check-versions', ['POST'], async (request) => {
    let payload = {}
    const raw = await request.text().catch(() => '')
    if (raw && raw.trim()) {
      try { payload = JSON.parse(raw) } catch {
        return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。' }, 400)
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return jsonResponse(request, { ok: false, error: '请求参数不合法。' }, 400)
      }
      const extra = Object.keys(payload).filter((k) => k !== 'force')
      if (extra.length || (payload.force !== undefined && typeof payload.force !== 'boolean')) {
        return jsonResponse(request, { ok: false, error: '只接受可选的 force 布尔参数，不接受链接或路径。' }, 400)
      }
    }
    const root = frameworkRoot()
    // 已登记来源白名单：后端自行枚举，前端无法注入 URL/本地路径（防开放代理）。
    // 同样注入安装核实基线，保证批量 result.install 与单条口径一致（profileDir 取宿主上下文）。
    const items = attachInstallToSources(listRiceSources({ frameworkRoot: root }),
      { frameworkRoot: root, profileDir: data.profileDir })
    const out = await checkVersionsBatch({
      frameworkRoot: root, items, force: payload.force === true
    })
    // 对外结构：results 为 [{id,result}] 数组，便于前端按 id 关联；内部错误摘要已脱敏。
    const results = Object.keys(out.results).map((id) => ({ id, result: out.results[id] }))
    return jsonResponse(request, {
      ok: true, results, dedupCount: out.dedupCount, checkedAt: out.checkedAt
    })
  })

  /* GET 手页插件开关只读状态：pluginId 候选来自 registry，逐个交给 C 的只读核实；三者分开不伪造。 */
  register(ctx, '/api/fish-body/plugin-switch/state', ['GET', 'HEAD'], async (request) => {
    const loaded = await loadPluginSwitch(ctx, registryIdentityAliases(frameworkRoot()))
    const registered = registeredPluginIds(frameworkRoot())
    if (!loaded) {
      // 模块未就绪：给每个登记候选一个缺口项，enabled=null/runtime=unknown，绝不显示假状态。
      return jsonResponse(request, { ok: true, items: registered.map((pluginId) => ({
        pluginId, nativeId: null, installed: false, enabled: null, runtime: 'unknown',
        registered: registered.includes(pluginId), code: 'native-api-unavailable', source: pluginId,
        message: '原生插件开关适配模块尚未就绪，状态未确认。'
      })) })
    }
    const { mod, bridge } = loaded
    const items = []
    for (const pluginId of registered) {
      try {
        /* 显式传本 ctx 的桥：bridge=null 时 C 走自身 native-api-unavailable 缺口，
           绝不回退 global 槽借到别的 ctx 的管理器。 */
        const row = await mod.readPluginSwitchState(pluginId, bridge)
        items.push({
          pluginId: row.pluginId ?? pluginId,
          nativeId: row.nativeId ?? null,
          installed: row.installed === true,
          enabled: row.enabled === true ? true : row.enabled === false ? false : null,
          runtime: ['running', 'stopped', 'error'].includes(row.runtime) ? row.runtime : 'unknown',
          registered: registered.includes(pluginId),
          ...(typeof row.code === 'string' && row.code ? { code: row.code } : {}),
          source: row.source ?? pluginId,
          message: typeof row.message === 'string' ? row.message : ''
        })
      } catch {
        items.push({ pluginId, nativeId: null, installed: false, enabled: null, runtime: 'unknown',
          registered: registered.includes(pluginId), code: 'read-state-failed', source: pluginId,
          message: '读取原生状态失败，当前未确认。' })
      }
    }
    return jsonResponse(request, { ok: true, items })
  })

  /* POST 插件开关：只操作目标插件；缺口给 native-api-unavailable，绝不安装/卸载/写 Profile/批量。 */
  register(ctx, '/api/fish-body/plugin-switch', ['POST'], async (request) => {
    let payload
    try { payload = await request.json() } catch {
      return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。' }, 400)
    }
    const pluginId = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.pluginId : undefined
    const enabled = payload && typeof payload === 'object' ? payload.enabled : undefined
    if (typeof pluginId !== 'string' || !pluginId.trim() || typeof enabled !== 'boolean') {
      return jsonResponse(request, { ok: false, error: '需要 pluginId（字符串）和 enabled（布尔）。' }, 400)
    }
    const key = pluginId.trim()
    let inflight = PLUGIN_SWITCH_INFLIGHT.get(ctx)
    if (!inflight) { inflight = new Set(); PLUGIN_SWITCH_INFLIGHT.set(ctx, inflight) }
    if (inflight.has(key)) {
      return jsonResponse(request, { ok: false, error: '该插件的开关请求正在处理中，请稍后。' }, 409)
    }
    inflight.add(key)
    try {
      const loaded = await loadPluginSwitch(ctx, registryIdentityAliases(frameworkRoot()))
      if (!loaded || typeof loaded.mod?.isNativeSwitchAvailable !== 'function') {
        return jsonResponse(request, { ok: false, error: { code: 'native-api-unavailable',
          message: '原生插件开关适配模块尚未就绪，未提交任何请求，也未写入 Profile。' } })
      }
      const { mod, bridge } = loaded
      /* 显式传本 ctx 的桥给两个 C 函数：bridge=null（本 ctx 无 remote 或已被接管）时，
         C 判非活走自身缺口，绝不借 global 槽里别的 ctx 的管理器。 */
      if (!mod.isNativeSwitchAvailable(bridge)) {
        return jsonResponse(request, { ok: false, error: { code: 'native-api-unavailable',
          message: '当前 ctx 没有可调用的原生插件开关接口，未提交任何请求，也未写入 Profile，未借用其它 ctx。' } })
      }
      const result = await mod.setPluginSwitch(key, enabled, bridge)
      if (result && result.code === 'native-api-unavailable') {
        return jsonResponse(request, { ok: false, error: { code: 'native-api-unavailable',
          message: typeof result.message === 'string' ? result.message : '原生插件开关接口不可用。' } })
      }
      return jsonResponse(request, { ok: true, result: {
        pluginId: result?.pluginId ?? key,
        requested: result?.requested ?? enabled,
        state: ['on', 'off', 'error'].includes(result?.state) ? result.state : 'error',
        message: typeof result?.message === 'string' ? result.message : ''
      } })
    } catch {
      return jsonResponse(request, { ok: false, error: { code: 'native-api-unavailable',
        message: '插件开关调用失败，当前未确认。' } })
    } finally {
      inflight.delete(key)
    }
  })

  /* POST 从已安装项进入兼容/逆向分析：按已装来源采材料+建分析+建任务，同步返回 taskId 供前端回跳。
     只接受 compatibility/reverse（off 是直装、不进分析）；不自动切换已装插件、不伪造批准。 */
  register(ctx, '/api/fish-body/analyze-installed', ['POST'], async request => {
    let payload
    try { payload = await request.json() } catch {
      return jsonResponse(request, { ok: false, error: '请求体不是有效 JSON。' }, 400)
    }
    const pluginId = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.pluginId : undefined
    const mode = payload && typeof payload === 'object' ? payload.mode : undefined
    if (typeof pluginId !== 'string' || !pluginId.trim() || !['compatibility', 'reverse'].includes(mode)) {
      return jsonResponse(request, { ok: false, error: '需要 pluginId（字符串）和 mode（compatibility/reverse）。' }, 400)
    }
    try {
      const result = await analyzeInstalledFromSource({
        frameworkRoot: frameworkRoot(),
        profileDir: hints.profileDir,
        pluginId: pluginId.trim(),
        nativeId: payload.nativeId ?? null,
        packageName: payload.packageName ?? null,
        mode,
      })
      if (result && result.ok) {
        return jsonResponse(request, { ok: true, taskId: result.taskId,
          ...(result.analysisId ? { analysisId: result.analysisId } : {}),
          pluginId: result.pluginId ?? pluginId.trim() })
      }
      return jsonResponse(request, { ok: false, error: result?.error ?? '按已装来源进入分析失败，原因未知。' }, 400)
    } catch (error) {
      return jsonResponse(request, { ok: false, error: error?.message ?? String(error) }, 400)
    }
  })

  mountSha256(ctx, config, bridge, hints)
}

apply.inject = ['connection', 'sessionController']
export default apply
