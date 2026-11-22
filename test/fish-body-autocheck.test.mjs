/* 自动版本检查（异步批量）：checkVersionAsync / checkVersionsBatch 回归测试
 * 覆盖（公共接口约定 v1.1 §A / Codex #241）：
 *  - 远端 key 去重（同 github repo / 同 npm 包只请求一次），dedupCount 正确；
 *  - 结果按来源 id 隔离，比较用各自本地基线；
 *  - 成功缓存 1h 复用、失败冷却 5min、force 绕过；
 *  - 并发≤3；signal 取消；无远端不发请求；错误脱敏（URL/token 不外带）；
 *  - 单项失败不影响其他。
 * 全程注入 asyncFetcher/asyncNpmReader mock，零联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const vc = await import(pathToFileURL(join(process.cwd(), 'internal/backend/lib/version-check.mjs')).href)
const { checkVersionAsync, checkVersionsBatch, clearVersionCache } = vc

function ghItem(id, owner, repo, localVersion, subdir) {
  return { id, sourceType: 'github', localVersion,
    _meta: { owner, repo, subdir: subdir || null, upstreamUrl: `https://github.com/${owner}/${repo}.git` } }
}
function npmItem(id, pkg, localVersion) {
  return { id, sourceType: 'npm', localVersion,
    _meta: { packageName: pkg, upstreamUrl: `npm:${pkg}` } }
}
function localItem(id) {
  return { id, sourceType: 'local', localVersion: '1.0.0', _meta: {} }
}
function releaseFetcher(tag) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    if (/\/releases\/latest$/.test(url)) return Buffer.from(JSON.stringify({ tag_name: tag }))
    return Buffer.from('[]')
  }
  fn.calls = calls
  return fn
}

test('checkVersionAsync：结构与同步版一致，ok/newer', async () => {
  clearVersionCache()
  const fetcher = releaseFetcher('2.0.0')
  const r = await checkVersionAsync({ frameworkRoot: 'R', id: 'x', source: ghItem('x', 'acme', 'x', '1.0.0'),
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.equal(r.state, 'ok')
  assert.equal(r.comparison, 'newer')
  assert.equal(r.remoteVersion, '2.0.0')
  assert.equal(r.lastSuccessAt, '2026-01-01T00:00:00.000Z')
})

test('去重：同 repo 两条来源只请求一次，结果按各自本地基线比较', async () => {
  clearVersionCache()
  const fetcher = releaseFetcher('3.0.0')
  const items = [
    ghItem('a', 'acme', 'shared', '1.0.0'),
    ghItem('b', 'acme', 'shared', '3.0.0'),
    ghItem('c', 'acme', 'shared', '4.0.0')
  ]
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items,
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.equal(out.dedupCount, 2, '3 条同 repo 应去重 2 次')
  assert.equal(fetcher.calls.filter((u) => /releases\/latest/.test(u)).length, 1, '只发一次 latest 请求')
  assert.equal(out.results.a.comparison, 'newer')
  assert.equal(out.results.b.comparison, 'same')
  assert.equal(out.results.c.comparison, 'local-newer')
})

test('npm 去重 + 无远端不发请求', async () => {
  clearVersionCache()
  let calls = 0
  const npmReader = async () => { calls++; return '5.0.0' }
  const fetcher = releaseFetcher('9.9.9')
  const items = [
    npmItem('n1', '@scope/pkg', '4.0.0'),
    npmItem('n2', '@scope/pkg', '5.0.0'),
    localItem('local-1')
  ]
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items,
    deps: { asyncNpmReader: npmReader, asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.equal(calls, 1, '同 npm 包只读一次')
  assert.equal(fetcher.calls.length, 0, '本地项不得触发任何 GET')
  assert.equal(out.results['local-1'].state, 'unavailable')
  assert.equal(out.results.n1.comparison, 'newer')
})

test('缓存：成功 1h 内复用、force 绕过', async () => {
  clearVersionCache()
  let t = Date.parse('2026-01-01T00:00:00.000Z')
  const now = () => new Date(t).toISOString()
  let calls = 0
  const fetcher = async (url) => { calls++; return Buffer.from(JSON.stringify({ tag_name: '2.0.0' })) }
  const item = ghItem('x', 'acme', 'x', '1.0.0')
  await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps: { asyncFetcher: fetcher, now } })
  assert.equal(calls, 1)
  t += 30 * 60 * 1000 // 30min 内
  await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps: { asyncFetcher: fetcher, now } })
  assert.equal(calls, 1, '新鲜缓存复用，不重复请求')
  await checkVersionsBatch({ frameworkRoot: 'R', items: [item], force: true, deps: { asyncFetcher: fetcher, now } })
  assert.equal(calls, 2, 'force 绕过缓存')
})

test('失败冷却 5min：不反复请求，回落历史标 historical', async () => {
  clearVersionCache()
  let t = Date.parse('2026-01-01T00:00:00.000Z')
  const now = () => new Date(t).toISOString()
  let calls = 0
  const fetcher = async () => { calls++; throw Object.assign(new Error('boom'), { code: 'E-CHECK-TIMEOUT' }) }
  const item = ghItem('x', 'acme', 'x', '1.0.0')
  const out1 = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps: { asyncFetcher: fetcher, now } })
  assert.equal(out1.results.x.state, 'error')
  // GitHub 一次检查依次试 releases/latest + tags，共 2 次 fetcher 调用。
  const callsAfterFirst = calls
  assert.ok(callsAfterFirst >= 1, '首次检查确实发起过请求')
  t += 60 * 1000 // 1min 内冷却
  const out2 = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps: { asyncFetcher: fetcher, now } })
  assert.equal(calls, callsAfterFirst, '冷却期内不重复请求')
  assert.equal(out2.results.x.state, 'error')
})

test('并发≤3：用并发计数峰值验证', async () => {
  clearVersionCache()
  let active = 0, peak = 0
  const fetcher = async () => {
    active++; peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
    return Buffer.from(JSON.stringify({ tag_name: '2.0.0' }))
  }
  const items = Array.from({ length: 8 }, (_, i) => ghItem(`x${i}`, 'acme', `repo${i}`, '1.0.0'))
  await checkVersionsBatch({ frameworkRoot: 'R', items, concurrency: 3,
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.ok(peak <= 3, `并发峰值 ${peak} 应 ≤3`)
  assert.ok(peak >= 1)
})

test('signal 取消：取消后不再发请求', async () => {
  clearVersionCache()
  const ac = new AbortController()
  let calls = 0
  const fetcher = async () => { calls++; return Buffer.from(JSON.stringify({ tag_name: '2.0.0' })) }
  ac.abort()
  const items = Array.from({ length: 3 }, (_, i) => ghItem(`x${i}`, 'acme', `r${i}`, '1.0.0'))
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items, signal: ac.signal,
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.equal(calls, 0, '已取消不得发请求')
  assert.equal(Object.keys(out.results).length, 3, '每条仍有结果')
})

test('错误脱敏：token/URL 不进结果 reason', async () => {
  clearVersionCache()
  const fetcher = async () => {
    throw Object.assign(new Error('curl failed https://user:mysecret@api.github.com/repos/a/b?token=ABC'),
      { code: 'E-CHECK-TIMEOUT', stderr: 'Authorization: Bearer TOKEN_VALUE_XYZ' })
  }
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items: [ghItem('x', 'acme', 'x', '1.0.0')],
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  const reason = out.results.x.reason
  assert.ok(!reason.includes('TOKEN_VALUE_XYZ'), '令牌不外带')
  assert.ok(!reason.includes('api.github.com'), 'URL 不外带')
  assert.ok(reason.includes('E-CHECK-TIMEOUT'))
})

test('反例·缺陷2：失败冷却期内 force:true 仍发第二次请求', async () => {
  clearVersionCache()
  let calls = 0, fail = true
  const deps = { asyncNpmReader: async () => { calls++; if (fail) throw new Error('temporary failure'); return '2.0.0' } }
  const item = npmItem('npm:f/one', 'f', '1.0.0')
  const first = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps })
  assert.equal(first.results[item.id].state, 'error')
  assert.equal(calls, 1)
  fail = false
  const forced = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps, force: true })
  assert.equal(calls, 2, 'force 必须绕过失败冷却重试')
  assert.equal(forced.results[item.id].state, 'ok')
})

test('反例·缺陷3：两个并发批次查同一远端只发一次请求（跨批次 in-flight 去重）', async () => {
  clearVersionCache()
  let calls = 0
  const deps = { asyncNpmReader: async () => { calls++; await new Promise((r) => setTimeout(r, 25)); return '2.0.0' } }
  const item = npmItem('npm:shared/one', 'shared', '1.0.0')
  const [a, b] = await Promise.all([
    checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps }),
    checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps })
  ])
  assert.equal(calls, 1, '并发同 key 共享一次 fetch')
  assert.equal(a.results[item.id].remoteVersion, '2.0.0')
  assert.equal(b.results[item.id].remoteVersion, '2.0.0')
})

test('反例·cache：成功→force失败→冷却期内普通重入回落 historical/unknown，不冒称当前最新', async () => {
  clearVersionCache()
  let bad = false, calls = 0
  const deps = { asyncNpmReader: async () => { calls++; if (bad) throw new Error('transient'); return '1.0.0' } }
  const item = npmItem('npm:cache-demo/one', 'cache-demo', '1.0.0')
  const first = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps })
  assert.equal(first.results[item.id].state, 'ok')
  assert.equal(first.results[item.id].comparison, 'same')
  bad = true
  const forced = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps, force: true })
  assert.equal(forced.results[item.id].state, 'historical')
  const reopen = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps })
  assert.equal(reopen.results[item.id].state, 'historical', '失败冷却优先于旧 raw 缓存')
  assert.equal(reopen.results[item.id].comparison, 'unknown')
})

test('反例·安装基线：材料1.0/实装2.0/远端1.5 → 用安装版本比较而非材料版本', async () => {
  clearVersionCache()
  const deps = { asyncNpmReader: async () => '1.5.0' }
  const item = npmItem('npm:baseline/one', 'baseline', '1.0.0')
  item._install = { sourceId: 'npm:baseline/one', state: 'installed', version: '2.0.0' }
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items: [item], deps })
  const r = out.results[item.id]
  assert.equal(r.state, 'ok')
  assert.equal(r.install.sourceId, 'npm:baseline/one')
  assert.equal(r.install.installedVersion, '2.0.0')
  assert.equal(r.install.state, 'installed')
  assert.equal(r.install.comparison, 'local-newer', '实装 2.0 高于远端 1.5，不能报「当前安装版有新版」')
})

test('单项失败不影响其他', async () => {
  clearVersionCache()
  const fetcher = async (url) => {
    if (/repos\/acme\/bad\//.test(url)) throw Object.assign(new Error('boom'), { code: 'E-NO-REMOTE-VERSION' })
    return Buffer.from(JSON.stringify({ tag_name: '2.0.0' }))
  }
  const out = await checkVersionsBatch({ frameworkRoot: 'R', items: [
    ghItem('bad', 'acme', 'bad', '1.0.0'), ghItem('good', 'acme', 'good', '1.0.0') ],
    deps: { asyncFetcher: fetcher, now: () => '2026-01-01T00:00:00.000Z' } })
  assert.equal(out.results.bad.state, 'error')
  assert.equal(out.results.good.state, 'ok')
  assert.ok(out.errors.length >= 1)
})

test('dev12缺陷3：force 真取数成功 → lastSuccessAt 推进到本次时间，不回退到旧成功时间', async () => {
  clearVersionCache()
  let now = '2026-11-22T08:00:00.000Z'
  let calls = 0
  const deps = { now: () => now, asyncNpmReader: async () => { calls++; return '2.0.0' } }
  const item = npmItem('npm:fresh-success/one', 'fresh-success', '1.0.0')
  const first = await checkVersionAsync({ frameworkRoot: 'R', id: item.id, source: item, deps })
  assert.equal(first.state, 'ok')
  assert.equal(first.lastSuccessAt, '2026-11-22T08:00:00.000Z')
  // 时间推进到 08:10，force 真去远端再取一次（不是走缓存）。
  now = '2026-11-22T08:10:00.000Z'
  const forced = await checkVersionAsync({ frameworkRoot: 'R', id: item.id, source: item, deps, force: true })
  assert.equal(calls, 2, 'force 必须真发第二次请求')
  assert.equal(forced.state, 'ok')
  assert.equal(forced.lastSuccessAt, '2026-11-22T08:10:00.000Z', '真成功时间必须推进到本次 checkedAt，不能回退旧成功时间')
  // 反向：08:20 普通重入走缓存成功，lastSuccessAt 仍保持首次真取数(08:10)不冒称刚联网。
  now = '2026-11-22T08:20:00.000Z'
  const cached = await checkVersionAsync({ frameworkRoot: 'R', id: item.id, source: item, deps })
  assert.equal(calls, 2, '缓存复用不再发请求')
  assert.equal(cached.lastSuccessAt, '2026-11-22T08:10:00.000Z', '缓存复用不得推进成功时间')
})
