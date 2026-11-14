import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'

const install = process.env.FISH_TEST_INSTALL_ROOT
if (!install) throw new Error('FISH_TEST_INSTALL_ROOT must point to an isolated installed tarball')
const body = join(install, 'node_modules/fish-body')
const load = path => import(pathToFileURL(join(body, 'internal/backend', path)))
const { ingestNpmPublished } = await load('lib/market-source.mjs')
const { buildInstallPackage, inspectInstallPackage } = await load('lib/w6-package.mjs')
const { recomputeFiles } = await load('lib/artifact.mjs')
const { treeHashOf, sri512, treeManifest } = await load('lib/w6-utils.mjs')
const req = createRequire(join(body, 'package.json'))
const { Header } = req('tar')
const npmCli = join(dirname(req.resolve('npm/package.json')), 'bin/npm-cli.js')
const root = mkdtempSync(join(tmpdir(), 'fish-archive-'))
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
const chinese = 'paper/模型驱动的分层增量压缩-免训练多代上下文管理.md'

function ingest(tgz, id, integrity = sri512(readFileSync(tgz))) {
  let saved
  const base = join(root, id)
  const result = ingestNpmPublished({ riceRoot: join(base, '饭'), stomachRoot: join(base, '胃'), store: { save: value => { saved = value } } },
    { id, packageName: 'archive-fixture', requestedVersion: '1.0.0', intent: { spec: 'archive-fixture@1.0.0' } },
    { pack: (_spec, dest) => { copyFileSync(tgz, join(dest, basename(tgz))); return [{ filename: basename(tgz), integrity }] } })
  assert.equal(saved.state, 'awaiting-approval')
  return result
}

test('actual npm publish -> collection -> actual pnpm package preserves UTF-8 names and every runtime byte', () => {
  const source = join(root, '源 包'), packed = join(root, '发布包')
  mkdirSync(source); mkdirSync(packed)
  json(join(source, 'package.json'), { name: 'archive-fixture', version: '1.0.0', main: 'lib/入口.js', files: ['lib', 'paper'] })
  put(join(source, 'lib/入口.js'), 'module.exports = "中文入口";\n')
  put(join(source, chinese), '# 中文文件名与内容\n不能因解包改变字节。\n')
  put(join(source, 'paper/带 空格/说明.md'), 'space + unicode\n')
  const rows = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', packed],
    { cwd: source, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  const tgz = join(packed, rows[0].filename)
  const collected = ingest(tgz, 'unicode')
  const warehouse = join(collected.riceDir, '仓库')
  assert.equal(readFileSync(join(warehouse, chinese), 'utf8'), readFileSync(join(source, chinese), 'utf8'))
  assert.deepEqual(treeManifest(warehouse), treeManifest(source))
  const artifact = join(root, '已审产物')
  mkdirSync(artifact)
  // Keep the actual collected tree; the builder uses the same source manifest contract.
  const files = recomputeFiles(warehouse)
  json(join(collected.riceDir, 'manifest.json'), { contentFiles: files, contentHash: treeHashOf(files) })
  const built = buildInstallPackage({ artifactDir: collected.riceDir, outDir: artifact,
    packageName: 'archive-fixture', version: '1.0.0', revision: 'unicode', published: true })
  assert(inspectInstallPackage({ artifactDir: collected.riceDir, recordPath: built.recordPath }).ok)
  assert.equal(readFileSync(join(built.runtimeDir, chinese), 'utf8'), readFileSync(join(source, chinese), 'utf8'))
  assert(built.runtimeFiles.some(row => row.path === 'lib/入口.js'))
  // Verify extraction without any external command on PATH in a fresh Node process.
  const copy = join(root, '独立回解')
  mkdirSync(copy)
  const script = `const {createRequire}=require('node:module');const req=createRequire(process.argv[1]);req('tar').x({file:process.argv[2],cwd:process.argv[3],sync:true,strict:true});`
  execFileSync(process.execPath, ['-e', script, join(body, 'package.json'), built.tgzPath, copy],
    { env: { ...process.env, PATH: '', NODE_OPTIONS: '' }, windowsHide: true })
  assert.deepEqual(treeManifest(join(copy, 'package')), built.runtimeFiles)
})

// Header fixtures represent inputs that the pre-existing npm archive checks reject.
function archive(label, path, type = 'File', linkpath = '') {
  const tgz = join(root, label + '.tgz'), payload = Buffer.from('outside')
  const header = new Header({ path, type, linkpath, size: type === 'File' ? payload.length : 0, mode: 0o644, uid: 0, gid: 0 })
  const block = Buffer.alloc(512); header.encode(block)
  const content = type === 'File' ? Buffer.concat([payload, Buffer.alloc(512 - payload.length)]) : Buffer.alloc(0)
  writeFileSync(tgz, gzipSync(Buffer.concat([block, content, Buffer.alloc(1024)])))
  return tgz
}

for (const [label, path, type, link] of [
  ['parent', 'package/../outside'], ['absolute', '/outside'], ['backslash', 'package\\outside'],
  ['symlink', 'package/link', 'SymbolicLink', '../outside'], ['hardlink', 'package/link', 'Link', '../outside'],
]) test('npm collection still rejects ' + label + ' before extraction', () => {
  assert.throws(() => ingest(archive(label, path, type, link), label), error => error.code === 'FH_NPM_ARCHIVE_INVALID')
  assert(!existsSync(join(root, label, '饭/npm/archive-fixture', label, 'unpacked')))
})

test('npm collection still rejects a mismatched integrity before archive processing', () => {
  assert.throws(() => ingest(archive('integrity', 'package/index.js'), 'integrity', 'sha512-wrong'),
    error => error.code === 'FH_NPM_INTEGRITY_MISMATCH')
})
