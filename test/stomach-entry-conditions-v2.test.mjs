// 续次1 定向补修 · Agent C 独立验收专项（v2）。
// 只读分析：内存构造语法样例调用 extractEntryConditions；不执行样例代码、不启动分析入口、不联网、不改生产与消费代码。
// 本文件写入 test/ 下的新文件；失败即修复前缺陷复现，不是产品通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractEntryConditions } from '../internal/analysis/morph-scan.mjs';
import { makeModel, callable, nodeKey } from '../internal/analysis/morph-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const { Project } = await import(pathToFileURL(path.join(repo, 'node_modules/ts-morph/dist/ts-morph.js')).href);

// 与原审阅探针同一构造方式：内存文件系统 + callables + F1/F2 编号。
function analyze(code) {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true, compilerOptions: { allowJs: true, noEmit: true } });
  const source = project.createSourceFile('/sample/probe.js', code);
  const model = makeModel(project);
  const functions = source.getDescendants().filter(callable);
  const ids = new Map(functions.map((fn, index) => [nodeKey(fn), 'F' + (index + 1)]));
  return extractEntryConditions(model, functions, fn => ids.get(nodeKey(fn)), {});
}
const rowFor = (rows, id) => rows.find(r => r.function === id) ?? null;
const entryOf = row => row?.entry ?? {};
const acceptsOf = row => entryOf(row).acceptsAction ?? null;
const candidatesOf = row => entryOf(row).actionCandidates ?? [];
const comparisonsOf = row => entryOf(row).comparisons ?? [];
const exitsOf = row => entryOf(row).earlyExits ?? [];
const actionsOf = row => candidatesOf(row).map(c => c.action);
const show = value => JSON.stringify(value);

// ── §4.1 四个原始反例：v2 修正后的预期 ──────────────────────────────────────

test('§4.1 ordinaryLiteralRight：source 无 traceable 关系 → acceptsAction=null；target 本地 publish 候选成立且不得出现 action', () => {
  const rows = analyze("function source(action){if(action !== 'publish') return 'denied';} function target(action){if(action === 'publish'){sink();}}");
  const source = rowFor(rows, 'F1'), target = rowFor(rows, 'F2');
  assert.ok(source && target, 'F1/F2 未被构造出来');
  assert.equal(acceptsOf(source), null, 'source 与 target 无可追溯关系，acceptsAction 必须为 null');
  assert.ok(actionsOf(target).includes('publish'), `target 应含 publish 候选，实际 actionCandidates=${show(candidatesOf(target))}`);
  assert.ok(!actionsOf(target).includes('action'), `标识符参数名不得成为动作值，实际=${show(actionsOf(target))}`);
});

test('§4.1 reversedLiteralLeft：source acceptsAction=null；左字面量写法同样产出 publish', () => {
  const rows = analyze("function source(action){if(action !== 'publish') return 'denied';} function target(action){if('publish' === action){sink();}}");
  const source = rowFor(rows, 'F1'), target = rowFor(rows, 'F2');
  assert.ok(source && target, 'F1/F2 未被构造出来');
  assert.equal(acceptsOf(source), null, 'source 无 traceable 关系，acceptsAction 必须为 null');
  assert.ok(actionsOf(target).includes('publish'), `左字面量应产出 publish，实际=${show(actionsOf(target))}`);
  assert.ok(!actionsOf(target).includes('action'), `标识符不得成为动作值，实际=${show(actionsOf(target))}`);
});

test('§4.1 unrelatedSameVariable：source acceptsAction=null；source 全部候选不含 delete 与 action', () => {
  const rows = analyze("function source(action){if(action !== 'publish') return 'denied';} function target(action){if(action === 'delete'){sink();}}");
  const source = rowFor(rows, 'F1');
  assert.ok(source, 'F1 未被构造出来');
  assert.equal(acceptsOf(source), null, '仅同名变量不构成配对，acceptsAction 必须为 null');
  const srcActions = actionsOf(source);
  assert.ok(!srcActions.includes('delete'), `delete 不得串入 source，实际=${show(srcActions)}`);
  assert.ok(!srcActions.includes('action'), `action 不得串入 source，实际=${show(srcActions)}`);
});

