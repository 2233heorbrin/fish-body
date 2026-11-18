import { withStateConfig } from './production-state.mjs';
import { readFileSync } from 'node:fs';
import { samePath } from './lib/path-identity.mjs';
/**
 * 正式候选 · 「鱼的身体」审批入口（Host half）
 *
 * 与既有 fish-body 设置页**同源复用**：分区列表与「打开文件夹」由既有 fish-body
 * 入口负责（它自己的 SECTIONS + explorer/宿主 Remote 行为），本插件**不重复注册**
 * /api/fish-body/sections 与 /api/fish-body/open，只注册审批动作路由。
 *
 * **真实宿主接入方式**（与 fish-body 逐字同型，不是手动调用工厂函数）：
 *   export const inject = ['connection']
 *   export function apply(ctx, config) { register(ctx, path, methods, fetch) }
 *   register → ctx.effect(() => ctx.connection.fetch.register({
 *     path, methods, requestBody: 'buffered', fetch }))
 *
 * 权威边界：**不 import 任何鱼人格 / 记忆 / 心情 / 思考 / Mnemon 模块**；
 * 不写运行态、不改 profile、不安装插件。静态扫描据此验证无新增脑区依赖。
 *
 * W2 · 「鱼的身体」总开关三态门禁（phase 全部交给 W1 的 ./lib/body-switch.mjs 判定）：
 *   - 每个请求进来时重新 readBodyPhase，不缓存、不在 apply 时固定（重启/切换立即生效）。
 *   - on      ：原 handler 逐字不变，并用 withBodyOperation 计入在途（供 bridge 判 closing）。
 *   - closing ：新身体流程一律返回中文等待态；已在途的那一次不中断；status 返回 phase:'closing'。
 *   - off     ：所有身体动作返回「已关闭、请用户手动开启」提示；status 返回 phase:'off'。
 *              零编排 / 零 registry 读 / 零审计；不自动开启开关、不自动加载身体。
 *   - 编排器全程**懒构造**：apply/构造 handler/工具定义阶段绝不 new FishHandOrchestrator，
 *     只有 on 态真正跑身体动作时才首次构造（off/closing 永不构造，避免 FH_NO_FRAMEWORK_ROOT
 *     拖累宿主启动，也避免关闭态触发身体落盘）。
 */
import { FishHandOrchestrator } from './fish-hand-orchestrator.mjs';
import { readBodyPhase, bodyPhase, withBodyOperation, observeBodyPhase } from './lib/body-switch.mjs';

export const name = 'fish-body-plugin-admission';
// 硬依赖只有 connection：审批路由必须无条件下注册。
// 对话工具依赖 tools 服务，用 ctx.inject 动态挂载（tools 未就绪时不阻塞审批入口）。
export const inject = ['connection'];

/** 审批入口自己的分区说明（供前端展示；分区注册归既有 fish-body）。 */
export const SECTIONS = Object.freeze({
  approval: { title: '插件审批', description: '待批请求、批准 / 拒绝、绑定决定。' },
});

/**
 * 只注册审批动作路由。鱼的身体两条路由（sections / open）属于既有入口，
 * 重复注册会覆盖既有实现并丢掉真实的「打开文件夹」行为，因此这里明确不注册。
 */
export const ROUTES = Object.freeze([
  { path: '/api/fish-hand/analysis', methods: ['POST'] },
  { path: '/api/fish-hand/task', methods: ['POST'] },
  { path: '/api/fish-hand/pending', methods: ['GET', 'POST'] },
  { path: '/api/fish-hand/review', methods: ['POST'] },
  { path: '/api/fish-hand/approve', methods: ['POST'] },
  { path: '/api/fish-hand/reject', methods: ['POST'] },
  { path: '/api/fish-hand/status', methods: ['GET'] },
]);

