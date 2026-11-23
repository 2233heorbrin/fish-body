// Codex#318「从已装插件进入分析」编排专项测试。
// 用依赖注入真跑整条链，验证编排/分流/边界契约；不冒充真 DSH 插件 E2E。
// 真 DSH 原生安装/运行由纵向链在隔离宿主完成（见 W2-r2 裁定第11-13行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeInstalledFromSource } from '../internal/analysis/installed-analysis.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w2installed-'));
}
function githubRecord(overrides = {}) {
  return {
    sourceKind: 'github', packageName: 'demo.plugin', id: 'demo.plugin',
    sourceSpec: 'github:owner/repo#main', sourceUrl: 'https://github.com/owner/repo',
    requestedRef: 'main', resolvedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceSubdir: 'plugin', bodyPath: null, ...overrides,
  };
}
function npmRecord(overrides = {}) {
  return {
    sourceKind: 'npm', packageName: 'demo.plugin', id: 'demo.plugin',
    sourceSpec: 'demo.plugin@1.2.3', npmSpec: 'demo.plugin@1.2.3',
    sourceUrl: '', bodyPath: null, ...overrides,
  };
}
function makeScope() {
  const root = tmpDir();
  const body = path.join(root, 'warehouse', 'body');
  fs.mkdirSync(body, { recursive: true });
  // 完整仓夹具：子包 plugin、兄弟包 sibling、仓根 README。用于验证 materialPath 收窄到子包。
  const repoDir = path.join(root, 'rice', 'repo');
  const subPkg = path.join(repoDir, 'plugin');
  const sibling = path.join(repoDir, 'sibling');
  fs.mkdirSync(subPkg, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# repo root\n');
  return { frameworkRoot: root, profileDir: root, body, repoDir, subPkg, sibling };
}
function defaultDeps(scope, record, calls) {
  return {
    findInstalledByPluginId: async ({ pluginId }) => {
      calls.find.push(pluginId);
      return record.packageName === pluginId || record.id === pluginId ? record : null;
    },
    sourceFetch: {
      // 模拟 source-fetch：repoDir 是完整仓，subdir 是独立字段（normalizeSubdir 净化后的值）。
      fetchSourceToRice: async args => {
        calls.fetch.push(args);
        return {
          owner: 'owner', repo: 'repo', ref: args.ref, subdir: args.subdir,
          head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repoDir: scope.repoDir,
          entryDir: path.dirname(scope.repoDir), downloadMethod: 'git', reused: false,
        };
      },
      recordRiceSource: async args => { calls.record.push(args); return { source: {} }; },
    },
    analysisToolAction: async (args) => {
      calls.actions.push(args.action + ':' + (args.taskOperation ?? args.analysisType ?? ''));
      if (args.action === 'analyze') calls.analyzeArgs = args;
      if (args.action === 'analyze') return { ok: true, result: { analysisId: 'analysis-1' } };
      if (args.action === 'task') return { ok: true, result: { taskId: 'task-1' } };
      return { ok: false, error: 'unexpected action' };
    },
    realpathSync: p => p,
  };
}

test('mode 严格：off 与非法值直接失败，不查来源、不建任务', async () => {
  for (const bad of ['off', 'OFF', 'both', '', undefined, null]) {
    const calls = { find: [], fetch: [], record: [], actions: [] };
    const scope = makeScope();
    const res = await analyzeInstalledFromSource({
      frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
      pluginId: 'demo.plugin', mode: bad,
      deps: defaultDeps(scope, npmRecord(), calls),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /mode/);
    assert.deepEqual(calls.find, [], '非法 mode 不应触发来源查询');
    assert.deepEqual(calls.actions, [], '非法 mode 不应建分析/任务');
  }
});

test('必填参数缺失返回中文错误', async () => {
  const r1 = await analyzeInstalledFromSource({ profileDir: 'p', mode: 'reverse' });
  assert.equal(r1.ok, false); assert.match(r1.error, /frameworkRoot/);
  const r2 = await analyzeInstalledFromSource({ frameworkRoot: 'f', mode: 'reverse' });
  assert.equal(r2.ok, false); assert.match(r2.error, /profileDir/);
});

test('身份解析：pluginId 命中即停；pluginId 未命中按 nativeId/packageName 回退', async () => {
  const scope = makeScope();
  const rec = npmRecord({ bodyPath: scope.body });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, rec, calls);
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'miss', nativeId: 'demo.plugin', packageName: 'demo.plugin', mode: 'compatibility', deps,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.find, ['miss', 'demo.plugin'], 'pluginId 未命中应按 nativeId 回退');
});