test('§4.1 oppositeBranch：source acceptsAction=null；!= 分支里的 publish 不得成为任何接受候选', () => {
  const rows = analyze("function source(action){if(action !== 'publish') return 'denied';} function target(action){if('publish' !== action){sink();}}");
  const source = rowFor(rows, 'F1'), target = rowFor(rows, 'F2');
  assert.ok(source && target, 'F1/F2 未被构造出来');
  assert.equal(acceptsOf(source), null, '不等分支不构成接受，acceptsAction 必须为 null');
  const leaked = rows.flatMap(r => candidatesOf(r)).filter(c => c.action === 'publish');
  assert.equal(leaked.length, 0, `!== 分支的 publish 不应成为候选，实际=${show(leaked)}`);
  const cmp = comparisonsOf(target).find(c => c.operator === '!==');
  assert.ok(cmp, `target 应记录 !== 比较事实，实际 comparisons=${show(comparisonsOf(target))}`);
  assert.equal(cmp.equalsLiteral?.then, false, '!== 的 then 分支不等于字面量');
  assert.equal(cmp.equalsLiteral?.else, true, '!== 的 else 分支等于字面量');
});

// ── §4.2 第 1 组：比较事实、极性、歧义、早退形态 ─────────────────────────────

test('§4.2-1 四种运算符极性：==/=== 的 then=true else=false；!=/!== 的 then=false else=true', () => {
  const rows = analyze([
    "function fEq(a){if(a == 'go'){sink();}else{return 'denied';}}",
    "function fStrictEq(a){if(a === 'go'){sink();}else{return 'denied';}}",
    "function fNe(a){if(a != 'go'){return 'denied';}else{sink();}}",
    "function fStrictNe(a){if(a !== 'go'){return 'denied';}else{sink();}}"
  ].join('\n'));
  const expected = [
    ['F1', '==', true, false], ['F2', '===', true, false],
    ['F3', '!=', false, true], ['F4', '!==', false, true]
  ];
  for (const [id, operator, thenValue, elseValue] of expected) {
    const row = rowFor(rows, id);
    assert.ok(row, `${id} 未被构造出来`);
    const cmp = comparisonsOf(row).find(c => c.operator === operator);
    assert.ok(cmp, `${id} 缺少 operator=${operator} 的比较事实，实际=${show(comparisonsOf(row))}`);
    assert.equal(cmp.equalsLiteral?.then, thenValue, `${operator} 的 then 极性错误`);
    assert.equal(cmp.equalsLiteral?.else, elseValue, `${operator} 的 else 极性错误`);
    assert.equal(cmp.status, 'supported', `${operator} 应为 supported`);
  }
});

test('§4.2-1 then/else 极性：candidate 的 condition.path 必须落在等于字面量的分支', () => {
  const rows = analyze([
    "function thenAccept(a){if(a === 'go'){sink();}else{return 'denied';}}",
    "function elseAccept(a){if(a !== 'go'){return 'denied';}else{sink();}}"
  ].join('\n'));
  const thenRow = rowFor(rows, 'F1'), elseRow = rowFor(rows, 'F2');
  assert.ok(thenRow && elseRow, 'F1/F2 未被构造出来');
  const thenCands = candidatesOf(thenRow).filter(c => c.action === 'go');
  const elseCands = candidatesOf(elseRow).filter(c => c.action === 'go');
  assert.ok(thenCands.some(c => c.condition?.path === 'then'), `=== 的 then 应为接受分支，实际=${show(candidatesOf(thenRow))}`);
  assert.ok(!thenCands.some(c => c.condition?.path === 'else'), '=== 的 else 不是接受分支');
  assert.ok(elseCands.some(c => c.condition?.path === 'else'), `!== 的 else 应为接受分支，实际=${show(candidatesOf(elseRow))}`);
  assert.ok(!elseCands.some(c => c.condition?.path === 'then'), '!== 的 then 不是接受分支');
});

