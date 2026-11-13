/**
 * W6-A 部署快照 / 恢复 / 五项核对（隔离实现）。
 *
 * 与 W4 时期 snapshot.mjs 的区别：那时只覆盖**被点名的单个包**，
 * 结论明确写「不证明整棵依赖树恢复正确」。本轮用户要求不能只恢复插件自身目录，
 * 因此这里把以下对象一起快照、一起恢复、一起独立复核：
 *   ① 目标包 node_modules/<plugin>
 *   ② 运行时依赖 node_modules/<dep>（可多个）
 *   ③ 锁文件 pnpm-lock.yaml + 清单 package.json + pnpm-workspace.yaml
 *   ④ 模块解析结果（由独立进程 w6-probe.mjs 采集，本模块记录并比对期望值）
 *   ⑤ 注册记录 registry.json 与 package.json 的 dsh.profile.bundles
 *
 * 恢复失败一律返回 ok=false 并落 restore-report，绝不宣称成功。
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import {
  sha256File, sha256Text, deployedTreeHash, treeManifest, copyTree, atomicJson,
} from './w6-utils.mjs';

/**
 * 除目标包 / 运行时依赖外，还必须覆盖 pnpm 自身的内部状态文件。
 * 实测 hoisted 模式下 node_modules 下另有 .modules.yaml、
 * .pnpm/lock.yaml、.pnpm-workspace-state-v1.json，更新安装会改写它们；
 * 只恢复包目录不足以声称「依赖与锁文件完整恢复」。
 */
const TRACKED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
];

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function packageDirOf(profileDir, name) {
  return join(profileDir, 'node_modules', ...name.split('/'));
}

/** 采集完整快照（必须在原生安装锁内调用）。 */
export function captureW6Snapshot({
  profileDir, packageNames, registryPath = null, snapshotRoot, id,
}) {
  const snapId = id ?? `snap-${Date.now()}`;
  const snapDir = join(snapshotRoot, snapId);
  const copyRoot = join(snapDir, 'copies');
  mkdirSync(copyRoot, { recursive: true });

  const files = {};
  for (const name of TRACKED_FILES) {
    const path = join(profileDir, name);
    const content = readIfExists(path);
    files[name] = {
      path, exists: content !== null,
      sha256: content === null ? null : sha256Text(content),
      content,
    };
  }
  if (registryPath) {
    const content = readIfExists(registryPath);
    files['registry.json'] = {
      path: registryPath, exists: content !== null,
      sha256: content === null ? null : sha256Text(content), content,
    };
  }

  let bundles = [];
  try {
    if (files['package.json'].content) {
      bundles = JSON.parse(files['package.json'].content).dsh?.profile?.bundles ?? [];
    }
  } catch { bundles = []; }

  const packages = {};
  for (const name of packageNames) {
    const dir = packageDirOf(profileDir, name);
    const present = existsSync(dir);
    let version = null;
    if (present && existsSync(join(dir, 'package.json'))) {
      try { version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null; }
      catch { version = null; }
    }
    const copyDir = join(copyRoot, ...name.split('/'));
    if (present) copyTree(dir, copyDir);
    packages[name] = {
      dir, exists: present, version,
      treeHash: deployedTreeHash(dir),
      files: treeManifest(dir),
      copyDir: present ? copyDir : null,
    };
  }

  const snapshot = {
    schema: 'w6-deploy-snapshot/v1',
    id: snapId,
    at: new Date().toISOString(),
    profileDir,
    packageNames,
    registryPath,
    files,
    bundles,
    packages,
    copyRoot,
    note: '快照覆盖目标包 / 运行时依赖 / 锁文件 / 清单 / 注册记录；不含依赖源目录与 pnpm 全局 store',
  };
  atomicJson(join(snapDir, 'snapshot.json'), snapshot);
  snapshot.snapshotPath = join(snapDir, 'snapshot.json');
  return snapshot;
}

