import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs'
import { apply as mountApproval } from './backend/fish-body-approval.mjs'
import { withStateConfig } from './backend/production-state.mjs'
import { createMarketBodyAdapter, registerMarketManager } from './backend/lib/market-runtime.mjs'
import { npmCommand, packageManagerCommand } from './backend/lib/runtime-programs.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createInstallTransaction } from './install-transaction.js'
import { BINDING_FILE } from './profile-data.js'
import { INTAKE_MODES, DEFAULT_INTAKE_MODE, INTAKE_MODE_KEY } from './analysis/intake-mode.mjs'

/** Full existing backend, scoped to this Profile. No process-global environment mutation. */
export function configureBackend(state, { packageManager = null, installAnchor = null } = {}) {
  const profileDir = state.profileDir, hand = state.paths.hand
  const configPath = join(profileDir, 'fish-body-state.json')
  // 用户默认工作模式（intake mode: off/compatibility/reverse）来自 UI 持久化写入，
  // 与部署用 mode:'production' 分开。每次启动重写 conf 时须保留用户已选值，不回退默认。
  let intakeMode = DEFAULT_INTAKE_MODE
  try {
    if (existsSync(configPath)) {
      const previous = JSON.parse(readFileSync(configPath, 'utf8'))
      if (INTAKE_MODES.includes(previous[INTAKE_MODE_KEY])) intakeMode = previous[INTAKE_MODE_KEY]
    }
  } catch { /* 配置损坏时回退默认，不阻断后端装载 */ }
  const conf = { packageManager, installAnchor, mode: 'production', [INTAKE_MODE_KEY]: intakeMode, frameworkRoot: state.root, handRoot: hand,
    registryPath: join(hand, '插件注册表', 'registry.json'),
    requestsRoot: join(hand, '插件注册表', 'requests'),
    artifactsRoot: join(hand, '插件仓'), decisionsRoot: join(hand, '插件注册表', 'decisions'),
    profileRoot: dirname(profileDir), defaultProfileDir: profileDir,
    snapshotRoot: join(hand, '运行数据', 'snapshots'), reportDir: join(hand, '运行数据', 'reports'),
    auditPath: join(hand, '审计日志', 'plugin-admission.jsonl') }
  mkdirSync(profileDir, { recursive: true })
  const temp = configPath + '.tmp'
  writeFileSync(temp, JSON.stringify(conf, null, 2) + '\n'); renameSync(temp, configPath)
  withStateConfig(configPath, () => { npmCommand(); packageManagerCommand() })
  return configPath
}

export function prepareBackend(ctx, state) {
  const profileDir = state.profileDir
  const configPath = configureBackend(state, ctx.profileContext)
  const plugin = { name: 'fish-body-backend', inject: ['connection'], apply(child) {
    mountApproval(child, { frameworkRoot: state.root, profileDir, stateConfigPath: configPath,
      dataBindingPath: join(profileDir, BINDING_FILE) })
  } }
  const handle = ctx.plugin(plugin)
  const adapter = withStateConfig(configPath, () => createMarketBodyAdapter({ profileDir }))
  const scopedAdapter = Object.fromEntries(Object.entries(adapter).map(([key, value]) => [key,
    typeof value === 'function' ? (...args) => withStateConfig(configPath, () => value(...args)) : value]))
  const req = createRequire(ctx.profileContext.installAnchor)
  // Capability comes from the explicit experimental host export, not its name
  // or a claimed DSH version. Original official installations remain blocked.
  const capability = import(pathToFileURL(req.resolve('@deepseek-ai/dsh-plugin-manager')).href)
  capability.then(module => {
    if (![1, 2].includes(module.installTransactionExtensionVersion)) return
    ctx.effect(() => registerMarketManager(profileDir, null,
      createInstallTransaction({ ...ctx.profileContext, dir: profileDir,
        fixedPackageSourcesVersion:module.fixedPackageSourcesVersion })))
  })
  return { handle, configPath, adapter: scopedAdapter, status: 'host-blocked',
    capability,
    code: 'FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE',
    error: '官方 DSH rc.5 无原生安装事务扩展接口；后端已随包提供，普通安装与市场接管尚未启用。' }
}
