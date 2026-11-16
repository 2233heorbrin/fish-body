/**
 * W2/W3 串联编排（隔离实现，不含任何安装动作）
 *
 *   安装请求（pending）
 *     → reviewing：W2 入饭（固定来源与提交 / 隔离饭目录 / 记录内容与依赖声明）
 *     → W3 胃材料生成（facts / candidates / unknowns，不自动下结论）
 *     → awaiting-approval（待审查 / 待决定；混合插件 holdInStomach=true，留胃不安装）
 *   任一步失败 → failed(download|admission)，绝不写 ready / installing / installed / active。
 *
 * 分区语义复用 fish-body 的 rice/stomach/hand 三键（见 sections.mjs），
 * 运行态唯一真源是 RequestStore 的 requests/<id>.json，胃只写 review.json，不写运行态。
 * 本模块**不实现** W4 审批、W5 artifact、W6 安装与激活；hand 目录本轮不创建。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSectionIds, layoutFor } from './sections.mjs';
import { ingest, drainCallLog } from './upstream.mjs';
import { buildReview, writeReview } from './review.mjs';
import { createRequest, transition, RequestStore } from './state.mjs';

export function createLayout(root, { sectionIds } = {}) {
  const ids = sectionIds ?? loadSectionIds();
  return { root, sectionIds: ids, dirs: layoutFor(root, ids) };
}

/**
 * 处理一条安装请求。
 *
 * @param {object} p
 * @param {string} p.root          隔离测试根目录
 * @param {object} p.repo          { dir, name }
 * @param {string} p.pinnedCommit  本次固定到的提交
 * @param {object} p.request       createRequest(...) 的结果（首次）
 * @param {RequestStore} [p.store]
 * @param {string[]} [p.sectionIds] 允许显式注入分区键（纯单测用；默认真实读 fish-body）
 */
