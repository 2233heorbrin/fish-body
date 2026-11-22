// 第二轮：check-version / check-versions 路由必须真正接通安装核实基线（result.install）。
// 生产链路反例：findRiceSource/listRiceSources 返回的 row 不带 _install，若路由不注入，
// withInstall 就永远不加 install 字段——以前只有手填 _install 的单元夹具绿灯，掩盖了生产空字段。
// 本测试真实调 index.js apply 注册的路由（最小 ctx），预热 RAW_CACHE 保证零联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const imp = (p) => import(pathToFileURL(p).href)
const req = createRequire(join(REPO, 'package.json'))
const YAML = req('yaml')
const { apply } = await imp(join(REPO, 'index.js'))
const { checkVersionAsync, clearVersionCache } = await imp(join(REPO, 'internal/backend/lib/version-check.mjs'))
const { findRiceSource } = await imp(join(REPO, 'internal/backend/lib/rice-model.mjs'))
const { mapInstalled } = await imp(join(REPO, 'internal/backend/lib/install-mapping.mjs'))

function scaffold() {
  const temp = mkdtempSync(join(tmpdir(), 'fish-wiring-'))
  const root = join(temp, 'root')
  const profileDir = join(temp, 'profile')
  mkdirSync(root, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  const json = (p, x) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(x)) }
  return { temp, root, profileDir, json }
}

// 最小 ctx：apply 注册路由即可；prepareBackend 里 resolve 失败会被 mountProfileData 吞掉，不影响注册。
function ctxFor(profileDir) {
  const routes = new Map()
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => name === 'profileContext'
      ? { dir: profileDir, installAnchor: join(REPO, 'index.js') }
      : undefined,
    connection: { fetch: { register: (row) => { routes.set(row.path, row); return () => {} } } },
    plugin: () => ({ await: () => {}, state: 2 }),
    sessionController: { openWorkspacePath: async () => {} }
  }
  return { ctx, routes }
}

function post(routes, path, body) {
  return routes.get(path).fetch(new Request('http://local' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
  }))
}

// 造 npm 来源 + 当前 profile 里真实安装的 2.0.0 + active install-decision（项目契约）→ mapInstalled=installed。
function installedNpm({ root, profileDir, json }, pkg, version, remoteVersion) {
  json(join(root, '饭', 'npm', pkg, 'req-1', '材料', '来源.json'), {
    schema: 'rice-source/v1', sourceKind: 'npm', packageName: pkg,
    versionFromManifest: '1.0.0', sourceStatus: 'collected',
    published: { repository: { url: 'https://github.com/acme/' + pkg + '.git' } }
  })
  json(join(profileDir, 'node_modules', pkg, 'package.json'), { name: pkg, version })
  json(join(profileDir, 'package.json'), { dependencies: { [pkg]: version } })
  json(join(profileDir, '.plugin-manager', 'install-decisions', 'dec-' + pkg + '.json'), {
    id: 'dec-' + pkg, status: 'active', packageName: pkg, version,
    binding: { source: { upstreamUrl: 'https://github.com/acme/' + pkg + '.git' }, targetProfile: basename(profileDir) }
  })
}

// 预热 RAW_CACHE：远端版本由注入 reader 提供，之后路由调用命中缓存，全程零联网。
async function warm(root, id, remoteVersion) {
  const source = findRiceSource({ frameworkRoot: root, id })
  assert.ok(source, '预热前来源应已登记：' + id)
  const out = await checkVersionAsync({ frameworkRoot: root, id, source,
    deps: { asyncNpmReader: async () => remoteVersion, now: () => new Date().toISOString() } })
  assert.equal(out.state, 'ok', '预热应成功写入 RAW_CACHE')
}

