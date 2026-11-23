// W2 胃三模式后端任务层专项验收（off / 关闭胃）。
// 只写 test/：从源码驱动 taskJob 与配置读取点，不启动分析入口、不联网、不打包。
// 关注用户可感行为：off 不建任务/不产 plan/materials/不伪造批准；切换只影响新请求；
// 配置字段/优先级读回验证（§13：验文件内容，不只验接口返回）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { taskJob } from '../internal/analysis/tasks.mjs';
import { conversationGuide } from '../internal/analysis/conversation.mjs';
import {
  INTAKE_MODES, DEFAULT_INTAKE_MODE, INTAKE_MODE_KEY, INSTALL_KINDS,
  readPersistedIntakeMode, resolveIntakeMode, resolveInstallIntent
} from '../internal/analysis/intake-mode.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-intake-modes-'));
let serial = 0;
function dir(...parts) { const d = path.join(tmpRoot, ...parts, String(serial++)); fs.mkdirSync(d, { recursive: true }); return d; }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

// 最小 harness：off 的 create 在调用 openTaskAnalysis 之前就短路返回，故无需真实 bundle。
function makeHarness({ openTaskAnalysis } = {}) {
  const fw = dir('fw');
  const profileDir = path.join(fw, 'profile');
  const taskRoot = path.join(fw, '鱼的胃', '任务');
  const analysisRoot = path.join(fw, '鱼的胃', '分析');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(analysisRoot, { recursive: true });
  let analysisCalls = 0;
  const ctx = { root: analysisRoot, profile: 'profile-synthetic', frameworkRoot: fw, profileDir };
  const scope = { frameworkRoot: fw, profileDir };
  const fake = {
    ctx, dir: analysisRoot,
    rec: { analysisId: 'a', kind: 'deep', source: { path: dir('source') }, initialAnalysisId: null, status: 'ready' },
    summary: { validity: { valid: true } }, bundle: { records: [], capabilities: [] }
  };
  const helpers = {
    context: () => ctx,
    openTaskAnalysis: openTaskAnalysis ?? (async () => { analysisCalls++; return fake; }),
    checkId: () => {}
  };
  return { scope, ctx, taskRoot, analysisRoot, helpers, calls: () => analysisCalls };
}

test('INTAKE_MODES 单点白名单恰为 off/compatibility/reverse，默认 compatibility', () => {
  assert.deepEqual([...INTAKE_MODES], ['off', 'compatibility', 'reverse']);
  assert.equal(DEFAULT_INTAKE_MODE, 'compatibility');
});

test('task create(off)：不建分析任务、不调分析入口、不写任何 task.json/plan/materials', async () => {
  const h = makeHarness({ openTaskAnalysis: async () => { throw new Error('off 不得调用 openTaskAnalysis'); } });
  const created = await taskJob({ taskOperation: 'create', taskMode: 'off', analysisId: 'whatever' }, h.scope, h.helpers);
  assert.equal(created.ok, true);
  assert.equal(created.action, 'task');
  assert.equal(created.result.analyzerExecutions, 0);
  assert.equal(created.result.mode, 'off');
  assert.equal(created.result.phase, 'skipped');
  assert.equal(created.result.status, 'registration-only');
  assert.equal(created.result.skipped, true);
  assert.equal(created.result.taskId, null, 'off 不产生可继续分析的 taskId');
  assert.equal(h.calls(), 0, 'off 未触发分析入口');
  // §13：读回磁盘，确认未落任何任务/产物文件。
  const files = walkFiles(h.taskRoot).concat(walkFiles(h.analysisRoot));
  assert.deepEqual(files, [], 'off 不应在任务/分析目录留下任何文件');
});

test('task create 未知 mode 仍被拒绝（白名单生效）', async () => {
  const h = makeHarness();
  await assert.rejects(
    taskJob({ taskOperation: 'create', taskMode: 'sideways', analysisId: 'x' }, h.scope, h.helpers),
    /off\/compatibility\/reverse/
  );
});

