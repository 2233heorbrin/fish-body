/**
 * W2「入饭」——固定上游来源与提交，隔离饭目录，记录真实内容（隔离实现）
 *
 * 硬约束（对应执行清单 T-ORG W2 与用户本轮要求）：
 *   1. 只读 Git 对象：rev-parse / ls-tree / cat-file / log。
 *      不 clone、不 checkout、不 archive 解包、不 import 候选代码、不跑构建/安装脚本、不联网。
 *   2. 固定到指定 commit；采集的是该 commit 的文件树，不是工作区当前状态、也不是 HEAD 的 latest。
 *   3. 记录真实来源、提交、文件内容（逐文件 sha256 + 完整原文副本）与依赖声明。
 *   4. 同一固定提交重复处理不覆盖已有记录；不同提交请求也不覆盖已有记录。
 *   5. 失败不写 pinnedCommit，不写成成功。
 *
 * 每次 git 调用都记入 callLog，供报告作为「没执行候选代码」的可核验证据。
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, lstatSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeSubdir } from './source-fetch.mjs';

export class SourceError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.detail = detail;
  }
}

let CALL_LOG = [];
/** 取出并清空本次采集以来记录的所有 git 调用（只读命令清单）。 */
export function drainCallLog() {
  const out = CALL_LOG;
  CALL_LOG = [];
  return out;
}

