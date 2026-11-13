/**
 * 安装请求状态机（隔离实现）
 *
 * 对应技术设计 §4.1。核心约定：
 *   - 单一写者：运行态只由「手」写；胃只写 review，不写状态。
 *   - 进 ready 必须同时满足：审查完成 + 授权满足 + artifact 校验通过。
 *   - 进 installed 必须安装退出码为 0；退出码非 0 但磁盘已变 → failed(half-installed)，
 *     由失败收敛处理，不得直接写 installed。
 *   - 进 active 必须有实测证据（按插件类型取证），安装动作自己不得写 active。
 *   - review 里保留的 unknown 只有被显式接受（acceptedUnknowns）才允许 complete。
 *
 * 状态中文映射：
 *   pending=待处理 reviewing=审查中 awaiting-approval=待批准 adapting=适配中
 *   ready=可安装 installing=安装中 installed=已安装 active=运行中
 *   failed=失败(带 stage) rolled-back=已回退
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const STATES = Object.freeze([
  'pending',
  'reviewing',
  'awaiting-approval',
  'adapting',
  'ready',
  'installing',
  'installed',
  'active',
  'failed',
  'rolled-back',
]);

/** 合法迁移表。任何不在此表的迁移都会被拒绝。 */
export const TRANSITIONS = Object.freeze({
  pending: ['reviewing', 'failed'],
  reviewing: ['awaiting-approval', 'adapting', 'failed'],
  'awaiting-approval': ['adapting', 'failed'],
  adapting: ['ready', 'failed'],
  ready: ['installing', 'failed'],
  installing: ['installed', 'failed'],
  installed: ['active', 'failed', 'rolled-back'],
  active: ['failed', 'rolled-back'],
  failed: ['rolled-back', 'pending'],
  'rolled-back': ['pending'],
});

/** 失败阶段，用于区分首次安装失败 / 更新失败 / 激活失败。 */
export const FAIL_STAGES = Object.freeze([
  'download', 'admission', 'install', 'half-installed', 'activate', 'restore',
]);

/**
 * patch 不得覆盖的受控字段。
 *
 * 缺陷修复点（GPT 复现）：此前 `transition(rec,'reviewing',{patch:{state:'active'}})`
 * 能直接把记录改成 active 且 evidence=null —— 因为 patch 在守卫之后 Object.assign。
 * 现在受控字段一律拒绝，不做「静默忽略」：静默忽略会让调用方以为改成功了。
 */
const PROTECTED_PATCH_KEYS = Object.freeze([
  'id', 'packageName', 'spec', 'source', 'legacy',
  'state', 'stage', 'updatedAt', 'createdAt', 'history',
  'evidence', 'error',
]);

export class StateError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

export function createRequest({ id, packageName, spec, source = null, legacy = false }) {
  if (!id || !packageName) throw new StateError('STATE_BAD_INPUT', 'id 与 packageName 必填');
  return {
    id,
    packageName,
    spec,
    source,
    legacy,
    state: 'pending',
    stage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ state: 'pending', at: new Date().toISOString(), note: '收到安装意图' }],
    review: { complete: false, unknowns: [], acceptedUnknowns: [] },
    admission: { allow: null, code: null, at: null },
    artifact: { verified: false, contentHash: null, path: null },
    install: { exitCode: null, version: null, diskChanged: false, verified: false },
    evidence: null,
    error: null,
  };
}

/**
 * 三个前置条件的「纯检查」版本。
 *
 * 必须同时用于两处：
 *   ① transition 开始时对**入参记录**检查（早失败，错误信息指向明确）；
 *   ② patch 合并后对**最终记录**再检查一次。
 * 只做①会被 `patch` 推翻——GPT 复现的遗漏正是如此：
 * `transition(rec,'ready',{patch:{review:{complete:false},...}})` 里，
 * ①用的是旧记录（通过），patch 之后没人再校验，最终记录 state=ready 但前置全 false。
 */
function collectReadyProblems(record) {
  const problems = [];
  if (record.review?.complete !== true) problems.push('review.complete 不为 true');
  if (record.admission?.allow !== true) problems.push('admission.allow 不为 true');
  if (record.artifact?.verified !== true) problems.push('artifact.verified 不为 true');
  const unknowns = Array.isArray(record.review?.unknowns) ? record.review.unknowns : [];
  const accepted = Array.isArray(record.review?.acceptedUnknowns) ? record.review.acceptedUnknowns : [];
  const open = unknowns.filter((u) => !accepted.includes(u));
  if (open.length > 0) problems.push(`未处置的 unknown：${open.join(', ')}`);
  return problems;
}