test('§4.2-1 字面量左右等价：a===字面量与字面量===a 都产出同一动作，且不把参数名当动作', () => {
  const rows = analyze([
    "function rightForm(a){if(a === 'go'){sink();}else{return 'denied';}}",
    "function leftForm(a){if('go' === a){sink();}else{return 'denied';}}"
  ].join('\n'));
  for (const id of ['F1', 'F2']) {
    const row = rowFor(rows, id);
    assert.ok(row, `${id} 未被构造出来`);
    const actions = actionsOf(row);
    assert.ok(actions.includes('go'), `${id} 应产出 go，实际=${show(actions)}`);
    assert.ok(!actions.includes('a'), `${id} 不得把参数名 a 当动作，实际=${show(actions)}`);
  }
});

test('§4.2-1 歧义边界：无字面量 / 双不同字面量 → unknown 且不得选出接受动作', () => {
  const rows = analyze([
    "function noLiteral(a,b){if(a === b){sink();}else{return 'denied';}}",
    "function twoLiterals(){if('x' === 'y'){sink();}else{return 'denied';}}"
  ].join('\n'));
  const noLiteral = rowFor(rows, 'F1'), two = rowFor(rows, 'F2');
  assert.ok(noLiteral && two, 'F1/F2 未被构造出来');
  const noCmp = comparisonsOf(noLiteral).find(c => c.status === 'no-literal');
  assert.ok(noCmp, `无字面量应记 no-literal，实际=${show(comparisonsOf(noLiteral))}`);
  assert.equal(acceptsOf(noLiteral), null, '无字面量不得产出 acceptsAction');
  const twoCmp = comparisonsOf(two).find(c => c.status === 'ambiguous-two-literals');
  assert.ok(twoCmp, `双不同字面量应记 ambiguous-two-literals，实际=${show(comparisonsOf(two))}`);
  assert.equal(twoCmp.equalsLiteral?.then, null, '双字面量歧义时 then 极性为 null');
  assert.equal(twoCmp.equalsLiteral?.else, null, '双字面量歧义时 else 极性为 null');
  assert.equal(acceptsOf(two), null, '双字面量歧义不得产出 acceptsAction');
  assert.ok(!actionsOf(two).includes('x') && !actionsOf(two).includes('y'), `歧义不得产出动作候选，实际=${show(actionsOf(two))}`);
});

test('§4.2-1/2 return sink() 与 return denied 必须靠 expressionKind 区分，调用返回不产生动作字面量', () => {
  const rows = analyze([
    "function callReturn(a){if(a === 'go'){return sink();}else{return 'denied';}}",
    "function literalReturn(a){if(a === 'go'){return 'denied';}else{sink();}}"
  ].join('\n'));
  const callRow = rowFor(rows, 'F1'), litRow = rowFor(rows, 'F2');
  assert.ok(callRow && litRow, 'F1/F2 未被构造出来');
  const callExit = exitsOf(callRow).find(e => /sink\(\)/.test(e.expression ?? ''));
  const litExit = exitsOf(litRow).find(e => (e.expression ?? '').includes('denied'));
  assert.ok(callExit, `缺少 return sink() 早退，实际=${show(exitsOf(callRow))}`);
  assert.ok(litExit, `缺少 return 'denied' 早退，实际=${show(exitsOf(litRow))}`);
  assert.equal(callExit.expressionKind?.kind, 'call', 'return sink() 的 expressionKind.kind 必须为 call');
  assert.equal(callExit.expressionKind?.hasCall, true, 'return sink() 必须标记 hasCall=true');
  assert.equal(callExit.expressionKind?.isLiteral, false, 'return sink() 不得标记为字面量');
  assert.ok(!(callExit.literalActions ?? []).includes('go'), `调用返回不得产生 go 动作字面量，实际=${show(callExit.literalActions)}`);
  assert.equal(litExit.expressionKind?.kind, 'literal', "return 'denied' 的 expressionKind.kind 必须为 literal");
  assert.equal(litExit.expressionKind?.isLiteral, true, "return 'denied' 必须标记 isLiteral=true");
  assert.ok((litExit.literalActions ?? []).includes('denied'), `字面量返回应保留 denied，实际=${show(litExit.literalActions)}`);
});

