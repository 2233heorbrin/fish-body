// Display names group records; only IDs and the existing validity boundary identify them.
import fs from 'node:fs';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordFile = kind => kind === 'analysis' ? 'record.json' : 'task.json';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const label = value => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') return label(value['zh-CN']) || label(value.zh) || label(value.en);
  return null;
};
export function sourcePlugin(source, originalSource = source) {
  let pkg = {};
  try { pkg = read(path.join(source, 'package.json')); } catch { /* naming never substitutes for source validation */ }
  const name = label(pkg.name) || path.basename(originalSource);
  return { name, version: label(pkg.version), displayName: label(pkg.displayName) || label(pkg.dsh?.displayName) || label(pkg.dsh?.bundle?.displayName) || name };
}
export function directoryLabel(name) {
  return Array.from(String(name || '未命名插件').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '')).slice(0, 80).join('') || '未命名插件';
}
export function newRecordDirectory(root, kind, id, plugin) {
  if (!uuid.test(id)) throw Error('FH_ANALYSIS_ID_INVALID: backend UUID required');
  return path.join(root, directoryLabel(plugin.displayName || plugin.name) + (kind === 'analysis' ? '-分析结果' : '-拆分任务'), id);
}
function directories(root) {
  return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()) : [];
}
export function recordEntries(root, kind) {
  const rows = [];
  for (const outer of directories(root)) {
    const group = path.join(root, outer.name);
    const entries = uuid.test(outer.name) ? [{ name: outer.name, dir: group }] : directories(group).filter(e => uuid.test(e.name)).map(e => ({ name: e.name, dir: path.join(group, e.name) }));
    for (const e of entries) if (fs.existsSync(path.join(e.dir, recordFile(kind)))) rows.push({ id: e.name, dir: e.dir });
  }
  return rows;
}
export function findRecordDirectory(root, kind, id) {
  if (!uuid.test(id)) throw Error('FH_ANALYSIS_ID_INVALID: use a backend-issued analysisId, not a path');
  const matches = recordEntries(root, kind).filter(e => e.id === id);
  if (matches.length > 1) throw Error('FH_RECORD_AMBIGUOUS: 同一编号存在多个结果目录，请核对材料，不能自动任选。');
  if (!matches.length) throw Object.assign(new Error('ENOENT: 未找到该结果，请刷新列表后选择。'), { code: 'ENOENT' });
  return matches[0].dir;
}
export function recordPlugin(record, dir, kind, analysisRoot) {
  if (record.plugin?.displayName) return record.plugin;
  let snapshot = path.join(dir, 'run/source-snapshot');
  if (kind === 'task') {
    try { snapshot = path.join(findRecordDirectory(analysisRoot, 'analysis', record.analysisId), 'run/source-snapshot'); }
    catch { return { ...record.plugin, displayName: record.plugin?.name || '未命名插件' }; }
  }
  return fs.existsSync(snapshot) ? sourcePlugin(snapshot, record.source?.path || snapshot) : { ...record.plugin, displayName: record.plugin?.name || '未命名插件' };
}
export function recordMetadata(record, dir, kind, analysisRoot) {
  return { plugin: recordPlugin(record, dir, kind, analysisRoot), createdAt: record.createdAt || fs.statSync(dir).birthtime.toISOString(),
    updatedAt: record.updatedAt || record.finishedAt || record.createdAt || fs.statSync(dir).mtime.toISOString() };
}