test('planted off 任务：produce 不产 plan/materials，confirm 不伪造批准（磁盘读回）', async () => {
  const h = makeHarness();
  const taskId = randomUUID();
  const taskDir = path.join(h.taskRoot, '测试插件-拆分任务', taskId);
  const taskFile = path.join(taskDir, 'task.json');
  writeJson(taskFile, {
    schema: 'fish-stomach-task/v1', taskId, profile: h.ctx.profile, binding: h.ctx.frameworkRoot,
    revision: 1, mode: 'off', phase: 'plan-pending', analysisId: randomUUID(), analysisKind: 'deep',
    initialAnalysisId: null, source: { path: 'x' }, plugin: { displayName: '测试插件' },
    capabilities: [], selected: [], dependencies: [], outputs: [], confirmation: null,
    unknowns: [], createdAt: new Date().toISOString()
  });
  await assert.rejects(
    taskJob({ taskOperation: 'produce', taskId, expectedRevision: 1 }, h.scope, h.helpers),
    /off mode.*does not produce plan\/materials/
  );
  await assert.rejects(
    taskJob({ taskOperation: 'confirm', taskId, expectedRevision: 1, taskConfirmation: { kind: 'user', actor: 'u', reason: 'r' } }, h.scope, h.helpers),
    /off mode.*no analysis output to confirm/
  );
  // §13：确认没有 plan.json / materials.json / 伪造的 confirmation 落盘。
  const produced = walkFiles(taskDir).filter(f => /(plan|materials)\.json$/.test(f));
  assert.deepEqual(produced, [], 'off 不得产出 plan/materials 文件');
  const reread = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.equal(reread.confirmation, null, 'off 不得写入 confirmation/approval');
});

test('已有分析任务不能切到 off：切模式只影响新请求', async () => {
  const h = makeHarness();
  const taskId = randomUUID();
  const taskDir = path.join(h.taskRoot, '测试插件-拆分任务', taskId);
  const taskFile = path.join(taskDir, 'task.json');
  writeJson(taskFile, {
    schema: 'fish-stomach-task/v1', taskId, profile: h.ctx.profile, binding: h.ctx.frameworkRoot,
    revision: 1, mode: 'compatibility', phase: 'plan-pending', analysisId: randomUUID(), analysisKind: 'deep',
    initialAnalysisId: null, source: { path: 'x' }, plugin: { displayName: '测试插件' },
    capabilities: [], selected: [], dependencies: [], outputs: [], confirmation: null,
    unknowns: [], createdAt: new Date().toISOString()
  });
  await assert.rejects(
    taskJob({ taskOperation: 'update', taskId, expectedRevision: 1, taskPatch: { mode: 'off' } }, h.scope, h.helpers),
    /off applies to new requests only/
  );
  const reread = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.equal(reread.mode, 'compatibility', '旧任务模式未被改写');
});

test('持久化默认模式：从 fish-body-state.json 读回，非法/缺失返回 null', () => {
  const profileDir = dir('profile-config');
  const stateFile = path.join(profileDir, 'fish-body-state.json');
  assert.equal(readPersistedIntakeMode(profileDir), null, '无配置返回 null');
  writeJson(stateFile, { mode: 'production', [INTAKE_MODE_KEY]: 'reverse' });
  assert.equal(readPersistedIntakeMode(profileDir), 'reverse', '读回持久化的 intakeMode');
  writeJson(stateFile, { mode: 'production', [INTAKE_MODE_KEY]: 'sideways' });
  assert.equal(readPersistedIntakeMode(profileDir), null, '非法值返回 null，不注入白名单');
  writeJson(stateFile, { mode: 'production' });
  assert.equal(readPersistedIntakeMode(profileDir), null, '缺字段返回 null，与部署 mode 不混');
  assert.equal(readPersistedIntakeMode({ [INTAKE_MODE_KEY]: 'off' }), 'off', '也接受已加载的配置对象');
});

