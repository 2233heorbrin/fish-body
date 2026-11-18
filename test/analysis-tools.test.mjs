import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const install = process.env.FISH_TEST_INSTALL_ROOT, work = process.env.FISH_ANALYSIS_TEST_ROOT;
if (!install || !work || fs.existsSync(work)) throw Error('Use an independent installed tarball and fresh FISH_ANALYSIS_TEST_ROOT');
fs.mkdirSync(work, { recursive: true });
const pkg = path.join(install, 'node_modules/fish-body');
const load = f => import(pathToFileURL(path.join(pkg, f)));
const { fishHandToolDefinition } = await load('internal/backend/fish-body-approval.mjs');
const { analyze, validateRun } = await load('internal/analysis/unified.mjs');
const phase = await load('internal/backend/lib/body-switch.mjs');
const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, value); };
const json = (f, value) => write(f, JSON.stringify(value, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const root = path.join(work, 'body-root'), profile = path.join(work, 'profile-a');
fs.mkdirSync(root); fs.mkdirSync(profile);
const select = enabled => json(path.join(profile, 'package.json'), { private: true, dependencies: { 'fish-body': 'file:test' }, dsh: { profile: { bundles: enabled ? ['fish-body'] : [] } } });
select(true);
let orchCalls = 0;
const tool = fishHandToolDefinition({ getOrch() { orchCalls++; throw Error('Analysis must not construct installation orchestrator'); }, bodySwitch: { frameworkRoot: root, profileDir: profile } });
const source = path.join(work, 'source'), marker = path.join(work, 'CANDIDATE_EXECUTED');
const trap = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');throw Error('candidate must not execute')`;
json(path.join(source, 'package.json'), { name: 'analysis-source-only', version: '1.0.0', type: 'module', scripts: { preinstall: 'node trap.cjs', prepare: 'node trap.cjs' } });
for (const f of ['trap.cjs', 'webpack.config.cjs', 'babel.config.cjs', 'dependency-cruiser.config.cjs']) write(path.join(source, f), trap);
write(path.join(source, 'sample.js'), `export function apply(host){
 const text='中文前缀';const local={systemPrompt:{section(v){return v}}};local.systemPrompt.section('local');host.systemPrompt.section('host');
 const alias=host.tools.register.bind(host.tools);alias({name:'bound-alias',execute(){return 1}});
 host.tools.register({name:'direct-tool',execute(){return 1}});
 const selected=globalThis.flag?host:{systemPrompt:{section(){}}};selected.systemPrompt.section('conditional');
}
function manufacture(){
${Array.from({ length: 30 }, (_, i) => `if(globalThis.choice===${i})return {service:{register(){return ${i}}}};`).join('\n')}
}
function receive(bag){const {service}=bag;service.register()}
export function start(){receive(manufacture())}
`);
write(path.join(source, 'opaque.ps1'), '# syntax is outside current configured rules\n');
const selected = { kind: 'local', path: source };
const examples = [], counts = { initial: 0, deep: 0, reuse: 0, query: 0 };
async function call(args, t = tool) {
  const started = performance.now();
  const value = await t.execute(args);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16000);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));
  examples.push({ args, elapsedMs: Math.round(performance.now() - started), value });
  if (value.ok && args.action === 'analyze') counts[value.result.action === 'reuse' ? 'reuse' : args.analysisType]++;
  if (args.action === 'query') counts.query++;
  return value;
}
const query = (id, queryType, queryOptions = {}) => call({ action: 'query', analysisId: id, queryType, queryOptions });
async function all(id, type, options = {}) {
  const rows = []; let offset = 0, total;
  do {
    const q = await query(id, type, { ...options, offset, limit: 20 }); assert.equal(q.ok, true);
    total = q.result.page.total; rows.push(...q.result.page.items); offset = q.result.page.nextOffset;
  } while (offset !== null);
  assert.equal(rows.length, total); return rows;
}
const { findRecordDirectory } = await load('internal/analysis/records.mjs');
const dir = id => findRecordDirectory(path.join(root, '鱼的胃', '分析'), 'analysis', id);
let first, deep, partial;

