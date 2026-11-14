import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadProductionState } from '../production-state.mjs'
const require = createRequire(import.meta.url)

let cachedRuntime = null
let cachedSelection = null

function runtimeError(code, message, details = {}) {
  return Object.assign(new Error(code + ': ' + message), { code, ...details })
}
function probeEnvironment(env) {
  const value = { ...env }
  // NODE_OPTIONS belongs to the workload. A broken preload must be reported by
  // the prepare child, not misclassified as an unusable executable.
  delete value.NODE_OPTIONS
  return value
}
function validateRuntime(command, env, source) {
  const candidate = String(command ?? '').trim()
  if (!candidate) throw runtimeError('FH_NODE_CANDIDATE_INVALID', source + ' 未提供运行时路径', { source })
  try {
    const version = execFileSync(candidate, ['-e', 'process.stdout.write(process.versions.node)'], {
      encoding: 'utf8', env: probeEnvironment(env), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('unexpected version output: ' + version)
    return { command: candidate, env: { ...env }, source, version }
  } catch (cause) {
    throw runtimeError('FH_NODE_CANDIDATE_INVALID', source + ' 不是可直接执行的 Node 运行时：' + candidate, {
      source, candidate, causeCode: cause?.code ?? null, causeMessage: cause?.message ?? String(cause),
    })
  }
}
function lookupCandidates(env, platform) {
  try {
    return execFileSync(platform === 'win32' ? 'where.exe' : 'which', ['node'], {
      encoding: 'utf8', env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  } catch { return [] }
}

export function nativeNodeRuntime(options = {}) {
  const cacheable = Object.keys(options).length === 0
  const env = options.env ?? process.env
  const execPath = options.execPath ?? process.execPath
  const platform = options.platform ?? process.platform
  const configured = String(env.DSH_NODE ?? '').trim()
  if (cacheable) {
    // Relative commands/PATH entries depend on cwd; Windows lookup also uses
    // PATHEXT/SystemRoot. Keep workload-only settings out of this identity.
    const lookupEnv = Object.keys(env).filter(key => platform === 'win32'
      ? ['path', 'pathext', 'systemroot'].includes(key.toLowerCase()) : key === 'PATH')
      .sort().map(key => [key, env[key]])
    const selection = JSON.stringify([configured, execPath, platform, env.ELECTRON_RUN_AS_NODE, process.cwd(), lookupEnv])
    if (cachedRuntime && cachedSelection === selection) return { ...cachedRuntime, env: { ...env } }
    cachedRuntime = null
    cachedSelection = selection
  }
  if (configured) {
    try {
      const resolved = validateRuntime(configured, env, 'DSH_NODE')
      if (cacheable) cachedRuntime = { command: resolved.command, source: resolved.source, version: resolved.version }
      return resolved
    } catch (cause) {
      throw runtimeError('FH_NODE_CONFIG_INVALID', '宿主提供的 DSH_NODE 无法使用，禁止静默回退：' + configured, {
        source: 'DSH_NODE', candidate: configured, causeCode: cause.causeCode ?? cause.code,
        causeMessage: cause.causeMessage ?? cause.message,
      })
    }
  }

  const attempts = []
  const candidates = []
  // A renamed Electron executable is a valid Node runtime only when its
  // required run-as-node mode is present. Ordinary Node remains valid by name.
  if (/^node(?:\.exe)?$/i.test(basename(execPath)) || env.ELECTRON_RUN_AS_NODE === '1') {
    candidates.push(['process.execPath', execPath])
  }
  const found = options.candidates ?? lookupCandidates(env, platform)
  for (const candidate of found) candidates.push(['PATH', candidate])
  const seen = new Set()
  for (const [source, candidate] of candidates) {
    const key = platform === 'win32' ? String(candidate).toLowerCase() : String(candidate)
    if (!candidate || seen.has(key)) continue
    seen.add(key)
    try {
      const resolved = validateRuntime(candidate, env, source)
      if (cacheable) cachedRuntime = { command: resolved.command, source: resolved.source, version: resolved.version }
      return resolved
    } catch (cause) {
      attempts.push({ source, candidate: String(candidate), code: cause.causeCode ?? cause.code })
    }
  }
  throw runtimeError('FH_NODE_UNAVAILABLE', '未找到可直接执行的 Node 运行时', { attempts })
}
export function nativeNode(options) {
  return nativeNodeRuntime(options).command
}
export function packageManagerCommand() {
  let configured
  try { configured = loadProductionState().packageManager } catch { /* standalone tests/CLI use the declared fallback */ }
  if (configured?.command) return { command: configured.command, args: configured.args || [] }
  const runtime = nativeNodeRuntime()
  return { command: runtime.command, args: [require.resolve('pnpm/bin/pnpm.mjs')], env: runtime.env, runtimeSource: runtime.source }
}
export function npmCommand() {
  const runtime = nativeNodeRuntime()
  return { exe: runtime.command, args: [join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')], env: runtime.env, runtimeSource: runtime.source }
}
