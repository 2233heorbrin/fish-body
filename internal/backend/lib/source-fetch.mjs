/** GitHub download at a fixed upstream commit; collection remains in upstream.mjs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export class SourceFetchError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new SourceFetchError(code, message); };
export function normalizeSubdir(value = '') {
  if (typeof value !== 'string' || /[\\\x00-\x1f:*?"<>|]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value))
    fail('FH_BAD_SUBDIR', 'subdir 必须为仓库内相对路径');
  const parts = value.replace(/\/+$/, '').split('/');
  if (value && parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
    fail('FH_BAD_SUBDIR', 'subdir 不允许空段、.、.. 或 .git');
  return parts.join('/');
}
const validRef = value => {
  if (!value || value.startsWith('-') || /[\x00-\x20~^:?*\[\\]/.test(value) || value.includes('..') || value.includes('@{'))
    fail('FH_BAD_REF', 'ref 无效；请提供明确分支、标签或固定提交');
  return value;
};
export function parseGithubUrl(raw, {ref = null, subdir = null} = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { fail('FH_BAD_SOURCE', '不是有效 GitHub 链接'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search)
    fail('FH_BAD_SOURCE', '仅接受无认证信息的 GitHub 仓库或 tree 链接');
  let parts;
  try { parts = url.pathname.replace(/\/+$/, '').slice(1).split('/').map(decodeURIComponent); }
  catch { fail('FH_BAD_SOURCE', '链接路径编码无效'); }
  const [owner, rawRepo] = parts, repo = rawRepo?.replace(/\.git$/i, '');
  if (![owner, repo].every(v => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v ?? '')))
    fail('FH_BAD_SOURCE', '链接缺少有效 owner/repo');
  if (parts.length > 2 && (parts[2] !== 'tree' || parts.length < 4))
    fail('FH_BAD_SOURCE', '请使用仓库根链接或 /tree/<ref>/<subdir> 链接');
  const treePath = parts.length > 2 ? parts.slice(3).join('/') : null;
  const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : null;
  if (fragment && !/^[0-9a-f]{7,40}$/i.test(fragment)) fail('FH_BAD_REF', '链接 # 后只接受固定提交');
  if (ref != null) validRef(ref);
  if (fragment && ref && fragment !== ref) fail('FH_SOURCE_CONFLICT', `链接提交 ${fragment} 与 ref ${ref} 冲突`);
  ref ??= fragment;
  if (subdir != null) subdir = normalizeSubdir(subdir);
  if (treePath && ref) {
    if (treePath !== ref && !treePath.startsWith(ref + '/')) fail('FH_SOURCE_CONFLICT', `tree 链接与 ref ${ref} 冲突`);
    const linked = normalizeSubdir(treePath.slice(ref.length).replace(/^\//, ''));
    if (subdir != null && subdir !== linked) fail('FH_SOURCE_CONFLICT', `链接子目录 ${linked} 与 subdir ${subdir} 冲突`);
    subdir = linked;
  }
  if (treePath && !ref && subdir != null) {
    const suffix = subdir ? '/' + subdir : '';
    if (suffix && !treePath.endsWith(suffix)) fail('FH_SOURCE_CONFLICT', `tree 链接与 subdir ${subdir} 冲突`);
    ref = validRef(suffix ? treePath.slice(0, -suffix.length) : treePath);
  }
  return {owner, repo, ref, subdir, treePath, cloneUrl:`https://github.com/${owner}/${repo}.git`, webUrl:`https://github.com/${owner}/${repo}`};
}
export const sourceMaterialName = (repo, subdir) => subdir ? `${repo}/subpackages/${encodeURIComponent(normalizeSubdir(subdir))}` : repo;
export function safeSourceError(error) {
  return String(error?.stderr ?? error?.message ?? error).replace(/https?:\/\/[^\s'"<>]+/g, value => {
    try { const u = new URL(value); u.username=''; u.password=''; u.search=''; return u.href; } catch { return '[url]'; }
  }).replace(/(authorization|token|password|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 1200);
}
function git(args, {direct = false} = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const config = direct ? ['-c','http.proxy=','-c','https.proxy='] : proxy ? ['-c',`http.proxy=${proxy}`,'-c',`https.proxy=${proxy}`] : [];
  const env = {...process.env, GIT_TERMINAL_PROMPT:'0'};
  if (direct) for (const key of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
  return execFileSync('git', [...config, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:60000,env}).trim();
}
function publicGet(url) {
  // No credentials, config files or candidate code are read by this public transport.
  return execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',
    ['--disable','--fail','--location','--silent','--show-error','--max-time','60','--header','User-Agent: fish-body-source',url],
    {stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:65000,maxBuffer:128*1024*1024});
}
function proxyFailure(error) {
  return /(?:proxy|via\s+(?:127\.|localhost)|connect[^\n]*(?:127\.0\.0\.1|localhost))[^\n]*(?:failed|refused|could not|connect)|(?:failed|could not)[^\n]*(?:proxy|via\s+(?:127\.|localhost))/i.test(safeSourceError(error));
}
function apiCommit(parsed, ref, get) {
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(ref)}`;
  try {
    const data = JSON.parse(get(url).toString('utf8'));
    if (!/^[0-9a-f]{40}$/i.test(data.sha ?? '')) throw new Error('GitHub 未返回真实完整提交');
    return data.sha.toLowerCase();
  } catch (error) { fail('FH_REF_UNAVAILABLE', `无法获取引用 ${ref}：${safeSourceError(error)}；请核对仓库与 ref`); }
}
/** Resolve slash-containing refs from actual upstream refs; never truncate at first slash. */
function resolveTree(parsed, runGit, get) {
  if (!parsed.treePath || parsed.ref) return {...parsed, subdir:parsed.subdir ?? ''};
  const first=parsed.treePath.split('/')[0];
  if (/^[0-9a-f]{40}$/i.test(first)) return {...parsed,ref:first,subdir:normalizeSubdir(parsed.treePath.slice(first.length).replace(/^\//,''))};
  let refs;
  try {
    refs = runGit(['ls-remote','--heads','--tags',parsed.cloneUrl]).split(/\r?\n/)
      .map(line => line.split(/\s+/)[1]?.replace(/^refs\/(heads|tags)\//, '')).filter(r => r && !r.endsWith('^{}'));
  } catch (gitError) {
    try {
      refs = ['heads','tags'].flatMap(type => JSON.parse(get(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/matching-refs/${type}/${encodeURIComponent(parsed.treePath.split('/')[0])}`).toString('utf8'))
        .map(row => row.ref.replace(/^refs\/(heads|tags)\//,'')));
    } catch (error) { fail('FH_REF_UNAVAILABLE', `Git 引用查询失败：${safeSourceError(gitError)}；无法确定 tree 链接引用：${safeSourceError(error)}；请显式提供 ref 和 subdir`); }
  }
  if (/^[0-9a-f]{7,40}$/i.test(parsed.treePath.split('/')[0])) refs.push(parsed.treePath.split('/')[0]);
  const matches = [...new Set(refs)].filter(r => parsed.treePath === r || parsed.treePath.startsWith(r+'/'));
  if (matches.length !== 1) fail('FH_REF_AMBIGUOUS', `tree 引用无法唯一确定（${matches.join(', ') || '未找到'}）；请显式提供 ref 和 subdir`);
  const ref = matches[0], subdir = normalizeSubdir(parsed.treePath.slice(ref.length).replace(/^\//,''));
  if (parsed.subdir != null && parsed.subdir !== subdir) fail('FH_SOURCE_CONFLICT', '链接与显式 subdir 冲突');
  return {...parsed, ref, subdir};
}
/** Existing trees stay untouched. A failed fetch never falls back to their old HEAD. */
export function fetchSourceToRice({frameworkRoot, url, revision=null, ref=null, subdir=null, transport={}}) {
  const runGit = transport.git ?? git, get = transport.get ?? publicGet;
  let parsed = parseGithubUrl(url,{ref,subdir});
  if (revision && !/^[0-9a-f]{7,40}$/i.test(revision)) fail('FH_BAD_REF','revision 必须是固定提交');
  if (revision && parsed.ref && /^[0-9a-f]{7,40}$/i.test(parsed.ref) && !revision.startsWith(parsed.ref) && !parsed.ref.startsWith(revision))
    fail('FH_SOURCE_CONFLICT', '固定 revision 与链接提交冲突');
  const attempts=[];
  const run = args => {try{return runGit(args);}catch(error){
    attempts.push({stage:'git',code:proxyFailure(error)?'FH_PROXY_CONNECTION_FAILED':'FH_GIT_FAILED',message:safeSourceError(error)});
    if (!proxyFailure(error)) throw error;
    try{return runGit(args,{direct:true});}catch(directError){attempts.push({stage:'git-direct',code:'FH_GIT_FAILED',message:safeSourceError(directError)});throw directError;}
  }};
  parsed=resolveTree(parsed,run,get);
  const entryDir=join(frameworkRoot,'饭','github.com',parsed.owner,parsed.repo), repoDir=join(entryDir,'仓库');
  const rel=relative(resolve(frameworkRoot,'饭/github.com'),resolve(repoDir));
  if (!rel || isAbsolute(rel) || rel==='..' || rel.startsWith('..'+sep)) fail('FH_BAD_SOURCE','下载目录越界');
  mkdirSync(entryDir,{recursive:true});
  const selected=revision ?? parsed.ref ?? 'HEAD', fixed=/^[0-9a-f]{7,40}$/i.test(selected);
  let head, localRepo=repoDir, reused=existsSync(join(repoDir,'.git'));
  try {
    if (!reused) {
      if (existsSync(repoDir)) throw new Error('仓库目录已存在但不是完整 Git 仓库；保留该目录，改试固定提交归档');
      const staging=join(mkdtempSync(join(entryDir,'.git-download-')),'仓库');
      run(['clone','--quiet','--depth','1',...(parsed.ref&&!fixed?['--branch',parsed.ref]:[]),parsed.cloneUrl,staging]);
      localRepo=staging;
    }
    if (fixed) {
      try { head=runGit(['-C',localRepo,'rev-parse','--verify',`${selected}^{commit}`]); }
      catch {run(['-C',localRepo,'fetch','--quiet','--depth','1','origin',selected]); head=runGit(['-C',localRepo,'rev-parse','FETCH_HEAD^{commit}']);}
      if (!head.toLowerCase().startsWith(selected.toLowerCase())) throw new Error('获取提交不匹配');
    } else {
      run(['-C',localRepo,'fetch','--quiet','--depth','1','origin',selected]);
      head=runGit(['-C',localRepo,'rev-parse','FETCH_HEAD^{commit}']);
    }
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('Git 返回无效提交');
    if (!reused) renameSync(localRepo,repoDir);
    return {...parsed,entryDir,repoDir,head:head.toLowerCase(),branch:parsed.ref,downloadMethod:'git',attempts,
      riceParent:join(frameworkRoot,'饭/github.com',parsed.owner),reused};
  } catch (error) {
    if (!attempts.length) attempts.push({stage:'git',code:'FH_GIT_FAILED',message:safeSourceError(error)});
  }
  // Resolve first, then use only the immutable commit for download and records.
  try {
    head=/^[0-9a-f]{40}$/i.test(selected) ? selected.toLowerCase() : apiCommit(parsed,selected,get);
    if (fixed && !head.startsWith(selected.toLowerCase())) fail('FH_REF_UNAVAILABLE','API 返回提交与指定提交不匹配');
    const archiveParent=join(entryDir,'archives'), complete=join(archiveParent,head), marker=join(complete,'download.json');
    if (existsSync(marker)) {
      const prior=JSON.parse(readFileSync(marker,'utf8'));
      if (prior.commit!==head || prior.upstreamUrl!==parsed.cloneUrl || !existsSync(join(complete,'仓库'))) throw new Error('已有归档完成记录不匹配');
    } else {
      mkdirSync(archiveParent,{recursive:true});
      const staging=mkdtempSync(join(archiveParent,'.partial-')),tgz=join(staging,'source.tgz');
      writeFileSync(tgz,get(`https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${head}`));
      const list=execFileSync('tar',['-tzf',tgz],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
      const prefix=list[0]?.split('/')[0];
      if (!prefix || list.some(p=>!p.startsWith(prefix+'/') || /[\\\x00-\x1f]/.test(p) || p.split('/').some(s=>s==='..'||s==='.git')))
        throw new Error('归档路径无效或越界');
      const verbose=execFileSync('tar',['-tvzf',tgz],{encoding:'utf8',windowsHide:true});
      if (verbose.split(/\r?\n/).some(line=>line && !/^[d-]/.test(line))) throw new Error('归档含不支持的链接或特殊文件');
      const extract=join(staging,'unpack');mkdirSync(extract);
      execFileSync('tar',['-xzf',tgz,'-C',extract],{windowsHide:true});
      renameSync(join(extract,prefix),join(staging,'仓库'));
      writeFileSync(join(staging,'download.json'),JSON.stringify({commit:head,upstreamUrl:parsed.cloneUrl,downloadMethod:'codeload-tar'})+'\n');
      renameSync(staging,complete);
    }
    return {...parsed,entryDir,repoDir:join(complete,'仓库'),head,branch:parsed.ref,downloadMethod:'codeload-tar',attempts,
      riceParent:join(frameworkRoot,'饭/github.com',parsed.owner),reused:false};
  } catch(error) {
    const code=error.code==='FH_REF_UNAVAILABLE'?'FH_REF_UNAVAILABLE':'FH_DOWNLOAD_FAILED';
    fail(code,`${attempts.map(a=>`${a.code}: ${a.message}`).join('；')}；归档回退失败：${safeSourceError(error)}；请核对仓库/ref 或稍后重试`);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 补齐饭侧既有记录：
 *   ① 来源.json —— 保留 ingest 写的采集字段（pinnedCommit / contentHash / upstreamUrl），
 *      同时补上饭规范字段（sourcePlatform / owner / repository / localRepositoryPath / sourceStatus）；
 *   ② 更新记录.md —— 追加本次固定提交；
 *   ③ 项目索引.json —— 更新/追加该仓库一条（存在才更新，不新建索引文件）。
 */
export function recordRiceSource({ frameworkRoot, entry, riceDir, packageName = null, license = null }) {
  const sourcePath = join(riceDir, '来源.json');
  const existing = readJson(sourcePath) ?? {};
  const merged = {
    ...existing,
    schemaVersion: '1.0',
    schema: existing.schema ?? 'rice-source/v1',
    sourceType: 'git',
    subdir: entry.subdir ?? '',
    ref: entry.ref ?? null,
    downloadMethod: entry.downloadMethod ?? 'git',
    sourcePlatform: 'github.com',
    owner: entry.owner,
    repository: entry.repo,
    upstreamUrl: entry.cloneUrl,
    defaultBranch: entry.branch,
    pinnedCommit: existing.pinnedCommit ?? entry.head,
    observedHead: entry.head,
    license: license ?? existing.license ?? null,
    localRepositoryPath: entry.repoDir,
    downloadedAt: existing.downloadedAt ?? today(),
    sourceStatus: existing.sourceStatus === 'collected' ? 'collected' : 'downloaded-pinned',
  };
  if (packageName && !merged.packageName) merged.packageName = packageName;
  writeJson(sourcePath, merged);

  const changeLogPath = join(riceDir, '更新记录.md');
  const line = `- ${today()} · 固定提交 \`${String(merged.pinnedCommit).slice(0, 12)}\` · ${entry.webUrl}\n`;
  if (existsSync(changeLogPath)) {
    const text = readFileSync(changeLogPath, 'utf8');
    if (!text.includes(String(merged.pinnedCommit))) {
      writeFileSync(changeLogPath, `${text.replace(/\s*$/, '')}\n${line}`, 'utf8');
    }
  } else {
    writeFileSync(changeLogPath,
      `# 更新记录\n\n当前固定版本：\`${merged.pinnedCommit}\`\n\n${line}`, 'utf8');
  }

  const indexPath = join(frameworkRoot, '饭', '项目索引.json');
  const index = readJson(indexPath);
  if (index && Array.isArray(index.projects)) {
    const id = `github.com/${entry.owner}/${entry.repo}${entry.subdir ? '#'+entry.subdir : ''}`;
    const row = {
      id, sourceType: 'git',
    subdir: entry.subdir ?? '',
    ref: entry.ref ?? null,
    downloadMethod: entry.downloadMethod ?? 'git', repositoryPath: entry.repoDir,
      pinnedCommit: merged.pinnedCommit, migrationStatus: 'downloaded-pinned',
    };
    const at = index.projects.findIndex((p) => p?.id === id);
    if (at >= 0) index.projects[at] = { ...index.projects[at], ...row };
    else index.projects.push(row);
    writeJson(indexPath, index);
  }

  return { sourcePath, changeLogPath, indexPath, source: merged };
}
