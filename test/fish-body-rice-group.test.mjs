/* 饭来源归组 + 安装映射：真实落盘形态回归测试（公共接口约定 v1.1 / Codex #241）
 * 覆盖：
 *  - 同插件 GitHub 来源 + npm 来源，声明仓库与实际 owner/repo 核对一致 → 归同一张根卡；
 *  - fork 保留上游包名/包内 repository 仍指上游，但实际来源是另一 owner → 不并回上游；
 *  - npm 发布包声明仓库缺失/与实际材料对不上 → 单列，identityBasis=unconfirmed；
 *  - 同仓不同 subdir 兄弟子包 → 不同 groupKey；
 *  - 多 market 历史（同名 npm 多 id）→ sourceHistory 折叠、install 只在首条；
 *  - install 映射：只有 lock/decision 精确命中才算 installed，缺证据 unconfirmed，不硬编码 profile。
 * 只用临时目录合成材料，只读，不触发网络/安装；路径在缓存临时区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(join(process.cwd(), 'internal/backend/lib/rice-model.mjs')).href)
const { publicSources, attachInstallToSources } = mod
const installMod = await import(pathToFileURL(join(process.cwd(), 'internal/backend/lib/install-mapping.mjs')).href)
const { mapInstalled } = installMod

function wj(p, obj) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8') }
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rice-group-'))
  try { fn(root); return root } catch (e) { rmSync(root, { recursive: true, force: true }); throw e }
}
function idx(projects) { return { schema: 'fish-food-project-index-v1', layoutVersion: 'food-upstream-library-layout-v1', projects } }
function ghProject(owner, repo, id, commit, pkg) {
  return { id: id || `github.com/${owner}/${repo}`, sourceType: 'git',
    repositoryPath: `饭/github.com/${owner}/${repo}/仓库`, pinnedCommit: commit, migrationStatus: 'moved-verified',
    packageName: pkg }
}
function ghSource(owner, repo, repoRel, commit, pkg) {
  const s = { schemaVersion: '1.0', sourceType: 'git', sourcePlatform: 'github.com', owner, repository: repo,
    upstreamUrl: `https://github.com/${owner}/${repo}.git`, defaultBranch: 'main',
    pinnedCommit: commit, observedHead: commit, localRepositoryPath: repoRel.replace(/\\/g, '/'),
    sourceStatus: 'pinned-preserved' }
  if (pkg) { s.packageName = pkg; s.versionFromManifest = '1.0.0'; s.packageJson = { name: pkg, version: '1.0.0', repository: `git+https://github.com/${owner}/${repo}.git` } }
  return s
}
function npmSource(pkg, version, repositoryDecl, commit) {
  const s = { schemaVersion: '1.0', sourceKind: 'npm', packageName: pkg, versionFromManifest: version,
    upstreamUrl: `npm:${pkg}`, sourceStatus: 'collected', published: { version } }
  if (repositoryDecl) s.published.repository = repositoryDecl
  if (commit) s.pinnedCommit = commit
  return s
}
function npmWrite(root, pkg, id, source) {
  const segments = pkg.split('/')
  wj(join(root, '饭', 'npm', ...segments, id, '材料', '来源.json'), source)
}

test('同插件 GitHub + npm 同源核对一致 → 归一张根卡，sourceHistory 含两条', () => {
  const root = fixture((r) => {
    const commit = 'aaaaaaa1234567890abcdef1234567890abcdef'
    const repoRel = '饭/github.com/acme/dsh-shared/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([ghProject('acme', 'dsh-shared', null, commit, 'dsh-shared')]))
    wj(join(r, repoRel, 'PLACEHOLDER'), { note: '仓库' })
    wj(join(r, '饭', 'github.com', 'acme', 'dsh-shared', '来源.json'),
      ghSource('acme', 'dsh-shared', repoRel, commit, 'dsh-shared'))
    npmWrite(r, 'dsh-shared', 'mkt-A', npmSource('dsh-shared', '1.0.0',
      { url: 'git+https://github.com/acme/dsh-shared.git' }, commit))
  })
  try {
    const items = publicSources({ frameworkRoot: root })
    const shared = items.filter((x) => x.groupName === 'dsh-shared')
    assert.ok(shared.length >= 2, 'GitHub 与 npm 两项都应在列表')
    const keys = new Set(shared.map((x) => x.groupKey))
    assert.equal(keys.size, 1, '同源的两项必须归到同一 groupKey')
    assert.match([...keys][0], /^pkg:dsh-shared$/)
    const withHistory = shared.find((x) => x.sourceHistory.length >= 2)
    assert.ok(withHistory, '根卡 sourceHistory 应聚合两条来源')
    assert.ok(shared.every((x) => x.install && typeof x.install === 'object'), '列表每条来源都应带 install，与单条/批量同判据')
    assert.ok(shared.every((x) => x.install.sourceId === null), '无当前 Profile 上下文时 sourceId=null，不回显输入 id')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('fork 保留上游包名与包内 repository → 实际来源单列，不并回上游', () => {
  const root = fixture((r) => {
    const upstreamCommit = 'bbbbbbb1234567890abcdef1234567890abcdef'
    const forkCommit = 'ccccccc1234567890abcdef1234567890abcdef'
    // 上游来源：包名 dsh-forked，声明仓库 acme/dsh-forked（自身）
    const upRel = '饭/github.com/acme/dsh-forked/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([
      ghProject('acme', 'dsh-forked', null, upstreamCommit, 'dsh-forked'),
      ghProject('forker', 'dsh-forked', null, forkCommit, 'dsh-forked')
    ]))
    wj(join(r, upRel, 'PLACEHOLDER'), {})
    wj(join(r, '饭', 'github.com', 'acme', 'dsh-forked', '来源.json'),
      ghSource('acme', 'dsh-forked', upRel, upstreamCommit, 'dsh-forked'))
    // fork 来源：实际 owner=forker，但 packageName 和 packageJson.repository 仍指上游 acme
    const forkRel = '饭/github.com/forker/dsh-forked/仓库'
    wj(join(r, forkRel, 'PLACEHOLDER'), {})
    const fork = ghSource('forker', 'dsh-forked', forkRel, forkCommit, 'dsh-forked')
    fork.packageJson = { name: 'dsh-forked', version: '1.0.0', repository: 'git+https://github.com/acme/dsh-forked.git' }
    wj(join(r, '饭', 'github.com', 'forker', 'dsh-forked', '来源.json'), fork)
  })
  try {
    const items = publicSources({ frameworkRoot: root })
    const forkRow = items.find((x) => x.name === 'forker/dsh-forked' || (x.path || '').includes('forker'))
    assert.ok(forkRow, 'fork 来源应在列表')
    assert.match(forkRow.groupKey, /^gh:forker\/dsh-forked$/, 'fork 必须用实际 owner 建键')
    assert.equal(forkRow.identityBasis, 'unconfirmed')
    const upRow = items.find((x) => (x.path || '').includes('acme'))
    assert.ok(upRow)
    assert.notEqual(forkRow.groupKey, upRow.groupKey, 'fork 不得与上游同组')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('npm 声明仓库缺失/对不上实际材料 → solo 单列，不按包名吸入 GitHub 组', () => {
  const root = fixture((r) => {
    const commit = 'ddddddd1234567890abcdef1234567890abcdef'
    const repoRel = '饭/github.com/acme/dsh-nolink/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([ghProject('acme', 'dsh-nolink', null, commit, 'dsh-nolink')]))
    wj(join(r, repoRel, 'PLACEHOLDER'), {})
    wj(join(r, '饭', 'github.com', 'acme', 'dsh-nolink', '来源.json'),
      ghSource('acme', 'dsh-nolink', repoRel, commit, 'dsh-nolink'))
    // npm 项声明仓库指向另一个 repo，与实际 acme/dsh-nolink 对不上
    npmWrite(r, 'dsh-nolink', 'mkt-X', npmSource('dsh-nolink', '2.0.0',
      { url: 'git+https://github.com/other/dsh-nolink.git' }, commit))
  })
  try {
    const items = publicSources({ frameworkRoot: root })
    const npmRow = items.find((x) => x.id === 'npm:dsh-nolink/mkt-X')
    assert.ok(npmRow)
    assert.match(npmRow.groupKey, /^solo:/, '对不上实际材料的 npm 项必须单列')
    assert.equal(npmRow.identityBasis, 'unconfirmed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同仓不同 subdir 兄弟子包 → 不同 groupKey', () => {
  const root = fixture((r) => {
    const commit = 'eeeeeee1234567890abcdef1234567890abcdef'
    wj(join(r, '饭', '项目索引.json'), idx([
      { id: 'github.com/acme/mono#packages/a', sourceType: 'git', subdir: 'packages/a',
        repositoryPath: '饭/github.com/acme/mono/a/仓库', pinnedCommit: commit },
      { id: 'github.com/acme/mono#packages/b', sourceType: 'git', subdir: 'packages/b',
        repositoryPath: '饭/github.com/acme/mono/b/仓库', pinnedCommit: commit }
    ]))
    for (const [sub, rel] of [['packages/a', '饭/github.com/acme/mono/a/仓库'], ['packages/b', '饭/github.com/acme/mono/b/仓库']]) {
      wj(join(r, rel, 'PLACEHOLDER'), {})
      const s = ghSource('acme', 'mono', rel, commit)
      s.subdir = sub
      wj(join(r, '饭', 'github.com', 'acme', 'mono', 'versions', commit, '来源.json'), s)
    }
  })
  try {
    const items = publicSources({ frameworkRoot: root })
    const mono = items.filter((x) => (x.path || '').includes('/mono/'))
    const keys = new Set(mono.map((x) => x.groupKey))
    assert.equal(keys.size, 2, '同仓不同 subdir 必须拆成两组')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('多 market 历史同名 npm → sourceHistory 折叠', () => {
  const root = fixture((r) => {
    npmWrite(r, '@scope/multi', 'mkt-1', npmSource('@scope/multi', '1.0.0', { url: 'git+https://github.com/acme/multi.git' }))
    npmWrite(r, '@scope/multi', 'mkt-2', npmSource('@scope/multi', '1.1.0', { url: 'git+https://github.com/acme/multi.git' }))
  })
  try {
    const items = publicSources({ frameworkRoot: root })
    const multi = items.filter((x) => x.id && x.id.startsWith('npm:@scope/multi/'))
    assert.equal(multi.length, 2)
    // 声明仓库一致但无 GitHub 实际材料 → 各自单列（关联未确认），但包名解析要正确。
    assert.ok(multi.every((x) => x.groupName === '@scope/multi'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mapInstalled：无 profileDir → unconfirmed，不硬编码、不探测', () => {
  const out = mapInstalled({ frameworkRoot: 'D:\\anything', packageName: 'dsh-x' })
  assert.equal(out.state, 'unconfirmed')
  assert.equal(out.version, null)
})

test('mapInstalled：node_modules 有版本但无 lock/decision 关联 → unconfirmed，不冒认来源', () => {
  const root = fixture((r) => {
    wj(join(r, 'node_modules', 'dsh-x', 'package.json'), { name: 'dsh-x', version: '1.2.3', repository: 'git+https://github.com/acme/x.git' })
    wj(join(r, 'package.json'), { dependencies: { 'dsh-x': '^1.2.0' } })
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'dsh-x', ownerRepo: { owner: 'acme', repo: 'x' }, profileDir: root })
    assert.equal(out.state, 'unconfirmed')
    assert.equal(out.version, '1.2.3', '版本仍如实读出')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反例·缺陷1：同版本但不同作者/仓库（scope lock file: 路径）→ unconfirmed，不冒认 installed', () => {
  const root = fixture((r) => {
    wj(join(r, 'package.json'), { dependencies: { '@acme/demo': 'file:/materials/market-current/demo.tgz' } })
    wj(join(r, 'node_modules', '@acme', 'demo', 'package.json'), { name: '@acme/demo', version: '1.0.0' })
    writeFileSync(join(r, 'pnpm-lock.yaml'),
      "packages:\n  '@acme/demo@file:/materials/market-current/demo.tgz':\n    resolution: {tarball: file:/materials/market-current/demo.tgz}\n    version: 1.0.0\n", 'utf8')
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: '@acme/demo', profileDir: root,
      ownerRepo: { owner: 'different-author', repo: 'different-repo' }, pinnedCommit: 'f'.repeat(40), subdir: 'unrelated/subdir' })
    assert.equal(out.state, 'unconfirmed')
    assert.match(out.basis, /pnpm-lock/, '必须真解析 lock，不能靠版本猜')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反例·缺陷1附：普通包 demo@file: 只一个 @ 也用 yaml 真解析 lock（旧实现整段漏读）', () => {
  const root = fixture((r) => {
    wj(join(r, 'package.json'), { dependencies: { demo: 'file:/materials/market-current/demo.tgz' } })
    wj(join(r, 'node_modules', 'demo', 'package.json'), { name: 'demo', version: '1.0.0' })
    writeFileSync(join(r, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      demo:\n        specifier: file:/materials/market-current/demo.tgz\n        version: file:/materials/market-current/demo.tgz\npackages:\n  demo@file:/materials/market-current/demo.tgz:\n    resolution: {tarball: file:/materials/market-current/demo.tgz}\n", 'utf8')
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'demo', profileDir: root,
      ownerRepo: { owner: 'acme', repo: 'demo' }, pinnedCommit: 'a'.repeat(40) })
    assert.match(out.basis, /pnpm-lock/, '普通单 @ 包必须命中 lock 解析，不能整段漏读成「只有 node_modules 版本」')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反例·缺陷1附：决定只给 7 位短提交不能通配命中完整固定提交', () => {
  const full = 'a'.repeat(40)
  const root = fixture((r) => {
    wj(join(r, 'node_modules', 'dsh-y', 'package.json'), { name: 'dsh-y', version: '1.2.3' })
    wj(join(r, '.plugin-manager', 'install-decisions', 'dec-2.json'), {
      schema: 'fish-install-decision/v1', id: 'dec-2', status: 'active', packageName: 'dsh-y', pluginId: 'dsh-y',
      version: '1.2.3', spec: 'file:../y.tgz',
      binding: { source: { upstreamUrl: 'https://github.com/acme/y.git', pinnedCommit: 'a'.repeat(7), subdir: '' } }
    })
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'dsh-y', profileDir: root,
      ownerRepo: { owner: 'acme', repo: 'y' }, pinnedCommit: full })
    assert.equal(out.state, 'unconfirmed', '短提交不得凭 slice(0,7) 通配命中 40 位固定提交')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反例·缺陷4：同名 npm 历史声明同一规范仓库、无 GitHub 实际材料 → 归一成 1 组 pkg', () => {
  const root = fixture((r) => {
    for (const id of ['first', 'second']) {
      npmWrite(r, 'demo', id, npmSource('demo', '1.0.0', { url: 'https://github.com/acme/demo.git' }))
    }
  })
  try {
    const rows = publicSources({ frameworkRoot: root }).filter((x) => x.id && x.id.startsWith('npm:demo/'))
    assert.equal(rows.length, 2)
    assert.equal(new Set(rows.map((x) => x.groupKey)).size, 1)
    assert.ok(rows.every((x) => x.groupKey === 'pkg:demo'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('反例·缺陷4保护：同名 npm 声明规范仓库互相冲突 → 仍各自 solo:unconfirmed', () => {
  const root = fixture((r) => {
    npmWrite(r, 'demo', 'first', npmSource('demo', '1.0.0', { url: 'https://github.com/acme/demo.git' }))
    npmWrite(r, 'demo', 'second', npmSource('demo', '1.0.0', { url: 'https://github.com/other/demo.git' }))
  })
  try {
    const rows = publicSources({ frameworkRoot: root }).filter((x) => x.id && x.id.startsWith('npm:demo/'))
    assert.equal(rows.length, 2)
    assert.ok(rows.every((x) => /^solo:/.test(x.groupKey)), '声明冲突不得归一')
    assert.ok(rows.every((x) => x.identityBasis === 'unconfirmed'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mapInstalled：install-decision 精确命中来源 → installed', () => {
  const commit = '1234567abcdef'
  const root = fixture((r) => {
    wj(join(r, 'node_modules', 'dsh-x', 'package.json'), { name: 'dsh-x', version: '1.2.3' })
    wj(join(r, '.plugin-manager', 'install-decisions', 'dec-1.json'), {
      schema: 'fish-install-decision/v1', id: 'dec-1', status: 'active', packageName: 'dsh-x',
      pluginId: 'dsh-x', version: '1.2.3', spec: 'file:../x.tgz',
      binding: { source: { upstreamUrl: 'https://github.com/acme/x.git', pinnedCommit: commit, subdir: '' } }
    })
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'dsh-x',
      ownerRepo: { owner: 'acme', repo: 'x' }, pinnedCommit: commit, profileDir: root })
    assert.equal(out.state, 'installed')
    assert.equal(out.version, '1.2.3')
    assert.match(out.source, /local-install|install-decision/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/* ===== 第三轮 dev.11 缺陷1：同一安装事实在列表/单条/批量口径一致，sourceId 为已核实关联 ===== */
