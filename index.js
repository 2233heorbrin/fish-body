/* fish-body · Host half
 * 通过真实 connection.fetch 端点提供固定分区元数据与「打开文件夹」动作。
 * 展示与打开共用同一份 SECTIONS 映射；前端只提交 section id，不传路径。
 */

import { stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

function bodySwitchModule(ctx, config) {
  if (config.bodySwitchModule) return config.bodySwitchModule
  const anchor = ctx.get?.('profileContext')?.installAnchor
  if (!anchor) return null
  const req = createRequire(anchor)
  return req(join(dirname(req.resolve('@deepseek-ai/fish-hand-admission-gate')), 'lib/body-switch.mjs'))
}

export const name = 'fish-body'
export const inject = ['connection', 'sessionController']

/* 唯一一份映射：id → 标题 / 说明 / 真实目录。对象键顺序即设置页分段顺序。 */
const SECTIONS = {
  rice: {
    title: '鱼的饭',
    description: '保存插件上游源码与下载材料。',
    path: 'D:\\deepseek框架\\饭'
  },
  hand: {
    title: '鱼的手',
    description: '管理工具插件及其运行相关目录。',
    path: 'D:\\deepseek框架\\鱼的手'
  },
  stomach: {
    title: '鱼的胃',
    description: '存放插件分析、拆分与适配产物。',
    path: 'D:\\deepseek框架\\鱼的胃'
  }
}

/* SHA-256 是身体内置能力：随包校验和释放，不再解析独立运行包。 */
const SHA256_GATE_CONFIG = Object.freeze({ pluginId: 'utility.sha256', toolName: 'utility_sha256' })

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

/* 严格白名单：只认 SECTIONS 自身的键，任何其它 id 一律拒绝。 */
function resolveSection(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SECTIONS, id)
    ? SECTIONS[id]
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

export function apply(ctx, config = {}) {
  // The native switch remains authoritative. This projection also tells a
  // startup-only Host's UI that its page unload is waiting for native restart.
  const bridge = config.bodySwitchModule || (ctx.get ? bodySwitchModule(ctx, config) : null)
  const hints = { profileDir: config.profileDir || ctx.get?.('profileContext')?.dir }
  if (bridge) register(ctx, '/api/fish-body/state', ['GET', 'HEAD'], request => {
    const state = bridge.readBodyPhase(hints)
    return jsonResponse(request, { ...state,
      application: state.phase === 'off' ? 'restart-required' : 'applied',
      message: state.phase === 'closing' ? '正在关闭：等待当前身体操作收尾，不再启动新流程。'
        : state.phase === 'off' ? '身体流程和工具已停用；当前页面卸载等待 DSH 原生重新加载或重启生效。'
          : '鱼的身体已开启。'
    })
  })
  register(ctx, '/api/fish-body/sections', ['GET', 'HEAD'], async (request) => {
    const sections = Object.keys(SECTIONS).map((id) => ({
      id,
      title: SECTIONS[id].title,
      description: SECTIONS[id].description,
      path: SECTIONS[id].path
    }))
    return jsonResponse(request, { sections })
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
    const entry = resolveSection(section)
    if (!entry) {
      return jsonResponse(request, { ok: false, error: '未知的分区 id。', path: null }, 400)
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

  mountSha256(ctx, config, bridge, hints)
}

apply.inject = ['connection', 'sessionController']
export default apply
