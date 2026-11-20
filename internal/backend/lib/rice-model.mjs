/* fish-body · 饭侧只读来源读模型
 * 职责：把 <root>/饭 下已保存的来源材料读成「来源列表」与「总览摘要」。
 * 硬约束：本模块只做本地文件 stat/read，绝不触发下载 / npm 脚本 / 分析 / 安装 / 版本查询。
 * 版本检查在 version-check.mjs，由调用方显式发起；本模块只提供已登记来源 id 与必要元数据。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const safeJson = (p) => { try { return readJson(p) } catch { return {} } }

function validRoot(root) {
  return typeof root === 'string' && root.trim() && isDir(root) ? resolve(root) : null
}

/** 中文名优先：展示名字段按优先级取值，缺失时回退到可读的仓库/包名。 */
function displayName(source, doc, dir) {
  for (const key of ['displayName', 'nameZh', 'display_name', 'name']) {
    const v = text(source?.[key] ?? doc?.[key]); if (v) return v
  }
  const pkg = text(source?.packageName ?? doc?.packageName)
  if (pkg) return pkg
  if (text(source?.owner) && text(source?.repository)) return `${source.owner}/${source.repository}`
  const repo = text(source?.repository ?? doc?.repository)
  if (repo) return basename(repo)
  return basename(dir ?? '') || '未命名材料'
}

/** 来源类型：github / npm / local / unknown；只看已落盘字段，不发任何网络请求。
 * 明确的本地类型/平台字段（local-copy / local-first-party / sourcePlatform=local）优先，
 * 不能被索引分区的 hint='github' 覆盖成远端来源——否则本地材料会被误标 github 并出现假的检查入口。 */
function classifyType(source, doc, hint) {
  const kind = text(source?.sourceKind ?? doc?.sourceKind ?? source?.sourceType ?? doc?.sourceType)
  const platform = text(source?.sourcePlatform ?? doc?.sourcePlatform)
  if (/^local/i.test(kind || '') || /^local$/i.test(platform || '')) return 'local'
  if (kind === 'npm' || kind === 'git' || kind === 'github') {
    if (kind === 'npm') return 'npm'
    return 'github'
  }
  const url = text(source?.upstreamUrl ?? source?.upstream ?? doc?.upstreamUrl)
  if (url && /github\.com/i.test(url)) return 'github'
  if (url && (/npmjs/i.test(url) || /^npm:/i.test(url))) return 'npm'
  // hint 只作兜底，且不得把显式本地平台/类型或本地路径材料标成 github。
  if (text(source?.localRepositoryPath) || text(source?.localPath)) return 'local'
  if (hint === 'npm') return 'npm'
  if (hint === 'github') return 'github'
  return 'unknown'
}

/**
 * 按索引项对应的真实落盘布局读取来源元数据。兼容三种布局：
 *  ① 旧迁移：仓库子目录内无 来源.json，真实来源在父层 <项目>/来源.json；
 *  ② 当前采集：<项目>/versions/<commit>/来源.json；
 *  ③ 仓库子目录自身 <仓库>/来源.json。
 * 只接受"localRepositoryPath 精确指向本索引 repositoryPath"的父层/版本来源，
 * 避免把邻居或同名来源误配到本项；核对 id/owner/repository 是否被来源覆盖缺失的元数据。
 */
function projectSource(root, p, dir) {
  const repo = text(p?.repositoryPath)
  if (!dir || !repo) return {}
  const dirAbs = resolve(dir)
  const pick = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null
    const lrp = text(candidate.localRepositoryPath ?? candidate.localPath)
    if (lrp && resolve(root, lrp) !== dirAbs) return null      // 关联不匹配：拒绝邻居来源（相对路径基于 root）
    const owner = text(candidate.owner), repository = text(candidate.repository ?? candidate.repo)
    const id = text(p.id)
    // 有 owner/repo 时，若与索引 id 的 owner/repo 都明确且不一致，也拒绝同名误配
    if (owner && repository && /^github\.com\//i.test(id || '')) {
      const m = /^github\.com\/([^/]+)\/([^/]+)/i.exec(id)
      if (m && m[1].toLowerCase() !== owner.toLowerCase()) return null
      if (m && m[2].toLowerCase() !== repository.toLowerCase()) return null
    }
    return candidate
  }
  const read = (fp) => existsSync(fp) ? pick(safeJson(fp)) : null
  const candidates = []
  // ③ 仓库子目录自身
  candidates.push(join(dir, '来源.json'))
  // ① 父层（旧迁移形态）
  candidates.push(join(dirname(dir), '来源.json'))
  // ② versions/<commit>/来源.json（当前采集器形态）
  const versionsDir = join(dirname(dir), 'versions')
  if (isDir(versionsDir)) {
    let commits = []
    try { commits = readdirSync(versionsDir) } catch { commits = [] }
    const pinned = text(p.pinnedCommit)
    const ordered = pinned ? [pinned, ...commits.filter((c) => c !== pinned)] : commits
    for (const c of ordered) {
      if (!c || c.includes('/') || c.includes('\\')) continue
      candidates.push(join(versionsDir, c, '来源.json'))
    }
  }
  for (const fp of candidates) {
    const source = read(fp)
    if (source) return source
  }
  return {}
}