/** 只校验当前磁盘是否与快照一致（不写入）。 */
export function verifyW6Snapshot(snapshot, { profileDir }) {
  const checks = [];
  for (const [name, entry] of Object.entries(snapshot.files)) {
    const content = readIfExists(entry.path);
    const ok = entry.exists
      ? (content !== null && sha256Text(content) === entry.sha256)
      : content === null;
    checks.push({ item: name, ok, expected: entry.sha256,
      actual: content === null ? null : sha256Text(content) });
  }

  let bundles = [];
  try {
    const pkgContent = readIfExists(join(profileDir, 'package.json'));
    if (pkgContent) bundles = JSON.parse(pkgContent).dsh?.profile?.bundles ?? [];
  } catch { bundles = null; }
  checks.push({ item: 'dsh.profile.bundles',
    ok: JSON.stringify(bundles) === JSON.stringify(snapshot.bundles),
    expected: snapshot.bundles, actual: bundles });

  const perPackage = [];
  for (const name of snapshot.packageNames) {
    const snapPkg = snapshot.packages[name];
    const dir = packageDirOf(profileDir, name);
    const present = existsSync(dir);
    const treeHash = deployedTreeHash(dir);
    const perFile = [];
    if (snapPkg.exists && present) {
      for (const f of snapPkg.files) {
        const full = join(dir, ...f.path.split('/'));
        const actual = existsSync(full) ? sha256File(full) : null;
        perFile.push({ path: f.path, ok: actual === f.sha256, expected: f.sha256, actual });
      }
    }
    perPackage.push({
      name,
      present,
      existsMatch: snapPkg.exists === present,
      treeHashMatch: snapPkg.treeHash === treeHash,
      expectedTreeHash: snapPkg.treeHash,
      actualTreeHash: treeHash,
      version: present && existsSync(join(dir, 'package.json'))
        ? (() => { try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null; }
          catch { return null; } })() : null,
      expectedVersion: snapPkg.version,
      perFile,
      mismatchedFiles: perFile.filter((f) => !f.ok).map((f) => f.path),
      ok: snapPkg.exists === present && snapPkg.treeHash === treeHash
        && perFile.every((f) => f.ok),
    });
  }

  return {
    ok: checks.every((c) => c.ok) && perPackage.every((p) => p.ok),
    checks,
    perPackage,
    mismatchedFiles: perPackage.flatMap((p) => p.mismatchedFiles),
  };
}

/**
 * 按快照恢复。必须在同一个原生安装锁内调用。
 * failInject.dropCopyFor = 包名 → 模拟「快照副本丢失」，用于构造恢复失败场景。
 */
export function restoreW6Snapshot(snapshot, {
  profileDir, reportDir, failInject = null,
}) {
  const steps = [];
  try {
    for (const [name, entry] of Object.entries(snapshot.files)) {
      if (entry.exists) {
        mkdirSync(dirname(entry.path), { recursive: true });
        writeFileSync(entry.path, entry.content, 'utf8');
      } else if (existsSync(entry.path)) rmSync(entry.path, { force: true });
      steps.push({ step: name, ok: true, action: entry.exists ? 'restore' : 'remove' });
    }

    for (const name of snapshot.packageNames) {
      const snapPkg = snapshot.packages[name];
      const dir = packageDirOf(profileDir, name);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      const copyMissing = failInject?.dropCopyFor === name
        || !snapPkg.copyDir || !existsSync(snapPkg.copyDir);
      if (snapPkg.exists && !copyMissing) {
        mkdirSync(dir, { recursive: true });
        copyTree(snapPkg.copyDir, dir);
        steps.push({ step: `node_modules/${name}`, ok: true, action: 'restore-code' });
      } else if (snapPkg.exists) {
        steps.push({ step: `node_modules/${name}`, ok: false,
          action: 'restore-code', note: `快照副本缺失（${snapPkg.copyDir ?? 'null'}）` });
      } else {
        steps.push({ step: `node_modules/${name}`, ok: true, action: 'remove' });
      }
    }
  } catch (error) {
    steps.push({ step: 'exception', ok: false, note: String(error?.message ?? error) });
  }

  const verification = verifyW6Snapshot(snapshot, { profileDir });
  const report = {
    schema: 'w6-restore-report/v1',
    at: new Date().toISOString(),
    snapshotId: snapshot.id,
    packageName: snapshot.packageNames[0] ?? null,
    packageNames: snapshot.packageNames,
    firstInstall: Object.values(snapshot.packages).every((p) => p.exists === false),
    steps,
    verification,
    failInject: failInject ?? null,
    ok: steps.every((s) => s.ok) && verification.ok,
  };
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    atomicJson(join(reportDir, `restore-report-${snapshot.id}.json`), report);
  }
  return report;
}
