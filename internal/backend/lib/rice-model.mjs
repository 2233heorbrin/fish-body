/* fish-body · 饭侧只读来源读模型
 * 职责：把 <root>/饭 下已保存的来源材料读成「来源列表」与「总览摘要」。
 * 硬约束：本模块只做本地文件 stat/read，绝不触发下载 / npm 脚本 / 分析 / 安装 / 版本查询。
 * 版本检查在 version-check.mjs，由调用方显式发起；本模块只提供已登记来源 id 与必要元数据。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { mapInstalled, repoFromDeclaration } from './install-mapping.mjs'
// #327：直装登记来源的只读实时查询（不回指 rice-model，无环）。install-mapping 的
// readRealInstall 只认 registry+formalDecisionId+requestId，覆盖不到 registration-only 直装行；
// 这里补一层「直装登记优先判定」，旧 mapInstalled 规则一行不动。
import { listDirectSources } from './market-direct-source.mjs'

// 直装登记查询只读且必须健壮：文件损坏/并发读写不能让饭页 sources 列表整体 500。
function safeDirectSources(frameworkRoot, profileDir) {
  try { return listDirectSources({ frameworkRoot, profileDir }) || [] } catch { return [] }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const safeJson = (p) => { try { return readJson(p) } catch { return {} } }

// W2 来源登记状态口径（跨 Agent 契约第 3 节）：对外 item 顶层必须直接带四值之一。
// registration-only = 直装只登记真实来源未采材料；material-absent = 明确无材料，
// 两者都不得冒充「已保存材料」。既有 collected/downloaded-pinned 语义保持不变。
export const SOURCE_STATUS_VALUES = Object.freeze(['collected', 'downloaded-pinned', 'registration-only', 'material-absent'])
function sourceStatusOf(meta) {
  const s = text(meta?.sourceStatus)
  return SOURCE_STATUS_VALUES.includes(s) ? s : 'collected'
}

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
  // 只认明确的本地语义。注意 sourceKind='local-git-fixture' 这类值虽以 local 开头，
  // 却是带真实 GitHub upstream 的 git 材料（如 dsh-context），不能用 /^local/ 前缀误伤。
  const explicitLocal =
    /^(local-copy|local-first-party|local)$/i.test(kind || '') ||
    /^local$/i.test(platform || '')
  if (explicitLocal) return 'local'
  if (kind === 'npm' || kind === 'git' || kind === 'github' || kind === 'local-git-fixture') {
    if (kind === 'npm') return 'npm'
    return /^local$/i.test(platform || '') ? 'local' : 'github'
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
  const id = text(p.id) || ''
  const idxSubdir = text(p.subdir)
  // 解析索引 id：github.com/<owner>/<repo>[/<subpackages/...>][#<subdir>]。
  // 不能用 ([^/]+) 吞掉 #subdir——那会把 monorepo 子包名吃进 repo，破坏兄弟子包区分。
  let idxOwner = null, idxRepo = null
  const gh = /^github\.com\/([^/#]+)\/([^/#]+)/i.exec(id)
  if (gh) { idxOwner = gh[1]; idxRepo = gh[2] }
  // 来源里的物理材料名（sourceMaterialName = repo/subpackages/<encoded-subdir>），
  // 用来核对 monorepo 子包，避免把兄弟子包来源配到本索引项。
  const materialMatches = (candidate) => {
    if (!idxSubdir && !/#/.test(id)) return true            // 非子包索引：无需核对子包
    const mName = text(candidate.sourceMaterialName)
    const sub = text(candidate.subdir)
    if (mName) {
      // 若材料名是 repo/subpackages/<enc>，其编码子目录须能对应索引 subdir。
      const enc = idxSubdir ? encodeURIComponent(idxSubdir.replace(/^\/+|\/+$/g, '')) : null
      if (enc && mName.includes('/subpackages/')) return mName.endsWith('/subpackages/' + enc)
      if (sub && idxSubdir && sub.replace(/^\/+|\/+$/g, '') !== idxSubdir.replace(/^\/+|\/+$/g, '')) return false
      return true
    }
    if (sub && idxSubdir && sub.replace(/^\/+|\/+$/g, '') !== idxSubdir.replace(/^\/+|\/+$/g, '')) return false
    return true
  }
  const pick = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || !Object.keys(candidate).length) return null
    const lrp = text(candidate.localRepositoryPath ?? candidate.localPath)
    // 关联确认：必须有能指向本仓库的 localRepositoryPath（相对基于 root / 绝对归一）。
    // 缺 lrp 的父层/版本来源一律不认；safeJson 失败得到 {} 也会被上面 empty 检查拒绝。
    if (!lrp || resolve(root, lrp) !== dirAbs) return null
    const owner = text(candidate.owner), repository = text(candidate.repository ?? candidate.repo)
    if (owner && idxOwner && owner.toLowerCase() !== idxOwner.toLowerCase()) return null
    if (repository && idxRepo && repository.toLowerCase() !== idxRepo.toLowerCase()) return null
    if (!materialMatches(candidate)) return null
    return candidate
  }
  const read = (fp) => {
    if (!existsSync(fp)) return null
    let obj; try { obj = safeJson(fp) } catch { return null }
    return pick(obj)
  }
  const candidates = []
  // ③ 仓库子目录自身
  candidates.push(join(dir, '来源.json'))
  // ① 父层（旧迁移形态）
  candidates.push(join(dirname(dir), '来源.json'))
  // ② versions/<pinnedCommit>/来源.json —— 只认索引固定提交，绝不扫描其他提交冒充当前来源。
  const pinned = text(p.pinnedCommit)
  if (pinned && !pinned.includes('/') && !pinned.includes('\\')) {
    candidates.push(join(dirname(dir), 'versions', pinned, '来源.json'))
  }
  for (const fp of candidates) {
    const source = read(fp)
    if (source) return source
  }
  return {}
}

/** 本地版本：优先 list 里的 manifest 版本，其次登记的内容身份版本，再次固定提交短号。 */
function localVersion(source, doc) {
  const v = text(source?.versionFromManifest ?? source?.version ?? source?.contentIdentity?.version
    ?? doc?.versionFromManifest)
  if (v) return v
  const commit = text(source?.pinnedCommit ?? source?.updateChannel?.resolvedCommit
    ?? source?.updateChannel?.requestedRef ?? doc?.pinnedCommit ?? source?.published?.integrity)
  if (commit && commit.length >= 7) return commit.slice(0, 7)
  return null
}