/** 本地版本：优先 list 里的 manifest 版本，其次固定提交短号。 */
function localVersion(source, doc) {
  const v = text(source?.versionFromManifest ?? source?.version ?? doc?.versionFromManifest)
  if (v) return v
  const commit = text(source?.pinnedCommit ?? doc?.pinnedCommit ?? source?.published?.integrity)
  if (commit && commit.length >= 7) return commit.slice(0, 7)
  return null
}

function remoteMetadata(source, doc) {
  const url = text(source?.upstreamUrl ?? source?.upstream ?? doc?.upstreamUrl)
  const owner = text(source?.owner ?? doc?.owner)
  const repo = text(source?.repository ?? source?.repo ?? doc?.repository)
  const subdir = text(source?.subdir ?? doc?.subdir)
  const packageName = text(source?.packageName ?? doc?.packageName)
  const pinnedCommit = text(source?.pinnedCommit ?? doc?.pinnedCommit)
  const versionFromManifest = text(source?.versionFromManifest ?? doc?.versionFromManifest)
  const published = source?.published && typeof source.published === 'object' ? source.published : null
  return { upstreamUrl: url, owner, repo, subdir, packageName, pinnedCommit, versionFromManifest, published }
}

function normalizeItem({ id, source, doc, dir, hint, root }) {
  const sourceType = classifyType(source, doc, hint)
  const meta = remoteMetadata(source, doc)
  const hasRemote = !!(meta.owner && meta.repo && sourceType === 'github') ||
    !!(meta.packageName && sourceType === 'npm') ||
    !!(meta.upstreamUrl && /^https?:\/\//i.test(meta.upstreamUrl) && sourceType !== 'local')
  const status = text(source?.sourceStatus ?? doc?.sourceStatus)
  const parts = [
    sourceType === 'github' ? 'GitHub 来源' : sourceType === 'npm' ? 'npm 来源' : sourceType === 'local' ? '本地材料' : '来源不明',
    status || '已保存材料'
  ]
  return {
    id,
    name: displayName(source, doc, dir),
    sourceType,
    localVersion: localVersion(source, doc),
    description: parts.join(' · '),
    path: dir ? relative(root, dir).replace(/\\/g, '/') : null,
    hasRemote,
    // 内部字段：仅 version-check 用；对外 sources 路由会剔除下划线字段。
    _meta: { ...meta, sourceStatus: status, dir }
  }
}

/** 递归找 来源.json，跳过历史版本/依赖目录；depth 限制避免大目录遍历。 */
function scanSources(base, byId, hint, root, depth) {
  if (!isDir(base) || depth <= 0) return
  let names = []
  try { names = readdirSync(base) } catch { return }
  for (const name of names) {
    if (['versions', 'node_modules', '.git', '材料'].includes(name)) continue
    const child = join(base, name)
    if (!isDir(child)) continue
    const docPath = join(child, '来源.json')
    if (existsSync(docPath)) {
      const source = safeJson(docPath)
      const meta = remoteMetadata(source, {})
      const id = meta.owner && meta.repo
        ? `github.com/${meta.owner}/${meta.repo}${meta.subdir ? '#' + meta.subdir : ''}`
        : `local:${relative(root, child).replace(/\\/g, '/')}`
      if (!byId.has(id)) byId.set(id, normalizeItem({ id, source, doc: {}, dir: child, hint, root }))
    }
    scanSources(child, byId, hint, root, depth - 1)
  }
}

/**
 * npm 来源从 <饭>/npm/<package>/<id>/材料/来源.json 读取。
 * 真实落盘（market-source.mjs ingestNpmPublished）：join(npmRoot, record.packageName, record.id)。
 * 有 scope 的包 packageName='@scope/name' 会形成三层 npm/@scope/name/<id>/材料/来源.json，
 * 无 scope 的包是两层 npm/<pkg>/<id>/材料/来源.json。两种布局都要能列出来。
 */
function scanNpm(riceRoot, byId, root) {
  const npmRoot = join(riceRoot, 'npm')
  if (!isDir(npmRoot)) return
  let packages = []
  try { packages = readdirSync(npmRoot) } catch { return }
  for (const first of packages) {
    const firstDir = join(npmRoot, first)
    if (!isDir(firstDir)) continue
    const scoped = first.startsWith('@')
    // scope 目录：npm/@scope/<name>/<id>/材料；普通目录：npm/<pkg>/<id>/材料
    const packageDirs = []
    if (scoped) {
      let names = []
      try { names = readdirSync(firstDir) } catch { continue }
      for (const name of names) {
        const dir = join(firstDir, name)
        if (isDir(dir)) packageDirs.push({ dir, packageName: `${first}/${name}` })
      }
    } else {
      packageDirs.push({ dir: firstDir, packageName: first })
    }
    for (const { dir: pkgDir, packageName } of packageDirs) {
      let ids = []
      try { ids = readdirSync(pkgDir) } catch { continue }
      for (const id of ids) {
        const material = join(pkgDir, id, '材料', '来源.json')
        if (!existsSync(material)) continue
        const source = safeJson(material)
        const key = `npm:${packageName}/${id}`
        if (byId.has(key)) continue
        byId.set(key, normalizeItem({ id: key, source, doc: {}, dir: join(pkgDir, id), hint: 'npm', root }))
      }
    }
  }
}

/**
 * 来源列表（只读）。返回项含内部 _meta 供 version-check 使用；对外路由剔除下划线字段。
 * 绝不下载 / 执行 npm 脚本 / 分析 / 安装 / 版本查询。
 */
export function listRiceSources({ frameworkRoot } = {}) {
  const root = validRoot(frameworkRoot)
  if (!root) return []
  const riceRoot = join(root, '饭')
  const byId = new Map()

  // ① 项目索引.json 是 github 来源的权威清单
  const indexPath = join(riceRoot, '项目索引.json')
  if (existsSync(indexPath)) {
    const doc = safeJson(indexPath)
    const projects = Array.isArray(doc?.projects) ? doc.projects : []
    for (const p of projects) {
      if (!p || typeof p !== 'object') continue
      const id = text(p.id) || (p.repositoryPath ? `local:${p.repositoryPath}` : null)
      if (!id || byId.has(id)) continue
      const dir = p.repositoryPath ? resolve(root, p.repositoryPath) : null
      // 按真实布局读来源：仓库内 / 父层 / versions/<commit>；核实 localRepositoryPath 关联本仓库，
      // 防邻居误配。本地材料（local-copy/local-first-party）由 classifyType 尊重其类型，不被 hint 误标。
      const source = projectSource(root, p, dir)
      byId.set(id, normalizeItem({ id, source, doc: p, dir, hint: 'github', root }))
    }
  }
  // ② 补齐未进索引的 github/本地来源（upstream 直接写入 <repo>/来源.json）
  scanSources(riceRoot, byId, 'github', root, 3)
  // ③ npm 来源
  scanNpm(riceRoot, byId, root)

  return [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
}

/** 供 check-version 按已登记 id 精确取回一条来源；不接受任意 URL/路径。 */
export function findRiceSource({ frameworkRoot, id } = {}) {
  if (typeof id !== 'string' || !id) return null
  return listRiceSources({ frameworkRoot }).find((row) => row.id === id) ?? null
}

/** 对外安全的 sources 列表（剔除内部字段）。 */
export function publicSources(options) {
  return listRiceSources(options).map(({ _meta, ...item }) => item)
}

/**
 * 统计分析任务。现行 tasks.mjs 经 records.mjs newRecordDirectory 把新任务写在
 * 任务/<插件>-拆分任务/<id>/task.json（外层拆分目录 + 内层 UUID 任务目录）；
 * 历史任务仍在 任务/<id>/task.json。两种布局都要数到，且不去重误计无关数据。
 * 只读 task.json，校验 schema/taskId 与目录名一致，不伪造 phase。
 */
function countTasks(root) {
  const base = join(root, '鱼的胃', '任务')
  if (!isDir(base)) return { count: 0, phases: {} }
  let count = 0
  const phases = {}
  const counted = new Set()
  const consider = (dir, name) => {
    const file = join(dir, 'task.json')
    if (!existsSync(file) || counted.has(file)) return
    const task = safeJson(file)
    if (task?.taskId !== name && task?.schema !== 'fish-stomach-task/v1') return
    counted.add(file)
    count++
    const phase = text(task.phase) || 'unknown'
    phases[phase] = (phases[phase] ?? 0) + 1
  }
  let outers = []
  try { outers = readdirSync(base) } catch { return { count: 0, phases: {} } }
  for (const outer of outers) {
    const group = join(base, outer)
    if (!isDir(group)) continue
    // 旧布局：任务/<id>/task.json
    consider(group, outer)
    // 现行拆分布局：任务/<插件>-拆分任务/<id>/task.json
    let inners = []
    try { inners = readdirSync(group) } catch { continue }
    for (const inner of inners) {
      const innerDir = join(group, inner)
      if (isDir(innerDir)) consider(innerDir, inner)
    }
  }
  return { count, phases }
}

/* 真实 phase 取值，只读核实自 internal/analysis/tasks.mjs 状态机（:245/:291/:298/:302）：
 * 未产出：selection-pending（刚创建）、plan-pending（计划待改）；
 * 已产出：materials-produced（reverse 产出材料）、plan-awaiting-confirmation（compatibility 产出方案）；
 * 已确认：materials-confirmed / model-reviewed-awaiting-user / confirmed-with-open-questions / confirmed-awaiting-separate-execution。
 * 只有「已产出或已确认」才计入「已产出方案或材料」，未产出阶段一律不计，杜绝误计。 */
const PRODUCED_PHASES = new Set([
  'materials-produced', 'plan-awaiting-confirmation', 'materials-confirmed',
  'model-reviewed-awaiting-user', 'confirmed-with-open-questions', 'confirmed-awaiting-separate-execution'
])

function countPlugins(root) {
  const file = join(root, '鱼的手', '插件注册表', 'registry.json')
  if (!existsSync(file)) return { count: 0 }
  const doc = safeJson(file)
  const plugins = Array.isArray(doc?.plugins) ? doc.plugins
    : doc?.plugins && typeof doc.plugins === 'object' ? Object.values(doc.plugins) : []
  return { count: plugins.length }
}

/** overview 单项：rice（饭侧来源读取）。失败只影响本项。 */
function riceSummary(root) {
  const items = listRiceSources({ frameworkRoot: root })
  if (!items.length) return { key: 'rice', title: '饭·来源', summary: '尚未保存任何插件来源材料。', state: 'empty', href: '#rice' }
  const github = items.filter((x) => x.sourceType === 'github').length
  const npm = items.filter((x) => x.sourceType === 'npm').length
  const ready = items.filter((x) => (x._meta?.sourceStatus ? /collected|downloaded/i.test(x._meta.sourceStatus) : true)).length
  return {
    key: 'rice', title: '饭·来源',
    summary: `已保存 ${items.length} 份来源材料（GitHub ${github} · npm ${npm}），其中 ${ready} 份已就绪。`,
    state: ready === items.length ? 'ok' : ready > 0 ? 'partial' : 'empty',
    href: '#rice'
  }
}

function stomachSummary(root) {
  const { count, phases } = countTasks(root)
  if (!count) return { key: 'stomach', title: '胃·分析', summary: '尚无分析任务。', state: 'empty', href: '#stomach' }
  const done = Object.entries(phases).filter(([k]) => PRODUCED_PHASES.has(k)).reduce((s, [, v]) => s + v, 0)
  return {
    key: 'stomach', title: '胃·分析',
    summary: `共 ${count} 个分析任务，其中 ${done} 个已产出方案或材料。`,
    state: done > 0 ? 'ok' : 'partial', href: '#stomach'
  }
}

function handSummary(root) {
  const { count } = countPlugins(root)
  if (!count) return { key: 'hand', title: '手·组件', summary: '插件注册表为空。', state: 'empty', href: '#hand' }
  return { key: 'hand', title: '手·组件', summary: `插件注册表已登记 ${count} 个插件。`, state: 'ok', href: '#hand' }
}

/** 总览摘要：三项各自 try/catch，单项失败只标该项 error+中文 summary，不影响其他。 */
export function overview({ frameworkRoot } = {}) {
  const root = validRoot(frameworkRoot)
  const errorItem = (key, title) => ({ key, title, summary: '该项读取失败（不影响其他分区）。', state: 'error', href: '#' + key })
  const items = []
  for (const [key, title, fn] of [
    ['rice', '饭·来源', riceSummary],
    ['stomach', '胃·分析', stomachSummary],
    ['hand', '手·组件', handSummary]
  ]) {
    if (!root) { items.push({ key, title, summary: '尚未绑定有效的鱼身体根目录。', state: 'empty', href: '#' + key }); continue }
    try { items.push(fn(root)) }
    catch { items.push(errorItem(key, title)) }
  }
  return { ok: true, items }
}
