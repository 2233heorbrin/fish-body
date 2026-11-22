/* fish-body · 当前安装来源核实（只读）
 * 职责：把「已保存的来源材料」与「当前 Profile 里真实安装的东西」做证据级关联。
 * 硬约束：
 *   - 全程只读：stat/read，绝不下载 / npm 脚本 / 安装 / 写 Profile / 改插件状态。
 *   - 不硬编码任何 profile 名（fish-main 等）、盘符或 market id；profileDir 必须由宿主上下文注入。
 *   - node_modules/<pkg>/package.json 的 version 只证明「装了什么版本」，不证明「当前来源是哪个 market 历史」。
 *     要确认当前来源，须 package.json spec / pnpm-lock resolution.tarball / install-decisions 的
 *     binding(source.upstreamUrl+pinnedCommit+subdir) 之一精确命中同一条来源；否则一律 unconfirmed。
 *   - packageName 精确匹配，@scope 保留。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import YAML from 'yaml'
import { samePath, pathIdentity } from './path-identity.mjs'

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const safeJson = (p, fs) => { try { return JSON.parse((fs.readFileSync ?? readFileSync)(p, 'utf8')) } catch { return null } }
const isDir = (p, fs) => { try { return (fs.statSync ?? statSync)(p).isDirectory() } catch { return false } }
const normPkg = (v) => { const s = text(v); return s ? s.toLowerCase() : null }
const pathIsAbsolute = (p) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]/.test(p)
/* 引用完整身份归一——不再截尾段。旧 normalizeResolution 只留 demo.tgz 文件名，丢掉 host 与目录，
 * 会把 <A>/demo.tgz 与 <B>/demo.tgz、old/demo.tgz 与 new/demo.tgz 误判成同一份，是路径身份反例的根因。
 * 契约（Codex 四次复核 #260 / dev13-四次复核退回-Codex.md）：
 *   - pnpm peer 后缀 `(@x@ver)` 按 lock 契约剥离；
 *   - 远端 URL：protocol + hostname 按标准 URL 归一（host 大小写不敏感），但 pathname / search /
 *     hash 必须保留原始大小写——release 资源如 .../v1.0.0/DEMO.tgz 与 .../demo.tgz 是不同制品，
 *     绝不能整条小写混同（dev14-定向复核补修-Codex.md）。只比文件名或子串同样禁止；
 *   - file: 引用按 baseDir（lock / Profile 所在目录）解析为规范完整路径，复用 path-identity 的
 *     realpath + 完整路径规范 + 去尾斜杠 + win32 小写（Windows 文件系统大小写不敏感，不动），不改历史签名字段；
 *   - 其余（版本号 / github: / npm: / workspace: 等 ref 类别）保留完整文本身份，不一律小写，
 *     若类别本身含大小写语义也不抹掉。
 * 返回带类别前缀的规范串，避免不同类别（url/path/ref）被误判相等。 */
