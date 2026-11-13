import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProfileData } from './profile-data.js'
import { configureBackend } from './backend-entry.js'
import { withStateConfig, loadProductionState } from './backend/production-state.mjs'
import { createMarketBodyAdapter, prepareInChild, restorePreparedRegistration } from './backend/lib/market-runtime.mjs'
import { classifyPnpmArgs, parseInstallSpecs, nativeOfficialSpecs } from './backend/fish-hand-admission-gate.mjs'

/** Entry declared by the bundle; called only by the experimental native seam.
 * No candidate JavaScript is imported. Preparation uses the existing backend.
 */
export function createInstallTransaction(context) {
  const profileDir = context.dir
  const data = new ProfileData(profileDir, 'body')
  const state = data.state()
  if (state.status !== 'ready') return { run: async ({ args }) => {
    const op = classifyPnpmArgs(args).op
    if (!['install', 'update', 'repair'].includes(op)) return null
    return { exitCode: 1, stderr: 'FISH_DATA_NOT_READY: 请先在鱼的身体页面选择工作区并初始化。', wroteNothing: true }
  } }
  const configPath = configureBackend(state, context)
  const prepare = (input, controls) => {
    if (/^file:/i.test(input.spec ?? '')) {
      const source = resolve(context.cwd || profileDir, input.spec.slice(5))
      const manifest = existsSync(join(source, 'package.json'))
        ? JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
        : JSON.parse(execFileSync('tar', ['-xOf', source, 'package/package.json'], { encoding: 'utf8', windowsHide: true }))
      input = { ...input, spec: 'file:' + source.replaceAll('\\', '/'), packageName: manifest.name, version: manifest.version }
    }
    return prepareInChild(input, controls)
  }
  const adapter = withStateConfig(configPath, () => createMarketBodyAdapter({ profileDir, prepare, prepareLocal: true }))
  const conf = withStateConfig(configPath, () => loadProductionState())
  const registry = existsSync(conf.registryPath) ? JSON.parse(readFileSync(conf.registryPath, 'utf8')) : { plugins: [] }
  const beforeRows = Array.isArray(registry.plugins) ? registry.plugins : Object.values(registry.plugins ?? {})
  const completed = []
  const run = async input => {
    const result = await adapter.run(input)
    if (result?.exitCode === 0 && result.managedLocal) completed.push(result.managedLocal)
    return result
  }
  return {
    ...adapter,
    managedSpec: (name, spec) => withStateConfig(configPath, () => adapter.managedSpec(name, spec)),
    afterRecovery: result => withStateConfig(configPath, () => {
      if (!result.ok) return { ok: false, error: '原生运行副本尚未恢复，身体登记不能声称已恢复。' }
      for (const prepared of completed.reverse()) restorePreparedRegistration(conf,
        beforeRows.find(row => row.packageName === prepared.packageName) ?? null, prepared)
      return { ok: true, restoredRegistrations: completed.map(row => row.packageName) }
    }),
    run: input => withStateConfig(configPath, async () => {
      if (nativeOfficialSpecs(input.args)) return null
      const op = classifyPnpmArgs(input.args).op
      const { specs, subcommand } = parseInstallSpecs(input.args)
      if (['install', 'update'].includes(op) && specs.length > 1) {
        let result
        for (const spec of specs) {
          result = await run({ ...input, args: [...input.args.slice(0, input.args.indexOf(subcommand)), 'add', spec,
            ...input.args.slice(input.args.indexOf(subcommand) + 1).filter(a => a.startsWith('-'))] })
          if (!result || result.exitCode !== 0) return result
        }
        return result
      }
      const result = await run(input)
      if (result == null && ['install', 'update'].includes(op)) return {
        exitCode: 1, stderr: 'FH_SOURCE_UNSUPPORTED: 此安装来源尚未被统一接入后端支持。', wroteNothing: true,
      }
      return result
    }),
  }
}
