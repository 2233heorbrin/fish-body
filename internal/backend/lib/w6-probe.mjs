/**
 * W6-A 独立进程探针：实际解析并调用无害样例。
 *
 * 用法：node w6-probe.mjs <profileDir> <pluginName> <depName>
 * 输出：单行 JSON（父进程用 execFileSync 捕获）。
 *
 * 为什么必须独立进程：同一 Node 进程内 createRequire 会复用模块缓存，
 * 更新安装后仍会读到旧代码（本轮实测已复现），无法证明「恢复后用的是旧代码/旧依赖」。
 *
 * 注意：部署后的这次调用是用户明确要求的验证动作；调用前清除
 * W6_PACK_PHASE_SENTINEL，避免与「打包/准入阶段是否执行候选代码」的探针混淆。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { deployedTreeHash, sha256File, NL } from './w6-utils.mjs';

delete process.env.W6_PACK_PHASE_SENTINEL;

const [, , profileDir, pluginName, depName] = process.argv;
const hasDep = typeof depName === 'string' && depName.length > 0;
const out = {
  schema: 'w6-independent-probe/v1-isolation-test-only',
  pid: process.pid,
  at: new Date().toISOString(),
  profileDir: profileDir ?? null,
  pluginName: pluginName ?? null,
  depName: hasDep ? depName : null,
  hasDep,
  ok: false,
};

try {
  if (!profileDir || !pluginName) throw new Error('缺少参数：profileDir / pluginName');
  const req = createRequire(join(profileDir, 'package.json'));

  out.resolvedPlugin = req.resolve(pluginName);
  out.pluginEntrySha256 = sha256File(out.resolvedPlugin);
  if (hasDep) {
    out.resolvedDep = req.resolve(depName);
    out.depEntrySha256 = sha256File(out.resolvedDep);
  }

  const plugin = req(pluginName);
  out.pluginVersion = plugin.version ?? null;
  out.loadForm = plugin.loadForm ?? null;
  out.probe = typeof plugin.probe === 'function' ? plugin.probe() : null;
  out.render = typeof plugin.render === 'function' ? plugin.render() : null;
  if (hasDep) {
    const dep = req(depName);
    out.depVersion = dep.version ?? null;
    out.depMarker = dep.marker ?? null;
    out.depDescribe = typeof dep.describe === 'function' ? dep.describe() : null;
  }

  const pluginDir = join(profileDir, 'node_modules', ...pluginName.split('/'));
  out.pluginTreeHash = deployedTreeHash(pluginDir);
  if (hasDep) {
    const depDir = join(profileDir, 'node_modules', ...depName.split('/'));
    out.depTreeHash = deployedTreeHash(depDir);
  }

  out.packageJsonSha256 = sha256File(join(profileDir, 'package.json'));
  out.lockExists = existsSync(join(profileDir, 'pnpm-lock.yaml'));
  out.lockSha256 = out.lockExists ? sha256File(join(profileDir, 'pnpm-lock.yaml')) : null;
  out.ok = true;
} catch (error) {
  out.error = String(error?.message ?? error);
  out.code = error?.code ?? null;
}

process.stdout.write(JSON.stringify(out) + NL);
process.exitCode = out.ok ? 0 : 1;
