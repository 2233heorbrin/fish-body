/* fish-body · 饭侧手动远端版本检查
 * 只在用户显式点击「检查远端版本」时调用；不下载、不安装、不切换提交、不执行 npm 生命周期脚本。
 * GitHub 走 releases/latest → tags 的只读 GET，无凭据；npm 走现有 npmCommand 元数据查询。
 * 结果 state 严格取：ok / incomparable / unavailable / error / historical。
 * comparison 由后端算（newer|same|local-newer|unknown），仅 state==='ok' 作为当前结论，其余一律 unknown。
 * URL 与凭据不进返回值与原因摘要；失败回落上次成功并标「历史结果·当前未确认」，绝不判「已是最新」。
 */
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseGithubUrl, safeSourceError } from './source-fetch.mjs'
import { findRiceSource } from './rice-model.mjs'
import { npmCommand } from './runtime-programs.mjs'

/* 最小缓存：仅存必要字段，键 = root + id；只缓存已取到远端版本的成功检查。 */
const CACHE = new Map()

/* 严格语义版本：只认 v?主.次.补，杜绝任意字符串比大小。 */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/
function semver(value) {
  if (typeof value !== 'string') return null
  const m = SEMVER.exec(value.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}
/** 版本比较结论：远端有新版本=newer，相同=same，本地较新=local-newer，无法判定=unknown。 */
function versionComparison(localVersion, remoteVersion) {
  const lv = semver(localVersion), rv = semver(remoteVersion)
  if (!lv || !rv) return 'unknown'
  const c = compare(lv, rv)
  return c < 0 ? 'newer' : c === 0 ? 'same' : 'local-newer'
}

/* 默认只读 GitHub GET：curl、无凭据、无配置文件、带 User-Agent，和 source-fetch 同型。 */
function defaultFetch(url) {
  return execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['--disable', '--fail', '--location', '--silent', '--show-error', '--max-time', '30',
      '--header', 'User-Agent: fish-body-version-check', '--header', 'Accept: application/vnd.github+json', url],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 35000, maxBuffer: 8 * 1024 * 1024 })
}

/* 默认 npm 元数据读取：沿用现有 npmCommand（node + npm-cli.js），只读 view，无安装脚本。 */
function defaultNpmReader(packageName) {
  // 允许 @scope/name 形如的首字符 @（market-source 真实会落 @scope 包），其余注入边界不回退：
  // 仍禁止参数分隔字符（空格/分号/管道）、前导连字符、路径穿越与超长包名。
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._@/-]{0,200}$/.test(packageName)) throw Object.assign(new Error('包名不合法'), { code: 'E-BAD-PACKAGE' })
  const cli = npmCommand()
  const out = execFileSync(cli.exe, [...cli.args, 'view', packageName, 'version', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000, env: cli.env })
  const parsed = JSON.parse(String(out).trim())
  return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
}