test('路由 /check-version：已安装来源带真实 install 基线，材料1.0/实装2.0/远端1.5 → local-newer', async () => {
  const fx = scaffold()
  const id = 'npm:demo/req-1'
  try {
    installedNpm(fx, 'demo', '2.0.0', '1.5.0')
    // binding 指向 root（components body），让 frameworkRoot() 命中；prepareBackend 失败被吞不影响注册。
    fx.json(join(fx.profileDir, 'fish-body-data.json'), { schema: 'fish-profile-data/v1', root: fx.root, components: ['body'] })
    clearVersionCache()
    await warm(fx.root, id, '1.5.0')
    const { ctx, routes } = ctxFor(fx.profileDir)
    await apply(ctx, { profileDir: fx.profileDir, bodySwitchModule: null })
    const res = await post(routes, '/api/fish-body/check-version', { id })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.state, 'ok')
    assert.equal(body.result.remoteVersion, '1.5.0')
    // 核心断言：生产路由返回的 result 必须带安装核实基线，且按真实安装版本比较。
    assert.ok(body.result.install, '生产 check-version 路由必须带 result.install（当前缺陷：缺失）')
    assert.equal(body.result.install.sourceId, id)
    assert.equal(body.result.install.state, 'installed')
    assert.equal(body.result.install.installedVersion, '2.0.0')
    assert.equal(body.result.install.comparison, 'local-newer', '安装版2.0 比远端1.5新，不得误报 newer')
    assert.equal(body.result.comparison, 'newer', '材料基线仍按材料1.0 vs 远端1.5 独立计算')
  } finally { rmSync(fx.temp, { recursive: true, force: true }) }
})

test('路由 /check-version：unconfirmed 来源不冒认 installed', async () => {
  const fx = scaffold()
  const id = 'npm:plain/req-1'
  try {
    // 有 node_modules 版本但无 decision/lock 关联 → mapInstalled=unconfirmed（不冒认）。
    fx.json(join(fx.root, '饭', 'npm', 'plain', 'req-1', '材料', '来源.json'), {
      schema: 'rice-source/v1', sourceKind: 'npm', packageName: 'plain',
      versionFromManifest: '1.0.0', sourceStatus: 'collected'
    })
    fx.json(join(fx.profileDir, 'node_modules', 'plain', 'package.json'), { name: 'plain', version: '2.0.0' })
    fx.json(join(fx.profileDir, 'fish-body-data.json'), { schema: 'fish-profile-data/v1', root: fx.root, components: ['body'] })
    clearVersionCache()
    await warm(fx.root, id, '1.5.0')
    const { ctx, routes } = ctxFor(fx.profileDir)
    await apply(ctx, { profileDir: fx.profileDir, bodySwitchModule: null })
    const res = await post(routes, '/api/fish-body/check-version', { id })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.result.install, 'unconfirmed 也必须带 install 字段（如实证伪安装状态）')
    assert.equal(body.result.install.state, 'unconfirmed')
    assert.equal(body.result.install.installedVersion, '2.0.0', '版本如实读出')
    assert.equal(body.result.install.comparison, 'unknown', '未确认安装来源不得算比较结论')
  } finally { rmSync(fx.temp, { recursive: true, force: true }) }
})

test('路由 /check-versions：批量结果每条都带 install 基线', async () => {
  const fx = scaffold()
  try {
    installedNpm(fx, 'alpha', '2.0.0', '1.5.0')
    fx.json(join(fx.root, '饭', 'npm', 'beta', 'req-1', '材料', '来源.json'), {
      schema: 'rice-source/v1', sourceKind: 'npm', packageName: 'beta',
      versionFromManifest: '1.0.0', sourceStatus: 'collected'
    })
    fx.json(join(fx.profileDir, 'fish-body-data.json'), { schema: 'fish-profile-data/v1', root: fx.root, components: ['body'] })
    clearVersionCache()
    await warm(fx.root, 'npm:alpha/req-1', '1.5.0')
    await warm(fx.root, 'npm:beta/req-1', '1.5.0')
    const { ctx, routes } = ctxFor(fx.profileDir)
    await apply(ctx, { profileDir: fx.profileDir, bodySwitchModule: null })
    const res = await post(routes, '/api/fish-body/check-versions', {})
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.ok(body.results.length >= 2, '两条来源都应返回结果')
    for (const row of body.results) {
      assert.ok(row.result.install, '批量每条 result 都必须带 install：' + row.id)
    }
    const alpha = body.results.find((r) => r.id === 'npm:alpha/req-1').result
    assert.equal(alpha.install.state, 'installed')
    assert.equal(alpha.install.sourceId, 'npm:alpha/req-1', '已核实安装才回显 sourceId')
    assert.equal(alpha.install.comparison, 'local-newer')
    const beta = body.results.find((r) => r.id === 'npm:beta/req-1').result
    assert.notEqual(beta.install.state, 'installed', 'beta 无安装证据，不得判 installed')
    assert.equal(beta.install.sourceId, null, '未确认来源不得把输入 id 原样回显成 sourceId')
  } finally { rmSync(fx.temp, { recursive: true, force: true }) }
})

