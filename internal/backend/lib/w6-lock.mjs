/**
 * W6-A 安装互斥：统一到「原生安装锁边界」。
 *
 * 取证结论（本轮读内核源码）：
 *   - `withFileLock(filename, operation, {waitMs})` 定义在
 *     `@deepseek-ai/dsh-atomic-write/lib/index.js`，锁文件是 `<filename>.lock`，
 *     用 `wx` + PID 接管； contention 指数退避，超时抛错。
 *   - 内核 `runPluginCommand()` 与 `PluginManager.installBundle()` 都是
 *     `withFileLock(join(dir,'package.json'), ...)` 包住 `runProfilePnpm`。
 *   - **`runProfilePnpm()` 本身不取锁**（全文件只有 runPluginCommand 一处 withFileLock）。
 *
 * 因此本模块直接复用同一把原生锁，把
 *   「快照 → 完整准入 → 安装 → 部署校验 → 失败恢复 → 独立复核」
 * 全部放进这个临界区，安装执行器调用**无锁版本** `runProfilePnpm`，
 * 全程只取一次锁 —— 不重复取锁、不会死锁。
 *
 * 边界：这统一的是**隔离 W6-A 路径**的锁边界；生产内核两处安装入口仍未改，
 * 因此 Q11 仍不 closed（生产接入待后续）。
 */

import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { atomicJson, NL } from './w6-utils.mjs';

const KERNEL = process.env.FISH_HAND_DSH_ROOT ?? '.';
let kernelRequire = null;
function getKernelRequire() {
  if (!kernelRequire) kernelRequire = createRequire(join(KERNEL, 'package.json'));
  return kernelRequire;
}

let withFileLockPromise = null;
async function loadNativeLock() {
  if (!withFileLockPromise) {
    withFileLockPromise = import(pathToFileURL(
      getKernelRequire().resolve('@deepseek-ai/dsh-atomic-write'),
    ).href).then((m) => m.withFileLock);
  }
  return withFileLockPromise;
}

/** 原生锁文件路径：与内核完全同一个 `<profile>/package.json.lock`。 */
export function nativeLockPathOf(profileDir) {
  return join(profileDir, 'package.json.lock');
}

export function isNativeLockHeld(profileDir) {
  return existsSync(nativeLockPathOf(profileDir));
}

/**
 * 在原生锁内执行临界区。可选 timelinePath 记录「尝试 / 进入 / 离开」时间戳，
 * 供跨进程验证「第二次安装不能插入恢复过程」。
 */
export async function withNativeInstallLock(profileDir, operation, options = {}) {
  const withFileLock = await loadNativeLock();
  const { waitMs = 30000, label = 'install', timelinePath = null } = options;
  const anchor = join(profileDir, 'package.json');
  const line = (event, extra = {}) => {
    if (!timelinePath) return;
    appendFileSync(timelinePath, JSON.stringify({
      event, label, pid: process.pid, at: new Date().toISOString(), t: Date.now(), ...extra,
    }) + NL, 'utf8');
  };

  line('attempt-lock', { lockPath: nativeLockPathOf(profileDir), waitMs });
  return withFileLock(anchor, async () => {
    line('enter-critical', { lockPath: nativeLockPathOf(profileDir) });
    try {
      return await operation({ line, lockPath: nativeLockPathOf(profileDir) });
    } finally {
      line('leave-critical', { lockPath: nativeLockPathOf(profileDir) });
    }
  }, { waitMs });
}

export { loadNativeLock };
