import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathIdentity, samePath } from '../backend/lib/path-identity.mjs';
import { writeJson } from './io.mjs';
import { treeManifest, treeHashOf } from '../backend/lib/w6-utils.mjs';
import { analyze, compose, query, validateRun } from './unified.mjs';

const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const kinds = new Set(['initial', 'deep']);
const queries = new Set(['summary', 'evidence', 'file', 'capability', 'phase']);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function checkId(id) { if (typeof id !== 'string' || !idPattern.test(id)) throw Error('FH_ANALYSIS_ID_INVALID: use a backend-issued analysisId, not a path'); }
function fixedSourceError(reason) {
  return Object.assign(new Error('FH_ANALYSIS_FIXED_SOURCE_CHANGED: ' + reason), { code: 'FH_ANALYSIS_FIXED_SOURCE_CHANGED' });
}
function checkMaterialFiles(expected, actual, label) {
  if (expected.length !== actual.length || expected.some((f, i) => f.path !== actual[i].path))
    throw fixedSourceError(label + ' file set/order differs from collected manifest');
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].bytes !== actual[i].bytes || expected[i].sha256 !== actual[i].sha256)
      throw fixedSourceError(label + ' content differs from collected manifest: ' + expected[i].path);
  }
}
function resolveSource(input, scope, snapshot = null) {
  if (!input || !['local', 'request'].includes(input.kind)) throw Error('analysisSource.kind must explicitly be local or request');
  if (input.kind === 'local') {
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw Error('local source requires an explicit absolute directory');
    const dir = fs.realpathSync.native(input.path);
    if (!fs.statSync(dir).isDirectory()) throw Error('local source is not a directory');
    return { kind: 'local', path: dir, identity: 'exact scoped bytes; no upstream commit claim' };
  }
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(input.requestId)) throw Error('Invalid requestId');
  // Read the existing canonical request, without creating installation intent.
  const rec = read(path.join(scope.frameworkRoot, '鱼的手', '插件注册表', 'requests', input.requestId + '.json'));
  if ((rec.id ?? rec.requestId) !== input.requestId || !samePath(rec.targetProfile, scope.profileDir)) throw Error('FH_ANALYSIS_PROFILE_MISMATCH: fixed request belongs to another Profile');
  if (!rec.rice?.dir || !rec.source?.pinnedCommit || !rec.source?.contentHash) throw Error('Request has no fixed source material; select a local directory or collect it separately');
  const source = read(path.join(rec.rice.dir, '来源.json')), content = read(path.join(rec.rice.dir, '内容清单.json'));
  if (source.pinnedCommit !== rec.source.pinnedCommit || (content.pinnedCommit && content.pinnedCommit !== source.pinnedCommit) || source.contentHash !== rec.source.contentHash)
    throw fixedSourceError('fixed source metadata mismatch');
  if (!Array.isArray(content.files) || content.files.some(f => !f || typeof f.path !== 'string' || !f.path
    || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^sha256:[0-9a-f]{64}$/.test(f.sha256)))
    throw fixedSourceError('collected manifest requires per-file path, bytes and sha256');
  // Exactly the collector's path + NUL + sha256 + LF protocol, in its en order.
  const digest = treeHashOf(content.files);
  if (digest !== source.contentHash || !(content.treeHash || content.contentHash)
    || ['treeHash', 'contentHash'].some(key => Object.hasOwn(content, key) && content[key] !== digest))
    throw fixedSourceError('collected manifest digest does not match recorded content identity');
  const dir = path.join(rec.rice.dir, '仓库');
  const manifest = root => treeManifest(root).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  // Full collection identity, including files the analyzers deliberately skip.
  checkMaterialFiles(content.files, manifest(dir), 'fixed source');
  if (snapshot) {
    const scoped = content.files.filter(f => !f.path.split('/').some(p => ['.git', 'node_modules', '.cache'].includes(p)));
    checkMaterialFiles(scoped, manifest(snapshot), 'analysis snapshot');
  }
  return { kind: 'request', requestId: input.requestId, path: dir, recordedCommit: source.pinnedCommit,
    recordedContentIdentity: source.contentHash, provenance: 'existing collector records, not a new remote commit verification; analyzed bytes retained and compared exactly' };
}
function context(scope) {
  const profile = pathIdentity(scope.profileDir), root = fs.realpathSync.native(scope.frameworkRoot);
  if (!profile || !fs.statSync(scope.profileDir).isDirectory()) throw Error('Missing current Profile');
  // Each record owns an exact Profile identity. No path-derived content key or
  // second cache: IDs locate records, byte witnesses decide whether reuse works.
  return { root: path.join(root, '鱼的胃', '分析'), profile, frameworkRoot: root, profileDir: scope.profileDir };
}
function loadRecord(ctx, id) {
  checkId(id);
  const dir = path.join(ctx.root, id), rec = read(path.join(dir, 'record.json'));
  if (rec.analysisId !== id || rec.profile !== ctx.profile) throw Error('FH_ANALYSIS_PROFILE_MISMATCH');
  if (!kinds.has(rec.kind)) throw Error('Missing or unsupported saved analysis kind; choose a new output');
  return { dir, rec };
}
function validateSource(rec, ctx, dir) {
  const current = resolveSource(rec.source, ctx, path.join(dir, 'run', 'source-snapshot'));
  if (JSON.stringify(current) !== JSON.stringify(rec.source)) throw Error('Analysis source identity changed; explicitly create a new result');
}
function validateSavedSources(rec, ctx, dir) {
  validateSource(rec, ctx, dir);
  if (rec.initialAnalysisId) {
    const initial = loadRecord(ctx, rec.initialAnalysisId);
    validateSource(initial.rec, ctx, initial.dir);
  }
}
function atomicRecord(dir, rec) {
  const tmp = path.join(dir, 'record.' + process.pid + '.tmp'); writeJson(tmp, rec); fs.renameSync(tmp, path.join(dir, 'record.json'));
}
// Shared read boundary for task planning/materials. Never repairs or reruns an analysis.
export async function openTaskAnalysis(scope, id) {
  const ctx = context(scope), { dir, rec } = loadRecord(ctx, id);
  if (!['ready', 'diagnostic-partial'].includes(rec.status)) throw Error('Analysis is not completed: ' + rec.status);
  validateSavedSources(rec, ctx, dir);
  const summary = await query(path.join(dir, rec.bundle), 'summary');
  if (!summary.validity.valid) throw Error('FH_TASK_ANALYSIS_INVALID: ' + summary.validity.reasons.join('; '));
  return { ctx, dir, rec, summary, bundle: read(path.join(dir, rec.bundle, 'bundle.json')) };
}
export async function runAnalysisJob({ args, scope }) {
  if (args.action === 'task') {
    const { taskJob } = await import('./tasks.mjs');
    return taskJob(args, scope, { context, openTaskAnalysis, checkId });
  }
  const ctx = context(scope);
  if (args.action === 'query') {
    if (!queries.has(args.queryType)) throw Error('queryType: summary, evidence, file, capability or phase required');
    const { dir, rec } = loadRecord(ctx, args.analysisId);
    if (!['ready', 'diagnostic-partial'].includes(rec.status)) throw Error('Analysis is not a completed result: ' + rec.status);
    validateSavedSources(rec, ctx, dir);
    const savedKind = validateRun(path.join(dir, 'run'), rec.source.path, rec.kind);
    if (!savedKind.valid) return { ok: false, action: 'query', result: { analysisId: rec.analysisId, kind: rec.kind,
      state: 'invalid-result', validity: savedKind, analyzerExecutions: 0, next: 'Keep old result; explicitly choose new analysis output' } };
    const options = args.queryOptions ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('queryOptions must be an object');
    const result = await query(path.join(dir, rec.bundle), args.queryType, options);
    return { ok: result.validity.valid, action: 'query', result: { analysisId: rec.analysisId, kind: rec.kind, ...result } };
  }
  if (args.action !== 'analyze' || !kinds.has(args.analysisType)) throw Error('analyze requires analysisType initial or deep');
  const source = resolveSource(args.analysisSource, ctx);
  let dir, rec, reused = false;
  if (args.analysisId) {
    ({ dir, rec } = loadRecord(ctx, args.analysisId));
    if (rec.kind !== args.analysisType) throw Error('Analysis kind mismatch; choose a new analysisId/output. Existing material was not changed');
    if (JSON.stringify(source) !== JSON.stringify(rec.source)) throw Error('Analysis source changed; choose a new analysisId/output');
    if (!['ready', 'diagnostic-partial'].includes(rec.status)) throw Error('Incomplete or failed analysis cannot be reused; choose a new output');
    validateSavedSources(rec, ctx, dir);
    reused = true;
  } else {
    const id = randomUUID(); dir = path.join(ctx.root, id);
    if (samePath(dir, source.path) || pathIdentity(dir).startsWith(pathIdentity(source.path) + '/')) throw Error('Result directory must be outside source');
    rec = { analysisId: id, profile: ctx.profile, kind: args.analysisType, source, status: 'running', createdAt: new Date().toISOString() };
  }
  let initial;
  if (args.initialAnalysisId) {
    if (args.analysisType !== 'deep' || reused) throw Error('initialAnalysisId is only for a new explicit deep analysis');
    initial = loadRecord(ctx, args.initialAnalysisId);
    validateSavedSources(initial.rec, ctx, initial.dir);
    if (initial.rec.kind !== 'initial' || !validateRun(path.join(initial.dir, 'run'), source.path, 'initial').valid) throw Error('initialAnalysisId must be a valid initial result for identical source bytes');
  }
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'operation.lock'), handle = fs.openSync(lock, 'wx');
  try {
    if (!reused) atomicRecord(dir, rec);
    const execution = await analyze(args.analysisType, source.path, path.join(dir, 'run'));
    if (!execution.validity.valid) throw Error('Source or rules changed during analysis; result invalid');
    // Recheck the full material and bind the bytes actually copied, even if a
    // writer changed the source during copying and restored it before this check.
    validateSavedSources({ ...rec, initialAnalysisId: rec.initialAnalysisId ?? args.initialAnalysisId }, ctx, dir);
    if (!reused) {
      const runs = [...(initial ? [{ name: 'initial', path: path.join(initial.dir, 'run') }] : []), { name: args.analysisType, path: path.join(dir, 'run') }];
      compose(source.path, path.join(dir, 'bundle'), runs);
      rec.bundle = 'bundle'; rec.initialAnalysisId = args.initialAnalysisId ?? null;
    }
    const summary = await query(path.join(dir, rec.bundle), 'summary');
    if (!summary.validity.valid) throw Error('Analysis bundle invalid; explicitly choose a fresh result');
    const status = summary.state === 'reused-diagnostic-partial' ? 'diagnostic-partial' : 'ready';
    const completeness = { mode: status === 'diagnostic-partial' ? status : 'evidence-with-known-limits',
      parseFailures: summary.validity.runs.reduce((n, r) => n + r.completeness.parseFailures, 0),
      incompleteRelations: summary.validity.runs.reduce((n, r) => n + r.completeness.incompleteRelations, 0),
      completeRuntimeProof: false, runs: summary.validity.runs };
    if (!reused) {
      rec.status = status; rec.finishedAt = new Date().toISOString(); atomicRecord(dir, rec);
    }
    return { ok: true, action: 'analyze', result: { analysisId: rec.analysisId, kind: rec.kind, initialAnalysisId: rec.initialAnalysisId ?? null, status, source,
      action: execution.action, analyzerExecutions: execution.analyzerExecutions, elapsedMs: execution.elapsedMs,
      completeness, summary: summary.page,
      next: 'query with analysisId and queryType; initial does not run deep. New deep may explicitly reference initialAnalysisId.',
      boundary: 'Analysis material/splitting evidence only. No candidate execution, safety approval, splitting or installation.' } };
  } catch (error) {
    if (!reused) atomicRecord(dir, { ...rec, status: 'failed', error: error.message });
    error.message += '; analysisId=' + rec.analysisId; throw error;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
if (process.send) process.once('message', async job => {
  try {
    const value = await runAnalysisJob(job);
    for (let i = 0; i < 3; i++) value.result.returnBytes = Buffer.byteLength(JSON.stringify(value));
    if (value.result.returnBytes > 16000) throw Error('Tool response exceeds 16000 byte budget; request a smaller page');
    process.send({ value }, () => process.disconnect());
  } catch (error) {
    process.exitCode = 1;
    process.send({ error: { code: error.code ?? 'FH_ANALYSIS_FAILED', message: error.message } }, () => process.disconnect());
  }
});