function collectInstalledProblems(record) {
  const problems = [];
  if (record.install?.exitCode !== 0) problems.push(`安装退出码为 ${record.install?.exitCode}`);
  if (record.install?.diskChanged === true && record.install?.verified !== true) {
    problems.push('磁盘已变但未校验一致');
  }
  return problems;
}

const VALID_EVIDENCE_KINDS = ['tool', 'service', 'client', 'bundle'];

function collectActiveProblems(record) {
  const problems = [];
  const ev = record.evidence;
  if (!ev || typeof ev !== 'object') {
    problems.push('缺少加载期实测证据');
    return problems;
  }
  if (!VALID_EVIDENCE_KINDS.includes(ev.kind)) problems.push(`证据类型无效：${ev.kind}`);
  if (!ev.detail || String(ev.detail).trim() === '') problems.push('证据缺少 detail');
  return problems;
}

function guardReady(record) {
  const missing = collectReadyProblems(record);
  if (missing.length > 0) {
    const code = missing.some((m) => m.includes('unknown')) ? 'STATE_UNKNOWN_OPEN' : 'STATE_PRECONDITION';
    throw new StateError(code, `不能进入 ready：${missing.join('；')}`, { missing });
  }
}

function guardInstalled(record) {
  const problems = collectInstalledProblems(record);
  if (problems.length > 0) {
    throw new StateError('STATE_PRECONDITION',
      `不能进入 installed：${problems.join('；')}（非 0 应走 failed(half-installed) 后收敛）`);
  }
}

function guardActive(record, ctx) {
  const ev = ctx?.evidence ?? record.evidence;
  const problems = collectActiveProblems({ ...record, evidence: ev });
  if (problems.length > 0) {
    throw new StateError('STATE_NO_EVIDENCE',
      `不能进入 active：${problems.join('；')}`);
  }
  return ev;
}

/**
 * 迁移到下一个状态。返回新记录（不修改入参）。
 * @param {object} record
 * @param {string} next
 * @param {object} [ctx]  { note, evidence, at }
 */
export function transition(record, next, ctx = {}) {
  if (!STATES.includes(next)) {
    throw new StateError('STATE_UNKNOWN', `未知状态：${next}`);
  }
  const allowed = TRANSITIONS[record.state] ?? [];
  if (!allowed.includes(next)) {
    throw new StateError('STATE_ILLEGAL',
      `非法迁移：${record.state} → ${next}（允许：${allowed.join(', ') || '无'}）`);
  }

  if (next === 'ready') guardReady(record);
  if (next === 'installed') guardInstalled(record);
  let evidence = record.evidence;
  if (next === 'active') evidence = guardActive(record, ctx);
  if (next === 'failed') {
    const stage = ctx.stage ?? record.stage;
    if (!FAIL_STAGES.includes(stage)) {
      throw new StateError('STATE_BAD_STAGE', `failed 需要合法 stage，收到：${stage}`);
    }
  }

  const at = ctx.at ?? new Date().toISOString();
  const updated = {
    ...record,
    state: next,
    stage: next === 'failed' ? (ctx.stage ?? record.stage) : null,
    updatedAt: at,
    history: [...record.history, { state: next, at, note: ctx.note ?? null }],
  };
  if (next === 'active') updated.evidence = evidence;
  if (next === 'failed') updated.error = { stage: updated.stage, code: ctx.code ?? null, message: ctx.note ?? null };

  if (ctx.patch !== undefined && ctx.patch !== null) {
    if (typeof ctx.patch !== 'object' || Array.isArray(ctx.patch)) {
      throw new StateError('STATE_BAD_PATCH', 'patch 必须是普通对象');
    }
    const forbidden = Object.keys(ctx.patch).filter((k) => PROTECTED_PATCH_KEYS.includes(k));
    if (forbidden.length > 0) {
      throw new StateError('STATE_PATCH_FORBIDDEN',
        `patch 不能覆盖受控字段：${forbidden.join(', ')}`, { forbidden });
    }
    Object.assign(updated, ctx.patch);
  }

  // 合并后校验最终记录：受控字段必须仍由实现决定，不能被任何路径改写
  assertInvariants(updated, next);
  return updated;
}

