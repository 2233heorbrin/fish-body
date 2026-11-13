/**
 * W6-A 共享工具（隔离实现）。
 *
 * 明确区分三种互不混用的完整性口径：
 *   ① sourceTreeHash        —— 源码树哈希：W2/W3/W5 的 treeHashOf（sha256 hex，逐文件）
 *   ② packageIntegrity     —— 安装包 integrity：tarball 的 SRI `sha512-<base64>`
 *   ③ deployedContentHash  —— 部署后内容校验：node_modules/<pkg> 目录树哈希（sha256 hex）
 * 另外 dependencySubtreeSha256 是「实际依赖子树」的稳定对象哈希，用于完整准入 Step3。
 * 四者算法、输入、用途都不同，任一都不能替代另一。
 */

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync,
  statSync, copyFileSync, rmSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const NL = String.fromCharCode(10);

export const sha256Buffer = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');
export const sha256Text = (text) => sha256Buffer(Buffer.from(text, 'utf8'));
export const sha256File = (path) => sha256Buffer(readFileSync(path));

/** npm/pnpm 的 dist.integrity 口径：sha512 + base64（SRI）。 */
export function sri512(buf) {
  return 'sha512-' + createHash('sha512').update(buf).digest('base64');
}

/** 稳定序列化（键名排序），用于对象指纹。 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
export const hashOf = (value) => sha256Text(stableStringify(value));

/** 与 upstream.mjs / w4w5-utils.mjs 的 treeHashOf 完全同一算法。 */
export function treeHashOf(files) {
  return sha256Text(files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));
}

/** 递归列出目录内所有文件（相对 / 路径），按路径排序。 */
export function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return out.sort();
}

/** 目录内容清单：{path, bytes, sha256}[]，路径统一用 / 分隔。 */
export function treeManifest(root) {
  if (!existsSync(root)) return [];
  return walkFiles(root).map((full) => {
    const rel = relative(root, full).split(sep).join('/');
    return { path: rel, bytes: statSync(full).size, sha256: sha256File(full) };
  });
}

/** 目录树哈希（与 snapshot.mjs 的 treeHash 同口径）。 */
export function deployedTreeHash(root) {
  if (!existsSync(root)) return null;
  const rows = walkFiles(root).map((full) => {
    const rel = relative(root, full).split(sep).join('/');
    return `${rel}\0${sha256File(full)}`;
  });
  return sha256Text(rows.join(NL));
}

/**
 * 递归复制目录。不用 fs.cpSync：本机 Node 22.22.2 + Windows 下会让进程静默退出
 * （exit 127），已复现；copyFileSync 正常。
 */
export function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copyTree(join(src, entry.name), join(dest, entry.name));
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

export function removeTree(path) {
  rmSync(path, { recursive: true, force: true });
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + NL, 'utf8');
  renameSync(tmp, path);
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const exists = (path) => existsSync(path);

export function fileHashOrNull(path) {
  return existsSync(path) ? sha256File(path) : null;
}