/* 错误摘要：经 safeSourceError 脱敏后再去掉任何 URL，绝不外带 token/地址/堆栈。 */
function safeReason(error, lead) {
  let detail = ''
  try {
    // safeSourceError 的 \S+ 只吃掉关键词后一个词，空格分隔的 Bearer <token> 会漏出令牌值，
    // 先自行 scrub 这类空格分隔凭据再交给它（GitHub 真实头就是 Authorization: Bearer ghp_xxx）。
    const scrub = (v) => typeof v === 'string'
      ? v.replace(/\b(bearer|token|password|secret|authorization)\s+([A-Za-z0-9._~+/\\=-]{4,})/gi, '$1=[redacted]')
      : v
    const wrapped = { message: scrub(error?.message), stderr: scrub(error?.stderr), code: error?.code }
    detail = safeSourceError(wrapped)
  } catch { detail = '' }
  detail = String(detail || '').replace(/https?:\/\/[^\s'"<>]+/g, '[地址已省略]').slice(0, 200)
  const code = error && typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(error.code)
    ? error.code : 'E-CHECK-FAILED'
  return `${lead}（${code}）${detail ? '：' + detail : ''}；本地材料仍可用，当前是否最新未确认。`
}

function isGithubSource(source, meta) {
  return source?.sourceType === 'github' && !!(meta.owner && meta.repo || /github\.com/i.test(meta.upstreamUrl || ''))
}
function isNpmSource(source, meta) {
  return source?.sourceType === 'npm' && !!meta.packageName
}

/* GitHub：从已落盘的 owner/repo 重建规范地址再交给 parseGithubUrl，绝不直接吃外部 URL（防开放代理）。 */
function githubRemote(meta, deps) {
  const fetcher = typeof deps.fetcher === 'function' ? deps.fetcher : defaultFetch
  let owner = meta.owner, repo = meta.repo
  if (!owner || !repo) {
    const parsed = parseGithubUrl(meta.upstreamUrl)
    owner = parsed.owner; repo = parsed.repo
  }
  const parsed = parseGithubUrl(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`

  let remoteVersion = null
  let label = 'GitHub'
  let releaseError = null
  try {
    const data = JSON.parse(fetcher(`${base}/releases/latest`).toString('utf8'))
    const tag = data.tag_name ?? data.name
    if (tag) { remoteVersion = String(tag); label = 'GitHub Releases' }
  } catch (error) { releaseError = error }

  if (!remoteVersion) {
    try {
      const tags = JSON.parse(fetcher(`${base}/tags`).toString('utf8'))
      const names = Array.isArray(tags) ? tags.map((t) => t && t.name).filter(Boolean).map(String) : []
      const ordered = names.map(semver).filter(Boolean)
      if (ordered.length) {
        ordered.sort(compare)
        const max = ordered[ordered.length - 1]
        remoteVersion = names.find((n) => { const s = semver(n); return s && compare(s, max) === 0 }) ?? max.join('.')
        label = 'GitHub Tags'
      } else if (names.length === 1) {
        remoteVersion = names[0]; label = 'GitHub Tags'
      } else if (names.length > 1) {
        // 多个非语义化标签：没有可靠顺序，显式 incomparable，绝不按字符串排序。
        return { remoteVersion: null, label: 'GitHub Tags', noOrder: true }
      }
    } catch (error) {
      if (!releaseError) releaseError = error
    }
  }
  if (!remoteVersion) throw releaseError ?? Object.assign(new Error('远端未返回版本'), { code: 'E-NO-REMOTE-VERSION' })
  return { remoteVersion, label }
}

function resultOf({ id, localVersion, remoteVersion, source, checkedAt, lastSuccessAt, state, comparison, reason }) {
  return { id, localVersion, remoteVersion, source, checkedAt, lastSuccessAt, state, comparison, reason }
}

/* 安装比较基线（给前端算「与当前安装版比较」用）：
 * 调用方（index.js / B）在 item 上带 _install={sourceId,state,version}（来自 mapInstalled 按来源 id 的核实结果），
 * 后端原样带出并按『安装版本 vs 远端版本』另算 install.comparison；材料基线 localVersion/comparison 不变。
 * 仅当 install.state==='installed' 且有安装版本、且本次 state==='ok' 拿到远端版本时才给真实比较，
 * 否则 install.comparison='unknown'——防止把「别的来源有新版」冒称「当前安装版可更新」。
 * 未带 _install 的结果不新增字段，保持既有契约不变。 */
function withInstall(result, item) {
  const ins = item && item._install
  if (!result || !ins || typeof ins !== 'object') return result
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const installedVersion = str(ins.version)
  const installedState = ins.state === 'installed' ? 'installed' : ins.state === 'not-installed' ? 'not-installed' : 'unconfirmed'
  const comparison = (installedState === 'installed' && installedVersion && result.state === 'ok' && result.remoteVersion)
    ? versionComparison(installedVersion, result.remoteVersion) : 'unknown'
  return { ...result, install: { sourceId: str(ins.sourceId), state: installedState, installedVersion, comparison } }
}

/* 历史结果：保留上次成功的远端版本与时间，但当前结论一律 unknown，标「历史结果·当前未确认」。 */
function historicalOf(cached, localVersion, now) {
  return resultOf({
    id: cached.id,
    localVersion,
    remoteVersion: cached.remoteVersion,
    source: cached.source,
    checkedAt: now(),
    lastSuccessAt: cached.checkedAt ?? null,
    state: 'historical',
    comparison: 'unknown',
    reason: `历史结果·当前未确认：远端 ${cached.remoteVersion}（上次成功于 ${cached.checkedAt}）。本次未能确认，未判定是否最新。`
  })
}

/**
 * 手动检查远端版本。
 * @param {object}  p
 * @param {string}  p.frameworkRoot  已绑定根
 * @param {string}  p.id             已登记来源 id（只接受登记项，拒任意 URL/路径）
 * @param {object}  [p.source]       可选：已取好的来源项（路由已查过则复用）
 * @param {object}  [p.deps]         可注入 {fetcher, npmReader, now}，供只读探针使用
 */
export function checkVersion({ frameworkRoot, id, source, deps = {} } = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString()
  const checkedAt = now()
  const cacheKey = `${frameworkRoot || ''}\u0000${id || ''}`
  const cached = CACHE.get(cacheKey)
  const lastSuccessAt = cached?.checkedAt ?? null

  let item = source
  if (!item && frameworkRoot && id) {
    try { item = findRiceSource({ frameworkRoot, id }) } catch { item = null }
  }

  // 未登记 id：拒绝，不给任何 URL/路径入口；有历史也只回落历史，不伪装成功。
  if (!item || item.id !== id) {
    if (cached) return historicalOf(cached, cached.localVersion, now)
    return resultOf({ id, localVersion: null, remoteVersion: null, source: '无', checkedAt,
      lastSuccessAt: null, state: 'error', comparison: 'unknown',
      reason: '未登记的来源 id；只接受已保存的来源，不接受任意链接或路径。' })
  }

  const meta = item._meta || {}
  const localVersion = item.localVersion ?? null

  // 无远端来源：明确 unavailable，绝不标「已是最新」；历史时间留作参考但不作为当前结论。
  if (!isGithubSource(item, meta) && !isNpmSource(item, meta)) {
    return resultOf({ id, localVersion, remoteVersion: null, source: '本地材料', checkedAt,
      lastSuccessAt, state: 'unavailable', comparison: 'unknown',
      reason: '该材料没有可查询的远端来源（本地材料或来源不明），无法检查远端版本。' })
  }

  try {
    let remoteVersion, sourceLabel, noOrder = false
    if (isNpmSource(item, meta)) {
      const reader = typeof deps.npmReader === 'function' ? deps.npmReader : defaultNpmReader
      const value = reader(meta.packageName)
      if (value == null || String(value).trim() === '') throw Object.assign(new Error('远端未返回版本'), { code: 'E-NO-REMOTE-VERSION' })
      remoteVersion = String(value).trim()
      sourceLabel = 'npm registry'
    } else {
      const out = githubRemote(meta, deps)
      remoteVersion = out.remoteVersion; sourceLabel = out.label; noOrder = !!out.noOrder
    }

    let state, reason, comparison
    if (noOrder) {
      state = 'incomparable'; comparison = 'unknown'
      reason = '远端有多个标签但没有可靠的版本顺序，未做字符串比较；当前是否最新未确认。'
    } else {
      comparison = versionComparison(localVersion, remoteVersion)
      const lv = semver(localVersion), rv = semver(remoteVersion)
      if (lv && rv) {
        state = 'ok'
        reason = comparison === 'newer' ? '远端有新版本，可查看更新说明（仅提示，不下载、不安装）。'
          : comparison === 'same' ? '远端版本与本地版本一致（手动检查结果）。'
            : '本地版本高于已发布的远端版本（手动检查结果）。'
      } else {
        state = 'incomparable'; comparison = 'unknown'
        reason = '已取得远端版本，但本地或远端版本无法可靠排序（提交号或非标准版本号），未做字符串比较。'
      }
    }

    // 取到远端版本的检查（ok/incomparable）记为一次成功，lastSuccessAt=本次。
    const successAt = checkedAt
    if (remoteVersion) CACHE.set(cacheKey, { id, localVersion, remoteVersion, source: sourceLabel, checkedAt: successAt })
    return resultOf({ id, localVersion, remoteVersion: remoteVersion ?? null, source: sourceLabel,
      checkedAt, lastSuccessAt: successAt, state, comparison, reason })
  } catch (error) {
    if (cached) return historicalOf(cached, localVersion, now)
    return resultOf({ id, localVersion, remoteVersion: null,
      source: isNpmSource(item, meta) ? 'npm registry' : 'GitHub', checkedAt,
      lastSuccessAt: null, state: 'error', comparison: 'unknown', reason: safeReason(error, '远端版本暂时无法检查') })
  }
}

/** 测试/集成辅助：清空内存缓存（不影响已落盘材料）。 */
export function clearVersionCache() { CACHE.clear(); RAW_CACHE.clear(); FAIL_CACHE.clear(); INFLIGHT.clear() }

/* 远端取数：成功写 RAW_CACHE、失败写 FAIL_CACHE；同一 remoteKey 的并发批次共享一次 fetch 的 Promise。
 * 完成/失败都从 INFLIGHT 清理（避免悬挂）；force=手动重试，独立请求、不复用也不登记共享。
 * run() 内部吞掉全部错误、永不 reject，故 .finally() 不会制造未处理拒绝。 */
function remoteFetch(key, sample, { signal, timeoutMs, deps, clock, checkedAt, force }) {
  const run = async () => {
    try {
      const out = await fetchRemoteRaw(sample, { signal, timeoutMs, deps })
      // 真实取数成功的时刻必须随结果一起返回：RAW_CACHE 存带时间的副本、out 也带同一时间。
      // 这样 force 真发新请求成功时 assembleFromRaw 用 out.fetchedAt(=本次)推进 lastSuccessAt，
      // 而缓存复用时 rawHit.fetchedAt 仍是首次取数时间、不被本次 checkedAt 覆写。两个方向共用这一个时间。
      const stamped = { ...out, fetchedAt: checkedAt }
      RAW_CACHE.set(key, stamped)
      FAIL_CACHE.delete(key)
      return { ok: true, out: stamped }
    } catch (error) {
      const reason = safeReason(error, '远端版本暂时无法检查')
      // failedAt 与冷却判断用的 clock() 同源：注入虚拟 now() 时冷却语义一致。
      FAIL_CACHE.set(key, { failedAt: clock(), reason })
      return { ok: false, reason }
    }
  }
  if (force) return run()
  let promise = INFLIGHT.get(key)
  if (!promise) {
    promise = run()
    INFLIGHT.set(key, promise)
    promise.finally(() => { if (INFLIGHT.get(key) === promise) INFLIGHT.delete(key) })
  }
  return promise
}

/* ==================== 异步批量检查（自动版本 / check-versions 路由） ====================
 * 与上面的同步 checkVersion 完全独立：同步 API/语义一行不改。
 * RAW_CACHE 按「远端 key」缓存已成功取得的远端版本（github:<owner>/<repo> / npm:<pkg>），
 * 供同一远端的多条来源复用原始响应，1h 新鲜度；FAIL_CACHE 失败冷却 5min，避免反复超时。
 * 结果按来源 id 隔离组装（各自的本地基线、subdir/ref/固定提交互不影响），错误经 safeReason 脱敏。
 */
const RAW_CACHE = new Map()   // remoteKey -> { remoteVersion, label, noOrder, fetchedAt }
const FAIL_CACHE = new Map()  // remoteKey -> { failedAt }
const INFLIGHT = new Map()    // remoteKey -> Promise<{ok,out?,reason?}>，跨批次并发去重，完成/失败即清理
const RAW_TTL = 60 * 60 * 1000       // 成功 1h
const FAIL_COOLDOWN = 5 * 60 * 1000  // 失败冷却 5min

const execFileAsync = promisify(execFile)

/* 异步只读 GET：execFile + AbortSignal/超时，默认实现与 defaultFetch 同型、无凭据。 */
async function defaultFetchAsync(url, { signal, timeoutMs = 20000 } = {}) {
  const { stdout } = await execFileAsync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['--disable', '--fail', '--location', '--silent', '--show-error',
      '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '--header', 'User-Agent: fish-body-version-check',
      '--header', 'Accept: application/vnd.github+json', url],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }
  )
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout))
}

/* 异步 npm 元数据读取：沿用 npmCommand，execFile + AbortSignal/超时，无安装脚本。 */
async function defaultNpmReaderAsync(packageName, deps, { signal, timeoutMs = 20000 } = {}) {
  // 与同步版同一注入边界：只放行 @scope 包名，禁参数分隔/前导连字符/路径穿越。
  if (!/^@?[A-Za-z0-9][A-Za-z0-9._@/-]{0,200}$/.test(packageName)) throw Object.assign(new Error('包名不合法'), { code: 'E-BAD-PACKAGE' })
  const mkCli = typeof deps.npmCommand === 'function' ? deps.npmCommand : npmCommand
  const cli = mkCli()
  const { stdout } = await execFileAsync(cli.exe, [...cli.args, 'view', packageName, 'version', '--json'],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: cli.env, signal })
  const parsed = JSON.parse(String(stdout).trim())
  return Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
}

/** 远端 key：用于 raw 响应去重。无远端返回 null。 */
function remoteKeyOf(item) {
  const meta = item?._meta || {}
  if (isNpmSource(item, meta)) return `npm:${meta.packageName}`
  if (isGithubSource(item, meta)) {
    let owner = meta.owner, repo = meta.repo
    if (!owner || !repo) {
      const parsed = parseGithubUrl(meta.upstreamUrl)
      owner = parsed.owner; repo = parsed.repo
    }
    if (owner && repo) return `github:${owner.toLowerCase()}/${repo.toLowerCase()}`
  }
  return null
}

/* 真正取远端版本（异步）。返回 {remoteVersion,label,noOrder}；无可靠顺序时 noOrder=true 不乱比。 */
async function fetchRemoteRaw(item, { signal, timeoutMs, deps }) {
  const meta = item._meta || {}
  if (isNpmSource(item, meta)) {
    const reader = typeof deps.asyncNpmReader === 'function' ? deps.asyncNpmReader
      : typeof deps.npmReader === 'function' ? async (pkg, o) => deps.npmReader(pkg)
        : (pkg, o) => defaultNpmReaderAsync(pkg, deps, o)
    const value = await reader(meta.packageName, { signal, timeoutMs })
    if (value == null || String(value).trim() === '') throw Object.assign(new Error('远端未返回版本'), { code: 'E-NO-REMOTE-VERSION' })
    return { remoteVersion: String(value).trim(), label: 'npm registry', noOrder: false }
  }
  // GitHub：从已落盘 owner/repo 重建规范地址，绝不直接吃外部 URL（防开放代理）。
  let owner = meta.owner, repo = meta.repo
  if (!owner || !repo) {
    const parsed = parseGithubUrl(meta.upstreamUrl)
    owner = parsed.owner; repo = parsed.repo
  }
  const parsed = parseGithubUrl(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`
  const fetcher = typeof deps.asyncFetcher === 'function' ? deps.asyncFetcher
    : typeof deps.fetcher === 'function' ? async (u, o) => deps.fetcher(u)
      : (u, o) => defaultFetchAsync(u, o)
  const opts = { signal, timeoutMs }

  let raw, label = 'GitHub', releaseError = null
  try {
    const data = JSON.parse(Buffer.from(await fetcher(`${base}/releases/latest`, opts)).toString('utf8'))
    const tag = data.tag_name ?? data.name
    if (tag) { raw = String(tag); label = 'GitHub Releases' }
  } catch (error) { releaseError = error }
  if (!raw) {
    try {
      const tags = JSON.parse(Buffer.from(await fetcher(`${base}/tags`, opts)).toString('utf8'))
      const names = Array.isArray(tags) ? tags.map((t) => t && t.name).filter(Boolean).map(String) : []
      const ordered = names.map(semver).filter(Boolean)
      if (ordered.length) {
        ordered.sort(compare)
        const max = ordered[ordered.length - 1]
        raw = names.find((n) => { const s = semver(n); return s && compare(s, max) === 0 }) ?? max.join('.')
        label = 'GitHub Tags'
      } else if (names.length === 1) {
        raw = names[0]; label = 'GitHub Tags'
      } else if (names.length > 1) {
        return { remoteVersion: null, label: 'GitHub Tags', noOrder: true }
      }
    } catch (error) { if (!releaseError) releaseError = error }
  }
  if (!raw) throw releaseError ?? Object.assign(new Error('远端未返回版本'), { code: 'E-NO-REMOTE-VERSION' })
  return { remoteVersion: raw, label, noOrder: false }
}

/* 单条异步检查：与同步 checkVersion 同结构、同 state/comparison 判定。 */
export async function checkVersionAsync({ frameworkRoot, id, source, deps = {}, signal, timeoutMs = 20000, force = false } = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString()
  const checkedAt = now()
  const clock = () => { const t = Date.parse(now()); return Number.isFinite(t) ? t : Date.now() }
  const cacheKey = `${frameworkRoot || ''}\u0000${id || ''}`
  const cached = CACHE.get(cacheKey)
  const lastSuccessAt = cached?.checkedAt ?? null
  let item = source
  if (!item && frameworkRoot && id) {
    try { item = findRiceSource({ frameworkRoot, id }) } catch { item = null }
  }
  if (!item || item.id !== id) {
    if (cached) return historicalOf(cached, cached.localVersion, now)
    return resultOf({ id, localVersion: null, remoteVersion: null, source: '无', checkedAt,
      lastSuccessAt: null, state: 'error', comparison: 'unknown',
      reason: '未登记的来源 id；只接受已保存的来源，不接受任意链接或路径。' })
  }
  const meta = item._meta || {}
  const localVersion = item.localVersion ?? null
  if (!isGithubSource(item, meta) && !isNpmSource(item, meta)) {
    return withInstall(resultOf({ id, localVersion, remoteVersion: null, source: '本地材料', checkedAt,
      lastSuccessAt, state: 'unavailable', comparison: 'unknown',
      reason: '该材料没有可查询的远端来源（本地材料或来源不明），无法检查远端版本。' }), item)
  }
  // 单条路径与批量共用同一套缓存/失败冷却/in-flight 去重口径：
  // 失败冷却优先于成功 raw，force 绕过两者；force 不复用也不登记 in-flight。
  const key = remoteKeyOf(item)
  const rawHit = RAW_CACHE.get(key)
  const failHit = FAIL_CACHE.get(key)
  if (!force && failHit && clock() - failHit.failedAt < FAIL_COOLDOWN) {
    return withInstall(assembleUnavailableError(item, checkedAt, now, cacheKey, failHit.reason), item)
  }
  if (!force && rawHit && clock() - Date.parse(rawHit.fetchedAt) < RAW_TTL) {
    return withInstall(assembleFromRaw(item, rawHit, checkedAt, now, cacheKey), item)
  }
  const outcome = await remoteFetch(key, item, { signal, timeoutMs, deps, clock, checkedAt, force })
  if (!outcome.ok) {
    return withInstall(assembleUnavailableError(item, checkedAt, now, cacheKey, outcome.reason), item)
  }
  const out = outcome.out
  if (out.noOrder) {
    return withInstall(resultOf({ id, localVersion, remoteVersion: null, source: out.label, checkedAt,
      lastSuccessAt, state: 'incomparable', comparison: 'unknown',
      reason: '远端有多个标签但没有可靠的版本顺序，未做字符串比较；当前是否最新未确认。' }), item)
  }
  return withInstall(assembleFromRaw(item, out, checkedAt, now, cacheKey), item)
}

/**
 * 批量异步版本检查。raw 按远端 key 去重、并发≤3、单请求超时、成功缓存 1h、失败冷却 5min、
 * force 绕过缓存、signal 取消、无远端不发请求；结果按来源 id 隔离，单项失败不影响其他。
 * @returns {{results:Object<string,object>, dedupCount:number, checkedAt:string, errors:Array}}
 */
export async function checkVersionsBatch({ frameworkRoot, items, deps = {}, signal,
  concurrency = 3, timeoutMs = 20000, force = false } = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString()
  const checkedAt = now()
  const clock = () => { const t = Date.parse(now()); return Number.isFinite(t) ? t : Date.now() }
  const results = {}
  const errors = []
  const list = Array.isArray(items) ? items : []
  const seen = new Set()
  const unique = []
  for (const it of list) {
    if (!it || typeof it.id !== 'string' || seen.has(it.id)) continue
    seen.add(it.id); unique.push(it)
  }

  // 远端 key -> 复用同一条来源项（取远端版本用），并记录对应的来源 id 列表。
  const byKey = new Map()
  const noRemote = []
  for (const it of unique) {
    const key = remoteKeyOf(it)
    if (!key) { noRemote.push(it); continue }
    if (!byKey.has(key)) byKey.set(key, { key, sample: it, ids: [] })
    byKey.get(key).ids.push(it.id)
  }
  let dedupCount = 0
  for (const group of byKey.values()) dedupCount += Math.max(0, group.ids.length - 1)

  // 无远端：直接产出 unavailable，不发任何请求。
  for (const it of noRemote) {
    results[it.id] = withInstall(resultOf({ id: it.id, localVersion: it.localVersion ?? null, remoteVersion: null,
      source: '本地材料', checkedAt, lastSuccessAt: null, state: 'unavailable', comparison: 'unknown',
      reason: '该材料没有可查询的远端来源，无法检查远端版本。' }), it)
  }

  // 缓存判定：新鲜成功 raw 直接复用；失败冷却内的键本轮不再请求，回落历史/错误。
  const needFetch = []
  for (const group of byKey.values()) {
    const rawHit = RAW_CACHE.get(group.key)
    const failHit = FAIL_CACHE.get(group.key)
    // 失败冷却优先于成功缓存：显式检查失败后，普通重入在冷却期必须保留 historical/unknown，
    // 不能因为旧 RAW_CACHE 还在 TTL 内就返回 ok/same——否则刚失败的检查被旧成功缓存伪装成"当前最新"。
    // force 显式重试绕过两者，永远发起新请求；重试失败仍写 FAIL_CACHE，成功则 RAW_CACHE 写入、FAIL_CACHE 删除。
    if (!force && failHit && clock() - failHit.failedAt < FAIL_COOLDOWN) {
      for (const id of group.ids) {
        const it = unique.find((x) => x.id === id)
        results[id] = withInstall(assembleUnavailableError(it, checkedAt, now,
          `${frameworkRoot || ''}\u0000${id}`, failHit.reason), it)
      }
      continue
    }
    if (!force && rawHit && clock() - Date.parse(rawHit.fetchedAt) < RAW_TTL) {
      for (const id of group.ids) {
        const it = unique.find((x) => x.id === id)
        results[id] = withInstall(assembleFromRaw(it, rawHit, checkedAt, now, `${frameworkRoot || ''}\u0000${id}`), it)
      }
      continue
    }
    needFetch.push(group)
  }

  // 并发池：默认 3，signal 取消后剩余任务直接产出错误，不再发请求。
  const worker = async () => {
    while (true) {
      const group = needFetch.shift()
      if (!group) return
      if (signal?.aborted) {
        for (const id of group.ids) {
          const it = unique.find((x) => x.id === id)
          results[id] = withInstall(assembleUnavailableError(it, checkedAt, now,
            `${frameworkRoot || ''}\u0000${id}`, '检查已取消；本地材料仍可用，当前是否最新未确认。'), it)
        }
        continue
      }
      // 跨批次 in-flight 去重：同 remoteKey 的并发批次共享一次 fetch 的 Promise（force 独立请求不共享）。
      // remoteFetch 内部负责成功写 RAW_CACHE / 失败写 FAIL_CACHE 与完成后清理 INFLIGHT。
      const outcome = await remoteFetch(group.key, group.sample, { signal, timeoutMs, deps, clock, checkedAt, force })
      if (outcome.ok) {
        const out = outcome.out
        if (out.noOrder) {
          for (const id of group.ids) {
            const it = unique.find((x) => x.id === id)
            results[id] = withInstall(resultOf({ id, localVersion: it.localVersion ?? null, remoteVersion: null,
              source: out.label, checkedAt, lastSuccessAt: null, state: 'incomparable', comparison: 'unknown',
              reason: '远端有多个标签但没有可靠的版本顺序，未做字符串比较；当前是否最新未确认。' }), it)
          }
          continue
        }
        for (const id of group.ids) {
          const it = unique.find((x) => x.id === id)
          results[id] = withInstall(assembleFromRaw(it, out, checkedAt, now, `${frameworkRoot || ''}\u0000${id}`), it)
        }
      } else {
        const reason = outcome.reason
        for (const id of group.ids) {
          const it = unique.find((x) => x.id === id)
          results[id] = withInstall(assembleUnavailableError(it, checkedAt, now, `${frameworkRoot || ''}\u0000${id}`, reason), it)
        }
        errors.push({ key: group.key, reason })
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.max(1, Math.min(concurrency, needFetch.length)); i++) workers.push(worker())
  await Promise.all(workers)

  return { results, dedupCount, checkedAt, errors }
}

/* 由已取得的 raw 远端版本组装单条结果（比较用本条本地基线，互不影响）。 */
function assembleFromRaw(item, raw, checkedAt, now, cacheKey) {
  const localVersion = item?.localVersion ?? null
  // 原始成功取数时间：RAW_CACHE.fetchedAt 是远端真正被拉取的时刻；缓存复用时它不变。
  // 绝不能用 CACHE.checkedAt（本次返回时间）当成功时间——否则 08:00 取数、08:10/08:20 复用缓存，
  // lastSuccessAt 会被逐次刷新成 08:10/08:20，冒称"刚成功"。checkedAt 仍是本次返回时间，两者分离。
  const originalFetchedAt = raw.fetchedAt ?? CACHE.get(cacheKey)?.checkedAt ?? checkedAt
  const lastSuccessAt = originalFetchedAt
  const comparison = versionComparison(localVersion, raw.remoteVersion)
  const lv = semver(localVersion), rv = semver(raw.remoteVersion)
  const state = (lv && rv) ? 'ok' : 'incomparable'
  const reason = state === 'incomparable'
    ? '已取得远端版本，但本地或远端版本无法可靠排序，未做字符串比较。'
    : comparison === 'newer' ? '远端有新版本，可查看更新说明（仅提示，不下载、不安装）。'
      : comparison === 'same' ? '远端版本与本地版本一致（手动检查结果）。'
        : '本地版本高于已发布的远端版本（手动检查结果）。'
  // CACHE 保留原始取数时间，不被缓存复用的本次返回时间覆盖；失败/historical 回落时也沿用真实成功时间。
  CACHE.set(cacheKey, { id: item.id, localVersion, remoteVersion: raw.remoteVersion, source: raw.label, checkedAt: originalFetchedAt })
  return resultOf({ id: item.id, localVersion, remoteVersion: raw.remoteVersion, source: raw.label,
    checkedAt, lastSuccessAt, state, comparison: state === 'ok' ? comparison : 'unknown', reason })
}

/* 失败/冷却：有历史成功回落 historical（标历史结果·当前未确认），否则 error；绝不判「已是最新」。 */
function assembleUnavailableError(item, checkedAt, now, cacheKey, reason) {
  const cached = CACHE.get(cacheKey)
  const localVersion = item?.localVersion ?? null
  if (cached) return historicalOf(cached, localVersion, () => checkedAt)
  return resultOf({ id: item.id, localVersion, remoteVersion: null,
    source: 'unknown', checkedAt, lastSuccessAt: null, state: 'error', comparison: 'unknown',
    reason: reason || '远端版本暂时无法检查；本地材料仍可用，当前是否最新未确认。' })
}