test('缺陷1：内容等价的多条历史全被判 installed 时 → 全部降 unconfirmed，sourceId=null，不挑首条', () => {
  const commit = 'aaaaaaa1234567890abcdef1234567890abcdef'
  const root = fixture((r) => {
    // 两条不同 id 的 npm 历史，但同包名 + 同 pinnedCommit（内容等价指纹相同）。
    npmWrite(r, 'dsh-equiv', 'mkt-A', npmSource('dsh-equiv', '1.0.0',
      { url: 'git+https://github.com/acme/dsh-equiv.git' }, commit))
    npmWrite(r, 'dsh-equiv', 'mkt-B', npmSource('dsh-equiv', '1.0.0',
      { url: 'git+https://github.com/acme/dsh-equiv.git' }, commit))
    // 一条 active 决定命中该来源身份与安装版本 → 旧实现两条都会判 installed。
    wj(join(r, 'node_modules', 'dsh-equiv', 'package.json'), { name: 'dsh-equiv', version: '1.0.0' })
    wj(join(r, '.plugin-manager', 'install-decisions', 'dec.json'), {
      schema: 'fish-install-decision/v1', id: 'dec', status: 'active', packageName: 'dsh-equiv',
      version: '1.0.0', binding: { source: { upstreamUrl: 'https://github.com/acme/dsh-equiv.git', pinnedCommit: commit } }
    })
  })
  try {
    const opts = { frameworkRoot: root, profileDir: root }
    const list = publicSources(opts).filter((x) => String(x.id).startsWith('npm:dsh-equiv/'))
    assert.equal(list.length, 2)
    // 核心反例：旧实现两条都 installed 且 sourceId=输入 id；新实现全部未确认、不回显、说明内容等价。
    assert.ok(list.every((x) => x.install.state === 'unconfirmed'), '内容等价的多条不得同时标成当前安装来源')
    assert.ok(list.every((x) => x.install.sourceId === null), 'unconfirmed 不得回显输入 id 当 sourceId')
    assert.ok(list.every((x) => /内容等价/.test(x.install.basis || '')), 'basis 应如实说明内容等价、具体历史未确认')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('缺陷1：publicSources 列表与 attachInstallToSources 单条/批量逐来源结论一致', () => {
  const commit = 'bbbbbbb1234567890abcdef1234567890abcdef'
  const root = fixture((r) => {
    // 一条 GitHub 来源（有实际身份）+ 一条无关联的 npm 来源。
    const repoRel = '饭/github.com/acme/dsh-mix/仓库'
    wj(join(r, '饭', '项目索引.json'), idx([ghProject('acme', 'dsh-mix', null, commit, 'dsh-mix')]))
    wj(join(r, repoRel, 'PLACEHOLDER'), { note: '仓库' })
    wj(join(r, '饭', 'github.com', 'acme', 'dsh-mix', '来源.json'),
      ghSource('acme', 'dsh-mix', repoRel, commit, 'dsh-mix'))
    npmWrite(r, 'dsh-plain', 'req-1', npmSource('dsh-plain', '1.0.0',
      { url: 'git+https://github.com/acme/dsh-plain.git' }))
  })
  try {
    const opts = { frameworkRoot: root, profileDir: root }
    const list = publicSources(opts)
    // 单条/批量入口：从列表项 id 取回原始来源行，再走 attachInstallToSources。
    const { listRiceSources } = mod
    const raw = listRiceSources({ frameworkRoot: root })
    const decorated = attachInstallToSources(raw, opts)
    const byId = new Map(decorated.map((d) => [d.id, d._install]))
    for (const item of list) {
      const perSource = byId.get(item.id)
      assert.ok(perSource, '每条列表来源都应有对应的逐来源 install：' + item.id)
      assert.equal(item.install.state, perSource.state, '列表与单条/批量 install.state 必须一致：' + item.id)
      assert.equal(item.install.sourceId, perSource.sourceId, '列表与单条/批量 sourceId 必须一致：' + item.id)
    }
    // 无安装证据：not-installed/unconfirmed（均非 installed）且 sourceId=null（输入 id 不回显）。
    const plain = decorated.find((d) => d.id === 'npm:dsh-plain/req-1')
    assert.notEqual(plain._install.state, 'installed')
    assert.equal(plain._install.sourceId, null, '未确认来源的 sourceId 必须为 null')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

/* ===== 第四轮 dev.12：缺陷2 当前 importer 精确 resolution + 缺陷1a registry 交叉核 ===== */
const DEV12_A = 'a'.repeat(40)
const DEV12_B = 'b'.repeat(40)
const DEV12_URL_A = `https://github.com/acme/demo/archive/${DEV12_A}.tgz`
const DEV12_URL_B = `https://github.com/acme/demo/archive/${DEV12_B}.tgz`
// 造一个当前 Profile：node_modules 装 2.0.0，root importer 直接依赖 B（urlB）。
// otherImporter=true 时额外给别的 importer 依赖 A；lock 同时残留 A(1.0.0)/B(2.0.0) 两条。
function dev12Profile(r, { version = '2.0.0', rootVersion = DEV12_URL_B, otherImporter = false, dirB = null } = {}) {
  const p = join(r, 'prof')
  wj(join(p, 'package.json'), { name: 'prof', version: '1.0.0', dependencies: { demo: DEV12_URL_B } })
  wj(join(p, 'node_modules', 'demo', 'package.json'), { name: 'demo', version })
  let yaml = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      demo:\n        specifier: '${DEV12_URL_B}'\n        version: '${rootVersion}'\n`
  if (otherImporter) yaml += `  other:\n    dependencies:\n      demo:\n        specifier: '${DEV12_URL_A}'\n        version: '${DEV12_URL_A}'\n`
  yaml += `packages:\n` +
    `  'demo@${DEV12_URL_A}':\n    resolution: {tarball: '${DEV12_URL_A}', integrity: sha512-A}\n    version: 1.0.0\n` +
    `  'demo@${DEV12_URL_B}':\n    resolution: {tarball: '${DEV12_URL_B}', integrity: sha512-B${dirB ? `, directory: '${dirB}'` : ''}}\n    version: 2.0.0\n`
  writeFileSync(join(p, 'pnpm-lock.yaml'), yaml, 'utf8')
  return p
}
const dev12Owner = { owner: 'acme', repo: 'demo' }

test('dev12缺陷2：另一个 importer 选 A、当前 root 依赖 B → 查 A 残留不冒认 installed', () => {
  const root = fixture((r) => { dev12Profile(r, { otherImporter: true }) })
  try {
    const out = mapInstalled({ packageName: 'demo', profileDir: join(root, 'prof'), sourceId: 'old-A',
      ownerRepo: dev12Owner, pinnedCommit: DEV12_A })
    assert.notEqual(out.state, 'installed', '另一 importer 的残留 lock 条目不得判当前来源 installed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dev12缺陷2：A/B 同版本 2.0、当前依赖 B → 先匹配到的 A 不冒认 installed', () => {
  const root = fixture((r) => { dev12Profile(r, { rootVersion: '2.0.0' }) })
  try {
    const out = mapInstalled({ packageName: 'demo', profileDir: join(root, 'prof'), sourceId: 'old-A',
      ownerRepo: dev12Owner, pinnedCommit: DEV12_A })
    assert.notEqual(out.state, 'installed', '仅版本号一致、非当前 resolution 的 A 不得判 installed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dev12缺陷2：要求子目录但 lock 不能证明 → unconfirmed、sourceId 不回显', () => {
  const root = fixture((r) => { dev12Profile(r, { dirB: null }) })
  try {
    const out = mapInstalled({ packageName: 'demo', profileDir: join(root, 'prof'), sourceId: 'cur-B',
      ownerRepo: dev12Owner, pinnedCommit: DEV12_B, subdir: 'packages/other' })
    assert.notEqual(out.state, 'installed', 'lock 无子目录证据不得判 installed')
    // sourceId 在 mapInstalled 层原样回显供聚合；null 收口由 rice-model.resolveInstalls 负责。
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// 造真实 registry 契约：registry 行 + 正式决定 + 请求记录三源交叉核，requestId 精确关联来源。
function dev12Registry(r, p, { requestId = 'req-a', contentHash = 'sha256:HASH-A', version = '2.0.0' } = {}) {
  const reg = join(r, '鱼的手', '插件注册表')
  wj(join(reg, 'registry.json'), { schema: 'fish-hand-registry/v1', plugins: [
    { pluginId: 'demo', packageName: 'demo', name: 'demo', state: 'installed', approved: true,
      version, requestId, formalDecisionId: 'fd-a', spec: DEV12_URL_B }
  ] })
  wj(join(reg, 'decisions', 'fd-a.json'), { schema: 'fish-hand-formal-decision/v1', status: 'active',
    pluginId: 'demo', packageName: 'demo', version, spec: DEV12_URL_B,
    binding: { artifactPath: 'artifact/demo', contentHash, targetProfile: p } })
  wj(join(reg, 'requests', `${requestId}.json`), { id: requestId, packageName: 'demo',
    source: { contentHash } })
}

test('dev12缺陷1a：真实 registry+正式决定+请求交叉核 → installed 且 sourceId 精确关联当前请求', () => {
  const root = fixture((r) => {
    const p = dev12Profile(r)
    dev12Registry(r, p, { requestId: 'req-a', contentHash: 'sha256:HASH-A' })
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'demo', profileDir: join(root, 'prof'),
      sourceId: 'npm:demo/req-a', ownerRepo: dev12Owner, pinnedCommit: DEV12_B })
    assert.equal(out.state, 'installed', '三源交叉核 + requestId 精确关联应判 installed')
    assert.equal(out.source, 'registry-decision')
    assert.equal(out.sourceId, 'npm:demo/req-a')
    assert.match(out.basis, /registry/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dev12缺陷1a：registry 当前安装关联的是别的请求历史 → 本来源 unconfirmed，不冒认', () => {
  const root = fixture((r) => {
    const p = dev12Profile(r)
    dev12Registry(r, p, { requestId: 'req-b', contentHash: 'sha256:HASH-B' })
  })
  try {
    const out = mapInstalled({ frameworkRoot: root, packageName: 'demo', profileDir: join(root, 'prof'),
      sourceId: 'npm:demo/req-a', ownerRepo: dev12Owner, pinnedCommit: DEV12_B })
    assert.notEqual(out.state, 'installed', 'registry 关联的是 req-b，req-a 同内容也不得冒认 installed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('dev12缺陷1b：单条入口传 [one] 也必须基于全量来源集合，与列表/批量同一结论', () => {
  const root = fixture((r) => {
    const p = dev12Profile(r)
    // 两条同内容的 npm 历史：同包名 demo + 同 pinnedCommit B（内容等价指纹相同）。
    const src = npmSource('demo', '2.0.0', { url: 'git+https://github.com/acme/demo.git' }, DEV12_B)
    npmWrite(r, 'demo', 'one', src)
    npmWrite(r, 'demo', 'two', { ...src })
  })
  try {
    const p = join(root, 'prof')
    const opts = { frameworkRoot: root, profileDir: p }
    const raw = mod.listRiceSources({ frameworkRoot: root }).filter((x) => String(x.id).startsWith('npm:demo/'))
    assert.equal(raw.length, 2)
    // 列表（全量）：两条内容等价 → 都 unconfirmed。
    const listed = publicSources(opts).filter((x) => String(x.id).startsWith('npm:demo/'))
    // 单条入口只传 [one]：必须仍基于全量算出与列表相同的结论（旧实现组长度=1→installed，分裂）。
    const single = attachInstallToSources([raw[0]], opts)[0]
    const oneInList = listed.find((x) => x.id === raw[0].id)
    assert.ok(oneInList)
    assert.equal(single._install.state, oneInList.install.state, '单条入口必须与列表对同一来源给出相同 state')
    assert.equal(single._install.sourceId, oneInList.install.sourceId, '单条入口必须与列表给出相同 sourceId')
    assert.notEqual(single._install.state, 'installed', '内容等价的多条不得因单条入口而误判 installed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
