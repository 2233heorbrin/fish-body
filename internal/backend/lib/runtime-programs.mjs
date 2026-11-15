import { basename, dirname, join, resolve, relative, isAbsolute, delimiter, extname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
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
function managerEnvironment(overrides = {}) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing]
    }
    env[key] = value
  }
  return env
}
function windowsPnpm(command, args, env) {
  let selected = command
  try {
    if (!/[\\/]/.test(command)) {
      // Match the selected Windows installation, ignoring its POSIX shell shim.
      const lookup = name => env[Object.keys(env).find(key => key.toLowerCase() === name)]
      const extensions = extname(command) ? [''] : (lookup('pathext') || '.COM;.EXE;.BAT;.CMD').split(';')
      const directories = [process.cwd(), ...(lookup('path') || '').split(delimiter)]
      selected = directories.flatMap(dir => extensions.map(ext => join(dir.replace(/^"|"$/g, ''), command + ext)))
        .find(path => existsSync(path))
    }
    if (!selected || !existsSync(selected)) throw Object.assign(new Error('pnpm command not found: ' + command), { code: 'ENOENT' })
    if (/\.exe$/i.test(selected)) return { command: selected, args, env }
    if (!/\.(?:cmd|bat)$/i.test(selected) && extname(selected)) throw new Error('unsupported pnpm command: ' + selected)
    const shimDir = dirname(resolve(selected))
    // npm global shims and package-local node_modules/.bin shims only. Read
    // package metadata, never interpret a command script or select another pnpm.
    const packageDir = basename(shimDir).toLowerCase() === '.bin'
      ? join(dirname(shimDir), 'pnpm') : join(shimDir, 'node_modules', 'pnpm')
    const meta = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.pnpm
    const entry = typeof bin === 'string' ? resolve(packageDir, bin) : ''
    const path = entry && relative(packageDir, entry)
    if (meta.name !== 'pnpm' || !path || path.startsWith('..') || isAbsolute(path) || !existsSync(entry))
      throw new Error('unsupported pnpm package/bin layout: ' + selected)
    if (/\.exe$/i.test(entry)) return { command: entry, args, env }
    if (!/\.[cm]?js$/i.test(entry)) throw new Error('unsupported pnpm bin entry: ' + entry)
    const runtime = nativeNodeRuntime({ env })
    return { command: runtime.command, args: [entry, ...args], env: runtime.env, runtimeSource: runtime.source }
  } catch (cause) {
    if (cause.code === 'FH_NODE_CONFIG_INVALID' || cause.code === 'FH_NODE_UNAVAILABLE') throw cause
    throw runtimeError('FH_PNPM_CONFIG_INVALID', '无法解析所选 pnpm 安装：' + command + '；' + cause.message, {
      candidate: selected ?? command, causeCode: cause.code ?? null,
    })
  }
}
export function packageManagerCommand() {
  let configured
  try { configured = loadProductionState().packageManager } catch { /* standalone tests/CLI use the declared fallback */ }
  const env = managerEnvironment(configured?.env)
  if (configured?.command) {
    const { command, args = [] } = configured
    if (process.platform === 'win32' && /^pnpm(?:\.(?:cmd|bat))?$/i.test(basename(command)))
      return windowsPnpm(command, args, env)
    return { command, args, env }
  }
  const runtime = nativeNodeRuntime({ env })
  return { command: runtime.command, args: [require.resolve('pnpm/bin/pnpm.mjs')], env: runtime.env, runtimeSource: runtime.source }
}
export function npmCommand() {
  const runtime = nativeNodeRuntime()
  return { exe: runtime.command, args: [join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')], env: runtime.env, runtimeSource: runtime.source }
}