function jsonResponse(request, value, status = 200) {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** 编排器来源：显式注入优先，其次按框架根构造（生产 = D:/deepseek框架）。 */
export function resolveOrchestrator({ orchestrator = null, frameworkRoot = null, mode = null } = {}) {
  if (orchestrator) return orchestrator;
  const root = frameworkRoot ?? process.env.FISH_HAND_FRAMEWORK_ROOT ?? null;
  if (!root) throw new Error('[FH_NO_FRAMEWORK_ROOT] 缺少 frameworkRoot（或 FISH_HAND_FRAMEWORK_ROOT）');
  return new FishHandOrchestrator({
    frameworkRoot: root,
    mode: mode ?? process.env.FISH_HAND_MODE ?? 'production',
  });
}

/* ================================================================== W2 · 总开关门禁 ================================================================== */

/** 身体已关闭：给可见入口 / 对话工具的统一提示（逐字覆盖用户要求）。 */
const OFF_MESSAGE = '鱼的身体当前已关闭；如需分析源码或按饭→胃→手统一流程安装，请由用户在插件页手动开启「鱼的身体」。普通安装仍可走 DSH 原生机制。';
/** 正在关闭：等待在途操作收尾期间，不再启动新的身体流程。 */
const CLOSING_MESSAGE = '鱼的身体正在关闭：当前操作完成后退出，等待期间不再启动新的身体流程。';
/** fish_hand 工具 on 态的完整说明（off/closing 时降级为纯提示壳，见下）。 */
const FULL_TOOL_DESCRIPTION = '鱼的手：submit 把 GitHub 链接下载到饭并登记安装意图；review 在胃里生成审查材料并返回待批项；'
  + 'approve 首次需真实授权与审查；同一请求重试复用有效批准，新增依赖脚本返回待授权范围；'
  + 'reject 拒绝；status 列出已登记插件。analyze 显式选择 initial 初扫或 deep 全源码深查，analysisSource 明确选择本地源码目录或既有请求的固定材料；返回 analysisId。'
  + 'query 用 analysisId 按 summary/evidence/file/capability/phase 分页取证，不启动分析器。新 deep 可用 initialAnalysisId 关联同源初扫。'
  + 'task 以 compatibility/reverse 创建任务；list/read 分页读取，update 带 expectedRevision 记录能力选择及有来源的判断/依赖决定，produce 产出方案或组件材料，output 分页读取，confirm 只确认具体版本而不授权执行。'
  + '只产出分析材料和拆分依据，不执行候选代码，不代表安全批准或拆分成功；不调用模型。本工具不自行批准、不安装插件。';

/** 测试注入钩子（W4 arm 用）：显式喂入 profileDir / patchPath 等线索。
 *  生产由 apply / createFishBodyApprovalHost 的 config 显式提供，不依赖此钩子。 */
let ambientHints = null;
export function setBodySwitchHintsForTest(hints = null) {
  ambientHints = hints && typeof hints === 'object' ? { ...hints } : null;
}
// arm() 也会尝试这两个别名；三者同为幂等设置，不会互相覆盖出不同值。
export const __setBodySwitchHints = setBodySwitchHintsForTest;
export const setHintsForTest = setBodySwitchHintsForTest;

/**
 * 只做「线索收集」：把 config / 测试注入 / 环境变量 / globalThis Symbol 收敛成
 * readBodyPhase 的 hints。phase 判定 100% 交给 W1 的 readBodyPhase，绝不另写状态逻辑。
 * 兼容两种命名：W1 的 bodyProfileDir/bodyPatchPath 与 W4 的 profileDir/patchPath。
 */
function bodySwitchHints(config = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const env = {
    profileDir: process.env.FISH_HAND_BODY_PROFILE_DIR ?? null,
    patchPath: process.env.FISH_HAND_BODY_PATCH ?? null,
    stateConfigPath: process.env.FISH_HAND_BODY_STATE ?? process.env.FISH_HAND_STATE ?? null,
  };
  const sym = (typeof globalThis !== 'undefined'
    ? (globalThis[Symbol.for('fish-body-switch.hints')]
      ?? globalThis[Symbol.for('fish.body.switch.hints')] ?? {}) : {});
  const a = ambientHints ?? {};
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v) ?? null;
  return {
    profileDir: pick(c.bodyProfileDir, c.profileDir, a.profileDir, env.profileDir, sym.profileDir),
    patchPath: pick(c.bodyPatchPath, c.patchPath, a.patchPath, env.patchPath, sym.patchPath),
    stateConfigPath: pick(c.stateConfigPath, a.stateConfigPath, a.statePath,
      env.stateConfigPath, sym.stateConfigPath, sym.statePath),
    absoluteConfigPath: pick(c.absoluteConfigPath, a.absoluteConfigPath),
  };
}

