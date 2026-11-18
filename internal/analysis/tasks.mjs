// Planning and source materials only. Uses the analysis worker's shared validity boundary.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from './io.mjs';
import { recordEntries, findRecordDirectory, newRecordDirectory, sourcePlugin, recordMetadata, recordPlugin } from './records.mjs';
import { conversationGuide } from './conversation.mjs';
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const modes = ['compatibility', 'reverse'], categories = ['tool', 'brain', 'mixed', 'unknown'];
const depKinds = ['implementation', 'shared-state-initialization', 'lifecycle-release', 'resources-programs', 'incidental-behavior', 'unresolved-relation'];
const text = (s, label, max = 2000) => { if (typeof s !== 'string' || !s.trim() || s.length > max) throw Error(label + ' requires nonempty text, max ' + max); return s.trim(); };
function origin(v) {
  if (!v || !['user', 'current-model'].includes(v.kind)) throw Error('Judgment requires attributed user/current-model origin');
  return { kind: v.kind, actor: text(v.actor, 'actor', 160), reason: text(v.reason, 'reason'), attribution: 'caller-declared, not identity authentication' };
}
function page(rows, options = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 5;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('offset>=0, limit=1..20 required');
  const items = []; let i = offset;
  for (; i < rows.length && items.length < limit; i++) { if (Buffer.byteLength(JSON.stringify([...items, rows[i]])) > 9500) break; items.push(rows[i]); }
  if (i < rows.length && !items.length) throw Error('Row exceeds budget; read output detail parts');
  return { items, offset, limit, total: rows.length, nextOffset: i < rows.length ? i : null, hasMore: i < rows.length };
}
function parts(value, pointer = '') {
  if (Buffer.byteLength(JSON.stringify(value)) < 1800) return [{ pointer, value }];
  if (typeof value === 'string') return Array.from({ length: Math.ceil(value.length / 600) }, (_, i) => ({ pointer, characterOffset: i * 600, value: value.slice(i * 600, (i + 1) * 600), continued: (i + 1) * 600 < value.length }));
  return Object.entries(value ?? {}).flatMap(([k, v]) => parts(v, pointer + '/' + k.replaceAll('~', '~0').replaceAll('/', '~1')));
}
const refOf = r => ({ id: r.id, file: r.coordinate?.file ?? null, line: r.coordinate?.line ?? null, endLine: r.coordinate?.endLine ?? null, unit: r.coordinate?.unit ?? null, raw: r.raw, status: r.status, layer: r.layer });
const analysisUnknowns = a => a.bundle.records.filter(r => ['unknown','ignored','failure','unresolved-call'].includes(r.kind)).map(r => ({ text: r.label, origin: {kind:'program',reason:'Retained analysis limitation; query exact evidence for full conditions'}, evidenceRefs:[r.id] }));
function refs(input, a) {
  if (!Array.isArray(input) || input.length > 40) throw Error('evidenceRefs must be an array of at most 40 exact IDs');
  return [...new Set(input)].map(id => { const r = a.bundle.records.find(r => r.id === id); if (!r) throw Error('Unknown evidence ID: ' + id); return id; });
}
function candidates(a) {
  const list = a.bundle.capabilities.map(c => ({ id: c.id, name: c.name, category: /self|persona|memory|mood/.test(c.name) ? 'brain' : 'tool',
    origin: { kind: 'program', reason: 'Syntactic declaration/name candidate; not confirmed semantics' }, evidenceRefs: [c.id, c.evidence].filter(Boolean) }));
  for (const r of a.bundle.records.filter(r => r.kind === 'category-candidate' && r.originalId === 'prompt')) list.push({ id: r.id, name: '人格/提示贡献', category: 'brain', origin: { kind: 'program', reason: 'Observed prompt contribution; scope requires discussion' }, evidenceRefs: [r.id] });
  return list;
}
function classification(a) {
  const tool = a.bundle.records.filter(r => r.kind === 'observation' && ['tool-registration', 'tool-definition'].includes(r.detail.category));
  const brain = a.bundle.records.filter(r => r.kind === 'observation' && r.detail.category === 'prompt-injection');
  return { value: tool.length && brain.length ? 'mixed' : brain.length ? 'brain' : tool.length ? 'tool' : 'unknown',
    origin: 'program-candidate', reason: 'Only positive syntactic observations; no hit is unknown. State access alone is not brain memory; runtime ownership/coverage unproved.',
    evidenceRefs: [...tool.slice(0,4), ...brain.slice(0,4)].map(r => r.id), confirmed: false };
}
function dependencies(t, a) {
  return t.selected.flatMap(id => {
    const c = t.capabilities.find(c => c.id === id), rec = a.bundle.records.find(r => r.id === id), detail = rec?.detail ?? {};
    const related = a.bundle.records.filter(r => r.run === rec?.run && (detail.scopedEvidence ?? []).includes(r.originalId));
    const global = {
      'shared-state-initialization': ['state-access'], 'lifecycle-release': ['listener', 'timer', 'lifecycle'],
      'resources-programs': ['process', 'external-resource', 'dynamic-import'], 'incidental-behavior': ['prompt-injection', 'route']
    };
    return depKinds.map((kind, i) => {
      const scope = kind === 'implementation' ? related : a.bundle.records.filter(r => r.kind === 'observation' && (global[kind] ?? []).includes(r.detail.category));
      const previous = t.dependencies?.find(d => d.id === id + ':D' + (i + 1));
      const evidenceRefs = refs(previous?.evidenceRefs ?? [...new Set([...c.evidenceRefs, ...scope.slice(0,8).map(r => r.id)])], a);
      return { id: id + ':D' + (i + 1), capabilityId: id, kind, evidenceRefs,
        candidateModules: kind === 'implementation' ? detail.codeModules ?? [] : [],
        relation: kind === 'implementation' ? 'Declaration/scoped calls and module closure are candidate implementation, not a proven minimum.' : 'Whole-plugin context; relation to selected capability still requires source/semantic review.',
        scope: { observed: scope.length, referenced: Math.min(scope.length,8), truncated: scope.length > 8 },
        decision: previous?.decision ?? 'pending', rationale: previous?.rationale ?? '待讨论：具体影响、必要范围及替代接线未确认。',
        origin: previous?.origin ?? { kind: 'program-candidate' }, proposedChange: previous?.proposedChange ?? null,
        businessSemanticChange: previous?.businessSemanticChange ?? 'unknown', acceptance: previous?.acceptance ?? null };
    });
  });
}
function currentExplanation(t) {
  return t.explanation?.revision === t.revision && t.explanation.analysisId === t.analysisId ? t.explanation : null;
}
function explain(value, t, a) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('请提供当前模型的方案说明对象。');
  const allowed = ['origin','goal','recommendation','retained','excluded','impacts','questions','nextSteps','evidenceRefs'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw Error('说明含不支持字段，请按 taskPatch.explanation 保存。');
  const attributed = origin(value.origin);
  if (attributed.kind !== 'current-model') throw Error('方案说明必须保留 current-model 归属，不代替用户决定。');
  const items = (input, max, map) => {
    if (!Array.isArray(input ?? []) || (input ?? []).length > max) throw Error('请缩短说明，只保留少量相关功能、影响和问题。');
    return (input ?? []).map(map);
  };
  const capability = (id, selected) => {
    if (!t.capabilities.some(c => c.id === id) || t.selected.includes(id) !== selected) throw Error('说明中的保留/排除功能与当前选择不一致，请先刷新任务。');
    return id;
  };
  const feature = selected => item => ({ capabilityId: capability(item.capabilityId, selected),
    ...(item.label ? { label: text(item.label, '功能说明名', 80) } : {}), reason: text(item.reason, '功能取舍理由', 240), evidenceRefs: refs(item.evidenceRefs ?? [], a) });
  const dependency = id => { if (!t.dependencies.some(d => d.id === id)) throw Error('说明引用了当前任务之外的依赖，请刷新任务。'); return id; };
  const result = { analysisId: t.analysisId, revision: t.revision, origin: attributed, goal: text(value.goal, '用户目标', 400), recommendation: text(value.recommendation, '简明推荐', 800),
    retained: items(value.retained, 12, feature(true)), excluded: items(value.excluded, 12, feature(false)),
    impacts: items(value.impacts, 12, item => ({ dependencyId: dependency(item.dependencyId), text: text(item.text, '使用影响', 280), evidenceRefs: refs(item.evidenceRefs ?? [], a) })),
    questions: items(value.questions, 5, item => ({ text: text(item.text, '待选问题', 280),
      ...(item.capabilityId ? { capabilityId: capability(item.capabilityId, t.selected.includes(item.capabilityId)) } : {}),
      ...(item.dependencyId ? { dependencyId: dependency(item.dependencyId) } : {}), evidenceRefs: refs(item.evidenceRefs ?? [], a) })),
    nextSteps: items(value.nextSteps, 6, item => text(item, '后续方向', 280)), evidenceRefs: refs(value.evidenceRefs ?? [], a) };
  if (Buffer.byteLength(JSON.stringify(result)) > 7000) throw Error('说明过长，请缩短推荐和问题；详细证据继续按需分页读取。');
  return result;
}
function overview(t) {
  const features = selected => t.capabilities.filter(c => t.selected.includes(c.id) === selected).slice(0,8).map(({id,name,category}) => ({id,name,category}));
  return { taskId: t.taskId, profile: t.profile, binding: t.binding, revision: t.revision, mode: t.mode, phase: t.phase,
    createdAt: t.createdAt, updatedAt: t.updatedAt ?? t.createdAt,
    analysisId: t.analysisId, analysisKind: t.analysisKind, initialAnalysisId: t.initialAnalysisId ?? null,
    source: t.source, plugin: t.plugin, classification: t.classification, judgment: t.judgment,
    selected: t.selected, counts: { capabilities: t.capabilities.length, dependencies: t.dependencies.length, pending: t.dependencies.filter(d => d.decision === 'pending').length },
    confirmation: t.confirmation, outputs: t.outputs, completeness: t.completeness,
    features: { retained: features(true), excluded: features(false), excludedCount: t.capabilities.length - t.selected.length },
    explanation: currentExplanation(t), explanationState: currentExplanation(t) ? 'current' : t.explanation ? 'stale' : 'missing',
    unknownCount: (t.analysisUnknowns?.length ?? 0) + t.unknowns.length,
    boundary: 'Plans/materials only; no adaptation, package, installation or global brain changes. Confirmation grants no deployment authority.',
    conversation: { action: 'task', taskOperation: 'read', taskId: t.taskId, taskView: 'dependencies', ...conversationGuide(t) } };
}
function safeSnapshot(a, file) {
  const run = path.join(a.dir, 'run/source-snapshot'), target = path.resolve(run, file);
  if (path.isAbsolute(file) || !target.startsWith(run + path.sep) || !fs.realpathSync.native(target).startsWith(fs.realpathSync.native(run) + path.sep)) throw Error('Source reference escapes verified snapshot');
  return target;
}
function sourceFragments(t, a) {
  const ranges = new Map();
  for (const id of t.selected) {
    const cap = t.capabilities.find(c => c.id === id);
    for (const evidence of [...new Set([...cap.evidenceRefs, ...t.dependencies.filter(d => d.capabilityId === id).flatMap(d => d.evidenceRefs.slice(0,5))])]) {
      const r = a.bundle.records.find(r => r.id === evidence); if (!r) continue;
      const coords = r.coordinate?.file ? r.coordinate : r.kind === 'capability' ? { file: r.detail.file, line: r.detail.line } : null;
      if (!coords?.file) continue;
      const f = coords.file, bytes = fs.readFileSync(safeSnapshot(a, f));
      if (bytes.includes(0) || !/\.(?:[cm]?[jt]sx?|py|rs|c|cpp|h|json|md)$/.test(f)) { ranges.set(f, { file: f, support: 'unsupported/binary: no fabricated source or call graph', evidenceRefs: [evidence] }); continue; }
      const lines = bytes.toString('utf8').split(/\r?\n/), from = Math.max(1, (coords.line ?? 1) - 3), end = Math.min(lines.length, coords.endLine ?? (coords.line ?? 1) + 25);
      const key = f + ':' + from + ':' + end;
      ranges.set(key, { file: f, startLine: from, endLine: end, support: 'text excerpt; not isolated runnable component', evidenceRefs: [...new Set([...(ranges.get(key)?.evidenceRefs ?? []), evidence])],
        content: lines.slice(from - 1, end).join('\n'), context: 'Only these declaration ranges are selected. Other code in this shared file is not proven necessary; dependency closure is context, not extraction.' });
    }
  }
  return [...ranges.values()];
}
function artifact(t, a) {
  const retained = t.capabilities.filter(c => t.selected.includes(c.id)), excluded = t.capabilities.filter(c => !t.selected.includes(c.id));
  const common = { schema: 'fish-stomach-task-output/v1', taskId: t.taskId, revision: t.revision, mode: t.mode, analysisId: t.analysisId, plugin: t.plugin,
    source: t.source, classification: { candidate: t.classification, judgment: t.judgment }, retained, excluded,
    dependencies: t.dependencies, completeness: t.completeness, unknowns: [...(t.analysisUnknowns ?? []), ...t.unknowns], explanation: currentExplanation(t),
    scope: 'plugin-local; never overwrite fish global persona/memory/mood. Module closure does not prove required code. No probability or runtime safety claim.',
    evidence: [...new Set([...retained.flatMap(c => c.evidenceRefs), ...t.dependencies.flatMap(d => d.evidenceRefs)])].map(id => refOf(a.bundle.records.find(r => r.id === id))) };
  if (t.mode === 'compatibility') return { ...common, kind: 'compatibility-plan', status: '方案待确认/待执行',
    derivedIdentity: { name: t.plugin.name, nativeSwitches: 1, target: 'One unified derivative maintained by the hand; no independent capability plugins; no package produced this round' },
    wiring: ['imports', 'registration', 'scope', 'lifecycle'].map(area => ({ area, status: 'pending', proposal: 'Review dependency decisions and exact evidence before specifying edits; no fabricated file patch.',
      attributedProposals: t.dependencies.filter(d => d.proposedChange && (area === 'lifecycle' ? d.kind === 'lifecycle-release' : area === 'scope' ? ['shared-state-initialization','incidental-behavior'].includes(d.kind) : d.kind === 'implementation')).map(d => ({dependencyId:d.id,proposal:d.proposedChange,origin:d.origin,evidenceRefs:d.evidenceRefs})) })),
    semanticChanges: t.dependencies.map(d => ({ dependencyId: d.id, state: d.businessSemanticChange, proposal: d.proposedChange })),
    behaviorAcceptance: t.dependencies.filter(d => d.kind === 'incidental-behavior').map(d => ({ dependencyId: d.id, acceptance: d.acceptance, status: d.acceptance ? 'explicitly-recorded' : 'not-accepted' })),
    futureVerification: ['Retained tool business behavior and excluded capability absence', 'Store initialization and plugin-local data ownership', 'Threads/approval/feedback/routes and external process requirements', 'Enable/disable, cancellation and disposal; no global brain write', 'Native display name and one switch; later execution requires separate authorization'],
    executable: false, installable: false };
  return { ...common, kind: 'reverse-materials', status: '组件材料已产出（未解耦）', fragments: sourceFragments(t,a),
    moduleContext: t.dependencies.filter(d => d.kind === 'implementation').flatMap(d => d.candidateModules).filter((v,i,all) => all.indexOf(v) === i).map(file => ({ file, snapshot: path.join(a.dir,'run/source-snapshot',file), necessity: 'not proven; referenced context only, not copied whole file' })),
    independenceWork: ['Resolve shared state/init ownership and scope', 'Decide incidental brain behavior explicitly', 'Adapt imports/registration/resources/lifecycle in a separate task', 'Unsupported/dynamic relations require further discussion; not impossible by default'], runnablePlugin: false };
}
export async function taskJob(args, scope, helpers) {
  const { context, openTaskAnalysis, checkId } = helpers, ctx = context(scope), root = path.join(ctx.frameworkRoot, '鱼的胃', '任务');
  const op = args.taskOperation, options = args.taskOptions ?? {};
  const ok = result => ({ ok: true, action: 'task', result: { ...result, analyzerExecutions: 0 } });
  if (op === 'list') {
    const collection = args.taskView === 'analyses' ? ctx.root : root;
    const kind = args.taskView === 'analyses' ? 'analysis' : 'task';
    const rows = recordEntries(collection, kind).flatMap(({id,dir}) => {
      try { const r = read(path.join(dir,kind === 'analysis' ? 'record.json' : 'task.json')); if (r.profile !== ctx.profile) return [];
        return [{ id, analysisId: r.analysisId, mode: r.mode ?? null, status: r.phase ?? r.status, source: r.source,
          ...recordMetadata(r, dir, kind, ctx.root),
          ...(args.taskView === 'analyses' ? { kind: r.kind, initialAnalysisId: r.initialAnalysisId ?? null } : {}),
          verified: false, note: 'Validate on read/use; list is metadata only' }]; } catch { return []; }
    }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return ok({ page: page(rows, options) });
  }
  let t, dir, a;
  if (op === 'create') {
    if (!modes.includes(args.taskMode)) throw Error('Explicit compatibility/reverse required');
    a = await openTaskAnalysis(scope,args.analysisId);
    const taskId = randomUUID(), plugin = sourcePlugin(path.join(a.dir,'run/source-snapshot'), a.rec.source.path); dir = newRecordDirectory(root,'task',taskId,plugin);
    // Avoid writing task outputs into the candidate tree, even for a broad local source.
    if (dir === a.rec.source.path || dir.startsWith(a.rec.source.path + path.sep)) throw Error('Task output must be outside source');
    t = { schema:'fish-stomach-task/v1', taskId, profile:ctx.profile, binding:ctx.frameworkRoot, revision:1, mode:args.taskMode, phase:'selection-pending',
      analysisId:args.analysisId, analysisKind:a.rec.kind, initialAnalysisId:a.rec.initialAnalysisId ?? null, source:a.rec.source, plugin, classification:classification(a), judgment:null,
      capabilities:candidates(a), selected:[], dependencies:[], analysisUnknowns:analysisUnknowns(a), unknowns:[], outputs:[], confirmation:null, completeness:a.summary.validity, createdAt:new Date().toISOString() };
    fs.mkdirSync(dir,{recursive:true}); writeJson(path.join(dir,'task.json'),t); return ok(overview(t));
  }
  checkId(args.taskId); dir = findRecordDirectory(root,'task',args.taskId); t = read(path.join(dir,'task.json'));
  if (t.taskId !== args.taskId || t.profile !== ctx.profile || t.binding !== ctx.frameworkRoot) throw Error('FH_TASK_SCOPE_MISMATCH');
  // Explicit new analysis resets all selections/judgments; stale source cannot be read as valid.
  a = await openTaskAnalysis(scope,op === 'update' && args.taskPatch?.analysisId ? args.taskPatch.analysisId : t.analysisId);
  t.plugin = recordPlugin(t, dir, 'task', ctx.root);
  t.analysisKind = a.rec.kind; t.initialAnalysisId = a.rec.initialAnalysisId ?? null;
  if (op === 'read') {
    const rows = args.taskView === 'capabilities' ? t.capabilities : args.taskView === 'dependencies' ? t.dependencies : args.taskView === 'unknowns' ? [...(t.analysisUnknowns ?? []), ...t.unknowns] : null;
    return ok(rows ? { taskId:t.taskId, revision:t.revision, completeness:t.completeness, page:page(rows,options) } : overview(t));
  }
  if (op === 'output') {
    const output = t.outputs.find(o => o.revision === (args.outputRevision ?? t.revision)); if (!output) throw Error('No output for requested revision; explicitly produce');
    const document = read(path.join(dir,output.file)); await openTaskAnalysis(scope,document.analysisId);
    return ok({ taskId:t.taskId, revision:output.revision, historical:output.revision !== t.revision, output, page:page(parts(document),options) });
  }
  const fd = fs.openSync(path.join(dir,'operation.lock'),'wx');
  try {
    if (read(path.join(dir,'task.json')).revision !== t.revision) throw Error('FH_TASK_REVISION_CONFLICT: concurrent change; refresh');
    if (args.expectedRevision !== t.revision) throw Error('FH_TASK_REVISION_CONFLICT: refresh current task before mutation');
    if (op === 'update') {
      const p = args.taskPatch; if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('taskPatch required');
      const allowed = ['mode','analysisId','selected','classification','addCapabilities','dependencyDecisions','unknowns','explanation'];
      if (Object.keys(p).some(k => !allowed.includes(k))) throw Error('Unknown task patch field');
      if (p.analysisId) { t.analysisId=p.analysisId; t.source=a.rec.source; t.capabilities=candidates(a);t.selected=[];t.dependencies=[];t.classification=classification(a);t.judgment=null;t.unknowns=[];t.analysisUnknowns=analysisUnknowns(a);t.completeness=a.summary.validity;
        t.plugin=sourcePlugin(path.join(a.dir,'run/source-snapshot'), a.rec.source.path); }
      if (p.mode) { if (!modes.includes(p.mode)) throw Error('Invalid task mode');t.mode=p.mode; }
      for (const c of p.addCapabilities ?? []) { const o=origin(c.origin), evidenceRefs=refs(c.evidenceRefs ?? [],a); if (!['tool','brain','unknown'].includes(c.category)) throw Error('Invalid capability category');t.capabilities.push({id:'supplement/'+randomUUID(),name:text(c.name,'capability name',160),category:c.category,origin:o,evidenceRefs}); }
      if (p.classification) { if(!categories.includes(p.classification.value))throw Error('Invalid classification');t.judgment={value:p.classification.value,origin:origin(p.classification.origin),evidenceRefs:refs(p.classification.evidenceRefs ?? [],a)}; }
      if (p.selected) { if(!Array.isArray(p.selected)||p.selected.some(id=>!t.capabilities.some(c=>c.id===id)))throw Error('Select capability IDs, not files');t.selected=[...new Set(p.selected)]; }
      t.dependencies=dependencies(t,a);
      for(const d of p.dependencyDecisions ?? []) {const target=t.dependencies.find(x=>x.id===d.id);if(!target)throw Error('Unknown dependency ID');if(!['retain','narrow','exclude','pending'].includes(d.decision))throw Error('Invalid dependency decision');
        const o=origin(d.origin);target.decision=d.decision;target.rationale=text(d.rationale,'dependency rationale');target.origin=o;target.evidenceRefs=refs(d.evidenceRefs ?? target.evidenceRefs,a);
        target.proposedChange=d.proposedChange ? text(d.proposedChange,'proposed change') : null;
        if(!['yes','no','unknown'].includes(d.businessSemanticChange ?? 'unknown'))throw Error('Invalid semantic change');target.businessSemanticChange=d.businessSemanticChange ?? 'unknown';
        target.acceptance=d.acceptIncidental === true ? {origin:o,note:text(d.acceptanceReason,'explicit incidental acceptance')} : null;
        if(target.acceptance && (target.kind!=='incidental-behavior'||o.kind!=='user'))throw Error('Incidental behavior requires separately attributed explicit user acceptance');
      }
      if(p.unknowns) {if(!Array.isArray(p.unknowns)||p.unknowns.length>80)throw Error('unknowns must be <=80 items');t.unknowns=p.unknowns.map(u=>({text:text(u.text,'unknown'),origin:origin(u.origin),evidenceRefs:refs(u.evidenceRefs ?? [],a)}));}
      // Explanatory annotations describe a plan revision, like produce/confirm;
      // they do not change choices, approval or already written output files.
      if (Object.keys(p).some(k => k !== 'explanation')) { t.revision++;t.confirmation=null;t.phase='plan-pending'; }
      if (Object.hasOwn(p,'explanation')) t.explanation=explain(p.explanation,t,a);
    } else if(op === 'produce') {
      if(!t.selected.length)throw Error('Select at least one capability');
      const existing=t.outputs.find(o=>o.revision===t.revision);if(existing)return ok(overview(t));
      const value=artifact(t,a);await openTaskAnalysis(scope,t.analysisId);
      const file='outputs/'+t.revision+'/'+(t.mode==='compatibility'?'plan.json':'materials.json');writeJson(path.join(dir,file),value);
      t.outputs.push({revision:t.revision,mode:t.mode,kind:value.kind,file,path:path.join(dir,file)});t.phase=t.mode==='compatibility'?'plan-awaiting-confirmation':'materials-produced';
    } else if(op === 'confirm') {
      if(!t.outputs.some(o=>o.revision===t.revision)||!t.judgment)throw Error('Produce current revision and record attributed overall judgment before confirmation');
      t.confirmation={revision:t.revision,origin:origin(args.taskConfirmation)};
      t.phase=t.confirmation.origin.kind==='current-model'?'model-reviewed-awaiting-user':t.mode==='reverse'?'materials-confirmed':t.dependencies.some(d=>d.decision==='pending')?'confirmed-with-open-questions':'confirmed-awaiting-separate-execution';
    } else throw Error('taskOperation: list/create/read/update/produce/confirm/output');
    await openTaskAnalysis(scope,t.analysisId);
    t.updatedAt=new Date().toISOString();
    const tmp=path.join(dir,'task.'+process.pid+'.tmp');writeJson(tmp,t);fs.renameSync(tmp,path.join(dir,'task.json'));return ok(overview(t));
  } finally {fs.closeSync(fd);fs.unlinkSync(path.join(dir,'operation.lock'));}
}
