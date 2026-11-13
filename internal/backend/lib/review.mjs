/**
 * W3「胃材料生成」——按模板产出 review.json 骨架（隔离实现）
 *
 * 硬约束（执行清单 T-ORG W3 + 用户本轮要求）：
 *   1. 只产出材料，**不自动下结论**：review.complete=false / conclusion=null / decision=pending。
 *   2. 严格区分三类内容：facts（事实）/ candidates（候选判断）/ unknowns（unknown）。
 *   3. 关键词未命中**不能**证明没有人格/记忆功能；命中也只是静态事实线索，
 *      不等于运行时确实注入。两者的结论字段都保持 unknown。
 *   4. 真含人格/记忆注入的混合样例 → holdInStomach=true，留胃、不安装。
 *   5. 只读饭目录里的文本，不 import 候选代码、不解析依赖、不生成锁、不执行任何脚本。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * 静态扫描分两级，避免「注释里出现一个词」就被当成插件形态结论：
 *   strong = 注入/写入 API 级线索；weak = 关键词级线索。
 * 只有 strong 线索参与 shape 候选判断；weak 只进 facts。
 * 无论 strong/weak 命中与否，注入结论字段一律保持 unknown（见 unknowns）。
 */
const SCAN_PATTERNS = [
  { category: 'persona', strength: 'strong', label: '人格/系统提示注入 API 线索',
    re: /ctx\.systemPrompt\.section|systemPrompt\.section|personaInjection|PERSONA\.md/i },
  { category: 'persona', strength: 'weak', label: '人格/系统提示关键词',
    re: /persona|PERSONA|人设|人格|systemPrompt/i },
  { category: 'memory', strength: 'strong', label: '记忆写入 API 线索',
    re: /ctx\.memory\.remember|memory\.remember|long-term|memoryInjection/i },
  { category: 'memory', strength: 'weak', label: '记忆相关关键词',
    re: /\bmemory\b|remember\(|长期记忆|记忆/i },
  { category: 'tool-register', strength: 'weak', label: '工具注册线索',
    re: /ctx\.tools\.register|tools\.register|registerTool/ },
  { category: 'bundle', strength: 'weak', label: 'bundle/挂载线索',
    re: /cordis|patch\.yml|\bbundles?\b/i },
  { category: 'fs-write', strength: 'weak', label: '文件写入线索',
    re: /writeFileSync|appendFileSync|fs\.writeFile|createWriteStream/ },
  { category: 'child-process', strength: 'weak', label: '子进程线索',
    re: /\bspawn\(|\bexec\(|\bexecFile\(|child_process/ },
];

function scanFiles(warehouseDir, files) {
  const hits = [];
  const scanned = [];
  for (const entry of files) {
    const full = join(warehouseDir, entry.path);
    const buffer = readFileSync(full);
    // 二进制文件不按行扫描，但仍作为 unknown 记录，不静默当成「没有命中」
    if (buffer.includes(0)) {
      scanned.push({ path: entry.path, scanned: false, reason: 'binary' });
      continue;
    }
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    scanned.push({ path: entry.path, scanned: true, lines: lines.length });
    lines.forEach((line, index) => {
      for (const pattern of SCAN_PATTERNS) {
        if (pattern.re.test(line)) {
          hits.push({
            category: pattern.category,
            strength: pattern.strength,
            label: pattern.label,
            file: entry.path,
            line: index + 1,
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    });
  }
  return { hits, scanned };
}

function countBy(hits, category) {
  return hits.filter((h) => h.category === category).length;
}

function injectionAssessment(hits, category, field) {
  const found = hits.filter((h) => h.category === category);
  return {
    assessment: found.length > 0 ? 'static-hits-found' : 'no-static-hit',
    basis: found.map((h) => `${h.file}:${h.line}`),
    confidence: 'candidate',
    note: found.length > 0
      ? '静态命中只是事实线索，是否构成实际注入需人工确认与运行时取证'
      : '关键词未命中不能证明没有该能力；静态扫描覆盖范围有限',
    // 关键：无论命中与否，结论字段都不写成 false / true
    conclusion: null,
    field,
  };
}

/**
 * 由饭目录材料生成胃审查材料（纯产出，不落盘）。
 */
export function buildReview({ riceDir, sourceDoc, contentDoc, requestId }) {
  const warehouseDir = join(riceDir, '仓库');
  const { hits, scanned } = scanFiles(warehouseDir, contentDoc.files);

  const personaHits = countBy(hits, 'persona');
  const memoryHits = countBy(hits, 'memory');
  const strongInjectionHits = hits.filter(
    (h) => h.strength === 'strong' && (h.category === 'persona' || h.category === 'memory'));
  const strongPersona = strongInjectionHits.filter((h) => h.category === 'persona').length;
  const strongMemory = strongInjectionHits.filter((h) => h.category === 'memory').length;
  // 只有 API 级强线索参与形态候选判断；弱关键词（含注释里的词）只作为事实保留。
  const shape = strongInjectionHits.length > 0 ? 'mixed' : 'tool';
  const holdInStomach = shape === 'mixed';

  const facts = {
    requestId,
    pinnedCommit: sourceDoc.pinnedCommit,
    upstreamUrl: sourceDoc.upstreamUrl,
    ...(sourceDoc.subdir ? {subdir:sourceDoc.subdir} : {}),
    upstreamHead: sourceDoc.upstreamHead,
    commitSubject: sourceDoc.commitSubject,
    contentHash: sourceDoc.contentHash,
    fileCount: contentDoc.fileCount,
    files: contentDoc.files,
    scannedFiles: scanned,
    packageJson: sourceDoc.packageJson,
    dependencyDeclarations: sourceDoc.dependencyDeclarations,
    flatDependencies: sourceDoc.flatDependencies,
    installScripts: sourceDoc.installScripts,
    scripts: sourceDoc.scripts,
    staticHits: hits,
    staticHitCounts: Object.fromEntries(
      [...new Set(SCAN_PATTERNS.map((p) => p.category))]
        .map((category) => [category, countBy(hits, category)])),
    strongInjectionHits,
    strongInjectionCounts: { persona: strongPersona, memory: strongMemory },
    scanRuleNote: 'strong=注入/写入 API 级线索；weak=关键词级线索（可能来自注释或说明文字）',
  };

  const candidates = {
    confidence: 'candidate',
    requiresHumanReview: true,
    shape,
    shapeBasis: holdInStomach
      ? `强注入线索 ${strongInjectionHits.length} 处（persona=${strongPersona}, memory=${strongMemory}）；弱关键词命中 persona=${personaHits}, memory=${memoryHits}（见 facts.staticHits）`
      : `强注入线索 0 处；弱关键词命中 persona=${personaHits}, memory=${memoryHits}（可能只是注释/说明文字）。关键词未命中不能证明没有注入能力`,
    capabilities: countBy(hits, 'tool-register') > 0
      ? [{ value: 'tool:register', basis: `${countBy(hits, 'tool-register')} 处工具注册静态命中`, confidence: 'candidate' }]
      : [],
    dependencySurface: {
      declared: sourceDoc.flatDependencies,
      transitive: null,
      note: '只记录 package.json 的显式声明；传递依赖未解析（unknown）',
    },
    injectionSurface: {
      personaInjection: injectionAssessment(hits, 'persona', 'personaInjection'),
      memoryInjection: injectionAssessment(hits, 'memory', 'memoryInjection'),
    },
    risks: [
      ...(countBy(hits, 'fs-write') > 0
        ? [{ value: 'file-write', basis: `${countBy(hits, 'fs-write')} 处静态命中`, confidence: 'candidate' }] : []),
      ...(countBy(hits, 'child-process') > 0
        ? [{ value: 'child-process', basis: `${countBy(hits, 'child-process')} 处静态命中`, confidence: 'candidate' }] : []),
      ...(sourceDoc.installScripts.length > 0
        ? [{ value: 'install-scripts', basis: sourceDoc.installScripts.join(', '), confidence: 'candidate' }] : []),
    ],
    classificationDraft: holdInStomach
      ? 'B 类混合插件（工具 + 人格/记忆注入线索）：按产品决策留胃，报告用户，由用户与 DSH 决定需要哪些部分后再适配；本轮不安装。'
      : 'A 类工具型插件（无 persona/memory 静态命中）：按普通工具插件处理，工具使用说明随工具保留，不因进入系统提示就拆成脑组件；仍需用户确认首次宿主代码执行后才继续。',
  };

  const unknowns = [
    {
      field: 'personaInjection', status: 'unknown',
      reason: `静态命中 ${personaHits} 处（强线索 ${strongPersona} 处）；关键词未命中不能证明没有人格注入功能，命中也不能证明运行时确实注入；扫描规则有限且未做运行时取证`,
    },
    {
      field: 'memoryInjection', status: 'unknown',
      reason: `静态命中 ${memoryHits} 处（强线索 ${strongMemory} 处）；关键词未命中不能证明没有记忆写入功能，命中也不能证明运行时确实写入长期记忆；扫描规则有限且未做运行时取证`,
    },
    {
      field: 'transitiveDependencies', status: 'unknown',
      reason: '未执行依赖解析、未生成锁文件；传递依赖子树与实际安装内容尚未固定',
    },
    {
      field: 'runtimeBehavior', status: 'unknown',
      reason: '候选代码未被执行（无 import / 无构建 / 无安装脚本），运行时行为不可判定',
    },
    {
      field: 'externalSideEffects', status: 'unknown',
      reason: '静态命中或缺失都不等价于运行时外部副作用；需批准前另行确认',
    },
    {
      field: 'upstreamTrust', status: 'unknown',
      reason: sourceDoc.sourceKind === 'npm'
        ? '已固定实际 npm 发布包及完整性；发布者信任与运行时行为不由内容摘要证明'
        : '已记录来源与固定提交；来源信任不由本地静态材料或提交摘要证明',
    },
  ];

  return {
    schema: 'stomach-review-material/v1',
    generatedAt: new Date().toISOString(),
    requestId,
    riceDir,
    facts,
    candidates,
    unknowns,
    review: {
      complete: false,
      conclusion: null,
      decision: 'pending',
      materialOnly: true,
      requiresHumanReview: true,
    },
    holdInStomach,
    installAllowedNow: false,
    nextStep: holdInStomach
      ? 'awaiting-user-decision：混合插件留胃，报告用户；由用户与 DSH 决定拆分范围后再适配，不进入安装'
      : 'awaiting-user-decision：等待用户确认首次宿主代码执行 / 工具替换 / 新增权限，之后才进入 adapting → ready',
    scopeNote: '本文件是胃的审查材料骨架，不是审批结论；不写运行态，运行态唯一真源是 requests/<id>.json',
  };
}

/** 落盘 review.json。同一提交已有材料时不覆盖。 */
export function writeReview({ stomachRoot, repoName, reviewDoc }) {
  const dir = join(stomachRoot, repoName, reviewDoc.facts.pinnedCommit);
  const path = join(dir, 'review.json');
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing.facts?.pinnedCommit === reviewDoc.facts.pinnedCommit) {
      return { status: 'already-present', path, doc: existing };
    }
    throw new Error(`STOMACH_COMMIT_MISMATCH：胃目录已有 ${existing.facts?.pinnedCommit} 的材料，拒绝覆盖`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reviewDoc, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return { status: 'created', path, doc: reviewDoc };
}