// ===== 第五轮 dev.13 路径身份反例：resolution 只留尾段导致同名误认 =====
const PX_A = 'a'.repeat(40), PX_B = 'b'.repeat(40)
const pxUrl = (x) => 'https://github.com/acme/demo/archive/' + x + '/demo.tgz'
function pxFixture(name, { wrongSpec = false, wrongProfile = false, missingSpec = false } = {}) {
  const fx = scaffold()
  const root = join(fx.temp, name)
  const profileDir = join(root, 'current', 'fish-main')
  const regDir = join(root, '鱼的手', '插件注册表')
  const current = 'file:' + join(root, 'new', 'demo.tgz')
  const old = 'file:' + join(root, 'old', 'demo.tgz')
  fx.json(join(profileDir, 'package.json'), missingSpec ? {} : { dependencies: { demo: current } })
  fx.json(join(profileDir, 'node_modules', 'demo', 'package.json'), { name: 'demo', version: '2.0.0' })
  const spec = wrongSpec ? old : current
  fx.json(join(regDir, 'registry.json'), { plugins: [
    { pluginId: 'demo', packageName: 'demo', state: 'installed', approved: true, version: '2.0.0',
      requestId: 'req-1', formalDecisionId: 'fd-1', spec }
  ] })
  fx.json(join(regDir, 'decisions', 'fd-1.json'), { schema: 'fish-hand-formal-decision/v1', status: 'active',
    packageName: 'demo', version: '2.0.0', spec,
    binding: { targetProfile: wrongProfile ? join(root, 'OTHER', 'fish-main') : profileDir,
      contentHash: 'sha256:example', artifactPath: join(root, 'artifact') } })
  fx.json(join(regDir, 'requests', 'req-1.json'), { id: 'req-1', packageName: 'demo', source: { contentHash: 'sha256:example' } })
  return { fx, root, profileDir }
}

test('dev13：lock 同文件名不同完整引用——查提交 a 不得命中当前依赖 url(b) 的目录', () => {
  const fx = scaffold()
  try {
    const prof = fx.profileDir
    fx.json(join(prof, 'package.json'), { dependencies: { demo: pxUrl(PX_B) } })
    fx.json(join(prof, 'node_modules', 'demo', 'package.json'), { name: 'demo', version: '2.0.0' })
    const lock = {
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { demo: { specifier: pxUrl(PX_B), version: pxUrl(PX_B) } } } },
      packages: {
        ['demo@' + pxUrl(PX_A)]: { resolution: { tarball: pxUrl(PX_A) }, version: '1.0.0' },
        ['demo@' + pxUrl(PX_B)]: { resolution: { tarball: pxUrl(PX_B) }, version: '2.0.0' }
      }
    }
    writeFileSync(join(prof, 'pnpm-lock.yaml'), YAML.stringify(lock))
    const out = mapInstalled({ packageName: 'demo', profileDir: prof, sourceId: 'old-A',
      ownerRepo: { owner: 'acme', repo: 'demo' }, pinnedCommit: PX_A })
    assert.notEqual(out.state, 'installed', '同文件名不同提交/目录，只留尾段会误命中 url(a)')
  } finally { rmSync(fx.temp, { recursive: true, force: true }) }
})

test('dev13：registry 正例（三源 spec/targetProfile/声明一致）仍 installed', () => {
  const c = pxFixture('px-valid')
  try {
    const out = mapInstalled({ frameworkRoot: c.root, packageName: 'demo', profileDir: c.profileDir, sourceId: 'npm:demo/req-1' })
    assert.equal(out.state, 'installed')
    assert.equal(out.source, 'registry-decision')
    assert.equal(out.sourceId, 'npm:demo/req-1')
  } finally { rmSync(c.fx.temp, { recursive: true, force: true }) }
})

test('dev13：registry 行/决定指向旧制品、当前声明指向新制品（同名不同目录）→ unconfirmed', () => {
  const c = pxFixture('px-wrongspec', { wrongSpec: true })
  try {
    const out = mapInstalled({ frameworkRoot: c.root, packageName: 'demo', profileDir: c.profileDir, sourceId: 'npm:demo/req-1' })
    assert.notEqual(out.state, 'installed', 'old/demo.tgz 与 new/demo.tgz 不得因同名被判等')
  } finally { rmSync(c.fx.temp, { recursive: true, force: true }) }
})