test('packed fish_hand analysis integration', async t => {
  await t.test('real definition and handler: explicit initial, no installation intent, async host', async () => {
    assert(tool.parameters.properties.action.enum.includes('analyze'));
    assert(tool.parameters.properties.action.enum.includes('query'));
    assert.deepEqual(tool.parameters.properties.analysisType.enum, ['initial', 'deep']);
    let ticks = 0; const timer = setInterval(() => ticks++, 5);
    try { first = await call({ action: 'analyze', analysisType: 'initial', analysisSource: selected }); }
    finally { clearInterval(timer); }
    assert.equal(first.ok, true); assert.equal(first.result.status, 'ready'); assert.equal(first.result.analyzerExecutions, 1);
    assert(ticks > 2, 'host event loop must advance during analysis');
    const rec = read(path.join(dir(first.result.analysisId), 'record.json'));
    assert.equal(rec.kind, 'initial'); assert.equal(orchCalls, 0);
    assert.equal(fs.existsSync(path.join(root, '鱼的手')), false);
    assert.equal(fs.existsSync(marker), false);
    const capability = await query(first.result.analysisId, 'capability', { name: 'direct-tool' });
    assert(capability.result.page.items.some(r => /No deep result/.test(r.unknown ?? '')));
  });
  await t.test('same-kind reuse and cross-kind core+tool refusal leave old output unchanged', async () => {
    const id = first.result.analysisId, run = path.join(dir(id), 'run');
    const before = fs.readFileSync(path.join(run, 'analysis.json'));
    const ops = fs.readFileSync(path.join(run, 'operations.jsonl'));
    await assert.rejects(analyze('deep', source, run), /analysis-kind-mismatch/);
    assert(fs.readFileSync(path.join(run, 'operations.jsonl')).equals(ops));
    await assert.rejects(call({ action: 'analyze', analysisType: 'deep', analysisSource: selected, analysisId: id }), /kind mismatch/);
    const reuse = await call({ action: 'analyze', analysisType: 'initial', analysisSource: selected, analysisId: id });
    assert.equal(reuse.result.action, 'reuse'); assert.equal(reuse.result.analyzerExecutions, 0);
    assert(fs.readFileSync(path.join(run, 'analysis.json')).equals(before));
    assert.equal(read(path.join(run, 'reuse.json')).kind, 'initial');
  });
  await t.test('deep is explicit; combined revisions/alias supplements and cap remain visible through tools', async () => {
    deep = await call({ action: 'analyze', analysisType: 'deep', analysisSource: selected, initialAnalysisId: first.result.analysisId });
    assert.equal(deep.ok, true); assert.equal(deep.result.status, 'diagnostic-partial');
    assert(deep.result.completeness.incompleteRelations > 0);
    const rows = await all(deep.result.analysisId, 'file', { file: 'sample.js' });
    assert(rows.some(r => r.kind === 'revision' && r.links.some(id => id.startsWith('initial/'))));
    assert(rows.some(r => r.kind === 'supplement'));
    assert(rows.some(r => r.status?.candidateSetComplete === false && r.status.truncations.some(x => x.limit === 24 && x.retained === 24 && x.total === null)));
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
    const revision = rows.find(r => r.kind === 'revision');
    const detail = await all(deep.result.analysisId, 'evidence', { id: revision.id });
    assert.match(JSON.stringify(detail), /does not prove absence/);
    const manual = await query(deep.result.analysisId, 'phase', { function: 'receive', stage: 'manual question', limit: 2 });
    assert.match(manual.result.question.origin, /manual/);
    assert.equal(manual.result.page.items[0].status.candidateSetComplete, false);
    assert.equal(manual.result.state, 'reused-diagnostic-partial');
    const run = path.join(dir(deep.result.analysisId), 'run');
    await assert.rejects(analyze('initial', source, run), /analysis-kind-mismatch/);
    await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: selected, analysisId: deep.result.analysisId }), /kind mismatch/);
    const reuse = await call({ action: 'analyze', analysisType: 'deep', analysisSource: selected, analysisId: deep.result.analysisId });
    assert.equal(reuse.result.analyzerExecutions, 0);
  });
  await t.test('missing and unsupported receipts never become valid; do not mutate saved witnesses', async () => {
    const run = path.join(dir(first.result.analysisId), 'run'), receipt = path.join(run, 'reuse.json'), original = fs.readFileSync(receipt);
    try {
      const r = JSON.parse(original); delete r.kind; json(receipt, r);
      assert.equal(validateRun(run, source).valid, false);
      await assert.rejects(analyze('initial', source, run), /unsupported-analysis-kind/);
      r.kind = 'other'; json(receipt, r); assert.equal(validateRun(run, source).valid, false);
    } finally { fs.writeFileSync(receipt, original); }
  });
  await t.test('query pages, namespaced evidence and original units/pointers; no analyzer invocation', async () => {
    const id = deep.result.analysisId, before = fs.readFileSync(path.join(dir(id), 'run/operations.jsonl'));
    const rows = await all(id, 'file', { file: 'sample.js' });
    assert(rows.some(r => r.id.startsWith('initial/'))); assert(rows.some(r => r.id.startsWith('deep/')));
    const initial = rows.find(r => r.kind === 'observation'), method = rows.find(r => r.kind === 'method');
    const i = await query(id, 'evidence', { id: initial.id, limit: 2 });
    const d = await query(id, 'evidence', { id: method.id, limit: 2 });
    assert(i.result.evidence.raw.pointer.startsWith('/facts/evidence/'));
    assert.match(i.result.evidence.coordinate.unit, /UTF-8/);
    assert.match(d.result.evidence.coordinate.unit, /UTF-16/);
    const bundle = read(path.join(dir(id), 'bundle/bundle.json'));
    assert.match(bundle.records.find(r => r.id === initial.id).coordinate.unit, /UTF-8/);
    assert.match(bundle.records.find(r => r.id === method.id).coordinate.unit, /UTF-16/);
    assert(d.result.evidence.raw.pointer.startsWith('/methodOwnership/'));
    await assert.rejects(query(id, 'evidence', { id: initial.originalId }), /namespaced/);
    await assert.rejects(query('../record.json', 'summary'), /backend-issued/);
    await assert.rejects(query(id, 'summary', { limit: 21 }), /limit/);
    assert(fs.readFileSync(path.join(dir(id), 'run/operations.jsonl')).equals(before));
  });
  await t.test('byte/config/code changes reject query and reuse, without an automatic scan', async () => {
    const id = first.result.analysisId, f = path.join(source, 'sample.js'), before = fs.readFileSync(f), run = path.join(dir(id), 'run');
    try {
      fs.appendFileSync(f, '\n// deliberate content change');
      const q = await query(id, 'summary'); assert.equal(q.ok, false); assert.equal(q.result.page, undefined);
      await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: selected, analysisId: id }), /invalid/);
    } finally { fs.writeFileSync(f, before); }
    const witness = path.join(run, 'validity/code/rules.mjs'), code = fs.readFileSync(witness);
    try { fs.appendFileSync(witness, '\n// altered witness'); assert.equal((await query(id, 'summary')).ok, false); }
    finally { fs.writeFileSync(witness, code); }
    const receipt = path.join(run, 'reuse.json'), bytes = fs.readFileSync(receipt);
    try { const r = JSON.parse(bytes); r.effective.rules = 'different'; json(receipt, r); assert.equal((await query(id, 'summary')).ok, false); }
    finally { fs.writeFileSync(receipt, bytes); }
    assert.equal((await query(id, 'summary')).ok, true);
  });
  await t.test('fixed request source is scoped, read-only and does not manufacture install intent', async () => {
    const rice = path.join(work, 'fixed-material'); fs.mkdirSync(path.join(rice, '仓库'), { recursive: true });
    fs.copyFileSync(path.join(source, 'sample.js'), path.join(rice, '仓库/sample.js'));
    const { collectFromArchive } = await load('internal/backend/lib/upstream.mjs');
    const warehouse = path.join(rice, '仓库'), commit = 'a'.repeat(40);
    const collected = collectFromArchive({ repoDir: warehouse, commit,
      sourceEntry: { downloadMethod: 'codeload-tar', repoDir: warehouse, head: commit } });
    json(path.join(rice, '来源.json'), { pinnedCommit: commit, contentHash: collected.treeHash });
    json(path.join(rice, '内容清单.json'), { pinnedCommit: commit, treeHash: collected.treeHash, files: collected.files });
    const requestFile = path.join(root, '鱼的手/插件注册表/requests/fixed-test.json');
    const record = { id: 'fixed-test', targetProfile: profile, rice: { dir: rice }, source: { pinnedCommit: commit, contentHash: collected.treeHash } };
    json(requestFile, record); const before = fs.readFileSync(requestFile);
    const value = await call({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'request', requestId: 'fixed-test' } });
    assert.equal(value.result.source.kind, 'request'); assert.match(value.result.source.provenance, /not a new remote/);
    assert(fs.readFileSync(requestFile).equals(before));
    record.targetProfile = path.join(work, 'other'); json(requestFile, record);
    await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'request', requestId: 'fixed-test' } }), /another Profile/);
    fs.writeFileSync(requestFile, before);
  });
  await t.test('Profile isolation, input validation and no candidate scripts', async () => {
    const other = path.join(work, 'profile-b'); fs.mkdirSync(other); fs.copyFileSync(path.join(profile, 'package.json'), path.join(other, 'package.json'));
    const second = fishHandToolDefinition({ bodySwitch: { frameworkRoot: root, profileDir: other } });
    await assert.rejects(call({ action: 'query', analysisId: first.result.analysisId, queryType: 'summary' }, second), /PROFILE_MISMATCH/);
    await assert.rejects(call({ action: 'analyze', analysisSource: selected }), /analysisType/);
    await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: { path: source } }), /explicitly/);
    await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'local', path: '.' } }), /absolute/);
    assert.equal(fs.existsSync(marker), false); assert.equal(orchCalls, 0);
  });
  await t.test('off and closing reject new actions; admitted analysis drains before closing', async () => {
    select(false); const before = fs.readdirSync(path.join(root, '鱼的胃/分析')).sort();
    const blocked = await call({ action: 'analyze', analysisType: 'initial', analysisSource: selected });
    assert.equal(blocked.ok, false); assert.equal(blocked.result.phase, 'off');
    assert.deepEqual(fs.readdirSync(path.join(root, '鱼的胃/分析')).sort(), before);
    select(true);
    const pending = call({ action: 'analyze', analysisType: 'initial', analysisSource: selected });
    assert.equal(phase.activeOperationCount(profile), 1);
    let changed = false;
    const closing = phase.runBodySwitchChange({ profileDir: profile, enabled: false, operation: () => { changed = true; select(false); } });
    const noNew = await query(first.result.analysisId, 'summary');
    assert.equal(noNew.result.phase, 'closing'); assert.equal(changed, false);
    const result = await pending; assert.equal(result.ok, true); await closing;
    assert.equal(changed, true); assert.equal(phase.activeOperationCount(profile), 0); select(true);
  });
  await t.test('worker failure/result-then-exit/timeout cannot report success; no operation leak', async () => {
    const { analysisInChild } = await load('internal/analysis/process.mjs');
    for (const [name, code] of [['exit', 'process.exit(9)'], ['result-exit', "process.once('message',()=>{process.send({value:{ok:true}},()=>process.exit(7))})"], ['timeout', 'setInterval(()=>{},1000)']]) {
      const entry = path.join(work, name + '.mjs'); write(entry, code);
      await assert.rejects(phase.withBodyOperation(profile, () => analysisInChild({}, { entry, timeoutMs: name === 'timeout' ? 300 : 5000 })), /without|process|timed out/i);
      assert.equal(phase.activeOperationCount(profile), 0);
    }
    const saved = process.env.DSH_NODE; process.env.DSH_NODE = path.join(work, 'missing-node.exe');
    try { await assert.rejects(call({ action: 'analyze', analysisType: 'initial', analysisSource: selected }), /DSH_NODE/); }
    finally { if (saved === undefined) delete process.env.DSH_NODE; else process.env.DSH_NODE = saved; }
    assert.equal(phase.activeOperationCount(profile), 0);
  });
  await t.test('parser diagnostic is retained rather than promoted to complete success', async () => {
    const broken = path.join(work, 'broken-source'); write(path.join(broken, 'broken.js'), 'export function broken( { if ( ');
    partial = await call({ action: 'analyze', analysisType: 'deep', analysisSource: { kind: 'local', path: broken } });
    assert.equal(partial.ok, true); assert.equal(partial.result.status, 'diagnostic-partial');
    assert(partial.result.completeness.parseFailures > 0);
    const q = await query(partial.result.analysisId, 'summary'); assert.equal(q.result.state, 'reused-diagnostic-partial');
  });
  await t.test('existing status path remains compatible', async () => {
    const legacy = fishHandToolDefinition({ orchestrator: { mode: 'isolation', frameworkRoot: root, list: () => [{ packageName: 'kept' }] } });
    const result = await legacy.execute({ action: 'status' }); assert.equal(result.ok, true); assert.equal(result.result.plugins[0].packageName, 'kept');
  });
  await t.test('real retained extras source passes through handler with any/inference and manual phase boundary', async () => {
    const real = process.env.FISH_ANALYSIS_REAL_SOURCE;
    assert(real, 'Provide the existing source-only real snapshot explicitly');
    const input = { kind: 'local', path: real };
    const quick = await call({ action: 'analyze', analysisType: 'initial', analysisSource: input });
    const rich = await call({ action: 'analyze', analysisType: 'deep', analysisSource: input, initialAnalysisId: quick.result.analysisId });
    assert.equal(rich.result.status, 'diagnostic-partial');
    const a = read(path.join(dir(rich.result.analysisId), 'run/analysis.json'));
    const resolve = a.wiring.find(w => w.member === 'resolve' && /tools/.test(w.use.file));
    const watch = a.wiring.find(w => w.member === 'watch' && /tools/.test(w.use.file));
    assert(resolve); assert(watch);
    for (const w of [resolve, watch]) {
      const result = await query(rich.result.analysisId, 'file', { file: w.use.file, line: w.use.startLine, limit: 20 });
      const row = result.result.page.items.find(r => r.kind === 'wiring' && r.originalId === w.id);
      assert(row); assert.equal(row.compilerBoundary.receiverAny, true);
      assert.match(JSON.stringify(row.compilerBoundary.attribution), /syntax|inference|provenance/i);
      assert(row.status); assert.equal(result.result.state, 'reused-diagnostic-partial');
      const details = await query(rich.result.analysisId, 'evidence', { id: row.id, limit: 2 });
      assert.equal(details.result.validity.analyzerExecutions, 0);
    }
    const capability = await query(rich.result.analysisId, 'capability', { name: 'feiyu_bili', limit: 2 });
    assert(capability.result.page.items[0].roots.length > 0); assert.match(capability.result.question.origin, /manual/);
    json(path.join(work, 'real-result-ids.json'), { initial: quick.result.analysisId, deep: rich.result.analysisId });
  });
});
test('combined status retains initial diagnostics even when deep has no parse failures', async () => {
  const mixed = path.join(work, 'partial-initial-source');
  write(path.join(mixed, 'valid.js'), 'export function apply(host){host.tools.register({name:"one",execute(){return 1}})}');
  write(path.join(mixed, 'broken.py'), 'a = )\n');
  const input = { kind: 'local', path: mixed };
  const quick = await call({ action: 'analyze', analysisType: 'initial', analysisSource: input });
  assert.equal(quick.result.status, 'diagnostic-partial');
  const combined = await call({ action: 'analyze', analysisType: 'deep', analysisSource: input, initialAnalysisId: quick.result.analysisId });
  assert.equal(combined.result.status, 'diagnostic-partial');
  assert(combined.result.completeness.parseFailures > 0);
  assert.equal(combined.result.completeness.runs.find(r => r.name === 'deep').completeness.parseFailures, 0);
  assert.equal(read(path.join(dir(combined.result.analysisId), 'record.json')).status, 'diagnostic-partial');
  assert.equal((await query(combined.result.analysisId, 'summary')).result.state, 'reused-diagnostic-partial');
});
test.after(() => {
  json(path.join(work, 'tool-examples.json'), examples);
  json(path.join(work, 'measurements.json'), { counts, examples: examples.length, node: process.version, execPath: process.execPath, electron: process.versions.electron ?? null,
    returnBytes: examples.map(e => Buffer.byteLength(JSON.stringify(e.value))), markerExists: fs.existsSync(marker), activeOperations: phase.activeOperationCount(profile), tokenUsage: null });
});