function resolutionIdentity(value, baseDir) {
  const s = text(value)
  if (!s) return null
  const x = s.replace(/\(@[^)]*\)\s*$/, '')            // 去 pnpm peer 后缀
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(x)) {             // 远端 URL
    try {
      const u = new URL(x)
      // protocol / host 用 WHATWG URL 标准归一（已把 hostname 转小写、去默认端口）；
      // pathname / search / hash 原样保留大小写——大小写敏感的资源路径必须区分。
      const pathname = u.pathname.replace(/\/+$/, '')   // 仅去路径末尾斜杠，不删 pathname 内容
      const rebuilt = `${u.protocol}//${u.host}${pathname}${u.search}${u.hash}`
      return `url:${rebuilt}`
    } catch {
      // 非标准 URL：仍保留 path 段原始大小写，只归一 scheme + host 部分。
      const m = x.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i)
      if (m) {
        const tail = m[3].replace(/\/+$/, '')
        return `url:${m[1].toLowerCase()}://${m[2].toLowerCase()}${tail}`
      }
      return `url:${x.replace(/[\\/]+$/, '')}`
    }
  }
  if (/^file:/i.test(x)) {                              // file: 引用按基目录解析为规范完整路径
    let p = x.replace(/^file:/i, '')
    if (!pathIsAbsolute(p)) p = baseDir ? resolve(baseDir, p) : resolve(p)
    const id = pathIdentity(p)
    return id ? `path:${id}` : `path:${p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
  }
  return `ref:${x.replace(/[\\/]+$/, '')}`              // ref 类别保留原始大小写语义
}
/* targetProfile 完整路径身份比对（Codex 四次复核 #260 第 3/5 点）：同名不同目录必须拒。
 * - 含路径分隔符 / 盘符的记录：走 samePath（realpath + 完整规范路径 + win32 小写）；
 * - legacy 纯目录名记录：按当前 profileDir 父目录下解析后再比，绝不拿任意 basename 通配。
 * 决定未写目标 Profile 时不额外强制（由其余证据交叉核负责）。 */
function targetProfileMatches(target, profileDir) {
  const t = text(target)
  if (!t || !profileDir) return true
  if (t.includes('/') || t.includes('\\') || /^[a-z]:/i.test(t)) return samePath(t, profileDir)
  return samePath(resolve(resolve(profileDir), '..', t), profileDir)
}

/* 从 GitHub 风格的 repository 声明里取 owner/repo（支持 git+https / https / github: / owner/repo）。 */
export function repoFromDeclaration(value) {
  const s = text(value)
  if (!s) return null
  let m = /github\.com[/:]([^/#]+)\/([^/#.]+?)(?:\.git)?(?:[/#]|$)/i.exec(s)
  if (m) return { owner: m[1], repo: m[2] }
  m = /^github:([^/#]+)\/([^/#.]+?)(?:\.git)?(?:#.*)?$/i.exec(s)
  if (m) return { owner: m[1], repo: m[2] }
  return null
}

/* 从 node_modules 里读已安装包的 version 与其 repository 声明（不证明来源历史）。 */
function readInstalledPackage(profileDir, packageName, fs) {
  if (!profileDir || !packageName) return null
  const segments = packageName.split('/').filter(Boolean)
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || /[\\]/.test(s))) return null
  const pkgDir = join(profileDir, 'node_modules', ...segments)
  if (!isDir(pkgDir, fs)) return null
  const doc = safeJson(join(pkgDir, 'package.json'), fs)
  if (!doc) return null
  const declared = normPkg(doc.name) === normPkg(packageName) ? normPkg(packageName) : null
  return {
    version: text(doc.version),
    repository: text(doc.repository?.url ?? doc.repository) ?? null,
    nameExact: !!declared,
    dir: pkgDir
  }
}

/* 读 profile/package.json 里该包的依赖声明 spec（file: / github: / 版本号 / workspace:）。 */
function readDeclaredSpec(profileDir, packageName, fs) {
  if (!profileDir || !packageName) return null
  const doc = safeJson(join(profileDir, 'package.json'), fs)
  if (!doc) return null
  const sections = [doc.dependencies, doc.devDependencies, doc.optionalDependencies]
  for (const sec of sections) {
    if (sec && typeof sec === 'object') {
      for (const key of Object.keys(sec)) {
        if (normPkg(key) === normPkg(packageName)) return text(sec[key])
      }
    }
  }
  return null
}

/* 在 pnpm-lock.yaml 里找该包的 resolution。
 * 用项目自带 yaml 依赖按 pnpm lockfile v6/v9 的真实结构解析，绝不靠「第二个 @ / 前后 5 行」猜：
 *   - importers['.'].dependencies[pkg] = {specifier, version} —— 直接依赖契约（权威）。
 *   - packages['pkg@spec'] = {resolution:{tarball|directory}, version} —— 解析结果（证据）。
 * 一个包在 package.json 里可能只写 @ 一次（如 `demo`），老逻辑取第二个 @ 会整个漏掉。 */
function readLockEvidence(profileDir, packageName, fs) {
  if (!profileDir || !packageName) return []
  const lock = join(profileDir, 'pnpm-lock.yaml')
  if (!(fs.existsSync ?? existsSync)(lock)) return []
  let raw = ''
  try { raw = (fs.readFileSync ?? readFileSync)(lock, 'utf8') } catch { return [] }
  let doc
  try { doc = YAML.parse(String(raw)) } catch { return [] }
  if (!doc || typeof doc !== 'object') return []
  const needle = normPkg(packageName)
  const hits = []

  // packages 段：key 形如 'demo@1.0.0' / '@scope/name@1.0.0' / 'pkg@file:...'。
  // 必须按最后一个 '@' 拆分（@scope 包的首个 '@' 是 scope 前缀，不能当分隔符）。
  const packages = doc.packages && typeof doc.packages === 'object' ? doc.packages : {}
  for (const key of Object.keys(packages)) {
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    if (normPkg(key.slice(0, at)) !== needle) continue
    const p = packages[key] || {}
    const res = p.resolution && typeof p.resolution === 'object' ? p.resolution : {}
    hits.push({
      spec: key,
      tarball: text(res.tarball),
      integrity: text(p.integrity ?? res.integrity),
      directory: text(res.directory ?? p.directory),
      version: text(p.version)
    })
  }

  // importers 段：只认「当前 Profile 根 importer（'.'）」的直接依赖。
  // 绝不遍历其他 importer（v9 workspace 子包/其他项目）：那是别的安装单元，当前 Profile 没声明
  // 就不算本 Profile 的实际依赖。旧实现 Object.values(importers) 全扫，会把 other importer 的旧条目
  // 也标成 current，导致「当前依赖 B、另一 importer 残留 A」时查 A 仍被冒认成 installed。
  const importers = doc.importers && typeof doc.importers === 'object' ? doc.importers : {}
  const rootImp = importers['.'] && typeof importers['.'] === 'object' ? importers['.'] : null
  const importerHits = []
  if (rootImp) {
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const group = rootImp[sec]
      if (!group || typeof group !== 'object') continue
      for (const key of Object.keys(group)) {
        if (normPkg(key) !== needle) continue
        const val = group[key]
        const specifier = text(val?.specifier ?? (typeof val === 'string' ? val : null))
        const v = text(val?.version)
        importerHits.push({ spec: specifier, version: v, direct: true })
      }
    }
  }
  // importer 与 packages 必须按「当前 importer 声明的完整 specifier → 唯一 resolution 引用」精确配对：
  // 只认 importers['.']（上面已过滤），且按完整引用身份比对——同文件名不同目录 / 同仓库不同提交
  // （<A>/demo.tgz vs <B>/demo.tgz）必须区分开，绝不拿 basename 或字符串包含猜。
  // file: 相对引用按 profileDir（lock 所在目录）解析为规范完整路径；远端保留 host + 完整路径；
  // pnpm peer 后缀按契约剥离。仍保留 version 字段的完整身份匹配（兼容纯版本号的 packages key）。
  for (const ih of importerHits) {
    const want = resolutionIdentity(ih.spec, profileDir)
    const wantVer = ih.version ? resolutionIdentity(ih.version, profileDir) : null
    const match = hits.find((h) => {
      const keyTail = h.spec && h.spec.includes('@') ? h.spec.slice(h.spec.lastIndexOf('@') + 1) : null
      const cands = [h.tarball, h.directory, h.spec, keyTail].filter(Boolean).map((v) => resolutionIdentity(v, profileDir))
      // 首选：resolution 完整引用等于 specifier；其次 version 完整引用命中（file: 相对路径 / 纯版本号 key）。
      return (want && cands.includes(want)) || (wantVer && cands.includes(wantVer))
    })
    if (match) { match.specifier = ih.spec; match.direct = true }
    else hits.push({ spec: ih.spec, version: ih.version, direct: true })
  }
  return hits
}

/* 遍历 install-decisions 目录，找与 packageName 精确匹配的 active 决定（来源关联的最强证据）。 */
function readDecisions(decisionsRoot, packageName, fs) {
  if (!decisionsRoot || !packageName || !isDir(decisionsRoot, fs)) return []
  let names = []
  try { names = (fs.readdirSync ?? readdirSync)(decisionsRoot) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const d = safeJson(join(decisionsRoot, name), fs)
    if (!d || d.status !== 'active') continue
    if (normPkg(d.packageName) !== normPkg(packageName) && normPkg(d.pluginId) !== normPkg(packageName)) continue
    const b = d.binding ?? {}
    out.push({
      id: text(d.id) ?? name.replace(/\.json$/, ''),
      version: text(d.version),
      spec: text(d.spec),
      source: b.source && typeof b.source === 'object' ? {
        upstreamUrl: text(b.source.upstreamUrl),
        pinnedCommit: text(b.source.pinnedCommit),
        subdir: text(b.source.subdir)
      } : null,
      targetProfile: text(b.targetProfile)
    })
  }
  return out
}

/* 判定某条决定是否命中目标来源：ownerRepo + 完整 pinnedCommit + subdir + 版本 + Profile。
 * 铁律：来源身份字段一旦由调用方给出，决定里缺该字段就判不命中——不允许「缺字段通配通过」。
 * Profile 已由读取路径（当前 profileDir 的 install-decisions 目录）绑定；决定若显式写了 targetProfile，
 * 还须与当前 Profile 目录名一致，防止把别的 Profile 的决定混进来。 */
function decisionMatches(decision, ownerRepo, pinnedCommit, subdir, installedVersion, profileDir) {
  const src = decision.source
  if (!src) return false
  if (ownerRepo) {
    const declared = repoFromDeclaration(src.upstreamUrl)
    if (!declared || declared.owner.toLowerCase() !== String(ownerRepo.owner).toLowerCase()
      || declared.repo.toLowerCase() !== String(ownerRepo.repo).toLowerCase()) return false
  }
  // 完整提交号比对（不再只比前 7 位）：给定 commit 但决定缺 commit / 不完整相等 → 不命中。
  if (pinnedCommit) {
    if (!text(src.pinnedCommit)) return false
    if (String(src.pinnedCommit).toLowerCase() !== String(pinnedCommit).toLowerCase()) return false
  }
  if (subdir) {
    if (!text(src.subdir)) return false
    if (src.subdir.replace(/^\/+|\/+$/g, '') !== String(subdir).replace(/^\/+|\/+$/g, '')) return false
  }
  // 版本核实：决定声明的版本必须等于 node_modules 实际安装版本，缺一不可。
  if (text(decision.version)) {
    if (!installedVersion || String(decision.version) !== String(installedVersion)) return false
  } else {
    return false // 决定缺版本字段，不能凭来源身份放行。
  }
  // Profile 核实：决定显式写了 targetProfile 时，必须与当前 Profile 是同一完整路径身份（同名不同目录必须拒）。
  if (decision.targetProfile && profileDir && !targetProfileMatches(decision.targetProfile, profileDir)) return false
  return true
}

/* lock 命中条目的来源身份核对：commit 命中是强证据；否则必须能从 tarball/spec 解析出 owner/repo
 * 并与目标 ownerRepo 一致。node_modules/lock 只有版本号一致时，不能证明「当前安装来自这条来源」，
 * 缺身份证据一律不判 installed（防不同作者/仓库同包名同版本冒认）。 */
function lockEntryMatchesSource(entry, ownerRepo, pinnedCommit, subdir) {
  // 只认当前直接依赖对应的 lock 条目：readLockEvidence 把 importer.dependencies 命中的 packages
  // 条目标记 direct=true；纯 packages 残留（历史 lock 条目，当前 importer 已不指向它）没有 direct，
  // 不能代表当前实际安装来源。只按版本号/前7位命中残留条目会把旧来源冒认成当前安装。
  if (!entry.direct) return false
  // 来源身份信息缺失时无法核实，绝不凭 direct 或版本放行。
  if (!pinnedCommit && !ownerRepo) return false
  // 给定提交时：tarball/spec 必须含"完整"提交号。前 7 位子串会把同仓库不同提交的条目误判命中。
  // 同规范仓库但不同提交 = 不同来源，必须拒绝。
  if (pinnedCommit) {
    const pc = String(pinnedCommit).toLowerCase()
    const inTarball = entry.tarball && entry.tarball.toLowerCase().includes(pc)
    const inSpec = entry.spec && entry.spec.toLowerCase().includes(pc)
    if (!inTarball && !inSpec) return false
  }
  // owner/repo 核对：解析得出的规范仓库必须与目标一致；解析不出不放行。
  const decl = repoFromDeclaration(entry.tarball) || repoFromDeclaration(entry.spec)
  if (ownerRepo) {
    if (!decl) return false
    if (decl.owner.toLowerCase() !== String(ownerRepo.owner).toLowerCase()) return false
    if (decl.repo.toLowerCase() !== String(ownerRepo.repo).toLowerCase()) return false
  }
  // subdir 核验：调用方要求子目录时，lock 条目必须能"证明"该子目录（directory 字段存在且相等）。
  // 旧逻辑只在双方都有值时才比，lock 缺 directory 就跳过 → 无法证明 packages/other 却仍判 installed。
  // 现在：给定 subdir 但 entry 无 directory → 拒绝（防把整包命中冒充子目录来源）。
  if (subdir) {
    if (!text(entry.directory)) return false
    const a = String(entry.directory).replace(/^\/+|\/+$/g, '')
    const b = String(subdir).replace(/^\/+|\/+$/g, '')
    if (a !== b) return false
  }
  return true
}

/* 真实鱼手 registry 运行态核实（唯一 canonical 契约，全程只读）。
 * <frameworkRoot>/鱼的手/插件注册表/registry.json  → requests/<requestId>.json → decisions/<formalDecisionId>.json
 * 只有 registry 行(state=installed/active) + 正式决定(status=active，版本/spec/targetProfile/contentHash 一致)
 * + 请求记录(requestId/packageName 一致) 同时交叉核通过，且与本来源 sourceId 尾段(requestId)精确关联，
 * 才判 installed。registry 行或 active 决定单独都不是运行态证据；缺字段/冲突一律 unconfirmed。
 * npm 材料的 64 位 pinnedCommit 是材料摘要(integrity/tarball)不是 git commit，不在这里当提交比对。 */
function readRealInstall(frameworkRoot, packageName, profileDir, sourceId, spec, fs) {
  if (!frameworkRoot || !packageName || !profileDir) return null
  const regDir = join(frameworkRoot, '鱼的手', '插件注册表')
  const regPath = join(regDir, 'registry.json')
  if (!(fs.existsSync ?? existsSync)(regPath)) return null
  const registry = safeJson(regPath, fs)
  if (!registry) return null
  const rows = Array.isArray(registry.plugins) ? registry.plugins
    : (registry.plugins && typeof registry.plugins === 'object' ? Object.values(registry.plugins) : [])
  const needle = normPkg(packageName)
  const candidates = rows.filter((row) => {
    const name = text(row.pluginId ?? row.packageName)
    const state = text(row.state)
    return name && normPkg(name) === needle
      && (state === 'installed' || state === 'active') && row.approved !== false
  })
  if (!candidates.length) return { found: false }
  const sid = text(sourceId)
  // npm 来源 id 形如 npm:<pkg>/<market-requestId>，尾段即 registry.requestId——精确关联 key。
  const sourceTail = sid ? String(sid).split('/').filter(Boolean).pop() : null
  for (const row of candidates) {
    const requestId = text(row.requestId)
    const formalId = text(row.formalDecisionId ?? row.decisionId)
    if (!requestId || !formalId) continue
    const decision = safeJson(join(regDir, 'decisions', `${formalId}.json`), fs)
    if (!decision || decision.status !== 'active') continue
    if (normPkg(decision.pluginId ?? decision.packageName) !== needle) continue
    const request = safeJson(join(regDir, 'requests', `${requestId}.json`), fs)
    if (!request) continue
    if (normPkg(request.packageName ?? request.pluginId) !== needle) continue
    if (text(request.id) && request.id !== requestId) continue
    // 精确关联：只有本来源 id 尾段 == 当前 registry.requestId 才认这条安装（区分四条同内容历史）。
    if (!sourceTail || sourceTail.toLowerCase() !== requestId.toLowerCase()) continue
    // 版本交叉核：registry 行版本 == 正式决定版本。
    const regVer = text(row.version), decVer = text(decision.version)
    if (!regVer || !decVer || regVer !== decVer) continue
    // 决定绑定：targetProfile 必须是当前 Profile 的同一完整路径身份（同名不同目录必须拒）。
    const binding = decision.binding && typeof decision.binding === 'object' ? decision.binding : {}
    const target = text(binding.targetProfile)
    if (!target || !targetProfileMatches(target, profileDir)) continue
    const decHash = text(binding.contentHash)
    const reqHash = text(request.source?.contentHash ?? request.contentHash ?? request.rice?.treeHash)
    if (!decHash || !reqHash || decHash !== reqHash) continue
    // 制品引用三源同一性：当前声明(spec)、registry 行、正式决定必须指向同一实际制品的完整引用，
    // 不只比文件名（old/demo.tgz 与 new/demo.tgz 必须区分）。
    const rowSpec = text(row.spec ?? decision.spec)
    const decSpec = text(decision.spec)
    const declaredSpec = spec || readDeclaredSpec(resolve(profileDir), packageName, fs)
    // 当前声明缺失时，node_modules 残留 + 旧 registry 不得放行显示：必须实际存在且与安装记录相符。
    if (!declaredSpec) continue
    if (rowSpec && resolutionIdentity(rowSpec, profileDir) !== resolutionIdentity(declaredSpec, profileDir)) continue
    if (decSpec && resolutionIdentity(decSpec, profileDir) !== resolutionIdentity(declaredSpec, profileDir)) continue
    return {
      found: true, matched: true, version: regVer, requestId, formalId,
      spec: rowSpec, hash: decHash, artifactPath: text(binding.artifactPath)
    }
  }
  // 该包有 installed/active 行，但无一条与本来源 requestId 精确关联 → 明确指向别的请求历史。
  return { found: true, matched: false, requestIds: candidates.map((c) => text(c.requestId)).filter(Boolean) }
}

/**
 * 核实当前安装来源。
 * @param {object}  p
 * @param {string}  p.frameworkRoot       已绑定根（仅用于相对路径归一，不用于猜 profile）
 * @param {string}  p.packageName         已核实包名（@scope 保留）
 * @param {object}  [p.ownerRepo]         {owner,repo}，GitHub 来源的实际身份
 * @param {string}  [p.pinnedCommit]      来源固定提交
 * @param {string}  [p.subdir]            来源子目录
 * @param {string}  [p.profileDir]        宿主上下文注入的当前 profile 目录；缺省不探测→unconfirmed
 * @param {string[]}[p.decisionsDirs]     可注入的决定目录候选（相对 profileDir 或绝对）
 * @param {string}  [p.sourceId]          材料包身份（如 npm:<pkg>/<id> 或 github.com/<o>/<r>）；仅回显供按条聚合
 * @param {object}  [p.deps]              可注入 {existsSync,readFileSync,statSync,readdirSync} 供只读探针
 * @returns {{state:'installed'|'not-installed'|'unconfirmed', source:string, version:string|null, sourceId:string|null, basis:string}}
 */
export function mapInstalled({
  frameworkRoot, packageName, ownerRepo, pinnedCommit, subdir,
  profileDir, decisionsDirs, sourceId, deps = {}
} = {}) {
  const sid = text(sourceId)
  const unconfirmed = (version, basis) => ({
    state: 'unconfirmed', source: 'unknown', version: version ?? null, sourceId: sid,
    basis: basis || '缺少可关联的安装证据，当前来源未确认。'
  })
  if (!profileDir) {
    return unconfirmed(null, '未取得当前 Profile 上下文，未核实安装来源（不硬编码、不探测其他 Profile）。')
  }
  if (normPkg(packageName) !== packageName.toLowerCase()) return unconfirmed(null, '包名不合法。')
  const fs = {
    existsSync: deps.existsSync, readFileSync: deps.readFileSync,
    statSync: deps.statSync, readdirSync: deps.readdirSync
  }
  const base = resolve(profileDir)
  const installed = readInstalledPackage(base, packageName, fs)
  if (!installed) {
    return { state: 'not-installed', source: 'unknown', version: null, sourceId: sid,
      basis: '当前 Profile 的 node_modules 中没有该包。' }
  }
  const version = installed.version ?? null
  if (!installed.nameExact) {
    return unconfirmed(version, 'node_modules 中包名与声明不一致，未确认来源。')
  }

  const spec = readDeclaredSpec(base, packageName, fs)

  // 最强证据①：真实鱼手 registry + 正式决定 + 请求记录 三者交叉核，且 requestId 与本来源 id 精确关联。
  // 这是运行态的权威证据，优先于兼容用的 .plugin-manager install-decisions 与 lock。
  // 只有 frameworkRoot 下存在真实 registry 才走此路径；隔离测试夹具（无 registry）不受影响。
  const realInstall = readRealInstall(frameworkRoot, packageName, base, sid, spec, fs)
  if (realInstall && realInstall.found) {
    if (realInstall.matched && (!version || version === realInstall.version)) {
      return {
        state: 'installed', source: 'registry-decision', version, sourceId: sid,
        basis: `真实 registry(请求 ${realInstall.requestId}) + 正式决定 ${realInstall.formalId}(active) + 请求记录交叉核通过：版本/spec/targetProfile/内容摘要一致，且本来源 id 精确关联；node_modules 版本 ${version ?? '未知'}。`
      }
    }
    // registry 明确安装的是别的请求历史 / 版本冲突 → 本来源未确认，不冒认 installed。
    const why = realInstall.matched
      ? `registry 安装版本 ${realInstall.version} 与 node_modules ${version} 不一致`
      : `registry 当前安装关联的是其他请求(${(realInstall.requestIds || []).join('、')})`
    return unconfirmed(version, `${why}；本来源非当前安装，内容/版本相同不足以确认。`)
  }

  const locks = readLockEvidence(base, packageName, fs)
  const dirs = Array.isArray(decisionsDirs) && decisionsDirs.length
    ? decisionsDirs
    : [join(base, '.plugin-manager', 'install-decisions'), join(base, '.plugin-manager', 'decisions')]
  const decisions = dirs.flatMap((d) => readDecisions(d.startsWith(base) ? d : resolve(base, d), packageName, fs))

  // 最强证据②：active install-decision 精确命中来源身份（含完整提交、版本、Profile 核实）。
  const match = decisions.find((d) => decisionMatches(d, ownerRepo, pinnedCommit, subdir, version, base))
  if (match) {
    const source = spec && /^file:/i.test(spec) ? 'local-install'
      : spec && /^github:/i.test(spec) ? 'github-spec'
        : spec && /^npm:/i.test(spec) ? 'npm-spec' : 'install-decision'
    return { state: 'installed', source, version, sourceId: sid,
      basis: `install-decision ${match.id} 的绑定来源与版本匹配；node_modules 版本 ${version ?? '未知'} 一致。` }
  }
  // 若决定存在但都不命中本来源：同版本也不能冒认当前这条。
  if (decisions.length) {
    return unconfirmed(version, `存在 ${decisions.length} 条安装决定但均未与本来源身份匹配；同版本不足以确认当前来源。`)
  }
  // 次强证据：lock 的 tarball/directory 必须能证明来源身份（固定提交命中，或 tarball/spec 解析出的
  // owner/repo 与目标一致）。仅 node_modules/lock 版本号一致不足以确认当前安装来自这条来源。
  if (locks.length) {
    const hit = locks.find((l) => lockEntryMatchesSource(l, ownerRepo, pinnedCommit, subdir))
    if (hit) {
      const source = hit.tarball ? (/^file:/i.test(hit.tarball) ? 'local-install' : 'npm-tarball')
        : hit.directory ? 'local-directory' : 'lock-entry'
      return { state: 'installed', source, version, sourceId: sid,
        basis: `pnpm-lock 条目 ${hit.spec} 命中本来源固定提交/规范仓库声明；未发现冲突的安装决定。` }
    }
    return unconfirmed(version, `pnpm-lock 中有 ${locks.length} 条该包记录，但仅版本号一致、无法证明属于本来源的 ownerRepo/固定提交/subdir，当前来源未确认。`)
  }
  // 只有 spec 且无来源证据：版本只证明装了什么，不足以认来源历史。
  return unconfirmed(version, spec
    ? '有依赖声明但缺少 lock/安装决定关联，仅凭版本不能确认当前来源。'
    : '只有 node_modules 版本，缺少来源关联证据，当前来源未确认。')
}