test('dev13：决定 targetProfile 同名不同目录 → unconfirmed', () => {
  const c = pxFixture('px-wrongprofile', { wrongProfile: true })
  try {
    const out = mapInstalled({ frameworkRoot: c.root, packageName: 'demo', profileDir: c.profileDir, sourceId: 'npm:demo/req-1' })
    assert.notEqual(out.state, 'installed', 'OTHER/fish-main 与 current/fish-main 只是 basename 相同，不得放行')
  } finally { rmSync(c.fx.temp, { recursive: true, force: true }) }
})

test('dev13：当前 package.json 无该依赖声明，仅 node_modules 残留+旧 registry → unconfirmed', () => {
  const c = pxFixture('px-missingspec', { missingSpec: true })
  try {
    const out = mapInstalled({ frameworkRoot: c.root, packageName: 'demo', profileDir: c.profileDir, sourceId: 'npm:demo/req-1' })
    assert.notEqual(out.state, 'installed', '无当前依赖声明，registry/目录证据不得替代')
  } finally { rmSync(c.fx.temp, { recursive: true, force: true }) }
})

// dev14 定向补修：URL 的 pathname 大小写敏感——release 资源 .../DEMO.tgz 与 .../demo.tgz 是不同制品。
// 旧 resolutionIdentity 对整条 URL .toLowerCase() 会把两者混同，两个反例都会误判 installed。
test('dev14：registry/决定记大写 DEMO.tgz、当前声明小写 demo.tgz → unconfirmed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fish-urlcase-'))
  try {
    const root = join(temp, 'root')
    const profileDir = join(temp, 'profile')
    const current = 'https://github.com/acme/demo/releases/download/v1.0.0/demo.tgz'
    const other = 'https://github.com/acme/demo/releases/download/v1.0.0/DEMO.tgz'
    const json = (p, x) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(x)) }
    json(join(profileDir, 'package.json'), { dependencies: { demo: current } })
    json(join(profileDir, 'node_modules/demo/package.json'), { name: 'demo', version: '1.0.0' })
    const reg = join(root, '鱼的手/插件注册表')
    json(join(reg, 'registry.json'), { plugins: [{ pluginId: 'demo', version: '1.0.0', state: 'installed', requestId: 'req1', formalDecisionId: 'fd1', spec: other }] })
    json(join(reg, 'decisions/fd1.json'), { status: 'active', packageName: 'demo', version: '1.0.0', spec: other, binding: { contentHash: 'sha256:demo', targetProfile: profileDir } })
    json(join(reg, 'requests/req1.json'), { id: 'req1', packageName: 'demo', source: { contentHash: 'sha256:demo' } })
    const out = mapInstalled({ frameworkRoot: root, packageName: 'demo', profileDir, sourceId: 'npm:demo/req1' })
    assert.notEqual(out.state, 'installed', '大写 DEMO.tgz 与小写 demo.tgz 不得因整条小写被判等')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('dev14：lock 同在时 root importer 选小写当前 URL，不选大写残留条目', () => {
  const temp = mkdtempSync(join(tmpdir(), 'fish-urllock-'))
  try {
    const profileDir = join(temp, 'profile')
    const current = 'https://github.com/acme/demo/releases/download/v1.0.0/demo.tgz'
    const other = 'https://github.com/acme/demo/releases/download/v1.0.0/DEMO.tgz'
    const json = (p, x) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(x)) }
    json(join(profileDir, 'package.json'), { dependencies: { demo: current } })
    json(join(profileDir, 'node_modules/demo/package.json'), { name: 'demo', version: '1.0.0' })
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), YAML.stringify({
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { demo: { specifier: current, version: current } } } },
      packages: {
        ['demo@' + other]: { resolution: { tarball: other }, version: '1.0.0' },
        ['demo@' + current]: { resolution: { tarball: current }, version: '1.0.0' }
      }
    }))
    const out = mapInstalled({ packageName: 'demo', profileDir, ownerRepo: { owner: 'acme', repo: 'demo' } })
    assert.equal(out.state, 'installed')
    assert.ok(out.basis.includes(current), 'basis 应指向小写当前 URL')
    assert.ok(!out.basis.includes(other), 'basis 不得指向大写残留条目')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
