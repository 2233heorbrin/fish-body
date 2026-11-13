/**
 * W6-A 隔离运行器（隔离实现，只写隔离目录）。
 *
 * 三个职责：
 *   ① 初始化隔离 profile（package.json / pnpm-workspace.yaml / registry.json）；
 *   ② 调用内核 `runProfilePnpm` 的**无锁版本**执行真实 pnpm 安装；
 *   ③ 用 spawnSync 启动**独立 Node 进程** w6-probe.mjs 实际解析并调用样例。
 *
 * 为什么用内核执行器而不直接 spawn pnpm：本机直接 spawn 'pnpm' 会 ENOENT；
 * 内核 `@deepseek-ai/dsh-plugin-manager/operations` 的 runProfilePnpm 自带
 * pnpm 解析与 cwd/anchor 处理，且与生产安装走同一执行器。
 *
 * 锁边界：本模块**不取锁**。锁由 w6-deploy.mjs 的 withNativeInstallLock() 统一包住
 * 「快照 → 完整准入 → 安装 → 校验 → 恢复 → 独立复核」；runProfilePnpm 自身不取锁
 * （内核源码已核实：只有 runPluginCommand / installBundle 两处包了 withFileLock），
 * 因此全程只取一次锁，不会重复取锁死锁。
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { NL, atomicJson, readJson } from './w6-utils.mjs';

const KERNEL = 'C:/Users/ACER/AppData/Roaming/DSH/data/versions/0.2.1-rc.5/node_modules/';
const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_SCRIPT = join(HERE, 'w6-probe.mjs');

let runnerPromise = null;
async function loadProfilePnpm() {
  if (!runnerPromise) {
    runnerPromise = (async () => {
      const req = createRequire(join(KERNEL, 'package.json'));
      const mod = await import(pathToFileURL(
        req.resolve('@deepseek-ai/dsh-plugin-manager/operations'),
      ).href);
      return mod.runProfilePnpm;
    })();
  }
  return runnerPromise;
}

export const KERNEL_NODE_MODULES = KERNEL;
export const PROBE_SCRIPT_PATH = PROBE_SCRIPT;

/** 建立隔离 profile。已有目录不删除，只补齐缺失文件。 */
export function createW6Profile({ profileDir, name = 'w6-isolated-profile' }) {
  mkdirSync(profileDir, { recursive: true });
  const pkgPath = join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name, private: true, version: '1.0.0',
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, null, 2) + NL, 'utf8');
  }
  const wsPath = join(profileDir, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) {
    writeFileSync(wsPath, [
      'packages:', '  - .', '', 'nodeLinker: hoisted',
      'autoInstallPeers: false', '',
    ].join(NL), 'utf8');
  }
  const registryPath = join(profileDir, 'registry.json');
  if (!existsSync(registryPath)) {
    atomicJson(registryPath, {
      schema: 'w6-isolation-registry/v1-isolation-test-only',
      note: '隔离自建注册表；仅登记 installed，不登记 active（真实宿主激活未验证）',
      plugins: {},
    });
  }
  return { profileDir, pkgPath, wsPath, registryPath };
}

/**
 * 返回 async (args, dir) => {exitCode, ...}。真实 pnpm，无锁。
 * execution 固定 'cli'：service 模式在独立脚本里会静默退出（已复现）。
 */
export function makeRunPnpm() {
  return async (args, dir) => {
    const fn = await loadProfilePnpm();
    return fn(
      { profile: 'w6-isolation', dir, installAnchor: join(dir, 'package.json'), cwd: dir },
      args,
      {
        execution: 'cli',
        outputBytes: 65536,
        onOutput: () => {},
        lockWaitMs: 120000,
        activateNewBundles: false,
        idleTimeoutMs: 120000,
        lookupTimeoutMs: 60000,
      },
    );
  };
}