function gitRead(repoDir, args, { binary = false } = {}) {
  CALL_LOG.push({ exe: 'git', args: ['-C', repoDir, ...args], binary });
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 校验 commit 是否真实存在，返回 40 位十六进制。 */
function verifyCommit(repoDir, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new SourceError('SOURCE_COMMIT_INVALID', `pinnedCommit 不是合法提交号：${String(commit)}`);
  }
  let full;
  try {
    full = gitRead(repoDir, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  } catch (error) {
    throw new SourceError('SOURCE_COMMIT_NOT_FOUND',
      `仓库中找不到提交 ${commit}：${String(error.message).slice(0, 160)}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(full)) {
    throw new SourceError('SOURCE_COMMIT_NOT_FOUND', `rev-parse 返回异常：${full}`);
  }
  return full.toLowerCase();
}

/** 采集指定 commit 的完整文件树，全部内容来自 git cat-file blob。 */
export function collectFromGit({ repoDir, commit, subdir = '' }) {
  subdir = normalizeSubdir(subdir);
  const pinnedCommit = verifyCommit(repoDir, commit);
  const head = gitRead(repoDir, ['rev-parse', 'HEAD']).trim().toLowerCase();
  const subject = gitRead(repoDir, ['log', '-1', '--format=%s', pinnedCommit]).trim();

  if (subdir) {
    let kind; try { kind=gitRead(repoDir,['cat-file','-t',`${pinnedCommit}:${subdir}`]).trim(); } catch {}
    if (kind!=='tree') throw new SourceError('SOURCE_SUBDIR_NOT_FOUND', `提交 ${pinnedCommit} 中没有子目录 ${subdir}；请核对 subdir`);
  }
  const raw = Buffer.from(gitRead(repoDir, ['ls-tree', '-r', '-z', pinnedCommit, ...(subdir?['--',subdir+'/']:[])], { binary: true }));
  const chunks = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0) { chunks.push(raw.subarray(start, i)); start = i + 1; }
  }

  const files = [];
  const contents = new Map();
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const tab = chunk.indexOf(0x09);
    if (tab < 0) throw new SourceError('SOURCE_TREE_UNPARSABLE', 'ls-tree 条目缺少 TAB 分隔');
    const meta = chunk.subarray(0, tab).toString('utf8');
    const originalPath = chunk.subarray(tab + 1).toString('utf8');
    const path = subdir ? originalPath.slice(subdir.length+1) : originalPath;
    const parts = meta.split(' ');
    if (parts.length !== 3 || parts[1] !== 'blob' || !['100644','100755'].includes(parts[0])) {
      // 本隔离样例只含普通文件；子模块/符号链接不静默当空文件处理
      throw new SourceError('SOURCE_TREE_UNPARSABLE', `非普通 blob 条目：${meta} ${path}`);
    }
    const [mode, , blobOid] = parts;
    const content = Buffer.from(gitRead(repoDir, ['cat-file', 'blob', blobOid], { binary: true }));
    files.push({ path, mode, blobOid, bytes: content.length, sha256: sha256(content) });
    contents.set(path, content);
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const treeHash = sha256(Buffer.from(
    files.map((f) => `${f.path}\0${f.sha256}\n`).join(''), 'utf8'));
  return { repoDir, pinnedCommit, head, subject, subdir, files, contents, treeHash };
}

/** The download adapter supplies real upstream identity; no synthetic Git repository. */
export function collectFromArchive({repoDir, commit, subdir='', sourceEntry}) {
  subdir=normalizeSubdir(subdir);
  if (!sourceEntry || sourceEntry.downloadMethod!=='codeload-tar' || sourceEntry.head!==commit || sourceEntry.repoDir!==repoDir)
    throw new SourceError('SOURCE_ARCHIVE_INVALID','缺少固定上游归档身份');
  const base=join(repoDir,subdir);
  if (!existsSync(base) || !lstatSync(base).isDirectory()) throw new SourceError('SOURCE_SUBDIR_NOT_FOUND',`归档提交 ${commit} 中没有子目录 ${subdir}`);
  const files=[], contents=new Map();
  const visit=(dir,prefix='')=>{ for(const name of readdirSync(dir)) {
    const full=join(dir,name), path=prefix+name, stat=lstatSync(full);
    if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile())) throw new SourceError('SOURCE_ARCHIVE_INVALID',`归档不支持链接/特殊文件：${path}`);
    if(stat.isDirectory()) visit(full,path+'/');
    else {const bytes=readFileSync(full);contents.set(path,bytes);files.push({path,mode:'100644',bytes:bytes.length,sha256:sha256(bytes)});}
  }};visit(base);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const treeHash=sha256(Buffer.from(files.map(f=>`${f.path}\0${f.sha256}\n`).join(''),'utf8'));
  return {repoDir,pinnedCommit:commit,head:commit,subject:null,subdir,files,contents,treeHash};
}
export function collectSource(options) {
  return options.sourceEntry?.downloadMethod==='codeload-tar' ? collectFromArchive(options) : collectFromGit(options);
}

/** 严格读取声明字段：字段存在但类型不对 → 报错，绝不静默当空。 */
function readDependencyDeclarations(pkg) {
  const out = {};
  const flat = [];
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!Object.hasOwn(pkg, key)) {
      out[key] = { status: 'absent', entries: [] };
      continue;
    }
    const value = pkg[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SourceError('SOURCE_PACKAGE_JSON_INVALID', `package.json.${key} 不是对象`);
    }
    const entries = Object.entries(value).map(([name, range]) => {
      if (typeof range !== 'string') {
        throw new SourceError('SOURCE_PACKAGE_JSON_INVALID',
          `package.json.${key}.${name} 不是字符串`);
      }
      flat.push(`${key}:${name}@${range}`);
      return { name, range };
    }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    out[key] = { status: 'ok', entries };
  }
  return { declarations: out, flat };
}

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'];

function readScripts(pkg) {
  const scripts = Object.hasOwn(pkg, 'scripts') ? pkg.scripts : null;
  if (scripts === null || scripts === undefined) return { status: 'absent', all: [], installScripts: [] };
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    throw new SourceError('SOURCE_PACKAGE_JSON_INVALID', 'package.json.scripts 不是对象');
  }
  const all = [];
  const installScripts = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') {
      throw new SourceError('SOURCE_PACKAGE_JSON_INVALID', `package.json.scripts.${name} 不是字符串`);
    }
    all.push({ name, command });
    if (INSTALL_SCRIPT_KEYS.includes(name)) installScripts.push(name);
  }
  return { status: 'ok', all: all.sort((a, b) => a.name.localeCompare(b.name, 'en')), installScripts };
}

/**
 * 执行一次入饭。成功才写 来源.json；失败只写 采集失败.json（不含 pinnedCommit）。
 *
 * @returns {{status:'created'|'already-present', riceDir, sourcePath, contentListPath,
 *            sourceDoc, contentDoc, warehouseDir}}
 */
export function ingest({ riceRoot, repoDir, repoName, commit, requestId, packageName, subdir='', sourceEntry=null, collected: suppliedCollection=null }) {
  let riceDir = join(riceRoot, repoName);
  // Never materialize a committed snapshot over the downloaded/user working tree.
  if ((!subdir && sourceEntry) || resolve(join(riceDir,'仓库'))===resolve(repoDir)) riceDir=join(riceDir,'versions',commit);
  const previousPath=join(riceDir,'来源.json');
  if(existsSync(previousPath)&&readJson(previousPath).pinnedCommit!==commit) riceDir=join(riceDir,'versions',commit);
  const sourcePath = join(riceDir, '来源.json');
  const contentListPath = join(riceDir, '内容清单.json');
  const changeLogPath = join(riceDir, '更新记录.md');
  const failurePath = join(riceDir, '采集失败.json');
  const warehouseDir = join(riceDir, '仓库');

  const writeFailure = (error) => {
    mkdirSync(riceDir, { recursive: true });
    const doc = {
      schema: 'rice-failure/v1',
      requestId,
      packageName,
      sourceStatus: 'failed',
      // 失败不写 pinnedCommit：只记录原始请求值，且不作为已固定提交登记
      pinnedCommit: null,
      pinnedCommitWritten: false,
      requestedCommit: typeof commit === 'string' ? commit : null,
      failedAt: new Date().toISOString(),
      code: error.code ?? 'SOURCE_UNKNOWN',
      message: error.message,
    };
    atomicJson(failurePath, doc);
    error.failurePath = failurePath;
  };

  let collected;
  let pkg;
  let deps;
  let scripts;
  try {
    collected = suppliedCollection ?? collectSource({ repoDir, commit, subdir, sourceEntry });

    const pkgBuf = collected.contents.get('package.json');
    if (!pkgBuf) throw new SourceError('SOURCE_PACKAGE_JSON_MISSING', `所选目录 ${subdir || '仓库根'} 在提交 ${commit} 中没有 package.json；请提供正确 tree 链接或 subdir`);
    try {
      pkg = JSON.parse(pkgBuf.toString('utf8'));
    } catch (error) {
      throw new SourceError('SOURCE_PACKAGE_JSON_INVALID', `package.json 无法解析：${error.message}`);
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      throw new SourceError('SOURCE_PACKAGE_JSON_INVALID', 'package.json 顶层不是对象');
    }
    deps = readDependencyDeclarations(pkg);
    scripts = readScripts(pkg);

    // 幂等：已有记录一律不覆盖
    if (existsSync(sourcePath)) {
      const existing = readJson(sourcePath);
      if (existing.pinnedCommit !== collected.pinnedCommit) {
        throw new SourceError('SOURCE_COMMIT_MISMATCH',
          `饭目录已固定到 ${existing.pinnedCommit}，不能覆盖为 ${collected.pinnedCommit}`);
      }
      if (existing.contentHash !== collected.treeHash) {
        throw new SourceError('SOURCE_CONTENT_DRIFT',
          '同一提交的内容清单与已有记录不一致，拒绝覆盖');
      }
      return {
        status: 'already-present', riceDir, sourcePath, contentListPath, warehouseDir,
        sourceDoc: existing, contentDoc: readJson(contentListPath),
      };
    }
  } catch (error) {
    const err = error instanceof SourceError ? error
      : new SourceError('SOURCE_UNKNOWN', String(error.message ?? error));
    writeFailure(err);
    throw err;
  }

  const collectedAt = new Date().toISOString();
  const upstreamUrl = sourceEntry?.cloneUrl ?? pathToFileURL(repoDir).href;

  const contentDoc = {
    schema: 'rice-content/v1',
    subdir,
    downloadMethod: sourceEntry?.downloadMethod ?? 'git',
    requestId,
    pinnedCommit: collected.pinnedCommit,
    treeHash: collected.treeHash,
    fileCount: collected.files.length,
    files: collected.files,
  };

  const sourceDoc = {
    schema: 'rice-source/v1',
    requestId,
    packageName,
    upstreamUrl,
    sourceKind: 'git',
    subdir,
    ref: sourceEntry?.ref ?? null,
    downloadMethod: sourceEntry?.downloadMethod ?? 'git',
    sourceStatus: 'collected',
    pinnedCommit: collected.pinnedCommit,
    pinnedTag: null,
    license: typeof pkg.license === 'string' ? pkg.license : null,
    packageNameFromManifest: typeof pkg.name === 'string' ? pkg.name : null,
    versionFromManifest: typeof pkg.version === 'string' ? pkg.version : null,
    upstreamHead: collected.head,
    commitSubject: collected.subject,
    collectedAt,
    collectionMethod: sourceEntry?.downloadMethod==='codeload-tar' ? 'fixed upstream commit codeload archive; static file collection' : 'git rev-parse / ls-tree -r -z / cat-file blob / log -1（只读 Git 对象）',
    notExecuted: ['clone', 'checkout', 'npm', 'pnpm', 'build', 'install scripts', 'import of candidate files'],
    contentHash: collected.treeHash,
    fileCount: collected.files.length,
    packageJson: pkg,
    dependencyDeclarations: deps.declarations,
    flatDependencies: deps.flat,
    scripts,
    installScripts: scripts.installScripts,
    contentFiles: collected.files.map((f) => f.path),
  };

  try {
    // 先落完整原文，再最后写 来源.json（成功标记）
    mkdirSync(warehouseDir, { recursive: true });
    for (const [path, buffer] of collected.contents) {
      const full = join(warehouseDir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, buffer);
    }
    atomicJson(contentListPath, contentDoc);
    const line = `- ${collectedAt} | ${requestId} | ${collected.pinnedCommit.slice(0, 10)} | 入饭：固定提交采集，${collected.files.length} 文件，treeHash=${collected.treeHash}\n`;
    const header = '# 更新记录（隔离 W2）\n\n';
    const previous = existsSync(changeLogPath) ? readFileSync(changeLogPath, 'utf8') : header;
    writeFileSync(changeLogPath, previous + line, 'utf8');
    atomicJson(sourcePath, sourceDoc);
    // 成功后清除此前的失败标记（只在本次成功创建时）
    if (existsSync(failurePath)) rmSync(failurePath, { force: true });
  } catch (error) {
    const err = new SourceError('SOURCE_WRITE_FAILED', `写入饭目录失败：${error.message}`);
    writeFailure(err);
    throw err;
  }

  return {
    status: 'created', riceDir, sourcePath, contentListPath, warehouseDir,
    sourceDoc, contentDoc,
  };
}
