/** Shared body section identities; parse the bundled entry without executing it. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FISH_BODY_INDEX_PATH = new URL('../../../index.js', import.meta.url);
export const REQUIRED_SECTION_IDS = Object.freeze(['rice', 'stomach', 'hand']);

/** 从 fish-body/index.js 源码里读出 SECTIONS 的键。读不到就报错，不静默回退到硬编码。 */
export function loadSectionIds(indexPath = FISH_BODY_INDEX_PATH) {
  const text = readFileSync(indexPath, 'utf8');
  const start = text.indexOf('const SECTIONS = {');
  if (start < 0) {
    throw new Error('SECTIONS_SOURCE_UNREADABLE：fish-body/index.js 中找不到 SECTIONS 定义');
  }
  const end = text.indexOf('\n}', start);
  if (end < 0) {
    throw new Error('SECTIONS_SOURCE_UNREADABLE：SECTIONS 块无法定位结束位置');
  }
  const block = text.slice(start, end);
  const ids = [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_-]*):\s*\{/gm)].map((m) => m[1]);
  for (const required of REQUIRED_SECTION_IDS) {
    if (!ids.includes(required)) {
      throw new Error(`SECTIONS_SOURCE_INCOMPLETE：缺少分区 ${required}，实际 ${ids.join(', ') || '空'}`);
    }
  }
  return ids;
}

/**
 * 隔离目录布局。
 * root/rice     ← W2 入饭（上游原文 + 来源.json + 内容清单.json + 更新记录.md）
 * root/stomach  ← W3 胃材料（review.json）
 * root/hand     ← 本轮**不创建**（W5/W6 才写），用于验证「留胃、不安装」
 * root/requests ← RequestStore 的请求状态记录（唯一运行态真源）
 */
export function layoutFor(root, sectionIds) {
  const dirs = { requests: join(root, 'requests') };
  for (const id of sectionIds) dirs[id] = join(root, id);
  return dirs;
}
