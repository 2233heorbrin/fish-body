/**
 * W4/W5 隔离实现的共享工具（无业务逻辑、无 IO 副作用之外的动作）。
 *
 * 单独成文件是为了避免模块循环依赖：
 *   conclusion / decision / artifact / pipeline 都只依赖本模块。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** 所有隔离产物都带 -isolation-test-only 后缀，防止被误当成生产数据。 */
export const SCHEMAS = Object.freeze({
  DECISION: 'hand-decision/v1-isolation-test-only',
  DECISION_INDEX: 'hand-decision-index/v1-isolation-test-only',
  CONCLUSION: 'stomach-review-conclusion/v1-isolation-test-only',
  ARTIFACT_MANIFEST: 'hand-artifact-manifest/v1-isolation-test-only',
  ARTIFACT_CONTENT: 'hand-artifact-content/v1-isolation-test-only',
  ARTIFACT_INDEX: 'hand-artifact-index/v1-isolation-test-only',
  ARTIFACT_FAILURE: 'hand-artifact-failure/v1-isolation-test-only',
  EVIDENCE: 'w4w5-run-record/v1',
});

export class ProbeError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
    this.detail = detail;
  }
}

export const sha256Buffer = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');
export const sha256Text = (text) => sha256Buffer(Buffer.from(text, 'utf8'));
export const sha256File = (path) => sha256Buffer(readFileSync(path));

/** 键名排序的稳定序列化，用于「决定绑定对象」的指纹，不受对象键顺序影响。 */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export const hashOf = (value) => sha256Text(stableStringify(value));

/** 与 upstream.mjs 的 treeHash 完全同一算法，使产物哈希可与上游哈希直接比对。 */
export function treeHashOf(files) {
  return sha256Text(files.map((f) => `${f.path}\0${f.sha256}\n`).join(''));
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const exists = (path) => existsSync(path);
