import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { bodyProfileData } from './body-data.js'
import { configureBackend } from './backend-entry.js'
import { withStateConfig, loadProductionState } from './backend/production-state.mjs'
import { createMarketBodyAdapter, prepareInChild, restorePreparedRegistration } from './backend/lib/market-runtime.mjs'
import { classifyPnpmArgs, parseInstallSpecs, nativeOfficialSpecs } from './backend/fish-hand-admission-gate.mjs'
import { readBodyPhase } from './backend/lib/body-switch.mjs'

/** Entry declared by the bundle; called only by the experimental native seam.
 * No candidate JavaScript is imported. Preparation uses the existing backend.
 */
export function createInstallTransaction(context) {
  const profileDir = context.dir
  if (readBodyPhase({profileDir}).phase === 'off') return { run: async () => null }
  const data = bodyProfileData(context)
  const state = data.state()
  if (state.status !== 'ready') return { run: async ({ args }) => {
    const op = classifyPnpmArgs(args).op
    if (!['install', 'update', 'repair'].includes(op)) return null
    return { exitCode: 2, nativeChoiceRequired: { code:'FISH_DATA_NOT_READY',
      reason:state.error || '胃尚未初始化；可明确选择本次原生安装，不要求先初始化。' }, wroteNothing: true }
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
    return prepareInChild(input, {...controls,timeoutMs:context.prepareTimeoutMs})
  }
  const adapter = withStateConfig(configPath, () => createMarketBodyAdapter({ profileDir, prepare, prepareLocal: true,
    sourcePreservationVersion:context.fixedPackageSourcesVersion }))
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
      const current = data.state()
      if (current.status !== 'ready') return {
        exitCode: 2, nativeChoiceRequired:{code:'FISH_DATA_NOT_READY',reason:current.error || current.status}, wroteNothing: true,
      }
      if (current.root !== state.root) return {
        exitCode: 2, nativeChoiceRequired:{code:'FH_ROOT_RELOAD_REQUIRED',reason:'数据位置已切换；旧实例不得继续写旧根。'}, wroteNothing: true,
      }
      if (nativeOfficialSpecs(input.args)) return null
      const op = classifyPnpmArgs(input.args).op
      const { specs, subcommand } = parseInstallSpecs(input.args)
      if (['install', 'update'].includes(op) && specs.length > 1) {
        let result
        const results=[]
        for (const [index,spec] of specs.entries()) {
          const decisionArgs=[...input.args.slice(0,input.args.indexOf(subcommand)),'add',spec,
            ...input.args.slice(input.args.indexOf(subcommand)+1).filter(a=>a.startsWith('-'))]
          result = await run({ ...input, args:decisionArgs })
          results.push({target:spec,result})
          if (!result || result.exitCode !== 0) return result && {...result,decisionArgs,completed:results.slice(0,-1),
            remainingArgs:specs.slice(index+1).length?['add',...specs.slice(index+1),
              ...input.args.slice(input.args.indexOf(subcommand)+1).filter(a=>a.startsWith('-'))]:null}
        }
        return {...result,completed:results}
      }
      const result = await run(input)
      if (result == null && ['install', 'update'].includes(op)) return {
        exitCode: 1, stderr: 'FH_SOURCE_UNSUPPORTED: 此安装来源尚未被统一接入后端支持。', wroteNothing: true,
      }
      return result
    }),
  }
}
