/* fish-body · 饭侧手动远端版本检查
 * 只在用户显式点击「检查远端版本」时调用；不下载、不安装、不切换提交、不执行 npm 生命周期脚本。
 * GitHub 走 releases/latest → tags 的只读 GET，无凭据；npm 走现有 npmCommand 元数据查询。
 * 结果 state 严格取：ok / incomparable / unavailable / error / historical。
 * comparison 由后端算（newer|same|local-newer|unknown），仅 state==='ok' 作为当前结论，其余一律 unknown。
 * URL 与凭据不进返回值与原因摘要；失败回落上次成功并标「历史结果·当前未确认」，绝不判「已是最新」。
 */
import { execFileSync } from 'node:child_process'
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
  try { detail = safeSourceError(error) } catch { detail = '' }
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
export function clearVersionCache() { CACHE.clear() }