// ── §4.2 第 2 组：跨函数、多候选、嵌套、无关同名 ─────────────────────────────

test('§4.2-2 多候选完整枚举：不得静默取全局首项，acceptsAction 必须为 null', () => {
  const rows = analyze([
    "function multi(a){if(a === 'publish'){sink();}else{return 'denied';}",
    "if(a === 'delete'){sink();}else{return 'denied';}}"
  ].join('\n'));
  const row = rowFor(rows, 'F1');
  assert.ok(row, 'F1 未被构造出来');
  const actions = actionsOf(row);
  assert.ok(actions.includes('publish') && actions.includes('delete'), `两个候选都应枚举，实际=${show(actions)}`);
  assert.ok(candidatesOf(row).length >= 2, `候选数应≥2，实际=${candidatesOf(row).length}`);
  assert.equal(acceptsOf(row), null, '多候选时不得静默选中单个 acceptsAction');
});

test('§4.2-2 嵌套回调归属：publish 候选归内层回调，不得作为外层的 same-function 候选', () => {
  const rows = analyze(
    "function outer(a){if(a === 'go'){[1].map(function inner(x){if(x === 'publish'){sink();}else{return 'denied';}});}else{return 'denied';}}"
  );
  const outer = rowFor(rows, 'F1'), inner = rowFor(rows, 'F2');
  assert.ok(outer && inner, `应构造 outer/inner 两个 callable，实际 F1/F2=${show([!!outer, !!inner])}`);
  assert.ok(actionsOf(inner).includes('publish'), `内层回调应含 publish，实际=${show(actionsOf(inner))}`);
  const allPublish = rows.flatMap(r => candidatesOf(r)).filter(c => c.action === 'publish');
  assert.ok(allPublish.length >= 1, '应存在 publish 候选');
  assert.ok(allPublish.some(c => c.target?.functionId === 'F2'), `publish 应归到内层函数 F2，实际=${show(allPublish)}`);
  assert.ok(!allPublish.some(c => c.relation === 'same-function' && c.target?.functionId === 'F1'),
    `publish 不得被当成外层 F1 的 same-function 候选，实际=${show(allPublish)}`);
});

test('§4.2-2 同名无关参数不跨函数配对：alpha 只拿 publish，beta 只拿 delete', () => {
  const rows = analyze([
    "function alpha(action){if(action === 'publish'){sink();}else{return 'denied';}}",
    "function beta(action){if(action === 'delete'){sink();}else{return 'denied';}}"
  ].join('\n'));
  const alpha = rowFor(rows, 'F1'), beta = rowFor(rows, 'F2');
  assert.ok(alpha && beta, 'F1/F2 未被构造出来');
  const alphaActions = actionsOf(alpha), betaActions = actionsOf(beta);
  assert.ok(alphaActions.includes('publish'), `alpha 应含 publish，实际=${show(alphaActions)}`);
  assert.ok(!alphaActions.includes('delete'), `delete 不得跨函数串入 alpha，实际=${show(alphaActions)}`);
  assert.ok(betaActions.includes('delete'), `beta 应含 delete，实际=${show(betaActions)}`);
  assert.ok(!betaActions.includes('publish'), `publish 不得跨函数串入 beta，实际=${show(betaActions)}`);
  for (const row of rows) for (const c of candidatesOf(row))
    assert.notEqual(c.action, 'action', `参数名 action 不得成为动作值，实际=${show(candidatesOf(row))}`);
  assert.ok(acceptsOf(alpha) === null || acceptsOf(alpha)?.action === 'publish', `alpha 接受值异常=${show(acceptsOf(alpha))}`);
  assert.ok(acceptsOf(beta) === null || acceptsOf(beta)?.action === 'delete', `beta 接受值异常=${show(acceptsOf(beta))}`);
});