/** 最终记录不变量。任何 patch / 未来扩展都不能让它失效。 */
function assertInvariants(record, expectedState) {
  if (record.state !== expectedState) {
    throw new StateError('STATE_INVARIANT',
      `state 必须等于目标状态 ${expectedState}，实际 ${record.state}`);
  }
  if (!Array.isArray(record.history) || record.history.length < 1) {
    throw new StateError('STATE_INVARIANT', 'history 必须是至少一条的数组');
  }
  if (record.history[record.history.length - 1].state !== expectedState) {
    throw new StateError('STATE_INVARIANT', 'history 末条必须记录本次迁移');
  }
  if (expectedState !== 'failed' && record.stage !== null && record.stage !== undefined) {
    throw new StateError('STATE_INVARIANT', `非 failed 状态的 stage 必须为空，实际 ${record.stage}`);
  }
  if (expectedState === 'failed') {
    if (!record.error || typeof record.error !== 'object') {
      throw new StateError('STATE_INVARIANT', 'failed 必须带 error 对象');
    }
    if (!FAIL_STAGES.includes(record.error.stage)) {
      throw new StateError('STATE_INVARIANT', `error.stage 非法：${record.error.stage}`);
    }
    if (record.error.stage !== record.stage) {
      throw new StateError('STATE_INVARIANT', 'error.stage 与 stage 不一致');
    }
  }
  // 合并 patch 之后，必须用**最终记录**再验一遍业务前置。
  // 缺陷修复点（GPT 复现）：只在迁移开头检查入参记录，patch 就能把
  // review/admission/artifact 改坏而 state 仍是 ready。
  if (expectedState === 'ready') {
    const problems = collectReadyProblems(record);
    if (problems.length > 0) {
      throw new StateError('STATE_PRECONDITION',
        `合并 patch 后 ready 前置不成立：${problems.join('；')}`,
        { missing: problems, afterPatch: true });
    }
  }
  if (expectedState === 'installed') {
    const problems = collectInstalledProblems(record);
    if (problems.length > 0) {
      throw new StateError('STATE_PRECONDITION',
        `合并 patch 后 installed 前置不成立：${problems.join('；')}`,
        { afterPatch: true });
    }
  }
  if (expectedState === 'active') {
    const problems = collectActiveProblems(record);
    if (problems.length > 0) {
      throw new StateError('STATE_NO_EVIDENCE', `active 前置不成立：${problems.join('；')}`);
    }
  } else if (expectedState !== 'active' && record.evidence != null && record.evidence.kind !== undefined) {
    // 非 active 状态允许保留历史证据（更新场景），但必须是合法结构
    if (!VALID_EVIDENCE_KINDS.includes(record.evidence.kind)) {
      throw new StateError('STATE_INVARIANT', `保留的 evidence.kind 非法：${record.evidence.kind}`);
    }
  }
}

/** 便捷判定：某状态下还允许哪些迁移。 */
export function nextStates(state) {
  return [...(TRANSITIONS[state] ?? [])];
}

/**
 * 请求存储。一个请求一个 JSON 文件，原子写入（tmp + rename）。
 * 目录：<root>/requests/<id>.json，索引：<root>/index.json
 */
export class RequestStore {
  constructor(root) {
    this.root = root;
    this.dir = join(root, 'requests');
    this.indexPath = join(root, 'index.json');
    mkdirSync(this.dir, { recursive: true });
  }

  pathOf(id) {
    return join(this.dir, `${id}.json`);
  }

  save(record) {
    const target = this.pathOf(record.id);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, target);
    this.#reindex();
    return record;
  }

  load(id) {
    const p = this.pathOf(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  list() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')));
  }

  remove(id) {
    const p = this.pathOf(id);
    if (existsSync(p)) rmSync(p, { force: true });
    this.#reindex();
  }

  #reindex() {
    const rows = this.list().map((r) => ({
      id: r.id, packageName: r.packageName, state: r.state, stage: r.stage, updatedAt: r.updatedAt,
    }));
    writeFileSync(this.indexPath, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2), 'utf8');
  }
}
