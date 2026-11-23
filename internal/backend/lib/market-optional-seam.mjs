/* fish-body · dshmarket 可选适配 seam（维护源，可审计；本轮只部署到隔离副本）
 *
 * 部署位置（仅隔离副本，绝不进日常 node_modules）：
 *   E:\gpt6 项目\隔离验收\fish-install-20261113-171724\profiles\extended-home-v2\
 *     profiles\web\node_modules\dshmarket\lib\fish-body-optional.js
 *
 * 职责：让 dshmarket 的更新消费者识别「普通市场直装入手仓、已在饭仓登记真实来源」
 * 的 link: 插件，并把登记记录里的原渠道目标交回 dshmarket 既有更新执行链。
 *
 * 三处关键纠正的 seam 侧落点：
 *   ① 来源判定与分析批准分离：本文件只读 SLOT 暴露的 directSourceRecord/managedDirectLink，
 *      不建分析任务、不发模型请求、不伪造 formalDecision/analysisApproved。
 *   ② 读来源接回原渠道、不按 catalog 换源：bodyDirectUpdateSpec 直接由 updateChannel 生成
 *      github:owner/repo#path:/subdir 或 name@range，不查 catalog、不把 GitHub 换同名 npm latest。
 *   ③ 完整消费者：routes.js 的 onlineSourceOf/updateCheckInputs/update 路由/stillLocal 与
 *      updates.js 的 link 比较分支统一走本 seam，API/summary/列表/单条/按钮结论一致。
 *
 * 边界：普通开发 link、generation link、未登记 link 一律返回 false/null，保持原生行为；
 * 禁止伪造 .generations/live/ 段。身体总关时 SLOT.forProfile 仍可用（原生 manager 仍在），
 * 但 run() 不在 body off 下操作——本 seam 的只读判定不依赖胃/身体的分析路径。
 */
function slot(profileDir) {
  try { return globalThis[Symbol.for('fish-body.market.v1')]?.forProfile?.(profileDir) ?? null }
  catch { return null }
}

/** 兼容分析受管 link（既有语义，要求 body on + formalDecisionId）——用于 restore 结果核验。 */
export function isBodyManagedSpec(profileDir, name, spec) {
  try { return slot(profileDir)?.managedSpec?.(name, spec) === true } catch { return false }
}

/** 直装受管 link：饭仓已登记真实来源、当前安装/Profile/版本内容身份三者对应。 */
export function isBodyDirectManagedLink(profileDir, name, spec) {
  try { return slot(profileDir)?.managedDirectLink?.(name, spec) === true } catch { return false }
}

/** 已成功安装的真实来源记录（registration-only 或 formal-registry），无来源则 null。 */
export function bodyDirectSourceRecord(profileDir, name, spec) {
  try { return slot(profileDir)?.directSourceRecord?.(name, spec) ?? null } catch { return null }
}

/** 原渠道更新目标 {kind:'github'|'npm', ...}，不查 catalog、不换源。 */
export function bodyDirectUpdateTarget(profileDir, name, spec) {
  try { return slot(profileDir)?.directUpdateTarget?.(name, spec) ?? null } catch { return null }
}

/**
 * 更新选择器（Codex #318 阻塞1）：更新目标必须跟踪「用户原始请求」，不能冻结成已装 commit。
 *   - 显式 40-hex commit pin（refKind==='pin'）：原样保留 pin，不自动追默认分支（#315 #3）。
 *   - 浮动 ref / branch / tag（refKind==='ref'）：继续跟踪该 ref，不用 resolvedCommit 替代。
 *   - 无请求（refKind==='default'）：不写 ref，跟默认分支。
 * resolvedCommit / sourceCommit 仅是「已装内容身份」，绝不进更新选择器。
 */
function updateRefOf(target) {
  const requested = String(target.requestedRef ?? target.ref ?? '').trim()
  if (requested) return requested                 // pin 或浮动 ref 都原样保留
  return ''                                        // 无请求 → 跟默认分支
}

/**
 * 把登记记录的原渠道目标转成 dshmarket 既有更新执行链接受的 spec：
 *   github → "github:owner/repo#<ref&>path:/subdir"（或没有 subdir 的 "github:owner/repo#<ref>"）
 *   npm    → "name@range"（去掉 npm: 前缀），交 npm 分支按 latest 比较
 * 绝不查 catalog，绝不把 GitHub 换成同名 npm latest。
 * 未登记 / 非法目标返回 null（调用方维持原生 link 行为）。
 */
export function bodyDirectUpdateSpec(profileDir, name, spec) {
  const ch = bodyDirectUpdateChannel(profileDir, name, spec)
  return ch ? ch.spec : null
}

/**
 * 原渠道更新通道对象（#318 阻塞1）：除 spec 外保留 npm registryUrl 与 kind，
 * 供消费者按 per-name registry 取 metadata / 保留 range，不退化成「只记录后忽略」。
 * @returns {{kind:'github'|'npm', spec:string, registryUrl:string|null, requestedRef:string|null,
 *            resolvedCommit:string|null, refKind:string, sourceSubdir:string}|null}
 */
export function bodyDirectUpdateChannel(profileDir, name, spec) {
  const target = bodyDirectUpdateTarget(profileDir, name, spec)
  if (!target || typeof target !== 'object') return null
  if (target.kind === 'github') {
    const url = String(target.sourceUrl ?? '')
    const m = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#]|$)/i.exec(url)
    const repo = m?.[1] ?? (() => {
      const s = String(target.spec ?? '')
      const g = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#|$)/i.exec(s)
      return g?.[1] ?? null
    })()
    if (!repo) return null
    const sub = String(target.sourceSubdir ?? '').replace(/^\/+|\/+$/g, '')
    const ref = updateRefOf(target)
    const selectors = [ref, sub ? `path:/${sub}` : ''].filter(Boolean)
    return { kind: 'github', spec: `github:${repo}${selectors.length ? `#${selectors.join('&')}` : ''}`,
      registryUrl: null, requestedRef: String(target.requestedRef ?? target.ref ?? '') || null,
      resolvedCommit: String(target.resolvedCommit ?? '') || null,
      refKind: String(target.refKind ?? '') || 'default', sourceSubdir: sub };
  }
  if (target.kind === 'npm') {
    // range 原样保留：不把 ^1.2.0 收窄成已装的 1.2.0；registryUrl 交消费者取 metadata。
    const s = String(target.spec ?? name ?? '').trim().replace(/^npm:/, '')
    if (!s) return null
    return { kind: 'npm', spec: s, registryUrl: target.registryUrl ? String(target.registryUrl) : null,
      requestedRef: null, resolvedCommit: null, refKind: 'default', sourceSubdir: '' };
  }
  return null
}