test('已装来源未找到返回中文错误，不建分析/任务', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, npmRecord({ packageName: 'other', id: 'other' }), calls);
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse', deps,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /未找到/);
  assert.deepEqual(calls.actions, []);
});

test('GitHub 来源：按实际 ref/commit/subdir 采集 + 登记来源，materialPath 收窄到子包', async () => {
  const scope = makeScope();
  const rec = githubRecord();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility',
    deps: defaultDeps(scope, rec, calls),
  });
  assert.equal(res.ok, true);
  assert.equal(res.taskId, 'task-1');
  assert.equal(res.analysisId, 'analysis-1');
  assert.equal(res.pluginId, 'demo.plugin');
  assert.equal(res.channel, 'github');
  assert.equal(res.collectedCommit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(res.materialPath, scope.subPkg, 'materialPath 必须是子包目录而非完整 repoDir');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, 'https://github.com/owner/repo');
  assert.equal(calls.fetch[0].ref, 'main');
  assert.equal(calls.fetch[0].subdir, 'plugin');
  assert.equal(calls.fetch[0].revision, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(calls.record.length, 1, '采集后必须登记来源');
  assert.deepEqual(calls.actions, ['analyze:initial', 'task:create'], '先建分析再建任务，且不切插件/不confirm');
});

test('GitHub 子包：materialPath 落在子包、不含兄弟包/仓根，analysisSource 指向子包（#324 补修）', async () => {
  const scope = makeScope();
  const rec = githubRecord({ sourceSubdir: 'plugin' });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse',
    deps: defaultDeps(scope, rec, calls),
  });
  assert.equal(res.ok, true);
  assert.equal(res.materialPath, scope.subPkg, '必须是 repoDir/plugin');
  assert.notEqual(res.materialPath, scope.repoDir, '不能是完整仓根');
  assert.ok(!res.materialPath.includes('sibling'), '不能包含兄弟包路径');
  // analysisSource 也必须指向子包，worker 才不会扫整仓
  assert.equal(calls.analyzeArgs.analysisSource.kind, 'local');
  assert.equal(calls.analyzeArgs.analysisSource.path, scope.subPkg);
  // record 侧 entry 带 subdir，source-fetch 会写入 来源.json 的 subdir 字段（范围可见）
  assert.equal(calls.record[0].entry.subdir, 'plugin');
});

test('GitHub 子包：fetch 返回 entry.subdir 为权威值，覆盖 found.sourceSubdir 兜底', async () => {
  const scope = makeScope();
  // found 摊平记录的 subdir 故意写错/缺失，fetch 实际采集值（entry.subdir）才是权威
  const rec = githubRecord({ sourceSubdir: null });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, rec, calls);
  deps.sourceFetch.fetchSourceToRice = async args => ({
    head: 'cccccccccccccccccccccccccccccccccccccccc', repoDir: scope.repoDir,
    entryDir: path.dirname(scope.repoDir), subdir: 'plugin', reused: false,
  });
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility', deps,
  });
  assert.equal(res.ok, true);
  assert.equal(res.materialPath, scope.subPkg, 'entry.subdir 应覆盖 null 的 found.sourceSubdir');
});

