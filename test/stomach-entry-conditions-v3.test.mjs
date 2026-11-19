// 续次3 · Agent C 独立验收（v3）：Codex 三项新反例 + 一条防"修过头"正向用例。
// 只读分析：内存构造语法样例调用 extractEntryConditions；不执行样例代码、不启动分析入口、
// 不联网、不改生产与消费代码、不读真实插件。本文件是 test/ 下的新文件。
// 当前为"修复前"基准：三项反例预期失败，正向用例预期通过。失败必须是断言失败，
// 不允许出现导入错误/语法错误（那属于测试自身无效，不算缺陷复现）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractEntryConditions } from '../internal/analysis/morph-scan.mjs';
import { makeModel, callable, nodeKey } from '../internal/analysis/morph-model.mjs';
import { ownershipIndex, ownershipOf } from '../internal/analysis/unified.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { Project } = await import(pathToFileURL(path.join(repo, 'node_modules/ts-morph/dist/ts-morph.js')).href);

// 复用复核反例脚本的 scan 写法：内存文件系统 + callables + F1/F2 编号。
function scan(code) {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true, compilerOptions: { allowJs: true, noEmit: true } });
  const source = project.createSourceFile('/sample/probe.js', code);
  const model = makeModel(project);
  const functions = source.getDescendants().filter(callable);
  const ids = new Map(functions.map((fn, i) => [nodeKey(fn), 'F' + (i + 1)]));
  return extractEntryConditions(model, functions, fn => ids.get(nodeKey(fn)), {});
}
const first = code => scan(code)[0];
const show = value => JSON.stringify(value);

// ── 反例 1：无条件 return 之后的调用不能支撑动作候选，但调用语法事实仍须保留 ──
test('unconditional-return-before-call：return 后 sink() 不得产生 candidate/acceptsAction，但调用事实须可见', () => {
  const row = first("function f(a){if(a === 'publish'){return 'denied';sink();}}");
  assert.ok(row, '未构造出 entry-condition 行');
  const entry = row.entry ?? {};

  // 主断言：动作候选被拒绝。
  assert.equal(entry.acceptsAction ?? null, null,
    `无条件的 return 截断后，acceptsAction 必须为 null，实际=${show(entry.acceptsAction)}`);
  const candidates = entry.actionCandidates ?? [];
  assert.ok(!candidates.some(c => c.status === 'candidate'),
    `不可达分支不得留下 status==='candidate' 的候选，实际=${show(candidates)}`);

  // 防"修过头"：sink() 作为调用/副作用语法事实仍须能从真实结构字段读到。
  // 只查 callee/expression 字段，不对整行做字符串命中（否则 snippet 会误命中）。
  const observable = [...(row.relations?.stateWrites ?? []), ...(entry.earlyExits ?? [])];
  const sinkKept = observable.some(x =>
    (typeof x.callee === 'string' && x.callee.includes('sink')) ||
    (typeof x.expression === 'string' && x.expression.includes('sink')));
  assert.ok(sinkKept,
    `sink() 的调用事实须保留在 stateWrites/earlyExits 中，实际 stateWrites=${show(row.relations?.stateWrites)} earlyExits=${show(entry.earlyExits)}`);
});

// ── 反例 2：主体被明确重赋值后再比较，必须降级为 unknown，并留下可追的缺口 ──
test('subject-reassigned-before-comparison：重赋值后 acceptsAction=null 且无 candidate，缺口可在 status/support 读到', () => {
  const row = first("function f(a){a='delete';if(a === 'publish'){sink();}}");
  assert.ok(row, '未构造出 entry-condition 行');
  const entry = row.entry ?? {};

  assert.equal(entry.acceptsAction ?? null, null,
    `主体来源不再可靠，acceptsAction 必须为 null，实际=${show(entry.acceptsAction)}`);
  const candidates = entry.actionCandidates ?? [];
  assert.ok(!candidates.some(c => c.status === 'candidate'),
    `重赋值缺口下不得有 status==='candidate'，实际=${show(candidates)}`);

  // 宽松匹配：不绑定最终字段名/具体字符串；缺口必须能在 status.uncertainty 或
  // support.notSupported 中读到（reassignment / assignment / subject 来源不可靠 / unknown 等）。
  const gapText = show({
    uncertainty: row.status?.uncertainty ?? [],
    notSupported: row.support?.notSupported ?? []
  });
  assert.match(gapText, /reassign|assignment|重赋值|赋值|subject[^\"]*unreliab|unresolved[^\"]*subject|source[^\"]*unreliab/i,
    `重赋值缺口须在 status.uncertainty 或 support.notSupported 中可读，实际=${gapText}`);
});

// ── 反例 3：无关兄弟 F2 调自己的 F3，shared 模块闭包不得升级为 associated ──
const siblingRecord = {
  id: 'deep/H2', originalId: 'H2', kind: 'entry-condition', run: 'deep',
  coordinate: { file: 'shared.js', line: 20 },
  detail: { function: 'F2', relations: { calls: ['F3'] } }
};
const selectedCallback = {
  id: 'deep/B1', kind: 'callback', run: 'deep',
  coordinate: { file: 'shared.js', line: 1 },
  detail: { name: 'selected', body: 'F1', definitionCall: { file: 'shared.js', startLine: 1, startColumn: 1 } }
};
const cap = { name: 'selected', file: 'shared.js', codeModules: ['shared.js'], scopedEvidence: [] };

test('unrelated-sibling-calls-its-own-helper：无 F1→F2/F3 边时 scope 只能是 background/unknown', () => {
  const bundle = { records: [selectedCallback, siblingRecord] };
  const ownership = ownershipOf(siblingRecord, ownershipIndex(bundle), cap);
  assert.ok(ownership && typeof ownership.scope === 'string', `ownership 结构异常：${show(ownership)}`);
  assert.notEqual(ownership.scope, 'associated',
    `F1 与 F2 无调用边，兄弟关系绝不能标为 associated，实际=${show(ownership)}`);
  assert.ok(ownership.scope === 'background' || ownership.scope === 'unknown',
    `同模块闭包至多 background/unknown，实际=${show(ownership)}`);
});

// ── 正向：F1 确有调用边到 F2 时，F2 可以是 associated 且保留 path（防 B 修过头）──
test('selected-body-calls-entry：F1→F2 有可追溯调用边时 F2 可为 associated 且 path 保留', () => {
  const selectedWithEdge = {
    ...selectedCallback,
    detail: { ...selectedCallback.detail, relations: { calls: ['F2'] } }
  };
  const bundle = { records: [selectedWithEdge, siblingRecord] };
  const ownership = ownershipOf(siblingRecord, ownershipIndex(bundle), cap);
  assert.ok(ownership && typeof ownership.scope === 'string', `ownership 结构异常：${show(ownership)}`);
  assert.equal(ownership.scope, 'associated',
    `F1 确有调用边到 F2，应保留 associated，实际=${show(ownership)}`);
  assert.ok(Array.isArray(ownership.path) && ownership.path.length > 0,
    `associated 必须保留可追溯 path，实际=${show(ownership.path)}`);
});