export function processRequest({
  root, repo, pinnedCommit, request, store, sectionIds, dirs = null, onCollected = null,
}) {
  // dirs：允许调用方把 rice / stomach 指到 canonical 分区根（饭 / 鱼的胃/来源审查）；
  // 不传时保持原行为（root/rice、root/stomach），既有回归不受影响。
  const layout = dirs
    ? { root, sectionIds: sectionIds ?? Object.keys(dirs), dirs: { ...dirs } }
    : createLayout(root, { sectionIds });
  const requestStore = store ?? new RequestStore(root);
  drainCallLog(); // 清空，保证 callLog 只含本次请求

  const existing = requestStore.load(request.id);
  let record = existing ?? request;
  if (!existing) requestStore.save(record);

  if (existing && !['pending', 'reviewing', 'failed', 'rolled-back'].includes(existing.state)) {
    if (existing.source?.pinnedCommit === pinnedCommit && (existing.source?.subdir??'') === (repo.subdir??'')) {
      return {
        status: 'already-present', record: existing, layout,
        callLog: drainCallLog(),
        note: '同一固定提交重复处理：不覆盖已有记录、不追加 history、不重写材料',
      };
    }
    throw new Error(`ORG_REQUEST_ID_REUSED：请求 ${request.id} 已存在（state=${existing.state}），且不是同一固定提交，拒绝覆盖`);
  }

  let riceResult = null;
  let stomachResult = null;
  let reviewDoc = null;

  try {
    if (['failed', 'rolled-back'].includes(record.state)) record = transition(record, 'pending', { note: '按已固定来源恢复失败请求' });
    if (record.state !== 'reviewing') record = transition(record, 'reviewing', {
      note: 'W2 入饭 / W3 胃材料生成开始',
    });
    requestStore.save(record);

    // ---------- W2 入饭 ----------
    riceResult = ingest({
      riceRoot: layout.dirs.rice,
      repoDir: repo.dir,
      repoName: repo.name,
      subdir: repo.subdir, sourceEntry: repo.sourceEntry, collected: repo.collected,
      commit: pinnedCommit,
      requestId: record.id,
      packageName: record.packageName,
    });
    // riceResult.status === 'already-present' 时沿用已有饭目录材料，
    // 不覆盖、不追加状态迁移；只继续生成/复用胃材料。

    // Preserve the acquired original before analysis; failure here is not a
    // download fallback. The native caller may later offer an explicit choice.
    onCollected?.(riceResult);
    // ---------- W3 胃材料生成 ----------
    reviewDoc = buildReview({
      riceDir: riceResult.riceDir,
      sourceDoc: riceResult.sourceDoc,
      contentDoc: riceResult.contentDoc,
      requestId: record.id,
    });
    stomachResult = writeReview({
      stomachRoot: layout.dirs.stomach,
      repoName: repo.name,
      reviewDoc,
    });

    // 材料落盘后才把摘要挂到请求上。review.complete 保持 false（不自动下结论）。
    record = {
      ...record,
      source: {
        kind: 'git',
        subdir: riceResult.sourceDoc.subdir ?? '',
        ref: riceResult.sourceDoc.ref ?? null,
        downloadMethod: riceResult.sourceDoc.downloadMethod ?? 'git',
        upstreamUrl: riceResult.sourceDoc.upstreamUrl,
        pinnedCommit: riceResult.sourceDoc.pinnedCommit,
        pinnedTag: riceResult.sourceDoc.pinnedTag,
        sourceStatus: riceResult.sourceDoc.sourceStatus,
        contentHash: riceResult.sourceDoc.contentHash,
      },
      rice: {
        dir: riceResult.riceDir,
        status: riceResult.status,
        sourcePath: riceResult.sourcePath,
        contentListPath: riceResult.contentListPath,
        fileCount: riceResult.sourceDoc.fileCount,
        treeHash: riceResult.sourceDoc.contentHash,
      },
      stomach: {
        dir: layout.dirs.stomach,
        status: stomachResult.status,
        reviewPath: stomachResult.path,
        materialOnly: true,
      },
      holdInStomach: reviewDoc.holdInStomach,
      installAllowedNow: reviewDoc.installAllowedNow,
      review: {
        complete: false,
        unknowns: reviewDoc.unknowns.map((u) => u.field),
        acceptedUnknowns: [],
      },
      admission: { allow: null, code: null, at: null },
      artifact: { verified: false, contentHash: null, path: null },
      pendingScopes: [],
    };

    record = transition(record, 'awaiting-approval', {
      note: reviewDoc.holdInStomach
        ? 'W3 判定为混合插件线索：留胃、不安装，等待用户与 DSH 决定拆分范围'
        : 'W3 材料已生成：等待用户确认首次宿主代码执行 / 工具替换 / 新增权限',
    });
    requestStore.save(record);

    return {
      status: 'ok',
      record,
      layout,
      riceResult,
      stomachResult,
      reviewDoc,
      callLog: drainCallLog(),
    };
  } catch (error) {
    let code = error.code ?? 'ORG_UNKNOWN';
    const stage = String(code).startsWith('STOMACH') ? 'admission' : 'download';
    const message = String(error.message ?? error);
    let failedRecord = record;
    try {
      failedRecord = transition(record, 'failed', { stage, code, note: message });
      requestStore.save(failedRecord);
    } catch (transitionError) {
      // 连失败迁移都不合法时，保留原记录，明确写出失败，绝不伪称成功
      requestStore.save(record);
      failedRecord = record;
      code = `${code}/FAILED_TRANSITION_${transitionError.code}`;
    }
    mkdirSync(root, { recursive: true });
    const failureDoc = {
      requestId: record.id,
      at: new Date().toISOString(),
      state: failedRecord.state,
      stage,
      code,
      message,
      wroteReady: false,
      wroteInstalled: false,
      wroteActive: false,
    };
    const failurePath = join(root, `编排失败-${record.id}.json`);
    writeFileSync(failurePath, JSON.stringify(failureDoc, null, 2) + '\n', 'utf8');
    return {
      status: 'failed', record: failedRecord, layout, failurePath,
      error: { code, message }, reviewDoc, riceResult, stomachResult,
      callLog: drainCallLog(),
    };
  }
}

export { createRequest, transition, RequestStore };