test('GitHub 空 subdir（仓库根来源）：materialPath 保持整仓，不回归', async () => {
  const scope = makeScope();
  const rec = githubRecord({ sourceSubdir: null });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, rec, calls);
  deps.sourceFetch.fetchSourceToRice = async args => ({
    head: 'dddddddddddddddddddddddddddddddddddddddd', repoDir: scope.repoDir,
    entryDir: path.dirname(scope.repoDir), subdir: null, reused: false,
  });
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility', deps,
  });
  assert.equal(res.ok, true);
  assert.equal(res.materialPath, scope.repoDir, 'subdir 为空时整仓即子包，保持原行为');
});

test('GitHub 子包越界：subdir 指向仓外时失败，不建分析/任务', async () => {
  const scope = makeScope();
  const rec = githubRecord({ sourceSubdir: null });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, rec, calls);
  deps.sourceFetch.fetchSourceToRice = async () => ({
    head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', repoDir: scope.repoDir,
    entryDir: path.dirname(scope.repoDir), subdir: '../outside', reused: false,
  });
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse', deps,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /越出仓库/);
  assert.deepEqual(calls.actions, [], '越界时不建分析/任务');
});

test('npm 来源：用真实已装 bodyPath 作 local 材料，不调 GitHub 采集器', async () => {
  const scope = makeScope();
  const rec = npmRecord({ bodyPath: scope.body });
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse',
    deps: defaultDeps(scope, rec, calls),
  });
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'npm');
  assert.equal(res.materialPath, scope.body);
  assert.deepEqual(calls.fetch, [], 'npm 来源不应调 GitHub 采集器');
  assert.deepEqual(calls.record, [], 'npm 用已装字节，不重采/不登记新来源');
  assert.deepEqual(calls.actions, ['analyze:initial', 'task:create']);
});

test('材料复用：fetchSourceToRice 返回 reused=true 时仍正常产出', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, githubRecord(), calls);
  deps.sourceFetch.fetchSourceToRice = async () => ({
    head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', repoDir: scope.repoDir,
    entryDir: path.dirname(scope.repoDir), reused: true,
  });
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility', deps,
  });
  assert.equal(res.ok, true);
  assert.equal(res.collectedCommit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('分析失败：返回中文错误，不建任务', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, npmRecord({ bodyPath: scope.body }), calls);
  deps.analysisToolAction = async (args) => {
    calls.actions.push(args.action);
    return args.action === 'analyze' ? { ok: false, error: '分析源或规则已变化' } : { ok: true, result: { taskId: 'x' } };
  };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse', deps,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /分析未成功/);
  assert.deepEqual(calls.actions, ['analyze'], '分析失败不应建任务');
});

test('建任务失败：返回中文错误，taskId 未伪造', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, npmRecord({ bodyPath: scope.body }), calls);
  deps.analysisToolAction = async (args) => {
    calls.actions.push(args.action);
    return args.action === 'analyze' ? { ok: true, result: { analysisId: 'a-1' } }
      : { ok: false, error: '任务落盘冲突' };
  };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility', deps,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /创建任务未成功/);
  assert.equal(res.taskId, undefined);
});

test('采集器抛错被包成中文错误，不建分析/任务', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const deps = defaultDeps(scope, githubRecord(), calls);
  deps.sourceFetch.fetchSourceToRice = async () => { throw new Error('FH_DOWNLOAD_FAILED: 归档回退失败'); };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'reverse', deps,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /FH_DOWNLOAD_FAILED/);
  assert.deepEqual(calls.actions, []);
});

test('返回契约：成功只含约定字段且不伪造批准字段', async () => {
  const scope = makeScope();
  const calls = { find: [], fetch: [], record: [], actions: [] };
  const res = await analyzeInstalledFromSource({
    frameworkRoot: scope.frameworkRoot, profileDir: scope.profileDir,
    pluginId: 'demo.plugin', mode: 'compatibility',
    deps: defaultDeps(scope, npmRecord({ bodyPath: scope.body }), calls),
  });
  assert.equal(res.ok, true);
  assert.equal(typeof res.taskId, 'string');
  assert.equal(typeof res.analysisId, 'string');
  assert.equal(res.pluginId, 'demo.plugin');
  assert.equal(res.confirmation, undefined);
  assert.equal(res.analysisApproved, undefined);
});