/** 无任何 phase 线索（纯回归脚本注入 orchestrator 的形态）→ 完全不分流，逐字保持原行为。 */
function switchEnabled(hints) {
  return !!(hints.profileDir || hints.patchPath || hints.stateConfigPath || hints.absoluteConfigPath);
}

/** 与 gate 一样按已解析的 Profile 目录计数；未知调用不借用别的 Profile。 */
function opDirFor(state, hints) {
  return state.profileDir || hints.profileDir || null;
}

/**
 * 懒构造编排器：apply / createHandler / 工具定义阶段绝不调用
 * resolveOrchestrator() / new FishHandOrchestrator；只有 on 态真正执行身体动作时才首次构造。
 */
function makeLazyOrchestrator({ orchestrator = null, getOrch = null, frameworkRoot = null, mode = null } = {}) {
  if (typeof getOrch === 'function') return getOrch;
  let cached = orchestrator ?? null;
  return () => {
    if (!cached) cached = resolveOrchestrator({ frameworkRoot, mode });
    return cached;
  };
}

/** 让 on 分支 `orch.handleRest(...)` 逐字保持不变，同时把编排器构造推迟到首次真正调用。 */
function lazyOrchProxy(resolve) {
  return new Proxy({}, {
    get(_target, prop) {
      const real = resolve();
      const value = Reflect.get(real, prop);
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

const phaseMessage = (phase) => (phase === 'off' ? OFF_MESSAGE : CLOSING_MESSAGE);

/** status 端点：off/closing 都可读，返回真实 phase + 中文提示，不谎报已关闭。 */
function statusOnlyResponse(request, state) {
  return jsonResponse(request, {
    ok: false, phase: state.phase, active: false,
    message: phaseMessage(state.phase),
    profileDir: state.profileDir ?? null,
    patchPath: state.patchPath ?? null,
    reason: state.reason ?? null,
  }, 200);
}

/** 身体动作端点：off/closing 一律返回同一提示 / 等待态，正文含 phase 与中文提示。 */
function blockedResponse(request, state) {
  return jsonResponse(request, {
    ok: false, phase: state.phase, active: false,
    message: phaseMessage(state.phase),
    reason: state.reason ?? null,
  }, 200);
}

/** off/closing 的分流：全程不触碰编排器（零编排 / 零 registry 读 / 零审计）。 */
function gatedResponse(request, path, state) {
  if (path === '/api/fish-hand/status') return statusOnlyResponse(request, state);
  if (path.startsWith('/api/fish-hand/')) return blockedResponse(request, state);
  if (path.startsWith('/api/fish-body/')) {
    return jsonResponse(request, { error: 'served-by-fish-body', path }, 409);
  }
  return jsonResponse(request, { error: 'not-found' }, 404);
}

/** fish_hand 工具 off/closing 时的结果（贴合 output schema：{ ok, action, result }）。 */
function toolPromptResult(action, state) {
  return { ok: false, action, result: {
    phase: state.phase, active: false,
    message: phaseMessage(state.phase),
    reason: state.reason ?? null,
  } };
}

/** 工具 description：运行时按需重读 phase；off/closing 降级为纯提示壳，on 保持原说明。 */
function toolDescription(hints, gated) {
  if (!gated) return FULL_TOOL_DESCRIPTION;
  try {
    const p = bodyPhase(hints);
    if (p === 'off') return OFF_MESSAGE;
    if (p === 'closing') return CLOSING_MESSAGE;
  } catch { /* 读不到线索时保留原说明；execute 里仍有硬门禁 */ }
  return FULL_TOOL_DESCRIPTION;
}

/**
 * Web 标准 handler：把宿主注册的 Request 转成编排端点调用。
 * 只使用 pathname，不接受外部路径参数；非审批路由一律 404（鱼的身体路由由既有入口负责）。
 */
export function createHandler({ orchestrator = null, getOrch = null, frameworkRoot = null, mode = null, bodySwitch = {} } = {}) {
  const resolve = makeLazyOrchestrator({ orchestrator, getOrch, frameworkRoot, mode });
  const hints = bodySwitchHints(bodySwitch);
  const gated = switchEnabled(hints);
  const orch = lazyOrchProxy(resolve);

  /** on 态执行器：函数体与改动前 handle 逐字一致（仅把 orch 换成惰性代理）。 */
  async function handleOn(request) {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    let body = {};
    if (request.method === 'POST') {
      try {
        const parsed = await request.json();
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return jsonResponse(request, { error: 'bad-json' }, 400);
      }
    }

    if (path === '/api/fish-hand/task' || path === '/api/fish-hand/analysis') {
      try {
        const { analysisToolAction } = await import('../analysis/service.mjs');
        if (path.endsWith('/analysis') && !['analyze', 'query'].includes(body.action)) throw Error('Explicit analyze/query action required');
        const out = await analysisToolAction(path.endsWith('/task') ? { ...body, action: 'task' } : body,
          { frameworkRoot: bodySwitch.frameworkRoot ?? frameworkRoot, profileDir: hints.profileDir });
        return jsonResponse(request, out);
      } catch (error) { return jsonResponse(request, { ok: false, error: error.message }, 400); }
    }
    if (path.startsWith('/api/fish-hand/')) {
      const out = await orch.handleRest({ method: request.method, path, body });
      return jsonResponse(request, out.body, out.status ?? 200);
    }
    if (path.startsWith('/api/fish-body/')) {
      // 既有 fish-body 已注册该前缀；这里只报归属，不提供服务，避免掩盖重复注册
      return jsonResponse(request, { error: 'served-by-fish-body', path }, 409);
    }
    return jsonResponse(request, { error: 'not-found' }, 404);
  }

  /** 每请求重读 phase（不缓存）：on 原样放行并计入在途；closing/off 一律不碰编排器。 */
  return async function handle(request) {
    if (!gated) return handleOn(request);
    const state = readBodyPhase(hints);
    if (state.phase === 'on') {
      return withBodyOperation(opDirFor(state, hints), () => handleOn(request));
    }
    const path = new URL(request.url, 'http://localhost').pathname;
    return gatedResponse(request, path, state);
  };
}

/** 与 fish-body 同型的注册函数：路由挂在宿主 connection.fetch 上，随 effect 释放。 */
function register(ctx, path, methods, fetch) {
  ctx.effect(() => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }));
}

/**
 * 对话侧入口（真实用户入口）：把「发一个 GitHub 链接」接到既有编排上。
 *
 * 工具本身**不批准、不安装**：
 *   - submit 只登记意图并把仓库下载到饭（无运行态副作用）；
 *   - review 只产出胃侧审查材料并把待批项回给用户；
 *   - approve 必须由调用方显式给出 approvedBy / approvedScopes / authorization /
 *     unknownDispositions（缺一即拒绝），审批主体与范围不在这里默认放行；
 *   - 安装仍走 DSH 原生 `dsh plugin ... add file:<tgz>`，本工具不碰 node_modules。
 *
 * W2：off/closing 时该工具降级为**纯提示壳**——execute 运行时重读 phase，直接返回提示，
 * 不构造编排器、不读 registry、不写审计、不执行任何身体动作（零编排）。
 */
/**
 * 工具返回值必须是**无损 JSON**：宿主会先判定 `value is not lossless JSON`，
 * 只要结果里有一个 `undefined`（例如未传 targetProfile 时记录里就没有该键），
 * 整次调用会被判失败——即使副作用已经成功落盘。这里统一做一次 JSON 往返。
 */
const jsonSafe = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

export function fishHandToolDefinition({ orchestrator = null, getOrch = null, frameworkRoot = null, mode = null, bodySwitch = {} } = {}) {
  const resolve = makeLazyOrchestrator({ orchestrator, getOrch, frameworkRoot, mode });
  const hints = bodySwitchHints(bodySwitch);
  const gated = switchEnabled(hints);

  return {
    name: 'fish_hand',
    // off/closing 时对外只呈现「身体已关闭」提示壳；execute 里还有运行时硬门禁。
    get description() { return toolDescription(hints, gated); },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['submit', 'review', 'approve', 'reject', 'status', 'analyze', 'query', 'task'] },
        taskOperation: { type: 'string', enum: ['list', 'create', 'read', 'update', 'produce', 'confirm', 'output'] },
        taskId: { type: 'string', description: 'Backend task UUID; never a file path' },
        taskMode: { type: 'string', enum: ['compatibility', 'reverse'], description: 'create: explicit processing mode; update via taskPatch.mode' },
        expectedRevision: { type: 'integer', minimum: 1, description: 'Required for update/produce/confirm; refresh after conflict' },
        taskView: { type: 'string', enum: ['overview', 'analyses', 'capabilities', 'dependencies', 'unknowns'] },
        taskOptions: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } } },
        outputRevision: { type: 'integer', minimum: 1 },
        taskConfirmation: { type: 'object', additionalProperties: false, required: ['kind', 'actor', 'reason'], properties: {
          kind: { type: 'string', enum: ['user', 'current-model'] }, actor: { type: 'string' }, reason: { type: 'string' } } },
        taskPatch: { type: 'object', additionalProperties: false, properties: {
          mode: { type: 'string', enum: ['compatibility', 'reverse'] }, analysisId: { type: 'string' },
          selected: { type: 'array', items: { type: 'string' } },
          classification: { type: 'object', additionalProperties: true, description: '{value:tool|brain|mixed|unknown, origin:{kind:user|current-model,actor,reason}, evidenceRefs:[exact IDs]}' },
          addCapabilities: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Attributed {name,category:tool|brain|unknown,origin,evidenceRefs}; never relabel as program discovery' },
          dependencyDecisions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '{id,decision:retain|narrow|exclude|pending,rationale,origin,evidenceRefs,proposedChange?,businessSemanticChange:yes|no|unknown,acceptIncidental?,acceptanceReason?}; incidental acceptance requires user attribution' },
          unknowns: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Attributed {text,origin,evidenceRefs}; preserve unresolved tradeoffs' },
        } },
        analysisType: { type: 'string', enum: ['initial', 'deep'], description: 'analyze 必填；initial 不运行深查，deep 显式运行全源码 ts-morph（不是单函数增量）' },
        analysisSource: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
          kind: { type: 'string', enum: ['local', 'request'] },
          path: { type: 'string', description: 'local：用户明确选择的源码目录绝对路径；只读解析，不导入代码或配置' },
          requestId: { type: 'string', description: 'request：当前 Profile 已采集的固定源码请求 ID；不新建安装意图' },
        } },
        analysisId: { type: 'string', description: 'query 必填，后端返回的结果 ID；analyze 可用同类型有效 ID 复用。不接受结果文件路径；失效时明确新建，不自动重跑' },
        initialAnalysisId: { type: 'string', description: '仅新 deep：关联同一源码的有效初扫，保留修订/冲突/补充关系；不重新初扫' },
        queryType: { type: 'string', enum: ['summary', 'evidence', 'file', 'capability', 'phase'] },
        queryOptions: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', description: 'evidence：完整带运行命名空间的证据 ID，例如 deep/M0001' },
          file: { type: 'string', description: '源码相对文件名，用于 file 或 phase 选择，不作为任意结果路径读取' },
          line: { type: 'integer', minimum: 1 }, name: { type: 'string', description: 'capability：已有能力候选名' },
          function: { type: 'string', description: 'phase：明确函数名；有限静态关系，不证明执行或释放' },
          stage: { type: 'string', description: 'phase：可选人工问题标签，不是自动业务识别' },
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
        }, description: '默认5项、最多20项及16000字节响应预算；使用返回的 nextOffset 继续读取' },
        source: { type: 'string', description: 'submit：GitHub 仓库或 /tree/<ref>/<subdir> 链接' },
        ref: {type:'string',description:'submit：明确分支/标签/提交；带斜杠分支无法唯一确定时与 subdir 一起提供'},
        subdir: {type:'string',description:'submit：仓库内插件相对子目录，例如 plugins/github-manager'},
        packageName: { type: 'string', description: 'submit：可省；审查前从固定源码 package.json 解析实际包名。显式提供时必须匹配。' },
        version: { type: 'string', description: 'submit：拟安装版本（可空，由审查产物决定）' },
        targetProfile: { type: 'string', description: 'submit：目标 profile 目录（默认 defaultProfileDir）' },
        loadForm: { type: 'string', enum: ['tool','service','ui','bundle','library','data-only','unknown'], description: '已知加载形态；省略保持 unknown，不把完整插件认定为工具' },
        requestId: { type: 'string', description: 'review / approve / reject：请求 id' },
        approvedBy: { type: 'string', description: 'approve / reject：真实审批主体（用户标识）' },
        approvedScopes: { type: 'object', additionalProperties: true, description: 'approve：用户确认的批准范围' },
        authorization: { type: 'object', additionalProperties: true, description: 'approve：六维授权（首次宿主代码执行 / 工具替换 / 凭据 / 对外动作 / 人格记忆 / 构建脚本）' },
        conclusionFields: { type:'object', additionalProperties:true, description:'基于行为与配置的审查判断及 basis；能力关键词仅为线索' },
        unknownDispositions: { type: 'array', additionalProperties: true, description: 'approve：审查 unknown 的显式处置' },
        reason: { type: 'string', description: 'reject：拒绝原因' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'result'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args = {}) => jsonSafe(await (async () => {
      const action = String(args.action ?? '');
      const dispatchAction = async () => {
        if (action === 'analyze' || action === 'query' || action === 'task') {
          const { analysisToolAction } = await import('../analysis/service.mjs');
          return analysisToolAction(args, { frameworkRoot: bodySwitch.frameworkRoot ?? frameworkRoot, profileDir: hints.profileDir });
        }
        return dispatch(resolve());
      };
      /** 真实编排动作：与改动前逐字一致；orchestrator 仅在 on 态首次调用时惰性构造。 */
      const dispatch = async (orchestrator) => {
        if (action === 'submit') {
          if (!args.source) throw new Error('[FH_BAD_REQUEST] submit 需要 source（GitHub 链接）');
          const rec = await orchestrator.createPending({
            requestId: args.requestId,
            packageName: args.packageName,
            version: args.version ?? null,
            spec: args.source,
            sourceUrl: args.source, ref:args.ref, subdir:args.subdir,
            targetProfile: args.targetProfile,
            loadForm: args.loadForm ?? 'unknown',
            note: `对话入口提交：${args.source}`,
          });
          return { ok: true, action, result: {
            requestId: rec.requestId ?? rec.id, packageName: rec.packageName,
            packageNameSource: rec.packageNameSource,
            state: rec.state, source: rec.sourceUrl, targetProfile: rec.targetProfile,
            next: 'review',
          } };
        }
        if (action === 'review') {
          if (!args.requestId) throw new Error('[FH_BAD_REQUEST] review 需要 requestId');
          const out = await orchestrator.runW2W3(args.requestId);
          const doc = out.review ?? {};
          const capabilities = [...new Set((doc.candidates?.capabilities ?? []).map((c) => c.value))].sort();
          return { ok: out.status !== 'failed', action, result: {
            status: out.status, state: out.record?.state ?? null, riceDir: out.riceDir ?? null,
            reviewPath: out.record?.stomach?.reviewPath ?? null,
            complete: doc.review?.complete ?? null,
            capabilities,
            shape: doc.candidates?.shape ?? 'unknown', loadForm: out.record?.loadForm ?? 'unknown',
            evidence: doc.facts?.strongInjectionHits ?? [], limitations: doc.scopeNote,
            dependencies: (doc.candidates?.dependencies ?? []).map((d) => d.value ?? d),
            installScripts: doc.candidates?.installScripts?.value ?? doc.facts?.installScripts ?? null,
            unknowns: (doc.unknowns ?? []).map((u) => ({ field: u.field, status:u.status, reason:u.reason, question: u.question ?? null })),
            ...(out.error ? {error:out.error} : {}),
            next: out.status==='failed' ? '按具体错误修正来源后重试' : 'approve（需用户确认范围与六维授权）',
          } };
        }
        if (action === 'approve') {
          if (!args.requestId) throw new Error('[FH_BAD_REQUEST] approve 需要 requestId');
          let out;try {out = await orchestrator.approve({
            requestId: args.requestId, approvedBy: args.approvedBy,
            approvedScopes: args.approvedScopes, authorization: args.authorization,
            unknownDispositions: args.unknownDispositions, conclusionFields:args.conclusionFields,
          });}catch(error){
            if(error.code==='PKG_SCRIPT_UNAPPROVED')return {ok:false,action,result:{status:'authorization-required',requestId:args.requestId,code:error.code,pendingScripts:error.pendingScripts??[],message:error.message}};
            throw error;
          }
          return { ok: out.status === 'ready', action, result: {
            status: out.status,
            decisionId: out.decision?.id ?? null,
            artifactPath: out.artifact?.artifactPath ?? null,
            contentHash: out.artifact?.contentHash ?? null,
            installSpec: out.package?.installSpec ?? out.package?.spec ?? null,
            tgzPath: out.package?.tgzPath ?? null,
            next: (out.package?.installSpec ?? out.package?.spec)
              ? `DSH 原生安装：dsh plugin --profile <p> add ${out.package.installSpec ?? out.package.spec}` : null,
          } };
        }
        if (action === 'reject') {
          if (!args.requestId) throw new Error('[FH_BAD_REQUEST] reject 需要 requestId');
          const rec = await orchestrator.reject({
            requestId: args.requestId, approvedBy: args.approvedBy ?? null, reason: args.reason ?? null,
          });
          return { ok: true, action, result: { requestId: args.requestId, state: rec.state } };
        }
        if (action === 'status') {
          return { ok: true, action, result: {
            mode: orchestrator.mode, frameworkRoot: orchestrator.frameworkRoot,
            plugins: orchestrator.list(),
          } };
        }
        throw new Error(`[FH_BAD_REQUEST] 未知 action：${action}`);
      };
      // 无 phase 线索（回归脚本）：逐字原行为。
      if (!gated) return dispatchAction();
      const state = readBodyPhase(hints);
      if (state.phase !== 'on') return toolPromptResult(action, state);
      return withBodyOperation(opDirFor(state, hints), dispatchAction);
    })()),
    presentCall: (args) => ({ card: 'generic', title: `鱼的手 · ${args.action}`, kind: 'read' }),
    presentResult: () => ({ card: 'generic', title: '鱼的手结果' }),
  };
}

