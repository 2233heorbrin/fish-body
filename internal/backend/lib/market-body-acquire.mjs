/* fish-body · 关闭胃直装「本体入仓」获取器（维护源，可审计）
 *
 * 只做一件事：把用户要装的发行包作为「运行本体」获取到手仓插件仓版本目录，装好普通依赖，
 * 产出一个稳定的 link: 本体路径与真实内容身份。它是安装/准备，不是分析、不是材料采集：
 *   - 不建请求、不跑 runW2W3、不发模型请求、不 review、不 approve、不写胃材料结论；
 *   - 依赖准备用 pnpm --ignore-scripts（只装依赖，不跑候选生命周期脚本），见报告边界说明。
 *
 * Codex #315 #1 主路径：下载发行包作为运行本体 → 存手仓版本目录 → 依赖由包管理器准备 →
 * 返回 link: 本体路径交原生 deploy → 成功后由 market-runtime realpath 核验落在本体目录才登记。
 *
 * 产物布局（canonical，与 artifactDirFor 同口径）：
 *   <pluginsRoot>/<safeName>/<version>/<rev>/   ← link 本体根（含 package.json / pnpm-workspace.yaml / node_modules）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extract as extractTar } from 'tar';
import { npmCommand } from './runtime-programs.mjs';
import { runPnpm, preparePnpmWorkspace, packageFiles } from './w6-package.mjs';
import { sha256Text, hashOf, treeHashOf, copyTree, removeTree } from './w6-utils.mjs';
import { fetchSourceToRice, parseGithubUrl, normalizeSubdir } from './source-fetch.mjs';
import { warehouseRoot, isWithinWarehouse } from './market-direct-source.mjs';
import { marketError } from './market-source.mjs';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const safeName = (n) => (String(n ?? '').replace(/^@/, '').replace(/[\\/]/g, '+').replace(/[^A-Za-z0-9._+-]/g, '_') || 'unnamed');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function acquireError(code, message, details = {}) {
  return Object.assign(new Error(`[${code}] ${message}`), { code, ...details });
}

/** 身份标记文件：本体目录写入自身的来源身份，用于「已就绪则沿用、身份冲突则拒绝」，避免重装正在被引用的版本。 */
const IDENTITY_FILE = '.fish-body-direct-source.json';

/**
 * 版本目录 revision（Codex #318 阻塞3：内容寻址，不再让 npm 恒 unpinned / 同名同版不同源串目录）。
 *   - GitHub 固定提交：以 commit 前 12 位为可读前缀，附来源身份 digest（含 subdir / integrity / ref）。
 *   - npm / 无提交：完全由 integrity + registry + npmSpec 内容寻址；同名同版不同源落不同目录。
 */
