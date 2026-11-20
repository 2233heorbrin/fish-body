/* 饭侧来源读取：真实布局回归测试
 * 覆盖决策文件《来源读取缺陷补修决策-Codex.md》的聚焦验证：
 *  - 旧布局：仓库内无来源.json，真实来源在项目父层（12 条 moved-verified 形态）
 *  - 当前采集布局：来源在 versions/<commit>/来源.json（downloaded-pinned 形态）
 *  - 仓库内来源.json：旧候选布局仍可识别
 *  - 真正无来源材料：保持 hasRemote=false / unavailable
 *  - 父层无关来源（localRepositoryPath 指向别的仓库）：不得误配到本索引项
 *  - 本地材料（local-copy / local-first-party）：尊重本地类型，不得被 hint 误标 github
 * 只用临时目录内合成材料，不触发任何网络/下载/安装；路径在 E 盘缓存临时区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listRiceSources, findRiceSource } from '../internal/backend/lib/rice-model.mjs'
import { checkVersion, clearVersionCache } from '../internal/backend/lib/version-check.mjs'

function wj(p, obj) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8') }
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rice-source-fix-'))
  try { fn(root) ; return root } catch (e) { rmSync(root, { recursive: true, force: true }); throw e }
}
function ghSource(owner, repo, repoRel, commit) {
  return { schemaVersion: '1.0', sourceType: 'git', sourcePlatform: 'github.com', owner, repository: repo,
    upstreamUrl: `https://github.com/${owner}/${repo}.git`, defaultBranch: 'main',
    pinnedCommit: commit, observedHead: commit,
    localRepositoryPath: repoRel.replace(/\\/g, '/'), sourceStatus: 'pinned-preserved' }
}
function idx(projects) { return { schema: 'fish-food-project-index-v1', layoutVersion: 'food-upstream-library-layout-v1', projects } }

test('旧布局：来源在项目父层、仓库内无来源.json → 名称/GitHub 来源/远端元数据进读模型', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/dsh-widget/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/dsh-widget', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: 'a1325c66eea03e4a236e2bc0b9e8f7713ea562f1', migrationStatus: 'moved-verified' }
    ]))
    wj(join(r, repoRel, 'PLACEHOLDER'), { note: '仓库内无来源.json' })
    wj(join(r, '饭', 'github.com', 'acme', 'dsh-widget', '来源.json'),
      ghSource('acme', 'dsh-widget', repoRel, 'a1325c66eea03e4a236e2bc0b9e8f7713ea562f1'))
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/dsh-widget' })
    assert.ok(row, '索引项应在来源列表')
    assert.equal(row.sourceType, 'github')
    assert.equal(row.hasRemote, true, '父层完整来源须产生 hasRemote=true')
    assert.equal(row._meta.owner, 'acme')
    assert.equal(row._meta.repo, 'dsh-widget')
    assert.match(row._meta.upstreamUrl, /github\.com\/acme\/dsh-widget/)
    assert.match(row.name, /dsh-widget/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('当前采集布局：来源在 versions/<commit>/来源.json → 识别远端来源', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/tool/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/tool', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', downloadMethod: 'git', migrationStatus: 'downloaded-pinned' }
    ]))
    wj(join(r, '饭', 'github.com', 'acme', 'tool', 'versions', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '来源.json'),
      { schema: 'rice-source/v1', sourceKind: 'git', owner: 'acme', repository: 'tool',
        upstreamUrl: 'https://github.com/acme/tool.git', pinnedCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        versionFromManifest: '1.2.3', localRepositoryPath: repoRel, sourceStatus: 'collected' })
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/tool' })
    assert.ok(row)
    assert.equal(row.sourceType, 'github')
    assert.equal(row.hasRemote, true)
    assert.equal(row._meta.upstreamUrl, 'https://github.com/acme/tool.git')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('仓库内来源.json 旧候选布局仍可识别', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/inrepo/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/inrepo', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: 'cccccccccccccccccccccccccccccccccccccccc' }
    ]))
    wj(join(r, repoRel, '来源.json'), ghSource('acme', 'inrepo', repoRel, 'cccccccccccccccccccccccccccccccccccccccc'))
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/inrepo' })
    assert.ok(row && row.sourceType === 'github' && row.hasRemote === true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('真正无来源材料：保持不可查询，不伪造远端', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/nosource/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/nosource', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: 'dddddddddddddddddddddddddddddddddddddddd' }
    ]))
    wj(join(r, repoRel, 'PLACEHOLDER'), { note: '无任何来源.json' })
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/nosource' })
    assert.ok(row)
    assert.equal(row.hasRemote, false, '无来源材料不得伪造 hasRemote')
    clearVersionCache()
    const v = checkVersion({ frameworkRoot: root, id: 'github.com/acme/nosource' })
    assert.equal(v.state, 'unavailable')
    assert.equal(v.comparison, 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('父层来源 localRepositoryPath 指向别的仓库时不得误配到本索引项', () => {
  const root = fixture((r) => {
    const targetRel = '饭/github.com/acme/target/仓库'
    const neighborRel = '饭/github.com/acme/neighbor/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/target', sourceType: 'git', repositoryPath: targetRel, pinnedCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }
    ]))
    wj(join(r, targetRel, 'PLACEHOLDER'), {})
    // 关键：来源就放在 target 的实际候选父层（dirname(dir)），而不是 WRONG_PARENT——
    // 否则空格子路径根本不会被读到，测试成了空测。此来源的 localRepositoryPath 指向 neighbor，须被拒。
    wj(join(r, '饭', 'github.com', 'acme', 'target', '来源.json'),
      ghSource('acme', 'neighbor', neighborRel, 'ffffffffffffffffffffffffffffffffffffffff'))
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/target' })
    assert.ok(row)
    assert.equal(row.hasRemote, false, '父层来源指向别的仓库时不得误配到 target')
    assert.equal(row._meta.owner ?? null, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('父层来源缺 localRepositoryPath 或 JSON 无效时不得命中（空对象拒绝）', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/nolrp/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/nolrp', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: '1111111111111111111111111111111111111111' }
    ]))
    wj(join(r, repoRel, 'PLACEHOLDER'), {})
    // 父层来源有完整 owner/repo/upstream，但缺 localRepositoryPath —— 无法确认关联，须拒绝
    wj(join(r, '饭', 'github.com', 'acme', 'nolrp', '来源.json'),
      { sourceType: 'git', sourcePlatform: 'github.com', owner: 'acme', repository: 'nolrp',
        upstreamUrl: 'https://github.com/acme/nolrp.git', sourceStatus: 'pinned-preserved' })
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/nolrp' })
    assert.ok(row)
    assert.equal(row.hasRemote, false, '缺关联字段的父层来源不得命中')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('versions 只认索引固定提交，不扫其他提交冒充当前来源', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/pinonly/仓库'
    const pinned = '2222222222222222222222222222222222222222'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/pinonly', sourceType: 'git', repositoryPath: repoRel, pinnedCommit: pinned }
    ]))
    wj(join(r, repoRel, 'PLACEHOLDER'), {})
    // 一个"其他提交"目录带完整来源，但 pinned 目录无来源 → 不得用其他提交冒充
    wj(join(r, '饭', 'github.com', 'acme', 'pinonly', 'versions', '3333333333333333333333333333333333333333', '来源.json'),
      ghSource('acme', 'pinonly', repoRel, '3333333333333333333333333333333333333333'))
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/pinonly' })
    assert.ok(row)
    assert.equal(row.hasRemote, false, '不得扫描非 pinned 提交来源')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('monorepo 子包 id（repo#subdir）不得被正则吞成 repo 整体而误配', () => {
  const root = fixture((r) => {
    const repoRel = '饭/github.com/acme/mono/subpackages/plugins%2Fa/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/mono#plugins/a', sourceType: 'git', subdir: 'plugins/a', repositoryPath: repoRel, pinnedCommit: '4444444444444444444444444444444444444444' }
    ]))
    wj(join(r, repoRel, 'PLACEHOLDER'), {})
    // 来源在子包材料的父层 mono/subpackages/plugins%2Fa/（= dirname(dir)）。
    // 来源 repository 是 'mono'（非 'mono#plugins/a'），旧正则会把 repo 读成 'mono#plugins/a' 而误拒。
    wj(join(r, '饭', 'github.com', 'acme', 'mono', 'subpackages', 'plugins%2Fa', '来源.json'),
      { ...ghSource('acme', 'mono', repoRel, '4444444444444444444444444444444444444444'),
        subdir: 'plugins/a', sourceMaterialName: 'mono/subpackages/plugins%2Fa' })
  })
  try {
    const row = findRiceSource({ frameworkRoot: root, id: 'github.com/acme/mono#plugins/a' })
    assert.ok(row)
    assert.equal(row.hasRemote, true, 'monorepo 子包须正确识别远端来源')
    assert.equal(row._meta.repo, 'mono')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('本地材料（local-copy/local-first-party）尊重本地类型，不被 hint 误标 github', () => {
  const root = fixture((r) => {
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'local/dsh配件', sourceType: 'local-copy', repositoryPath: '饭/local/dsh配件/仓库', pinnedCommit: null, migrationStatus: 'moved-verified' },
      { id: 'local/utility.sha256', sourceType: 'local-first-party', repositoryPath: '饭/local/utility.sha256/仓库', pinnedCommit: 'local-sha256:ABCDEF', migrationStatus: 'fixed-source-recorded' }
    ]))
    wj(join(r, '饭', 'local', 'dsh配件', '来源.json'),
      { sourceType: 'local-copy', sourcePlatform: 'local', owner: null, repository: 'dsh配件',
        upstreamUrl: null, localRepositoryPath: '饭/local/dsh配件/仓库', sourceStatus: 'complete-local-copy' })
    wj(join(r, '饭', 'local', 'utility.sha256', '来源.json'),
      { sourceType: 'local-first-party', sourcePlatform: 'local', owner: 'fish-brain', repository: 'utility.sha256',
        upstreamUrl: null, pinnedCommit: 'local-sha256:ABCDEF', localRepositoryPath: '饭/local/utility.sha256/仓库', sourceStatus: 'complete-local-first-party' })
  })
  try {
    const a = findRiceSource({ frameworkRoot: root, id: 'local/dsh配件' })
    const b = findRiceSource({ frameworkRoot: root, id: 'local/utility.sha256' })
    assert.ok(a && b)
    assert.equal(a.sourceType, 'local', 'local-copy 须为本地类型')
    assert.equal(b.sourceType, 'local', 'local-first-party 须为本地类型')
    assert.equal(a.hasRemote, false)
    assert.equal(b.hasRemote, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/* 注：读真实饭目录（D:\deepseek框架）的实机核对不放进开源测试，避免硬编码本机路径。
 * 该核对（dsh-fish/cyanwell/fish-body hasRemote=true、本地项 hasRemote=false、成批识别数）
 * 由结果目录独立探针 probe-source-layout*.mjs 覆盖，随交付证据留存。 */