/** 读取隔离注册表，登记/更新一个插件的记录。 */
export function registrySet(registryPath, packageName, entry) {
  const doc = existsSync(registryPath) ? readJson(registryPath) : { plugins: {} };
  doc.plugins = doc.plugins ?? {};
  const row = { ...entry, updatedAt: new Date().toISOString() };
  // 生产 canonical 是 V1 数组 schema；隔离登记表是对象 schema，两者共用同一真源
  if (Array.isArray(doc.plugins)) {
    const i = doc.plugins.findIndex((p) =>
      p?.pluginId === packageName || p?.packageName === packageName);
    const merged = { ...(i >= 0 ? doc.plugins[i] : { pluginId: packageName }), ...row };
    if (i >= 0) doc.plugins[i] = merged; else doc.plugins.push(merged);
    atomicJson(registryPath, doc);
    return merged;
  }
  doc.plugins[packageName] = { ...(doc.plugins[packageName] ?? {}), ...row };
  atomicJson(registryPath, doc);
  return doc.plugins[packageName];
}

export function registryGet(registryPath, packageName) {
  if (!existsSync(registryPath)) return null;
  const plugins = readJson(registryPath)?.plugins;
  if (Array.isArray(plugins)) {
    return plugins.find((p) => p?.pluginId === packageName || p?.packageName === packageName) ?? null;
  }
  return plugins?.[packageName] ?? null;
}

/**
 * 独立进程探针：实际 require.resolve + 调用无害样例。
 * depName 为 null 时只解析插件（UI 样例无运行时依赖也可验证）。
 */
export function independentProbe({
  profileDir, pluginName, depName = null,
  probeScript = PROBE_SCRIPT, timeoutMs = 30000,
}) {
  const env = { ...process.env };
  delete env.W6_PACK_PHASE_SENTINEL;
  const args = [probeScript, profileDir, pluginName, depName ?? ''];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const text = (r.stdout ?? '').trim();
  let parsed = null;
  try { parsed = JSON.parse(text.split(/\r?\n/).pop() ?? ''); } catch { /* 保留原始输出 */ }
  return {
    ok: r.status === 0 && parsed?.ok === true,
    exitCode: r.status,
    pid: parsed?.pid ?? null,
    parsed,
    stderrTail: (r.stderr ?? '').slice(-800),
    stdoutTail: text.slice(-1200),
    command: [process.execPath, ...args].join(' '),
    note: '独立 Node 进程；规避同进程 createRequire 模块缓存导致「更新后仍读到旧代码」的假象',
  };
}

/** 独立读取 profile 的清单/锁/注册表摘要（父进程只读，用于五项核对）。 */
export function profileState(profileDir, registryPath, packageNames) {
  const pkgPath = join(profileDir, 'package.json');
  const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;
  const lockPath = join(profileDir, 'pnpm-lock.yaml');
  return {
    dependencies: pkg?.dependencies ?? null,
    bundles: pkg?.dsh?.profile?.bundles ?? null,
    lockExists: existsSync(lockPath),
    lockBytes: existsSync(lockPath) ? readFileSync(lockPath).length : null,
    registry: existsSync(registryPath) ? readJson(registryPath) : null,
    packages: Object.fromEntries(packageNames.map((n) => {
      const p = join(profileDir, 'node_modules', ...n.split('/'), 'package.json');
      return [n, existsSync(p) ? readJson(p)?.version ?? null : null];
    })),
  };
}

/** 供证据链脚本记录内核执行器来源（不修改内核）。 */
export function runnerFact() {
  const req = createRequire(join(KERNEL, 'package.json'));
  const resolved = req.resolve('@deepseek-ai/dsh-plugin-manager/operations');
  const atomic = req.resolve('@deepseek-ai/dsh-atomic-write');
  return {
    operationsModule: resolved.replace(/\\/g, '/'),
    atomicWriteModule: atomic.replace(/\\/g, '/'),
    runnerFunction: 'runProfilePnpm',
    lockFunction: 'withFileLock',
    note: 'runProfilePnpm 自身不取锁；withFileLock(join(profile,"package.json")) 由 W6-A 部署器统一取一次',
  };
}

export { execFileSync };
