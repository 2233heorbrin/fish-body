import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadProductionState } from '../production-state.mjs'
const require = createRequire(import.meta.url)

export function nativeNode() {
  if (/^node(?:\.exe)?$/i.test(basename(process.execPath))) return process.execPath
  const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
  if (!found) throw new Error('FH_NODE_UNAVAILABLE: DSH 安装环境中缺少 Node 运行时')
  return found
}
export function packageManagerCommand() {
  let configured
  try { configured = loadProductionState().packageManager } catch { /* standalone tests/CLI use the declared fallback */ }
  if (configured?.command) return { command: configured.command, args: configured.args || [] }
  return { command: nativeNode(), args: [require.resolve('pnpm/bin/pnpm.mjs')] }
}
export function npmCommand() {
  return { exe: nativeNode(), args: [join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js')] }
}
