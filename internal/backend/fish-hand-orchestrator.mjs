/** Canonical rice -> stomach -> hand orchestration, keeping the existing approval API.
 * Rice preserves fixed upstream; stomach prepares dependencies/approved scripts;
 * hand holds a runnable, hashed tarball. Only the native DSH installer writes Profile state.
 * A valid approval is reused on retry; expanded execution scope must be supplied explicitly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { samePath } from './lib/path-identity.mjs';
import { sha256File } from './lib/w6-utils.mjs';
import { processRequest, createRequest, RequestStore } from './lib/orchestrator.mjs';
import { runW4W5, reverifyReady } from './lib/pipeline.mjs';
import { DecisionStore } from './lib/decision.mjs';
import { buildInstallPackage } from './lib/w6-package.mjs';
import {
  writeInjectionReviewEvidence, INJECTION_REVIEW_SCHEMA,
} from './lib/w6-injection-review.mjs';
import { createFormalDecision, validateFormalDecision } from './formal-decision.mjs';
import { fetchSourceToRice, recordRiceSource, parseGithubUrl, normalizeSubdir, sourceMaterialName } from './lib/source-fetch.mjs';
import { collectSource } from './lib/upstream.mjs';
import { loadProductionState } from './production-state.mjs';
import { ingestNpmPublished, reviewToolContent } from './lib/market-source.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const atomic = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
};
/** 带稳定错误码的编排错误（REST 端点原样回传，便于调用方区分拒绝原因）。 */
function fhError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

/**
 * @param {object} p
 * @param {string} p.frameworkRoot 框架根（生产为 D:/deepseek框架；复核为独立副本根）
 * @param {'production'|'isolation'} [p.mode]
 */
export class FishHandOrchestrator {
  constructor({ frameworkRoot, root = null, mode = 'production', reviewedBy = null, sourceTransport = null }) {
    // root 兼容旧调用（等价于 frameworkRoot）
    this.frameworkRoot = frameworkRoot ?? root;
    if (!this.frameworkRoot) throw fhError('FH_NO_FRAMEWORK_ROOT', '缺少 frameworkRoot');
    this.mode = mode;
    this.sourceTransport = sourceTransport;
    this.reviewedBy = reviewedBy
      ?? (mode === 'production' ? 'fish-hand-approval-host' : 'isolated-test-reviewer');

    // canonical 四层落位（与 fish-body SECTIONS 一致）
    this.riceRoot = join(this.frameworkRoot, '饭');
    this.stomachRoot = join(this.frameworkRoot, '鱼的胃', '来源审查');
    this.handRoot = join(this.frameworkRoot, '鱼的手');
    this.registryRoot = join(this.handRoot, '插件注册表');
    this.registryPath = join(this.registryRoot, 'registry.json');
    this.requestsRoot = join(this.registryRoot, 'requests');
    this.decisionsRoot = join(this.registryRoot, 'decisions');
    this.pluginsRoot = join(this.handRoot, '插件仓');
    this.logsRoot = join(this.handRoot, '运行数据', 'logs');

    for (const d of [this.riceRoot, this.stomachRoot, this.registryRoot,
      this.requestsRoot, this.decisionsRoot, this.pluginsRoot, this.logsRoot]) {
      mkdirSync(d, { recursive: true });
    }
    this.store = new RequestStore(this.registryRoot);      // → 插件注册表/requests + index.json
    this.decisionStore = new DecisionStore(this.decisionsRoot); // → 插件注册表/decisions/decisions
    if (!existsSync(this.registryPath)) {
      atomic(this.registryPath, { schema: 'fish-hand-plugin-registry/v1', plugins: [] });
    }
  }

  get auditPath() { return join(this.logsRoot, 'orchestrator.jsonl'); }