/**
 * 宿主入口（真实接入点）。宿主加载本插件后调用 apply(ctx)。
 * W1 的 w6-boot 已保证 off 时不插入本入口行；这里仍对运行时翻转做逐请求门禁。
 * 编排器全程懒构造（getOrch），apply 阶段绝不 new FishHandOrchestrator。
 */
export function apply(ctx, config = {}) {
  if (!ctx?.connection?.fetch?.register) {
    throw new Error('[FH_NO_HOST_CONNECTION] 宿主未提供 connection.fetch.register');
  }
  const getOrch = makeLazyOrchestrator({
    orchestrator: config.orchestrator ?? null,
    frameworkRoot: config.frameworkRoot ?? null,
    mode: config.mode ?? null,
  });
  const handle = createHandler({ getOrch, bodySwitch: config });
  const invoke = operation => {
    if (config.dataBindingPath && !samePath(JSON.parse(readFileSync(config.dataBindingPath, 'utf8')).root, config.frameworkRoot))
      throw new Error('FH_ROOT_RELOAD_REQUIRED: 数据位置已切换；当前操作收尾后请重新加载身体，不再向旧位置启动新流程');
    return config.stateConfigPath ? withStateConfig(config.stateConfigPath, operation) : operation();
  };
  for (const route of ROUTES) {
    register(ctx, route.path, route.methods, async request => {
      try { return await invoke(() => handle(request)); }
      catch (error) { return jsonResponse(request, { ok: false, error: error.message }, 409); }
    });
  }
  const tools = [];
  const mountTool = (target) => {
    const def = fishHandToolDefinition({ getOrch, bodySwitch: config });
    { const execute = def.execute; def.execute = (...args) => invoke(() => execute(...args)); }
    let release = null;
    const hints = bodySwitchHints(config);
    const stop = observeBodyPhase(hints, async (state) => {
      if (state.phase === 'off' && release) {
        const dispose = release; release = null;
        await dispose();
      } else if (state.phase === 'on' && !release) {
        release = target.effect(() => target.tools.register(def));
      }
    });
    target.effect(() => () => stop());
    tools.push(def.name);
  };
  if (typeof ctx.inject === 'function') {
    // tools 就绪后再挂工具；审批路由不受影响
    ctx.inject(['tools'], (child) => mountTool(child));
  } else if (typeof ctx.tools?.register === 'function') {
    mountTool(ctx);
  }
  return { registered: ROUTES.map((r) => r.path), tools };
}

/** 同进程调用形态（回归脚本用；与 apply 共用同一 handler，不另写一套端点）。 */
export function createFishBodyApprovalHost(options = {}) {
  const { orchestrator = null, frameworkRoot = null, mode = null } = options;
  const handle = createHandler({ orchestrator, frameworkRoot, mode, bodySwitch: options });
  async function fetch({ method = 'GET', path, body = {} }) {
    const request = new Request(`http://localhost${path}`, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' } } : {}),
    });
    const response = await handle(request);
    return { status: response.status, body: await response.json() };
  }
  return { name, inject, fetch, ROUTES };
}
