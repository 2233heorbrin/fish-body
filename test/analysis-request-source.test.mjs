import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const install = process.env.FISH_TEST_INSTALL_ROOT, work = process.env.FISH_REQUEST_TEST_ROOT;
const loadLog = process.env.FISH_ANALYSIS_LOAD_LOG;
if (!install || !work || !loadLog || fs.existsSync(work)) throw Error('Use a fresh request test root, current extracted package and analyzer load log');
fs.mkdirSync(work, { recursive: true });
const pkg = path.join(install, 'node_modules/fish-body'), load = f => import(pathToFileURL(path.join(pkg, f)));
const { fishHandToolDefinition } = await load('internal/backend/fish-body-approval.mjs');
const { collectFromArchive, ingest } = await load('internal/backend/lib/upstream.mjs');
const { activeOperationCount } = await load('internal/backend/lib/body-switch.mjs');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const json = (f, o) => write(f, JSON.stringify(o, null, 2));
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const root = path.join(work, 'body'), profile = path.join(work, 'profile');
fs.mkdirSync(root); fs.mkdirSync(profile);
json(path.join(profile, 'package.json'), { dependencies: { 'fish-body': 'file:test' }, dsh: { profile: { bundles: ['fish-body'] } } });
const tool = fishHandToolDefinition({ bodySwitch: { frameworkRoot: root, profileDir: profile } });
const marker = path.join(work, 'CANDIDATE_EXECUTED'), commit = 'a'.repeat(40), events = [];
const analyzerLoads = () => fs.existsSync(loadLog) ? fs.readFileSync(loadLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  .map(JSON.parse).filter(r => /\/internal\/analysis\/(scan|morph-scan)\.mjs$/.test(r.url)) : [];
async function call(args, target = tool) {
  const before = analyzerLoads().length;
  try {
    const value = await target.execute(args);
    events.push({ args, value, analyzerExecutions: analyzerLoads().length - before });
    return value;
  } catch (error) {
    events.push({ args, error: { code: error.code, message: error.message }, analyzerExecutions: analyzerLoads().length - before });
    throw error;
  }
}
async function refuses(args, reason, target = tool) {
  const before = analyzerLoads().length;
  await assert.rejects(call(args, target), reason);
  assert.equal(analyzerLoads().length, before, 'source refusal must precede analyzer startup');
}
function material(name) {
  const archive = path.join(work, 'archives', name);
  json(path.join(archive, 'package.json'), { name: 'request-fixture', version: '1.0.0', type: 'module', main: 'entry.js', scripts: { prepare: 'node entry.js' } });
  write(path.join(archive, 'entry.js'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');export const VALUE=1;export function apply(host){host.tools.register({name:'fixture',execute(){return VALUE}})}`);
  for (const f of ['Z.dat', 'a.dat', '中文.dat', '.cache/retained.bin', 'node_modules/retained.bin']) write(path.join(archive, f), 'original');
  const collection = collectFromArchive({ repoDir: archive, commit, sourceEntry: { repoDir: archive, head: commit, downloadMethod: 'codeload-tar' } });
  const rice = ingest({ riceRoot: path.join(work, 'rice'), repoDir: archive, repoName: name, requestId: name, packageName: 'request-fixture', commit, collected: collection });
  const requestFile = path.join(root, '鱼的手/插件注册表/requests', name + '.json');
  json(requestFile, { id: name, targetProfile: profile, rice: { dir: rice.riceDir }, source: { pinnedCommit: commit, contentHash: collection.treeHash } });
  return { ...rice, requestFile, source: { kind: 'request', requestId: name }, collection };
}
const analysis = (m, extra = {}) => ({ action: 'analyze', analysisType: 'initial', analysisSource: m.source, ...extra });
const query = id => ({ action: 'query', analysisId: id, queryType: 'summary' });
const output = id => path.join(root, '鱼的胃/分析', id);
let good, initial, deep;

test('fixed request material content and snapshot contract', async t => {
  await t.test('A: real collector manifest admits initial, query, reuse and associated deep', async () => {
    good = material('good'); const request = fs.readFileSync(good.requestFile);
    initial = await call(analysis(good)); assert.equal(initial.ok, true);
    assert.equal(initial.result.source.recordedCommit, commit);
    assert.equal(initial.result.source.recordedContentIdentity, good.collection.treeHash);
    assert.equal((await call(query(initial.result.analysisId))).ok, true);
    const reuse = await call(analysis(good, { analysisId: initial.result.analysisId }));
    assert.equal(reuse.result.analyzerExecutions, 0);
    // Exercise a local deep with a request initial: later validation must also
    // check that linked initial's full material, not just the local subset.
    deep = await call(analysis(good, { analysisType: 'deep', analysisSource: { kind: 'local', path: good.warehouseDir }, initialAnalysisId: initial.result.analysisId }));
    assert.equal(deep.ok, true);
    assert.equal(fs.existsSync(path.join(output(deep.result.analysisId), 'run/source-snapshot/.cache')), false);
    assert(good.contentDoc.files.some(f => f.path.startsWith('.cache/')));
    assert(fs.readFileSync(good.requestFile).equals(request));
  });
  await t.test('B: same file names and lengths with different bytes refuse first analysis before analyzers', async () => {
    const bad = material('same-length'), file = path.join(bad.warehouseDir, 'entry.js');
    const original = fs.readFileSync(file), changed = Buffer.from(original.toString().replace('VALUE=1', 'VALUE=2'));
    assert.equal(original.length, changed.length); assert(!original.equals(changed)); fs.writeFileSync(file, changed);
    const before = fs.readdirSync(path.join(root, '鱼的胃/分析')).sort();
    await refuses(analysis(bad), /fixed source content differs.*entry\.js/);
    assert.deepEqual(fs.readdirSync(path.join(root, '鱼的胃/分析')).sort(), before);
    assert(fs.readFileSync(file).equals(changed));
  });
  await t.test('C: edits, including ignored files, invalidate reuse, query and the request initial linked by local deep', async () => {
    const saved = ['record.json', 'run/analysis.json', 'run/reuse.json'].map(f => [f, fs.readFileSync(path.join(output(initial.result.analysisId), f))]);
    for (const name of ['entry.js', '.cache/retained.bin', 'node_modules/retained.bin']) {
      const file = path.join(good.warehouseDir, name), original = fs.readFileSync(file);
      const changed = Buffer.from(original); changed[0] ^= 1; fs.writeFileSync(file, changed);
      try {
        await refuses(analysis(good, { analysisId: initial.result.analysisId }), /fixed source content differs/);
        await refuses(query(initial.result.analysisId), /fixed source content differs/);
        await refuses(query(deep.result.analysisId), /fixed source content differs/);
        await refuses(analysis(good, { analysisType: 'deep', analysisSource: { kind: 'local', path: good.warehouseDir }, analysisId: deep.result.analysisId }), /fixed source content differs/);
        await refuses(analysis(good, { analysisType: 'deep', analysisSource: { kind: 'local', path: good.warehouseDir }, initialAnalysisId: initial.result.analysisId }), /fixed source content differs/);
      } finally { fs.writeFileSync(file, original); }
    }
    for (const [f, bytes] of saved) assert(fs.readFileSync(path.join(output(initial.result.analysisId), f)).equals(bytes));
  });
  await t.test('D: changed manifest digest, missing identities and file additions/removals refuse without repair', async () => {
    const original = fs.readFileSync(good.contentListPath), doc = JSON.parse(original);
    try {
      const changed = structuredClone(doc); changed.files[0].sha256 = 'sha256:' + '0'.repeat(64); json(good.contentListPath, changed);
      await refuses(analysis(good), /manifest digest does not match/);
      await refuses(query(initial.result.analysisId), /manifest digest does not match/);
      delete changed.files[0].sha256; json(good.contentListPath, changed);
      await refuses(analysis(good), /requires per-file path, bytes and sha256/);
    } finally { fs.writeFileSync(good.contentListPath, original); }
    const added = path.join(good.warehouseDir, 'extra.dat'); write(added, 'extra');
    try { await refuses(analysis(good), /file set\/order differs/); } finally { fs.unlinkSync(added); }
    const file = path.join(good.warehouseDir, 'a.dat'), bytes = fs.readFileSync(file); fs.unlinkSync(file);
    try { await refuses(analysis(good), /file set\/order differs/); } finally { fs.writeFileSync(file, bytes); }
    assert(fs.readFileSync(good.contentListPath).equals(original));
  });
  await t.test('existing npm contentHash manifest variant uses the same collected-byte binding', async () => {
    const original = fs.readFileSync(good.contentListPath), doc = JSON.parse(original);
    doc.contentHash = doc.treeHash; delete doc.treeHash; delete doc.pinnedCommit; doc.schema = 'rice-content-list/v1';
    try { json(good.contentListPath, doc); assert.equal((await call(query(initial.result.analysisId))).ok, true); }
    finally { fs.writeFileSync(good.contentListPath, original); }
  });
  await t.test('E: local needs no collection manifest and Profile isolation is retained', async () => {
    const local = path.join(work, 'local'); write(path.join(local, 'entry.js'), 'export const value=1');
    const value = await call({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'local', path: local } });
    assert.equal(value.ok, true); assert.equal(value.result.source.recordedCommit, undefined);
    assert.equal((await call(query(value.result.analysisId))).ok, true);
    const other = path.join(work, 'other-profile'); fs.mkdirSync(other); fs.copyFileSync(path.join(profile, 'package.json'), path.join(other, 'package.json'));
    const second = fishHandToolDefinition({ bodySwitch: { frameworkRoot: root, profileDir: other } });
    await refuses(analysis(good), /another Profile/, second);
    await refuses(query(initial.result.analysisId), /PROFILE_MISMATCH/, second);
  });
  await t.test('copy-time changes restored before admission still reject the actual wrong snapshot', async () => {
    const race = material('copy-race'), file = path.join(race.warehouseDir, 'entry.js'), original = fs.readFileSync(file);
    process.env.FISH_REQUEST_RACE_SOURCE = file;
    process.env.FISH_REQUEST_RACE_MARKER = path.join(work, 'race-writer.json');
    const before = analyzerLoads().length;
    try { await assert.rejects(call(analysis(race)), /analysis snapshot content differs.*entry\.js/); }
    finally { delete process.env.FISH_REQUEST_RACE_SOURCE; delete process.env.FISH_REQUEST_RACE_MARKER; }
    assert.equal(analyzerLoads().length - before, 1);
    assert(fs.readFileSync(file).equals(original));
    assert.equal(read(path.join(work, 'race-writer.json')).restoredBeforeAdmission, true);
    const failed = fs.readdirSync(path.join(root, '鱼的胃/分析')).map(id => read(path.join(output(id), 'record.json'))).find(r => r.source.requestId === 'copy-race');
    assert.equal(failed.status, 'failed'); assert.equal(failed.bundle, undefined);
  });
});
test.after(() => {
  assert.equal(fs.existsSync(marker), false); assert.equal(activeOperationCount(profile), 0);
  json(path.join(work, 'events.json'), events);
  json(path.join(work, 'measurements.json'), { node: process.version, electron: process.versions.electron ?? null, execPath: process.execPath,
    analyzerLoads: analyzerLoads(), successes: events.filter(e => e.value?.ok).length, rejections: events.filter(e => e.error).length,
    rejectedBeforeAnalyzer: events.filter(e => e.error && e.analyzerExecutions === 0).length, markerExists: fs.existsSync(marker), activeOperations: activeOperationCount(profile) });
});