function revisionOf({ resolvedCommit, requestedRef, sourceSubdir, sourceSpec, integrity, registryUrl, npmSpec, sourceUrl }) {
  const commit = text(resolvedCommit);
  const identityTail = [text(integrity), text(registryUrl), text(npmSpec || sourceSpec || sourceUrl), text(requestedRef)].filter(Boolean).join('|');
  const digest = hashOf(identityTail).slice(7, 13); // 6 位内容身份（去掉 hashOf 的 'sha256:' 前缀）
  if (commit) {
    const base = commit.slice(0, 12).replace(/[^A-Za-z0-9._-]/g, '_');
    const sub = text(sourceSubdir) ? hashOf(sourceSubdir).slice(7, 13) : '';
    return [base, digest, sub].filter(Boolean).join('-');
  }
  // hashOf 返回 'sha256:<hex>'，必须去前缀再取 hex；目录名不得含 ':'（Windows 非法）。
  return 'npm-' + hashOf([text(registryUrl) || '', text(integrity) || '', text(npmSpec || sourceSpec || '')].join('|')).slice(7, 23).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 运行就绪判定（Codex #318 阻塞4：off 只跳分析，不静默绕过脚本授权、不把不可运行包冒充通过）。
 * 只做只读检查，不执行任何生命周期脚本；需要脚本/构建的包如实标 needs-build / scripts-ignored。
 */
function runtimeReadinessOf(manifestDir, manifest) {
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack'].filter((k) => typeof scripts[k] === 'string' && scripts[k].trim());
  const mainField = text(manifest.main) || text(manifest.module)
    || (typeof manifest.exports === 'string' ? manifest.exports : null)
    || (manifest.exports && typeof manifest.exports === 'object' ? text(manifest.exports['.']) : null);
  const entries = [mainField, 'index.js'].filter(Boolean);
  const entryPresent = entries.some((e) => existsSync(join(manifestDir, e)));
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim().length > 0;
  let state = 'ready';
  if (!entryPresent && hasBuild) state = 'needs-build';
  else if (!entryPresent) state = 'no-entry';
  else if (lifecycle.length) state = 'ready-with-scripts-ignored';
  return { state, entryPresent, entryCandidates: entries, ignoredLifecycleScripts: lifecycle, buildScript: hasBuild,
    note: state === 'needs-build' ? '包需要 build 生成入口；--ignore-scripts 不执行构建，未运行不得冒充可运行，须按宿主脚本授权机制处理'
      : state === 'ready-with-scripts-ignored' ? '包有生命周期脚本但按 off 边界以 --ignore-scripts 装依赖、未执行脚本；运行是否需脚本由原生授权链判定'
      : state === 'no-entry' ? '未找到可解析入口（main/module/exports/index.js）' : '入口存在，可交由原生加载链验证真实运行' };
}

/** 校验解包目录无越界路径与特殊文件（与 source-fetch 归档校验同口径）。 */
function assertSafeTree(list, prefix) {
  if (!prefix || list.some((p) => !p.startsWith(prefix + '/') || /[\\\x00-\x1f]/.test(p)
    || p.split('/').some((s) => s === '..' || s === '.git')))
    throw acquireError('FH_DIRECT_BODY_UNSAFE_ARCHIVE', '发行包归档路径无效或越界');
}

/** npm registry → tarball（npm pack --ignore-scripts，绝不执行候选生命周期脚本）。 */
function npmTarball(spec, staging, registryUrl) {
  const cli = npmCommand();
  const args = [...cli.args, 'pack', '--ignore-scripts', '--json', '--pack-destination', staging, spec];
  if (text(registryUrl)) args.push('--registry', text(registryUrl));
  let rows;
  try {
    const out = execFileSync(cli.exe, args, { cwd: staging, env: cli.env, encoding: 'utf8',
      windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    rows = JSON.parse(out);
  } catch (cause) {
    throw acquireError('FH_DIRECT_BODY_PACK_FAILED', `发行包获取失败：${spec}`, { causeCode: cause?.code ?? null });
  }
  const row = Array.isArray(rows) ? rows.find((r) => text(r?.filename)) : null;
  if (!row) throw acquireError('FH_DIRECT_BODY_PACK_INVALID', `发行包未产出唯一 tarball：${spec}`);
  return { tarball: join(staging, row.filename), integrity: text(row.integrity), filename: row.filename };
}

/**
 * 获取运行本体并准备依赖。返回 prepared 片段供 prepareMarketPackage(off) 直接回传。
 * 失败一律抛带 code 的错误，由子进程 IPC 如实回传，绝不伪装安装成功。
 */
export function acquireDirectBody({ frameworkRoot, spec, requestId, packageName = null, version = null,
  sourceUrl = null, requestedRef = null, resolvedCommit = null, sourceSubdir = '', registryUrl = null,
  npmSpec = null, mode = 'off', report = () => {} } = {}) {
  if (!frameworkRoot || !spec) throw acquireError('FH_DIRECT_BODY_ARGUMENT', '本体获取需要 frameworkRoot 与 spec');
  const pluginsRoot = warehouseRoot(frameworkRoot);
  const work = join(frameworkRoot, '鱼的胃', '构建工作副本', `${safeName(packageName ?? spec)}-${requestId || 'body'}-direct`);
  mkdirSync(work, { recursive: true });
  const staging = mkdtempSync(join(work, '.stage-'));
  const unpacked = join(staging, 'unpacked');
  mkdirSync(unpacked, { recursive: true });
  let sourceRoot = unpacked; // 解包后真正含 package.json 的根（npm tarball 会多一层 package/）
  const isGithub = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)/i.test(spec);
  let manifest, integrity = null, commit = text(resolvedCommit), ref = text(requestedRef);

  if (isGithub) {
    report('关闭胃：从 GitHub 固定提交获取运行本体（不执行候选构建脚本）');
    const url = text(sourceUrl) || String(spec).replace(/^github:\/?/, 'https://github.com/').replace(/^git\+/, '').split('#')[0];
    const selected = commit || ref || 'HEAD';
    let fetched;
    try {
      fetched = fetchSourceToRice({ frameworkRoot: staging, url,
        ...(commit ? { revision: commit } : {}), ...(ref && !commit ? { ref } : {}),
        ...(sourceSubdir ? { subdir: sourceSubdir } : {}) });
    } catch (cause) {
      throw acquireError('FH_DIRECT_BODY_SOURCE_FAILED', `GitHub 运行本体获取失败：${url}`, { code0: cause?.code ?? null, message: cause?.message });
    }
    commit = fetched.head || commit;
    ref = ref || fetched.branch || null;
    const from = sourceSubdir ? join(fetched.repoDir, ...sourceSubdir.split('/').filter(Boolean)) : fetched.repoDir;
    if (!existsSync(join(from, 'package.json'))) throw acquireError('FH_DIRECT_BODY_NO_MANIFEST', '固定提交内找不到 package.json（subdir 可能有误）');
    copyTree(from, unpacked);
  } else {
    report('关闭胃：从 registry 获取发行包作为运行本体（npm pack --ignore-scripts）');
    const packed = npmTarball(npmSpec || spec, staging, registryUrl);
    integrity = packed.integrity;
    try {
      extractTar({ file: resolve(packed.tarball), cwd: unpacked, sync: true, strict: true });
    } catch (cause) {
      throw acquireError('FH_DIRECT_BODY_UNPACK_FAILED', '发行包解包失败', { causeCode: cause?.code ?? null });
    }
    // npm/pnpm tarball 固定解到 <cwd>/package/（与 w6-package.unpack 同口径）；把本体根指过去。
    if (!existsSync(join(unpacked, 'package.json')) && existsSync(join(unpacked, 'package', 'package.json')))
      sourceRoot = join(unpacked, 'package');
  }

  const manifestPath = join(sourceRoot, 'package.json');
  if (!existsSync(manifestPath)) throw acquireError('FH_DIRECT_BODY_NO_MANIFEST', '发行包不含 package.json');
  manifest = readJson(manifestPath);
  const realName = text(manifest.name) || text(packageName);
  const realVersion = text(manifest.version) || text(version) || 'unversioned';
  if (!realName) throw acquireError('FH_DIRECT_BODY_NO_NAME', '发行包缺少包名');

  const rev = revisionOf({ resolvedCommit: commit, requestedRef: ref, sourceSubdir, sourceSpec: spec,
    integrity, registryUrl, npmSpec: isGithub ? null : (npmSpec || spec), sourceUrl });
  const bodyDir = join(pluginsRoot, safeName(realName), realVersion, rev);
  if (!isWithinWarehouse(bodyDir, pluginsRoot)) throw acquireError('FH_DIRECT_BODY_OUTSIDE', '本体目录越出手仓插件仓范围');

  // Codex #318 阻塞3：先在临时目录完成「复制 + 依赖准备」，成功后一次性切到正式版本目录；
  // 绝不重装/覆盖正在被 link 引用的旧版本目录，同名同版不同源因 rev 内容寻址落不同目录。
  const identity = Object.freeze({ packageName: realName, version: realVersion, integrity,
    sourceSpec: npmSpec || spec, sourceUrl: isGithub ? sourceUrl : null, requestedRef: ref,
    resolvedCommit: commit, sourceSubdir: isGithub ? sourceSubdir : '', registryUrl: isGithub ? null : registryUrl });
  let reused = false;
  if (existsSync(join(bodyDir, 'package.json'))) {
    // 目标目录已存在：只有身份标记完全一致才沿用（不重装），否则拒绝覆盖，避免改到在跑的版本。
    const marker = join(bodyDir, IDENTITY_FILE);
    const existing = existsSync(marker) ? readJson(marker) : null;
    if (existing && JSON.stringify(existing.identity) === JSON.stringify(identity)) {
      reused = true;
      report('运行本体目录身份一致，沿用已准备版本（不重装）');
    } else {
      throw acquireError('FH_DIRECT_BODY_DIR_CONFLICT', '版本目录已存在且身份不符，拒绝覆盖（保留现有版本）', { bodyDir });
    }
  } else {
    const prep = join(staging, 'body-prep');
    mkdirSync(prep, { recursive: true });
    copyTree(sourceRoot, prep);
    // 依赖准备：pnpm workspace + hoisted，--ignore-scripts 只装依赖不跑生命周期脚本。
    try {
      preparePnpmWorkspace(prep);
      const args = ['install', '--ignore-scripts', '--config.node-linker=hoisted', '--no-frozen-lockfile'];
      if (text(registryUrl)) args.push('--registry', text(registryUrl));
      runPnpm(args, prep);
    } catch (cause) {
      throw acquireError('FH_DIRECT_BODY_DEPS_FAILED', `运行本体依赖准备失败：${realName}@${realVersion}`,
        { pnpmFailure: cause?.pnpmFailure ?? null, code0: cause?.code ?? null });
    }
    writeFileSync(join(prep, IDENTITY_FILE), JSON.stringify({ identity, preparedAt: new Date().toISOString() }, null, 2));
    mkdirSync(join(bodyDir, '..'), { recursive: true });
    renameSync(prep, bodyDir); // 原子切换：准备完整才对原生可见
  }
  const files = packageFiles(bodyDir);
  const contentHash = treeHashOf(files);
  const linkSpec = 'link:' + bodyDir.replace(/\\/g, '/');
  const finalManifest = readJson(join(bodyDir, 'package.json'));
  const runtimeReadiness = runtimeReadinessOf(bodyDir, finalManifest);

  // 清理临时解包目录，保留本体目录（旧版不会被覆盖）。
  try { removeTree(staging); } catch { /* 清理失败不影响本体 */ }

  return {
    directInstall: true,
    readyForDeploy: true,
    spec: linkSpec,
    bodyPath: bodyDir.replace(/\\/g, '/'),
    bodySpec: linkSpec,
    packageName: finalManifest.name,
    version: finalManifest.version,
    integrity,
    contentHash,
    fileCount: files.length,
    sourceSpec: npmSpec || spec,
    npmSpec: isGithub ? null : (npmSpec || spec),
    sourceUrl: isGithub ? (sourceUrl || String(spec).replace(/^github:\/?/, 'https://github.com/').split('#')[0]) : null,
    requestedRef: ref,
    resolvedCommit: commit,
    sourceSubdir: isGithub ? sourceSubdir : '',
    registryUrl: isGithub ? null : registryUrl,
    requestId: null,
    analysis: null,
    authorization: 'intake-off-direct',
    deployed: false,
    runtimeReadiness,
    acquisition: { method: isGithub ? 'github-fixed-commit' : 'npm-pack-ignore-scripts',
      dependencyScripts: 'ignored（只装依赖，不执行候选生命周期脚本）', revision: rev,
      reused, identity },
    basis: 'mode=off：只把发行包作为运行本体入仓并准备依赖，零胃分析、零模型请求、零正式决定；脚本授权与真实运行由原生链判定',
  };
}
