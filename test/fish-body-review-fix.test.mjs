// A 职责：定向补修 3 项真实缺陷的专项测试。捕获生产落盘形态（非喂 JSON 夹具），零联网零日常。
// (1) check-version 入口：合法含斜杠 id 放行、外部 URL/本地路径拒绝（开放代理防护）。
// (2) countTasks：现行拆分目录 + 旧目录双层发现，只计真实已产出 phase，未产出不计。
// (3) scanNpm：@scope 两层目录 + 普通一层目录都能列出；defaultNpmReader 正则放行 @。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const imp = (p) => import(pathToFileURL(p).href)
const { publicSources, findRiceSource, overview } = await imp(join(REPO, 'internal/backend/lib/rice-model.mjs'))
const { checkVersion, clearVersionCache } = await imp(join(REPO, 'internal/backend/lib/version-check.mjs'))

function scaffold() {
  const temp = mkdtempSync(join(tmpdir(), 'fish-review-fix-test-'))
  const root = join(temp, 'root')
  mkdirSync(root, { recursive: true })
  const json = (p, x) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(x)) }
  return { root, json }
}
const U = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`

test('缺陷2 countTasks：拆分布局 + 旧布局双层发现，只计真实已产出 phase', () => {
  const { root, json } = scaffold()
  // 现行拆分布局：3 已产出 + 2 未产出
  json(join(root, '鱼的胃', '任务', '测试插件-拆分任务', U(1), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(1), phase: 'materials-produced', profile: 'p', revision: 1 })
  json(join(root, '鱼的胃', '任务', '测试插件-拆分任务', U(2), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(2), phase: 'plan-awaiting-confirmation', profile: 'p', revision: 1 })
  json(join(root, '鱼的胃', '任务', '测试插件-拆分任务', U(3), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(3), phase: 'materials-confirmed', profile: 'p', revision: 2 })
  json(join(root, '鱼的胃', '任务', '测试插件-拆分任务', U(4), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(4), phase: 'selection-pending', profile: 'p', revision: 1 })
  json(join(root, '鱼的胃', '任务', '测试插件-拆分任务', U(5), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(5), phase: 'plan-pending', profile: 'p', revision: 1 })
  // 旧布局：1 已产出（model-reviewed-awaiting-user，旧正则会漏）
  json(join(root, '鱼的胃', '任务', U(6), 'task.json'), { schema: 'fish-stomach-task/v1', taskId: U(6), phase: 'model-reviewed-awaiting-user', profile: 'p', revision: 3 })
  const item = overview({ frameworkRoot: root }).items.find(x => x.key === 'stomach')
  assert.equal(item.state, 'ok')
  assert.match(item.summary, /6 个分析任务/, '双层共 6 个')
  assert.match(item.summary, /4 个已产出/, '4 个已产出（含 model-reviewed-awaiting-user）')
})

test('缺陷3a scanNpm：@scope 两层目录 + 普通一层目录均可列出，id 精确', () => {
  const { root, json } = scaffold()
  json(join(root, '饭', 'npm', '@probe', 'scoped', 'req-1', '材料', '来源.json'), { schema: 'rice-source/v1', sourceKind: 'npm', packageName: '@probe/scoped', versionFromManifest: '1.2.3', sourceStatus: 'collected' })
  json(join(root, '饭', 'npm', 'plain-pkg', 'req-2', '材料', '来源.json'), { schema: 'rice-source/v1', sourceKind: 'npm', packageName: 'plain-pkg', versionFromManifest: '2.0.0', sourceStatus: 'collected' })
  const rows = publicSources({ frameworkRoot: root })
  const scoped = rows.find(x => x.name === '@probe/scoped')
  const plain = rows.find(x => x.name === 'plain-pkg')
  assert.ok(scoped, 'scope npm 可见')
  assert.ok(plain, '普通 npm 可见')
  assert.equal(scoped.id, 'npm:@probe/scoped/req-1')
  assert.equal(plain.id, 'npm:plain-pkg/req-2')
  assert.equal(scoped.localVersion, '1.2.3')
})

test('缺陷1 check-version 只接受已登记 id：含斜杠放行、URL/路径拒绝', () => {
  const { root, json } = scaffold()
  json(join(root, '饭', '项目索引.json'), { projects: [{ id: 'github.com/owner/repo', repositoryPath: join(root, '饭', 'repo') }] })
  json(join(root, '饭', 'repo', '来源.json'), { sourceKind: 'local', versionFromManifest: '1.0.0', sourceStatus: 'collected' })
  clearVersionCache()
  // 合法含斜杠 id 能找到来源
  const ok = findRiceSource({ frameworkRoot: root, id: 'github.com/owner/repo' })
  assert.ok(ok && ok.id === 'github.com/owner/repo', '含斜杠登记 id 可精确命中')
  // 无远端 → unavailable（零联网）
  const cv = checkVersion({ frameworkRoot: root, id: 'github.com/owner/repo' })
  assert.equal(cv.state, 'unavailable')
  // 外部 URL / 本地路径不在登记集合 → error，不发起任何网络
  for (const bad of ['https://evil.example.com/x', 'D:/Windows/system32', 'C:\\secret']) {
    const r = checkVersion({ frameworkRoot: root, id: bad })
    assert.equal(r.state, 'error')
    assert.equal(r.remoteVersion, null)
  }
})

test('缺陷3b checkVersion npm 分支接受 @scope 包名（deps 注入 mock，零联网）+ 正则放行 @', () => {
  const { root, json } = scaffold()
  json(join(root, '饭', 'npm', '@probe', 'scoped', 'req-1', '材料', '来源.json'), { schema: 'rice-source/v1', sourceKind: 'npm', packageName: '@probe/scoped', versionFromManifest: '1.0.0', sourceStatus: 'collected' })
  clearVersionCache()
  const r = checkVersion({ frameworkRoot: root, id: 'npm:@probe/scoped/req-1', deps: { npmReader: (pkg) => pkg === '@probe/scoped' ? '2.0.0' : null, now: () => '2026-11-20T10:00:00.000Z' } })
  assert.equal(r.state, 'ok')
  assert.equal(r.remoteVersion, '2.0.0')
  assert.equal(r.comparison, 'newer')
  const src = readFileSync(join(REPO, 'internal/backend/lib/version-check.mjs'), 'utf8')
  assert.match(src, /\/\^@\?\[A-Za-z0-9\]/, 'defaultNpmReader 正则放行首字符 @')
})