test('新请求权威判定：显式 > 持久化默认 > 系统默认', () => {
  assert.equal(resolveIntakeMode({ explicit: 'off', persisted: 'reverse' }), 'off');
  assert.equal(resolveIntakeMode({ persisted: 'reverse' }), 'reverse');
  assert.equal(resolveIntakeMode({}), DEFAULT_INTAKE_MODE);
  assert.equal(resolveIntakeMode({ explicit: 'bogus', persisted: 'bogus', fallback: 'bogus' }), DEFAULT_INTAKE_MODE);
});

test('conversationGuide(off)：关闭胃口径，不出现兼容/逆向拆分话术', () => {
  const g = conversationGuide({ taskId: 'x', revision: 1, mode: 'off' });
  assert.match(g.prompt, /关闭胃/);
  assert.match(g.prompt, /直装/);
  assert.doesNotMatch(g.prompt, /兼容拆分|逆向拆分/);
  assert.match(conversationGuide({ analysisId: 'a', mode: 'reverse' }).prompt, /读取分析/);
});

// ── Codex #315 #2：安装意图分流专项（普通市场/CLI 固定直装 off，不受分析模式污染）──
test('INSTALL_KINDS 单点白名单恰为 market/cli', () => {
  assert.deepEqual([...INSTALL_KINDS], ['market', 'cli']);
});

test('resolveInstallIntent ②：市场/CLI 普通安装固定 off，完全不读持久化（关键回归）', () => {
  // 用户在胃里把持久化默认设成 reverse/compatibility，市场普通安装仍必须 off。
  for (const kind of ['market', 'cli']) {
    const r = resolveInstallIntent({ installKind: kind, persisted: 'reverse' });
    assert.equal(r.mode, 'off', `${kind} 安装必须固定 off，不得被持久化 reverse 污染`);
    assert.equal(r.intent, 'install');
    assert.equal(r.source, 'install-kind');
    const r2 = resolveInstallIntent({ installKind: kind, persisted: 'compatibility' });
    assert.equal(r2.mode, 'off', `${kind} 安装不得被持久化 compatibility 污染`);
  }
});

test('resolveInstallIntent ①：入口显式携带并受理的选择优先于 installKind 与持久化', () => {
  const r = resolveInstallIntent({ explicitIntakeMode: 'compatibility', installKind: 'market', persisted: 'reverse' });
  assert.equal(r.mode, 'compatibility', '显式分析请求即使带 market 上下文也按显式选择');
  assert.equal(r.intent, 'explicit');
  assert.equal(r.source, 'request');
  const off = resolveInstallIntent({ explicitIntakeMode: 'off', persisted: 'reverse' });
  assert.deepEqual(off, { mode: 'off', intent: 'explicit', source: 'request' });
});

test('resolveInstallIntent ③：未声明安装意图时回退 persisted > fallback（兼容历史调用/显式分析）', () => {
  assert.deepEqual(resolveInstallIntent({ persisted: 'reverse' }), { mode: 'reverse', intent: 'analysis', source: 'analysis-default' });
  assert.deepEqual(resolveInstallIntent({}), { mode: DEFAULT_INTAKE_MODE, intent: 'analysis', source: 'analysis-default' });
  assert.deepEqual(resolveInstallIntent({ explicitIntakeMode: 'bogus', persisted: 'off' }), { mode: 'off', intent: 'analysis', source: 'analysis-default' }, '非法显式值被忽略，落到持久化');
});

test('resolveInstallIntent 非法 installKind 不命中直装分支，落到分析判定', () => {
  const r = resolveInstallIntent({ installKind: 'sideways', persisted: 'reverse' });
  assert.equal(r.mode, 'reverse', '未知 installKind 不触发固定 off，走持久化');
  assert.equal(r.intent, 'analysis');
});