  log(row) {
    mkdirSync(this.logsRoot, { recursive: true });
    writeFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n',
      { flag: 'a' }, 'utf8');
  }

  registry() {
    const doc = readJson(this.registryPath);
    if (!Array.isArray(doc.plugins)) doc.plugins = Object.values(doc.plugins ?? {});
    return doc;
  }

  /**
   * 目标 profile 目录：显式给出优先，否则取手侧唯一的受管 profile。
   *
   * 与准入门同源（production-state 的 defaultProfileDir）：准入门在锁内实际
   * 比对的就是这个值，若这里另算一套，正式决定必然绑不上（FH_DECISION_UNBOUND）。
   */
  targetProfileOf(explicit) {
    if (explicit) return String(explicit);
    try {
      return String(loadProductionState().defaultProfileDir ?? '');
    } catch { throw fhError('FH_TARGET_PROFILE_REQUIRED','无法确定目标 Profile，请明确 targetProfile'); }
  }

  /** ① 安装意图 → pending 请求（零副作用；不写 node_modules、不改 profile）。 */
  createPending(req) {
    const id = req.requestId ?? `req-${Date.now()}`;
    const suppliedName = req.packageName ?? req.pluginId;
    const location = req.sourceUrl ? parseGithubUrl(req.sourceUrl,{ref:req.ref,subdir:req.subdir}) : null;
    const repositoryName = location?.repo ?? null;
    const sourceSelection = location ? {ref:location.ref,subdir:location.subdir,treePath:location.treePath} : {ref:req.ref??null,subdir:normalizeSubdir(req.subdir??''),treePath:null};
    const name = suppliedName ?? repositoryName;
    if (!name || !req.spec) throw fhError('FH_BAD_REQUEST', '缺少 packageName / spec');
    const request = createRequest({ id, packageName: name, spec: req.spec });
    const record = {
      ...request,
      // 安装意图原文（不可变）：来源规格 + 本次拟加载形态 + 目标 profile
      requestId: id, pluginId: req.pluginId ?? name,
      packageNameSource: suppliedName != null ? 'explicit' : 'repository-default',
      requestedPackageName: suppliedName ?? null,
      requestedVersion: req.version ?? null,
      repositoryName, sourceSelection,
      version: req.version ?? null,
      loadForm: req.loadForm ?? 'tool',
      targetProfile: this.targetProfileOf(req.targetProfile),
      repoDir: req.repoDir ?? null,
      // GitHub 链接入口：没有本地 repoDir 时，用它在审查前把仓库下载到饭
      sourceUrl: req.sourceUrl ?? null,
      intent: {
        spec: req.spec, requestedScopes: req.requestedScopes ?? null,
        note: req.note ?? null,
      },
      // grantedScopes 在审批端点按 W3 实际发现、用户确认后写入（见 approve）
      grantedScopes: null,
    };
    const existing=this.store.load(id);
    if(existing) {
      const sameName = existing.packageNameSource === 'repository-default'
        ? suppliedName == null && existing.repositoryName === repositoryName
        : (existing.requestedPackageName ?? existing.packageName) === suppliedName;
      if(sameName && (existing.intent?.spec??existing.spec)===req.spec
        && samePath(existing.targetProfile,record.targetProfile)
        && JSON.stringify(existing.sourceSelection??{ref:null,subdir:null,treePath:null})===JSON.stringify(sourceSelection)) return existing;
      throw fhError('FH_REQUEST_ID_REUSED', 'requestId 已绑定其他安装意图');
    }
    this.store.save(record);
    this.log({ kind: 'pending-created', requestId: id, packageName: name, spec: req.spec });
    return record;
  }

  /**
   * ② 饭 + 胃：复用 W2/W3（真实采集 + 材料生成），不下结论、不写运行态。
   *
   * 来源入口（本轮补齐）：记录只有 `sourceUrl`（GitHub 链接）时，先把仓库下载到
   * `饭/github.com/<owner>/<repo>/仓库`，再走同一套 ingest / collectFromGit；
   * 本地 `repoDir` 行为保持不变。
   */
  runW2W3(requestId, { onCollected = null } = {}) {
    let rec = this.store.load(requestId);
    if (!rec) throw fhError('FH_NO_REQUEST', `请求不存在：${requestId}`);
    if (rec.sourceKind==='npm') return ingestNpmPublished(this, rec, { onCollected });

    let repoDir = rec.repoDir;
    let riceRoot = this.riceRoot;
    let sourceEntry = null;
    const selection=rec.sourceSelection ?? {};
    const intent=String(rec.intent?.spec??rec.spec);
    const revision=rec.source?.pinnedCommit??intent.match(/#([0-9a-f]{7,40})$/i)?.[1]??null;
    let subdir=rec.source?.subdir??selection.subdir??'';
    if (!repoDir || !existsSync(repoDir) || rec.sourceDownload) {
      if (!rec.sourceUrl) throw fhError('FH_NO_REPO', `缺少可采集的上游仓库：${String(repoDir)}`);
      sourceEntry=fetchSourceToRice({frameworkRoot:this.frameworkRoot,url:rec.sourceUrl,revision,
        ref:selection.ref,subdir:rec.source?.subdir??selection.subdir,transport:this.sourceTransport??{}});
      repoDir=sourceEntry.repoDir;riceRoot=sourceEntry.riceParent;subdir=sourceEntry.subdir;
      rec={...rec,repoDir,sourceDownload:{owner:sourceEntry.owner,repo:sourceEntry.repo,head:sourceEntry.head,
        ref:sourceEntry.ref,subdir,downloadMethod:sourceEntry.downloadMethod,attempts:sourceEntry.attempts,
        reused:sourceEntry.reused,at:new Date().toISOString()}};
      this.store.save(rec);
      this.log({kind:'source-downloaded',requestId,head:sourceEntry.head,subdir,downloadMethod:sourceEntry.downloadMethod});
    }
    let pinnedCommit=sourceEntry?.head;
    if (!pinnedCommit) {
      const selected=revision??selection.ref??'HEAD';
      try { pinnedCommit=execFileSync('git',['-C',repoDir,'rev-parse','--verify',`${selected}^{commit}`],
        {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
      catch { throw fhError('FH_REF_UNAVAILABLE',`本地仓库无法解析引用 ${selected}`); }
    }
    // Identity and every downstream file come from the same selected commit/subtree.
    const collected=collectSource({repoDir,commit:pinnedCommit,subdir,sourceEntry});
    const manifest=collected.contents.get('package.json');
    if (!manifest) throw fhError('SOURCE_PACKAGE_JSON_MISSING',`所选目录 ${subdir||'仓库根'} 在提交 ${pinnedCommit} 中没有 package.json；请提供子目录 tree 链接或 subdir`);
    let identity;
    try { identity=JSON.parse(manifest.toString('utf8')); }
    catch { throw fhError('FH_PACKAGE_IDENTITY_INVALID',`所选目录 ${subdir||'仓库根'} 的 package.json 无效`); }
    if (!identity || typeof identity.name !== 'string' || !identity.name.trim()
      || typeof identity.version !== 'string' || !identity.version.trim())
      throw fhError('FH_PACKAGE_IDENTITY_INVALID', '固定源码 package.json 必须包含 name 和 version');
    const expectedName = rec.packageNameSource === 'repository-default' ? null : (rec.requestedPackageName ?? rec.packageName);
    if (expectedName != null && expectedName !== identity.name)
      throw fhError('FH_PACKAGE_IDENTITY_MISMATCH', `包名不匹配：期望 ${expectedName}，实际 ${identity.name}`);
    const expectedVersion = Object.hasOwn(rec, 'requestedVersion') ? rec.requestedVersion : rec.version;
    if (expectedVersion != null && expectedVersion !== identity.version)
      throw fhError('FH_PACKAGE_VERSION_MISMATCH', `版本不匹配：期望 ${expectedVersion}，实际 ${identity.version}`);
    if ((rec.decisionId || rec.formalDecisionId || rec.approvalInput)
      && (rec.packageName !== identity.name || rec.version !== identity.version))
      throw fhError('FH_PACKAGE_IDENTITY_MISMATCH', `已有批准绑定 ${rec.packageName}@${rec.version}，实际 ${identity.name}@${identity.version}；不自动改绑`);
    rec = { ...rec, packageName: identity.name,
      pluginId: !rec.pluginId || rec.pluginId === rec.packageName ? identity.name : rec.pluginId,
      version: identity.version };
    this.store.save(rec);
    const repoName = sourceMaterialName(sourceEntry?.repo ?? rec.repositoryName ?? String(rec.pluginId).replace(/^@/,'').replace(/\//g,'+'),subdir);
    const out = processRequest({
      root: this.handRoot,
      onCollected,
      repo: { dir: repoDir, name: repoName, subdir, sourceEntry, collected },
      pinnedCommit,
      request: rec,
      store: this.store,
      dirs: { rice: riceRoot, stomach: this.stomachRoot },
    });
    if (out.status === 'failed') {
      this.log({ kind: 'w2w3-failed', requestId, error: out.error });
      return { status: 'failed', record: out.record, error: out.error };
    }
    const review = readJson(out.record.stomach.reviewPath);
    if (sourceEntry) {
      // 补齐饭侧既有记录（来源.json 合并 / 更新记录 / 项目索引）
      recordRiceSource({
        frameworkRoot: this.frameworkRoot, entry: sourceEntry,
        riceDir: out.record.rice.dir, packageName: rec.packageName,
        license: review?.license ?? null,
      });
    }
    this.log({ kind: 'w2w3-done', requestId, pinnedCommit,
      riceDir: out.record.rice.dir, reviewPath: out.record.stomach.reviewPath,
      source: sourceEntry ? `${sourceEntry.owner}/${sourceEntry.repo}` : 'local-repo' });
    return { status: out.status, record: out.record, review, riceDir: out.record.rice.dir };
  }

  /**
   * ③ 审查处置 + 决定 + 真实产物 + 安装包 + 注入面证据 + 正式批准决定。
   * 审查未完成（未显式给出 unknownDispositions）→ 直接拒绝，绝不写 ready。
   */
  approve({ requestId, approvedBy, approvedScopes, authorization, unknownDispositions, conclusionFields, marketInstall=false }) {
    const rec = this.store.load(requestId);
    if (!rec) throw fhError('FH_NO_REQUEST', `请求不存在：${requestId}`);
    // awaiting-approval / adapting / ready 都接受：
    //   adapting —— W5 产物构建失败后重跑；
    //   ready    —— 已批准且产物已复算通过，但安装包构建失败时补建（幂等复核不会新建决定）。
    // 三者都不会绕过审查与授权：审查完成、unknown 处置、六维授权仍逐项校验。
    if (!['awaiting-approval', 'adapting', 'ready'].includes(rec.state)) {
      throw fhError('FH_BAD_STATE', `请求状态不允许批准：${rec.state}`);
    }
    let saved=rec.approvalInput;
    const context={commit:rec.source?.pinnedCommit,contentHash:rec.source?.contentHash,targetProfile:rec.targetProfile,loadForm:rec.loadForm,subdir:rec.source?.subdir??''};
    if(saved?.context && (saved.context.commit!==context.commit||saved.context.contentHash!==context.contentHash
      ||!samePath(saved.context.targetProfile,context.targetProfile)||saved.context.loadForm!==context.loadForm||(saved.context.subdir??'')!==context.subdir)) saved=null;
    // Existing approved requests predate approvalInput. Reuse their bound decision,
    // never infer authorization from the plugin's own manifest.
    if(!saved && rec.state==='ready') {
      const rows=this.decisionStore.findByRequest(rec.id).filter(d=>d.status==='active' && !this.decisionStore.isInvalidated(d.id));
      const previous=rows.find(d=>d.id===rec.decisionId)??rows.at(-1);
      const formal=rec.formalDecisionId && existsSync(join(this.decisionsRoot,`${rec.formalDecisionId}.json`))
        ? readJson(join(this.decisionsRoot,`${rec.formalDecisionId}.json`)):null;
      if(previous && formal?.productionApproval===true && formal.status==='active'
        && samePath(formal.binding?.targetProfile,context.targetProfile)
        && formal.binding?.contentHash===context.contentHash && previous.binding?.pinnedCommit===context.commit
        && (previous.binding?.subdir??'')===context.subdir) {
        const conclusion=readJson(previous.review.conclusionPath);
        saved={approvedBy:formal.approvedBy,approvedScopes:previous.approvedScopes,authorization:previous.authorization,
          unknownDispositions:conclusion.unknownDispositions,conclusionFields:undefined};
      }
    }
    if(!saved && !approvedBy && !approvedScopes && !authorization) {
      const priorRow=this.registry().plugins.find(row=>row.packageName===rec.packageName
        && row.sourceCommit===context.commit && (row.sourceSubdir??'')===context.subdir && row.contentHash===context.contentHash);
      const priorRequest=priorRow?.requestId && this.store.load(priorRow.requestId);
      const priorDecision=priorRow?.decisionRecordId && this.decisionStore.load(priorRow.decisionRecordId);
      const priorPath=priorRow?.formalDecisionId && join(this.decisionsRoot,`${priorRow.formalDecisionId}.json`);
      if(priorRequest && priorDecision && priorPath && existsSync(priorPath)
        && samePath(priorRequest.targetProfile,context.targetProfile) && priorRequest.loadForm===context.loadForm) {
        const formal=readJson(priorPath);
        const packaged=readJson(priorRow.packageRecordPath);
        const binding=validateFormalDecision({decision:formal,request:priorRequest,
          artifact:{artifactPath:priorRow.artifactPath,contentHash:priorRow.contentHash,
            packageIntegrity:packaged.packageIntegrity,runtimeContentHash:packaged.runtimeContentHash},
          profileDir:context.targetProfile,mode:this.mode,decisionsRoot:this.decisionsRoot});
        const ready=reverifyReady({root:this.handRoot,record:priorRequest,decision:priorDecision,
          artifactDir:priorRow.artifactPath,decisionStore:this.decisionStore});
        if(binding.ok && ready.ok && priorRequest.review?.conclusionRef?.reviewContentHash===sha256File(rec.stomach.reviewPath)) {
          const reviewed=readJson(priorDecision.review.conclusionPath);
          saved={approvedBy:formal.approvedBy,approvedScopes:priorDecision.approvedScopes,
            authorization:priorDecision.authorization,unknownDispositions:reviewed.unknownDispositions,
            conclusionFields:reviewed.conclusion};
          // Keep only conclusion fields accepted by the existing review API.
          saved.conclusionFields={shape:reviewed.conclusion.shape,capabilities:reviewed.conclusion.capabilities,
            risks:reviewed.conclusion.risks,injectionAssessment:reviewed.conclusion.injectionAssessment,basis:reviewed.conclusion.basis};
        }
      }
    }
    approvedBy ??= saved?.approvedBy; approvedScopes ??= saved?.approvedScopes;
    authorization ??= saved?.authorization; unknownDispositions ??= saved?.unknownDispositions;
    conclusionFields ??= saved?.conclusionFields;
    if (!approvedBy) throw fhError('FH_NO_APPROVER', '缺少真实审批主体');
    if (unknownDispositions === undefined || unknownDispositions === null) {
      throw fhError('FH_REVIEW_INCOMPLETE', '审查未完成：必须显式给出 unknownDispositions');
    }
    if (!approvedScopes) throw fhError('FH_NO_SCOPES', '缺少已确认的批准范围');

    // 批准范围是「本次审查后用户确认的范围」，写入记录后与决定逐字绑定
    const scoped = { ...rec, grantedScopes: approvedScopes, approvalInput:{ approvedBy, approvedScopes, authorization, unknownDispositions, conclusionFields, context } };
    if(rec.approvalInput && JSON.stringify(rec.approvalInput)!==JSON.stringify(scoped.approvalInput) && rec.state==='ready') {
      scoped.state='awaiting-approval'; scoped.review={...scoped.review, complete:false};
    }
    let run;try {run = runW4W5({
      root: this.handRoot,
      store: this.store,
      decisionStore: this.decisionStore,
      record: scoped,
      reviewedBy: this.reviewedBy,
      unknownDispositions, conclusionFields,
      kind: 'approve',
      authorization,
      approvedScopes,
      note: '审批端点确认范围与授权后生成决定（W4），并据实际已审代码构建 W5 产物',
      productionApproval: this.mode === 'production',
      productionReview: this.mode === 'production',
      // pluginsRoot = 手根：产物落 <手>/插件仓/<name>/<version>/<rev>（不重复叠一层插件仓）
      artifactOptions: { pluginsRoot: this.handRoot },
    });}catch(error){
      // A rejected replacement approval must not poison the previous valid request.
      // Build/install failures after authorization retain their resumable state.
      if(rec.state==='ready' && /^(DEC_|CON_)/.test(String(error.code??''))) this.store.save(rec);
      throw error;
    }
    // already-ready 也是放行：记录已复核通过、产物已复算一致，只差安装包与登记。
    // 它的 run 形状不同（没有 run.artifact / run.review），下面统一取记录里已校验的对象。
    if (run.status !== 'ready' && run.status !== 'already-ready') {
      this.log({ kind: 'approve-blocked', requestId, status: run.status });
      return { status: run.status, run, record: run.record };
    }

    const authorized=this.store.load(rec.id)??run.record;
    authorized.approvalInput=scoped.approvalInput;
    authorized.grantedScopes=approvedScopes;
    this.store.save(authorized);

    const artifactDir = run.status === 'ready'
      ? run.artifact.artifactDir
      : (run.record?.artifact?.path ?? null);
    if (!artifactDir) throw fhError('FH_NO_ARTIFACT', '已就绪记录缺少产物路径');
    const artifactManifest = readJson(join(artifactDir, 'manifest.json'));
    const revision = basename(artifactDir);
    const version = artifactManifest.version ?? scoped.version;
    // 真实安装包（字节来自已审产物），落 <手>/插件仓/<name>/<version>/安装包/
    const pkg = buildInstallPackage({
      artifactDir,
      outDir: dirname(artifactDir),
      packageName: rec.packageName,
      version,
      revision, workRoot:join(this.frameworkRoot,'鱼的胃','构建工作副本'),
      approvedScopes, authorization, production:this.mode==='production',
      published:rec.source?.kind==='npm',
      registryUrl:marketInstall?rec.marketRegistry:null,
      reviewPrepared:marketInstall?({work,dependencies})=>{
        reviewToolContent(work);
        for(const dep of dependencies) reviewToolContent(dep.resolvedDir);
      }:null,
    });
    // 安装规格必须与 DSH 原生安装逐字一致：
    //   - GitHub 来源 → github:<owner>/<repo>#<pinnedCommit>（原生 pnpm 会 clone 该提交并按 allowBuilds 构建）
    //   - 本地来源   → 已审 tgz（file:...）
    // 两种形态都固定到「本次已审对象」，不引入未审代码。
    const installSpec = pkg.spec;

    // 绑定事实回写请求记录（本轮实测缺陷）：
    // 准入门在锁内用 validateFormalDecision 把**请求记录**的 version / spec /
    // targetProfile 与正式决定逐字比对；而请求记录里这三项一直是「用户输入原样 /
    // null / undefined」，于是任何一次批准都会在原生安装前被判
    // FH_DECISION_UNBOUND 永久拒绝（表现是「批准成功但永远装不上」）。
    // 已审对象本来就是「这个版本的这份制品 + 这条安装规格 + 这个 profile」，
    // 所以批准时把它们解析成实际值写回请求；用户输入原文保留在 intent.spec / sourceUrl。
    const intentSpec = rec.intent?.spec ?? rec.spec;
    const targetProfile = this.targetProfileOf(rec.targetProfile);
    // 必须基于**最新**记录回写：W4/W5 期间已把 grantedScopes / state / artifact
    // 写进磁盘，拿函数开头读到的旧对象整体覆盖会把这些一起抹掉。
    const binding = this.store.load(rec.id) ?? rec;
    binding.version = version;
    binding.spec = installSpec;
    binding.targetProfile = targetProfile;
    binding.installSpec = installSpec;
    binding.intent = { ...(binding.intent ?? {}), spec: intentSpec };
    this.store.save(binding);

    // 注入面证据：生产 schema，绑定本次产物 / 决定 / 结论 / 提交
    const evidence = this.mode==='production' ? { path:null, source:'existing-review-decision' } : writeInjectionReviewEvidence({
      path:join(artifactDir,'注入面审查证据.json'), w5ManifestPath:join(artifactDir,'manifest.json'),
      conclusionPath:run.review?.conclusion?.path ?? run.record?.review?.conclusionRef?.path,
      reviewPath:scoped.stomach.reviewPath, decision:run.decision?.decision??run.decision,
      pinnedCommit:scoped.source.pinnedCommit, schema:INJECTION_REVIEW_SCHEMA
    });

    // 正式批准决定（由审批端点生成；绑定实际制品哈希，取自 manifest 实读）
    const manifestDoc = artifactManifest;
    const decision = createFormalDecision({
      request: {
        requestId: rec.requestId ?? rec.id, pluginId: rec.pluginId ?? rec.packageName,
        packageName: rec.packageName, version, spec: installSpec, loadForm: rec.loadForm, source:rec.source,
        grantedScopes: approvedScopes, targetProfile,
        // 留胃形态要让正式决定用同一口径复算人格/记忆授权
        mixedHold: scoped.holdInStomach === true,
        injectionAssessment:readJson(this.store.load(rec.id).review.conclusionRef.path)?.conclusion?.injectionAssessment,
      },
      artifact: { artifactPath: artifactDir, contentHash: manifestDoc.contentHash, packageIntegrity:pkg.packageIntegrity, runtimeContentHash:pkg.runtimeContentHash },
      approvedBy,
      approvedScopes,
      authorization,
      targetProfile,
      mode: this.mode,
    });
    const baseId=decision.id;
    let path=join(this.decisionsRoot,`${baseId}.json`);
    if(existsSync(path) && readJson(path).bindingFingerprint!==decision.bindingFingerprint) {
      decision.id=baseId+'-'+decision.bindingFingerprint.replace('sha256:','').slice(0,16);
      decision.asLegacyDecision.id=decision.id; path=join(this.decisionsRoot,`${decision.id}.json`);
    }
    if(!existsSync(path))atomic(path,decision);

    // 手侧唯一运行态真源：registry（覆盖同包旧行，不动其它记录）
    // already-ready 分支里 run.decision 就是决定本身，不再套一层 .decision；两种形状都认
    const legacyDecisionId = run.decision?.decision?.id ?? run.decision?.id ?? null;
    const registry = this.registry();
    const previous=registry.plugins.find(x=>(x.pluginId??x.packageName)===rec.packageName);
    const previousVersions=previous?[...(previous.previousVersions??[]),Object.fromEntries(Object.entries(previous).filter(([k])=>k!=='previousVersions'))]:[];
    registry.plugins = registry.plugins.filter((x) => (x.pluginId ?? x.packageName) !== rec.packageName);
    registry.plugins.push({
      pluginId: rec.pluginId ?? rec.packageName,
      packageName: rec.packageName,
      version,
      spec: installSpec,                 // 安装规格（交给 DSH 原生 pnpm 的那一条）
      sourceSpec: intentSpec,            // 安装意图原文（不可变：用户输入的原始来源）
      sourceUrl: rec.sourceUrl ?? null,
      sourceCommit: rec.source?.pinnedCommit ?? null,
      sourceSubdir: rec.source?.subdir ?? '',
      state: 'ready', active: false,
      contentHash: manifestDoc.contentHash,
      artifactPath: artifactDir,
      packagePath: pkg.tgzPath,
      packageRecordPath: pkg.recordPath,
      injectionReviewEvidencePath: evidence.path,
      requestId: rec.requestId ?? rec.id,
      decisionId: decision.id,
      formalDecisionId: decision.id,
      decisionRecordId: legacyDecisionId,
      loadForm: rec.loadForm,
      approvedScopes,
      grantedScopes: approvedScopes,
      previousVersions,
    });
    if(marketInstall) {
      // Preparation is not deployment. Keep the old installed object canonical
      // until the market actually hands this exact artifact to native install.
      const prepared={...registry.plugins.pop(),state:'prepared',active:false};
      const flat=Object.fromEntries(Object.entries(prepared).filter(([k])=>k!=='previousVersions'));
      registry.plugins.push(previous?{...previous,previousVersions:[...(previous.previousVersions??[]).filter(r=>r.spec!==prepared.spec),flat]}:prepared);
    }
    atomic(this.registryPath, registry);

    const done = {
      ...this.store.load(rec.id),
      installSpec,
      package: { spec: pkg.spec, tgzPath: pkg.tgzPath, recordPath: pkg.recordPath,
        packageIntegrity: pkg.packageIntegrity },
      formalDecisionId: decision.id,
    };
    this.store.save(done);
    this.log({ kind: 'approved', requestId: rec.id, decisionId: decision.id,
      w4DecisionId: legacyDecisionId, approvedBy,
      artifactDir, contentHash: manifestDoc.contentHash, tgzPath: pkg.tgzPath, installSpec });

    return {
      status: 'ready', record: done, decision, artifact: {
        artifactPath: artifactDir, contentHash: manifestDoc.contentHash, packageIntegrity:pkg.packageIntegrity, runtimeContentHash:pkg.runtimeContentHash,
        manifestPath: join(artifactDir, 'manifest.json'),
      }, package: { ...pkg, installSpec }, evidence, run,
    };
  }

  reject({ requestId, approvedBy, reason }) {
    const rec = this.store.load(requestId);
    if (!rec) throw fhError('FH_NO_REQUEST', `请求不存在：${requestId}`);
    rec.state = 'rejected';
    rec.rejectReason = reason ?? null;
    rec.rejectedBy = approvedBy ?? null;
    this.store.save(rec);
    this.log({ kind: 'rejected', requestId, approvedBy, reason });
    return rec;
  }

  /**
   * 放行前复核（供安装入口调用）：决定文件 + 请求记录 + **实际制品复算哈希**。
   * 不使用决定自身写的 contentHash 作为独立依据。
   */
  verifyDecision({ decisionId, requestId, profileDir }) {
    const decisionPath = join(this.decisionsRoot, `${decisionId}.json`);
    if (!existsSync(decisionPath)) {
      return { ok: false, code: 'FH_DECISION_MISSING', reason: `决定不存在：${decisionPath}` };
    }
    const decision = readJson(decisionPath);
    const rec = this.store.load(requestId);
    const artifactDir = decision?.binding?.artifactPath;
    const manifestPath = join(String(artifactDir), 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { ok: false, code: 'FH_ARTIFACT_MISSING', reason: `产物清单不存在：${manifestPath}` };
    }
    const manifest = readJson(manifestPath);
    return validateFormalDecision({
      decision, request: rec,
      artifact: { artifactPath: artifactDir, contentHash: manifest.contentHash,
        ...(rec?.package?.recordPath ? readJson(rec.package.recordPath) : {}) },
      profileDir: profileDir ?? rec?.targetProfile,
      mode: this.mode, decisionsRoot: this.decisionsRoot,
    });
  }

  /** 已批准候选的只读清单（供审批界面展示；不参与放行判定）。 */
  list() {
    return this.registry().plugins.map((row) => ({
      pluginId: row.pluginId ?? row.packageName, version: row.version, state: row.state,
      spec: row.spec, decisionId: row.decisionId ?? null,
      artifactPath: row.artifactPath ?? null,
      evidenceSha256: row.injectionReviewEvidencePath && existsSync(row.injectionReviewEvidencePath)
        ? sha256File(row.injectionReviewEvidencePath) : null,
    }));
  }

  /** REST 端点（由 fish-body 审批入口调用）。 */
  handleRest({ method, path, body = {} }) {
    try {
      if (method === 'GET' && path === '/api/fish-hand/pending') {
        return { status: 200, body: { pending: this.store.list() } };
      }
      if (method === 'POST' && path === '/api/fish-hand/pending') {
        return { status: 201, body: this.createPending(body) };
      }
      if (method === 'POST' && path === '/api/fish-hand/review') {
        return { status: 200, body: this.runW2W3(body.requestId) };
      }
      if (method === 'POST' && path === '/api/fish-hand/approve') {
        return { status: 200, body: this.approve(body) };
      }
      if (method === 'POST' && path === '/api/fish-hand/reject') {
        return { status: 200, body: this.reject(body) };
      }
      if (method === 'GET' && path === '/api/fish-hand/status') {
        return { status: 200, body: { mode: this.mode, frameworkRoot: this.frameworkRoot,
          registryPath: this.registryPath, plugins: this.list() } };
      }
      return { status: 404, body: { error: 'not-found' } };
    } catch (error) {
      this.log({ kind: 'rest-error', method, path, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 400) });
      return { status: 400, body: { error: error?.code ?? 'FH_ORCHESTRATOR_ERROR',
        message: String(error?.message ?? error).slice(0, 600),
        ...(error?.pendingScripts ? { pendingScripts:error.pendingScripts } : {}) } };
    }
  }
}

export { readdirSync };