function remoteMetadata(source, doc) {
  // Codex #315 #4：直装登记记录把原渠道写在 updateChannel、真实版本写在 contentIdentity。
  // 兼容这些字段，让 hasRemote / localVersion / sourceStatus 有值；不覆盖既有 upstream/owner/repo 语义。
  const channel = source?.updateChannel && typeof source.updateChannel === 'object' ? source.updateChannel : null
  const url = text(source?.upstreamUrl ?? source?.upstream ?? doc?.upstreamUrl ?? channel?.sourceUrl)
  const owner = text(source?.owner ?? doc?.owner) ?? (() => {
    const m = /github\.com[:/]([^/#]+)\/([^/#]+)/i.exec(String(url ?? '')); return m?.[1] ?? null
  })()
  const repo = text(source?.repository ?? source?.repo ?? doc?.repository) ?? (() => {
    const m = /github\.com[:/]([^/#]+)\/([^/#]+)/i.exec(String(url ?? '')); return m?.[2]?.replace(/\.git$/i, '') ?? null
  })()
  const subdir = text(source?.subdir ?? doc?.subdir ?? channel?.sourceSubdir)
  const packageName = text(source?.packageName ?? doc?.packageName ?? source?.packageNameFromManifest ?? doc?.packageNameFromManifest)
  const pinnedCommit = text(source?.pinnedCommit ?? doc?.pinnedCommit ?? channel?.resolvedCommit ?? channel?.requestedRef ?? channel?.ref)
  const versionFromManifest = text(source?.versionFromManifest ?? doc?.versionFromManifest
    ?? source?.contentIdentity?.version
    ?? source?.packageJson?.version ?? doc?.packageJson?.version)
  const published = source?.published && typeof source.published === 'object' ? source.published : null
  // packageJson.repository 是包清单里声明的规范仓库（同源核对证据），并入 published 视图供 declaredRepoOf 读取。
  const packageJsonRepo = text(source?.packageJson?.repository?.url ?? source?.packageJson?.repository
    ?? doc?.packageJson?.repository?.url ?? doc?.packageJson?.repository)
  return { upstreamUrl: url, owner, repo, subdir, packageName, pinnedCommit, versionFromManifest,
    published, packageJsonRepo, updateChannel: channel, contentIdentity: source?.contentIdentity ?? null }
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

/* ---------- 饭来源归组（对外 sources 列表） ----------
 * 关键原则（公共接口约定 v1.1 / Codex #241）：
 *   - 包名相同 ≠ 同源。同一 packageName 只是「声明」，fork 常保留上游包名与 repository 声明。
 *   - npm 项只有在「npm 发布包声明的规范仓库 + 实际获取的 GitHub owner/repo/subdir」能核对一致时，
 *     才允许与对应 GitHub 项合并成一张根卡；否则单列并标 identityBasis='unconfirmed'。
 *   - GitHub 身份优先实际来源（owner/repo/subdir），不能被包内 repository 声明拉回上游。
 *   - groupKey 规则：有经核实的 packageName→pkg:<norm>；仅 GitHub 无包名→gh:<owner>/<repo>[#subdir]；
 *     无法确认→solo:<原id>。不同 scope / 不同 owner fork / 同仓不同 subdir 必须不同键。
 *   - groupName：已核实 packageName 优先，否则 displayName。sourceHistory 聚合同组成员。
 *   - install 只在每张根卡首条带（mapInstalled 只读核实；profileDir 由宿主上下文注入，不硬编码）。
 */

/** 规范化包名：小写、去首尾空白，@scope 保留。 */
function normPackageName(v) {
  const s = text(v)
  return s ? s.toLowerCase() : null
}

/** 从 npm 发布元数据里读「该发布包声明的规范仓库」。只认发布态声明，不拿本地路径硬凑。 */
function declaredRepoOf(meta) {
  const pub = meta?.published && typeof meta.published === 'object' ? meta.published : {}
  // 声明仓库来源：npm 发布元数据 repository/homepage，或包清单 packageJson.repository。
  const decl = text(pub.repository?.url ?? pub.repository ?? pub.homepage ?? meta?.packageJsonRepo) ?? null
  const repo = decl ? repoFromDeclaration(decl) : null
  return repo ? { ...repo, subdir: text(pub.repository?.directory ?? pub.directory) } : null
}

/** 实际 GitHub 身份：优先已落盘的 owner/repo（真实获取来源），subdir 区分同仓子包。 */
function actualIdentityOf(meta) {
  const owner = text(meta?.owner), repo = text(meta?.repo)
  if (!owner || !repo) return null
  return { owner, repo, subdir: text(meta?.subdir) }
}

function repoSame(a, b) {
  return !!(a && b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase())
}
function subdirSame(a, b) {
  const norm = (s) => (text(s) || '').replace(/^\/+|\/+$/g, '').toLowerCase()
  return norm(a) === norm(b)
}
function encodeSubdir(s) {
  const v = text(s)
  return v ? '#' + encodeURIComponent(v.replace(/^\/+|\/+$/g, '')) : ''
}

/** 每条来源的身份证据（只读 _meta，不改 dev.9 的字段判定）。 */
function identityEvidence(rows) {
  return rows.map((row) => {
    const meta = row._meta || {}
    // 包名「经包清单核实」：versionFromManifest 存在或 published 存在才算核实，否则只是索引声明。
    const rawPkg = text(meta.packageName)
    const verifiedPkg = rawPkg && (meta.versionFromManifest || meta.published || row.sourceType === 'npm') ? normPackageName(rawPkg) : null
    return {
      row,
      meta,
      sourceType: row.sourceType,
      pkgName: verifiedPkg,
      actual: actualIdentityOf(meta),
      declared: declaredRepoOf(meta),
      localVersion: row.localVersion
    }
  })
}

/**
 * 内容等价指纹：同包名 + 同一份「仓库内容摘要」（npm integrity/dist.tarball 或固定提交）。
 * 仅能证明内容相同，不能证明这些历史里哪一条就是当前安装来源——绝不据此挑第一条。
 */
function contentFingerprintOf(e) {
  const pkg = (e.pkgName || normPackageName(text(e.row?.name) || '') || '').toLowerCase()
  if (!pkg) return null
  const pub = e.meta?.published && typeof e.meta.published === 'object' ? e.meta.published : {}
  const digest = text(pub.integrity) || text(pub.dist?.integrity) || text(pub.dist?.tarball) || text(e.meta?.pinnedCommit)
  if (!digest) return null
  return `${pkg}\u0000${digest.toLowerCase()}`
}

/**
 * #327 直装登记优先判定：一行来源证据是否就是「当前 Profile 下真实已装、且来自本轮直装登记」。
 * 三条必须全满足，任一不满足 → null（交回旧 mapInstalled 规则，一行不动）：
 *   ① 包名归一相等（e.pkgName ↔ record.packageName）；
 *   ② 该行确属直装登记（e.meta.sourceStatus === 'registration-only'，且 directSources 里确有其记录）；
 *   ③ 同名多条时用 linkRealPath / bodyPath / contentIdentity.version 交叉，只认唯一一条。
 * 只认「当前 Profile 声明 spec + 当前 link realpath + 登记身份 + 实时内容身份」全部实时核过的记录；
 * 历史同包不同 id / 不同 bodyPath / 已卸载（realpath 消失）一律不冒当前。
 */
function directRegistrationFor(e, directSources) {
  if (!Array.isArray(directSources) || !directSources.length) return null
  const meta = e.meta || {}
  // ② 确属直装登记行（直装 sources.json 的 sourceStatus=registration-only）。
  if (text(meta.sourceStatus) !== 'registration-only') return null
  const pkg = normPackageName(e.pkgName || text(meta.packageName) || text(e.row?.name))
  if (!pkg) return null
  // ① 包名归一相等。
  const sameName = directSources.filter((r) => normPackageName(r.packageName) === pkg)
  if (!sameName.length) return null
  // 实时内容身份已漂移（改字节/改版本）的登记行不冒当前安装；原样交回旧规则，basis 由下方修正。
  // ③ 用 linkRealPath / bodyPath / contentIdentity.version 交叉，只认唯一条。
  const version = text(meta.contentIdentity?.version) || text(meta.versionFromManifest) || null
  const uniq = sameName.filter((r) => {
    if (r.contentDrift) return false
    const rver = text(r.contentIdentity?.version)
    if (version && rver && version !== rver) return false
    const rBody = text(r.bodyPath), rLink = text(r.linkRealPath)
    const mBody = text(meta.contentIdentity?.linkRealPath || meta.bodyPath || meta.linkRealPath)
    if (mBody && rBody && mBody !== rBody && mBody !== rLink) return false
    return true
  })
  if (uniq.length !== 1) return null
  return uniq[0]
}

/**
 * 统一「逐来源安装映射」：列表 publicSources、单条/批量版本路由 attachInstallToSources
 * 都走这里，保证同一份材料在三条链路得到完全一致的 install 结论，杜绝卡头未确认/行已安装的分裂。
 * 口径与原 groupSources:452-461 完全相同，不硬编码 profileDir（由 options.profileDir 注入）。
 * sourceId 语义：只有 state==='installed' 且身份可核实才回显该来源 id（已核实关联）；
 * unconfirmed/not-installed 一律 null，绝不把输入 id 原样回显冒充当前来源。
 * 内容等价：同包名同摘要的多条历史若都被判 installed，仅能证明内容相同，
 * 全部降为 unconfirmed 并在 basis 说明「内容等价、具体当前来源未确认」，不挑第一条、不并成多个当前来源。
 */
function resolveInstalls(evidence, options = {}) {
  const installs = new Map()
  // #327：一次取当前 Profile 直装登记来源（只读、实时核 realpath/身份/Profile；卸载后自动消失）。
  // 没有 profileDir/frameworkRoot 上下文时返回空数组，全部回退旧规则（不硬编码、不探测其他 Profile）。
  const directSources = (options.frameworkRoot && options.profileDir)
    ? safeDirectSources(options.frameworkRoot, options.profileDir)
    : []
  for (const e of evidence) {
    // #327 直装登记优先判定：命中 → 直接 installed/direct-registration，不再走 mapInstalled
    // 那套 registry+formalDecisionId+requestId 三源交叉（那是分析产物路径，registration-only 无分支消费）。
    const direct = directRegistrationFor(e, directSources)
    if (direct) {
      installs.set(e.row.id, {
        state: 'installed',
        source: 'direct-registration',
        version: text(direct.contentIdentity?.version) || e.row.localVersion || null,
        sourceId: e.row.id,
        sourceStatus: 'registration-only',
        basis: `当前 Profile 直装登记来源：包名、link realpath（落在本体仓内）、登记身份与实时内容身份交叉核实一致；零胃分析、无正式决定。本体 ${text(direct.bodyPath || direct.linkRealPath) || '未知'}。`,
        directRegistration: {
          sourceKind: direct.sourceKind || null,
          sourceSpec: text(direct.sourceSpec || direct.npmSpec) || null,
          requestedRef: text(direct.requestedRef) || null,
          resolvedCommit: text(direct.resolvedCommit) || null,
          bodyPath: text(direct.bodyPath) || null,
          linkRealPath: text(direct.linkRealPath) || null,
          contentIdentity: direct.contentIdentity || null
        }
      })
      continue
    }
    const act = e.actual
    const raw = mapInstalled({
      frameworkRoot: options.frameworkRoot,
      packageName: e.pkgName || e.row.name,
      ownerRepo: act ? { owner: act.owner, repo: act.repo } : null,
      pinnedCommit: e.meta?.pinnedCommit || null,
      subdir: act?.subdir || null,
      profileDir: options.profileDir || null,
      decisionsDirs: options.decisionsDirs,
      sourceId: e.row.id,
      deps: options.installDeps || {}
    })
    // #327 unconfirmed 文案按真实原因：直装登记行没命中是因为内容漂移/仓外/realpath 失配/同名多条，
    // 绝不一律归因「内容等价历史」。旧规则未命中本就有自己的 basis，这里只对直装登记行补真实原因。
    if (raw.state === 'unconfirmed' && text(e.meta?.sourceStatus) === 'registration-only') {
      const why = directSources.some((r) => normPackageName(r.packageName) === normPackageName(e.pkgName || text(e.meta.packageName)))
        ? '直装登记身份与当前安装的 link realpath/版本/内容身份交叉未通过（内容漂移或同名多条无法唯一认定）'
        : '当前 Profile 无匹配的直装登记来源（可能已卸载、本体 realpath 消失或不属于当前 Profile）'
      installs.set(e.row.id, { ...raw, basis: `${why}；当前安装来源未确认，未伪造正式决定或分析批准。` })
      continue
    }
    installs.set(e.row.id, { ...raw })
  }
  // 内容等价检测：只有被判 installed 的条目才需要辨别「多条同内容冒充多个当前来源」。
  const byContent = new Map()
  for (const e of evidence) {
    const inst = installs.get(e.row.id)
    if (!inst || inst.state !== 'installed') continue
    const fp = contentFingerprintOf(e)
    if (!fp) continue
    if (!byContent.has(fp)) byContent.set(fp, [])
    byContent.get(fp).push(e)
  }
  for (const group of byContent.values()) {
    if (group.length < 2) continue
    const ids = group.map((e) => e.row.id).join('、')
    for (const e of group) {
      const inst = installs.get(e.row.id)
      installs.set(e.row.id, {
        ...inst,
        state: 'unconfirmed',
        source: 'unknown',
        sourceId: null,
        basis: `${inst.basis || ''}；同组 ${group.length} 条历史内容等价（相同仓库摘要/固定提交：${ids}），仅凭内容相同不能证明其中某一条就是当前安装来源，具体当前来源未确认，也未挑选为首条。`
      })
    }
  }
  // sourceId 收口：只有已核实 installed 才带来源 id，其余一律 null（不回显输入）。
  for (const [id, inst] of installs) {
    if (inst.state !== 'installed' && inst.sourceId != null) installs.set(id, { ...inst, sourceId: null })
  }
  return installs
}

/** 归组：返回每条来源带 groupKey/groupName/identityBasis/sourceHistory/install 的对外项。 */
function groupSources(options) {
  const rows = listRiceSources(options)
  const evidence = identityEvidence(rows)
  // 缺陷1：逐来源安装映射统一在 resolveInstalls 完成，列表每条都带 install，
  // 与单条/批量版本路由同判据，避免「卡头未确认、npm 行已安装」的分裂结论。
  const installs = resolveInstalls(evidence, options)
  const byActual = new Map() // owner/repo -> 证据集合（GitHub 实际来源）
  for (const e of evidence) {
    if (!e.actual || e.sourceType !== 'github') continue
    const key = `${e.actual.owner.toLowerCase()}/${e.actual.repo.toLowerCase()}`
    if (!byActual.has(key)) byActual.set(key, [])
    byActual.get(key).push(e)
  }

  // 预处理：每个核实包名对应的「实际 GitHub 身份」集合。>1 说明同名却来自不同实际仓库/子目录，
  // 此时禁止用 pkg 键把这些项并到一起（防 fork 与同仓兄弟子包误并）。
  const actualsByPkg = new Map()
  for (const e of evidence) {
    if (!e.pkgName || !e.actual || e.sourceType !== 'github') continue
    if (!actualsByPkg.has(e.pkgName)) actualsByPkg.set(e.pkgName, new Set())
    actualsByPkg.get(e.pkgName).add(
      `${e.actual.owner.toLowerCase()}/${e.actual.repo.toLowerCase()}${encodeSubdir(e.actual.subdir)}`)
  }
  const ambiguousPkg = new Set(
    [...actualsByPkg.entries()].filter(([, set]) => set.size > 1).map(([pkg]) => pkg))

  // 缺陷4：纯 npm 历史材料（无实际 GitHub 身份）凭「同核实包名 + 同声明规范仓库（owner/repo/subdir 一致）」
  // 互证同源。只有满足全部条件的 ≥2 条才归一成 pkg 组；fork（actual 与 declared 冲突）、
  // ambiguousPkg（同名多实际身份）、declared 缺失或互相冲突的项都不进这个互证集合，仍各自 solo:unconfirmed。
  const npmClaimKey = (e) => `${e.pkgName}\u0000${e.declared.owner.toLowerCase()}/${e.declared.repo.toLowerCase()}\u0000${(e.declared.subdir || '').toLowerCase()}`
  const npmClaimGroups = new Map()
  for (const e of evidence) {
    if (e.sourceType !== 'npm' || !e.pkgName || !e.declared || e.actual) continue
    if (ambiguousPkg.has(e.pkgName)) continue
    const key = npmClaimKey(e)
    if (!npmClaimGroups.has(key)) npmClaimGroups.set(key, [])
    npmClaimGroups.get(key).push(e)
  }

  // 缺陷4：同名 npm 若声明了多个不同规范仓库（如 acme/one 与 acme/two），它们互相冲突，
  // 绝不能共用一个 pkg:${pkgName} 键把四条款目并成一组。只有声明仓库唯一的包才用裸 pkg 键
  // （保护 dev.9/dev.10 正例：同源历史归一）；冲突包按声明仓库分键。
  const npmDeclaredByPkg = new Map()
  for (const e of evidence) {
    if (e.sourceType !== 'npm' || !e.pkgName || !e.declared) continue
    if (!npmDeclaredByPkg.has(e.pkgName)) npmDeclaredByPkg.set(e.pkgName, new Set())
    npmDeclaredByPkg.get(e.pkgName).add(
      `${e.declared.owner.toLowerCase()}/${e.declared.repo.toLowerCase()}${encodeSubdir(e.declared.subdir)}`)
  }
  const npmConflictPkg = new Set(
    [...npmDeclaredByPkg.entries()].filter(([, set]) => set.size > 1).map(([pkg]) => pkg))
  const npmPkgKey = (e) => {
    const base = `pkg:${e.pkgName}`
    if (!npmConflictPkg.has(e.pkgName) || !e.declared) return base
    return `${base}@${e.declared.owner.toLowerCase()}/${e.declared.repo.toLowerCase()}${encodeSubdir(e.declared.subdir)}`
  }

  const ghKeyOf = (actual) => `gh:${actual.owner.toLowerCase()}/${actual.repo.toLowerCase()}${encodeSubdir(actual.subdir)}`

  // 每张根卡的判定：groupKey / groupName / identityBasis。
  const decision = evidence.map((e) => {
    // ① fork 自证最优先：GitHub 实际来源与包内声明仓库指向不同 owner/repo ——
    //    以实际来源单列，绝不因包内 repository 仍指上游被并回上游 pkg 组。
    if (e.actual && e.sourceType === 'github' && e.declared && !repoSame(e.actual, e.declared)) {
      return { ...e, groupKey: ghKeyOf(e.actual), identityBasis: 'unconfirmed' }
    }
    // ② npm 项用「声明仓库」与实际 GitHub 材料核对同源；核对通过才允许并入 pkg 组。
    if (e.sourceType === 'npm') {
      let matched = null
      if (e.declared && e.pkgName && !ambiguousPkg.has(e.pkgName)) {
        const key = `${e.declared.owner.toLowerCase()}/${e.declared.repo.toLowerCase()}`
        const candidates = byActual.get(key) || []
        matched = candidates.find((g) => subdirSame(e.declared.subdir, g.actual.subdir)) || null
      }
      if (matched && e.pkgName) return { ...e, groupKey: npmPkgKey(e), identityBasis: 'package-manifest' }
      // 缺陷4：无实际 GitHub 身份的多条 npm，声明同一规范仓库且包名一致 → 互证归一成 pkg 组。
      // 仅在互证集合 ≥2 条时生效（避免单条样本凭自身声明自我确认）；fork/ambiguous/声明冲突已在建集合时排除。
      // npmPkgKey 对声明仓库冲突的包追加 owner/repo 后缀，避免 acme/one 与 acme/two 被并成同一键。
      if (e.declared && e.pkgName && !e.actual && !ambiguousPkg.has(e.pkgName)) {
        const mates = npmClaimGroups.get(npmClaimKey(e)) || []
        if (mates.length >= 2) return { ...e, groupKey: npmPkgKey(e), identityBasis: 'package-manifest' }
      }
      // 声明仓库缺失/冲突/对不上实际材料 —— 单列标来源关联未确认，不按包名吸入别人的根卡。
      return { ...e, groupKey: `solo:${e.row.id}`, identityBasis: 'unconfirmed' }
    }
    // ③ GitHub 实际来源：有核实包名且包名未被多实际身份污染 → pkg 键；否则实际身份键。
    if (e.actual && e.sourceType === 'github') {
      if (e.pkgName && !ambiguousPkg.has(e.pkgName)) {
        return { ...e, groupKey: `pkg:${e.pkgName}`, identityBasis: 'package-manifest' }
      }
      return { ...e, groupKey: ghKeyOf(e.actual), identityBasis: 'owner-repo' }
    }
    // ④ 有包名但无 GitHub 实际身份的来源（如纯本地带 packageName）：单列并标未确认，
    //    不凭包名把它和远端根卡合并。
    return { ...e, groupKey: `solo:${e.row.id}`, identityBasis: 'unconfirmed' }
  })

  // 按 groupKey 聚合 sourceHistory；install 只挂每张卡首条。
  const order = []
  const buckets = new Map()
  for (const d of decision) {
    if (!buckets.has(d.groupKey)) { buckets.set(d.groupKey, []); order.push(d.groupKey) }
    buckets.get(d.groupKey).push(d)
  }
  const result = []
  for (const key of order) {
    const group = buckets.get(key)
    // 根卡首条优先取有 GitHub 实际身份者，便于 install 关联 owner/repo。
    const headIdx = Math.max(0, group.findIndex((d) => d.actual))
    const name = group.find((d) => d.pkgName)?.pkgName || group[headIdx].row.name
    for (let i = 0; i < group.length; i++) {
      const d = group[i]
      const { _meta, ...item } = d.row
      const sourceHistory = group.map((g) => {
        const h = { id: g.row.id, localVersion: g.row.localVersion ?? null, sourceKind: g.sourceType }
        if (g.meta?.sourceStatus) h.checkedHint = g.meta.sourceStatus
        return h
      })
      // 展示归一键（#324）：按「核实包名」把同一插件的多条来源记录归并成一张展示卡。
      // 有核实包名 → pkg:<包名>；无包名（本地/solo）→ 按来源 id 单列。
      // 这是展示层键，不是身份核实键：groupKey/identityBasis/install 全部原样保留，
      // fork 自证虽可能与同源记录共用 displayKey，仍逐条带自己的 groupKey/identityBasis，
      // 前端详情如实分述，绝不因归一展示就把 fork 认成已核实的同源或当前安装来源。
      const displayKey = d.pkgName ? `pkg:${d.pkgName}` : `solo:${d.row.id}`
      const out = {
        ...item,
        // 顶层直接带四值之一：前端按 item.sourceStatus 渲染，兼容 item.source?.sourceStatus/_meta。
        // 取本条自己的登记状态（d.meta.sourceStatus），不和同组其它来源串状态。
        sourceStatus: sourceStatusOf(d.meta),
        groupKey: key,
        groupName: name,
        // #324 对外新增：核实包名（无则 null）与展示归一键，供前端展示层「一插件一卡」归一。
        packageName: d.pkgName || null,
        displayKey,
        identityBasis: d.identityBasis,
        sourceHistory
      }
      // 每条来源都带统一映射结论：列表与单条/批量版本路由逐条一致；
      // 卡级结论由前端按 install.state/sourceId 自行聚合，后端不再只挑首条冒充整卡安装来源。
      out.install = installs.get(d.row.id) ?? null
      result.push(out)
    }
  }
  return result
}

/** 对外安全的 sources 列表（剔除内部字段，带归组字段）。 */
export function publicSources(options) {
  return groupSources(options || {})
}

/**
 * 给「版本检查链路」的来源项附加安装核实基线 _install={sourceId,state,version}。
 * 供 index.js 的 /check-version 与 /check-versions 路由在调用 checkVersionAsync/checkVersionsBatch
 * 之前注入：withInstall 读 item._install 才产出 result.install，而 findRiceSource/listRiceSources
 * 返回的行本身不带该字段——不注入则生产链路的 result.install 永远为空。
 * 身份提取复用 identityEvidence，mapInstalled 入参与 groupSources 完全同口径，逐条核实（不只组头），
 * 不硬编码 profileDir：由宿主经 options.profileDir 注入（与 /sources 路由一致）。
 */
export function attachInstallToSources(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : []
  // 缺陷1b：install 判定必须基于「全量来源集合」，不能只看本次传入的子集。
  // 否则单条入口([one])看不到同内容的另一条(two)，内容等价检测组长度=1不降级→installed，
  // 而列表/批量入口看到两条→降级 unconfirmed，同一来源三入口结论分裂。
  // 用 frameworkRoot 取回全量再按请求行 id 挑回；隔离测试手填、全量覆盖不到的行才回退到传入集合。
  let basisRows = list
  if (options.frameworkRoot) {
    const all = listRiceSources({ frameworkRoot: options.frameworkRoot })
    const wanted = new Set(list.map((r) => r && r.id).filter(Boolean))
    if (all.some((r) => wanted.has(r.id))) basisRows = all
  }
  // 与 publicSources 列表共用 resolveInstalls 的逐来源映射，三条链路同一结论。
  const installs = resolveInstalls(identityEvidence(basisRows), options)
  return list.map((row) => {
    const install = installs.get(row.id) ?? null
    return { ...row, _install: {
      sourceId: install?.sourceId ?? null,
      state: install?.state ?? 'unconfirmed',
      version: install?.version ?? null
    } }
  })
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
