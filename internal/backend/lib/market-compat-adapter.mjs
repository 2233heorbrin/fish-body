/* fish-body · dshmarket 直装来源兼容适配（可分发维护源，可审计）
 *
 * Codex #315 #5 / #318 阻塞2：首轮只在隔离副本手工改 routes.js/updates.js，无法分发/撤销。
 * 本模块把适配「版本化 + 声明边界 + 幂等部署 + 手术式撤销」留在 fish-body 维护源，
 * 部署验证只落到隔离副本 dshmarket，绝不改日常 node_modules。
 *
 * PATCHES 由 pristine dshmarket 1.73.19 → 适配后副本的 git diff --unified=3 精确生成，
 * 每条 oldStr/newStr 在各自文件中唯一（生成器已 SANITY 校验），非手写猜测锚点。
 *
 * 能力边界：
 *   - 宿主：globalThis[Symbol.for('fish-body.market.v1')].forProfile(profileDir)。
 *   - 市场：dshmarket >=1.73.0 <1.74.0（消费者文件 hash 基线见 PRISTINE_HASHES）。
 *   - 只识别「饭仓已登记真实来源 + link realpath 落手仓 + Profile/版本内容身份对应」的受管直装 link。
 *   - 普通开发 link、generation link、未登记 link 保持市场原生行为。
 *   - 复用市场权限/脚本/供应链/并发保护与 git/npm 更新链，不新开旁路安装器。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ADAPTER_ID = 'fish-body-direct-source-market-adapter';
export const ADAPTER_VERSION = '1.1.0';
export const HOST_CAPABILITY = Object.freeze({
  slot: 'fish-body.market.v1',
  forProfile: 'forProfile(profileDir) → { managedDirectLink, directSourceRecord, directUpdateTarget, bodyDirectUpdateChannel }',
  dshmarket: '>=1.73.0 <1.74.0',
  consumerFiles: ['routes.js', 'updates.js'],
  seamFile: 'fish-body-optional.js',
});

/** pristine dshmarket 1.73.19 消费者文件 hash 基线：只有匹配才允许 apply（版本限定最小差异）。 */
export const PRISTINE_HASHES = Object.freeze({
  "routes.js": "06a9767d7610818ebf0e0fc1eed2b7c4c09be04411e669646d7fc1c2166d9f65",
  "updates.js": "fd38dd1520e055ccde28c7721c86b4468df6503b502ead4c631d17b6b1e545a4"
});

/** 精确 transform 对（git diff --unified=3 生成，oldStr/newStr 各自文件内唯一）。 */
export const PATCHES = [
  {
    "file": "routes.js",
    "id": "seam-import",
    "oldStr": "/**\n * HTTP routes bridging the browser market UI to the host. This layer only\n * parses requests, calls the service modules, and serializes responses —",
    "newStr": "import { isBodyManagedSpec, isBodyDirectManagedLink, bodyDirectSourceRecord, bodyDirectUpdateTarget, bodyDirectUpdateSpec, bodyDirectUpdateChannel } from './fish-body-optional.js';\n/**\n * HTTP routes bridging the browser market UI to the host. This layer only\n * parses requests, calls the service modules, and serializes responses —",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "online-source-of-guard",
    "oldStr": "     * — a developer's own `link:` checkout is never compared online.\n     */\n    const onlineSourceOf = (plugins, name, spec) => {\n        if (!spec.toLowerCase().startsWith('file:') && !isGenerationLink(spec))\n            return null;\n        const evidence = readInstalledRepoEvidence(config.profile, name, spec, activeProfileDir);",
    "newStr": "     * — a developer's own `link:` checkout is never compared online.\n     */\n    const onlineSourceOf = (plugins, name, spec) => {\n        // fish-body 受管直装 link：原渠道目标由 directSourceFor 单独承载，\n        // 绝不在此按 catalog 把 GitHub 换成同名 npm latest。\n        if (isBodyDirectManagedLink(activeProfileDir, name, spec))\n            return null;\n        if (!spec.toLowerCase().startsWith('file:') && !isGenerationLink(spec))\n            return null;\n        const evidence = readInstalledRepoEvidence(config.profile, name, spec, activeProfileDir);",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "direct-source-for-map-fill",
    "oldStr": "        // empty, and an empty map authorizes nothing.\n        const catalogNpmByRepo = new Map();\n        const releaseSources = new Map();\n        try {\n            const registry = await loadRegistry();\n            for (const [name, spec] of Object.entries(installed)) {",
    "newStr": "        // empty, and an empty map authorizes nothing.\n        const catalogNpmByRepo = new Map();\n        const releaseSources = new Map();\n        // fish-body 手仓直装受管 link：name → 登记记录里的原渠道 spec\n        // （github:owner/repo#path:/subdir 或 name@range）。不查 catalog、\n        // 不把 GitHub 换同名 npm latest。summary/单条/列表共用此 Map。\n        const directSourceFor = new Map();\n        for (const [name, spec] of Object.entries(installed)) {\n            if (typeof spec === 'string' && spec.toLowerCase().startsWith('link:')\n                && isBodyDirectManagedLink(activeProfileDir, name, spec)) {\n                const channel = bodyDirectUpdateChannel(activeProfileDir, name, spec);\n                if (channel && channel.spec)\n                    directSourceFor.set(name, channel);\n            }\n        }\n        try {\n            const registry = await loadRegistry();\n            for (const [name, spec] of Object.entries(installed)) {",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "return-direct-for",
    "oldStr": "        catch (error) {\n            logEvent('warn', 'updates', `package source lookup failed — ${error instanceof Error ? error.message : String(error)}`);\n        }\n        return { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources };\n    }\n    /**\n     * Pre-install host compatibility refusal, shared by the update route and",
    "newStr": "        catch (error) {\n            logEvent('warn', 'updates', `package source lookup failed — ${error instanceof Error ? error.message : String(error)}`);\n        }\n        return { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources, directSourceFor };\n    }\n    /**\n     * Pre-install host compatibility refusal, shared by the update route and",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "callsite-summary",
    "oldStr": "                    return;\n                }\n                try {\n                    const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources } = await updateCheckInputs();\n                    const updates = await checkUpdates(config.profile, forceCheckFrom(request), activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources });\n                    // `packages` carries the same objects the single-package endpoint\n                    // returns, so one parser serves both. Only updatable ones: a badge\n                    // wants the count, a panel wants the rows, and neither wants to",
    "newStr": "                    return;\n                }\n                try {\n                    const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources, directSourceFor } = await updateCheckInputs();\n                    const updates = await checkUpdates(config.profile, forceCheckFrom(request), activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources, directSourceFor });\n                    // `packages` carries the same objects the single-package endpoint\n                    // returns, so one parser serves both. Only updatable ones: a badge\n                    // wants the count, a panel wants the rows, and neither wants to",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "callsite-single",
    "oldStr": "                        // The same inputs the market page builds, so a generation (#497)\n                        // or a catalog-matched local package answers here with the\n                        // release it can be compared against rather than with nothing.\n                        const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources } = await updateCheckInputs();\n                        const update = (await checkUpdates(config.profile, force, activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources }))[name];\n                        if (update === undefined) {\n                            sendJson(response, 404, { schema: UPDATE_API_V1_SCHEMA, error: 'plugin is not installed' });\n                            return;",
    "newStr": "                        // The same inputs the market page builds, so a generation (#497)\n                        // or a catalog-matched local package answers here with the\n                        // release it can be compared against rather than with nothing.\n                        const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources, directSourceFor } = await updateCheckInputs();\n                        const update = (await checkUpdates(config.profile, force, activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources, directSourceFor }))[name];\n                        if (update === undefined) {\n                            sendJson(response, 404, { schema: UPDATE_API_V1_SCHEMA, error: 'plugin is not installed' });\n                            return;",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "callsite-list-destructure",
    "oldStr": "                }\n                try {\n                    const force = (request.url ?? '').includes('force=1');\n                    const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources } = await updateCheckInputs();\n                    // Migration hints are this listing's own business: the market page\n                    // is where \"this could come from npm now\" is offered, and no other\n                    // caller acts on it.",
    "newStr": "                }\n                try {\n                    const force = (request.url ?? '').includes('force=1');\n                    const { channelFor, onlineSourceFor, catalogNpmByRepo, releaseSources, directSourceFor } = await updateCheckInputs();\n                    // Migration hints are this listing's own business: the market page\n                    // is where \"this could come from npm now\" is offered, and no other\n                    // caller acts on it.",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "callsite-list-checkupdates",
    "oldStr": "                    catch (error) {\n                        logEvent('warn', 'updates', `package source lookup failed — ${error instanceof Error ? error.message : String(error)}`);\n                    }\n                    const updates = await checkUpdates(config.profile, force, activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources });\n                    for (const [name, migration] of sourceMigrationFor) {\n                        const status = updates[name];\n                        if (status !== undefined)",
    "newStr": "                    catch (error) {\n                        logEvent('warn', 'updates', `package source lookup failed — ${error instanceof Error ? error.message : String(error)}`);\n                    }\n                    const updates = await checkUpdates(config.profile, force, activeProfileDir, channelFor, onlineSourceFor, catalogNpmByRepo, { holdYoungReleases: config.desktopHost === true, releaseSources, directSourceFor });\n                    for (const [name, migration] of sourceMigrationFor) {\n                        const status = updates[name];\n                        if (status !== undefined)",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "update-route-direct",
    "oldStr": "                            sendJson(response, 400, { error: '市场的本地开发链接不会被线上版本替换。 / The market\\'s local development link is never replaced by an online release.' });\n                            return;\n                        }\n                        if (isLocalSpec(spec)) {\n                            if (!restore) {\n                                sendJson(response, 400, { error: 'locally linked plugins update from their checkout' });\n                                return;",
    "newStr": "                            sendJson(response, 400, { error: '市场的本地开发链接不会被线上版本替换。 / The market\\'s local development link is never replaced by an online release.' });\n                            return;\n                        }\n                        // fish-body 手仓直装受管 link：更新请求按登记记录的原渠道目标\n                        // 交回既有 git/npm 更新执行链，不查 catalog、不换源。\n                        // 普通开发 link / generation link 无登记记录，维持原生 400 行为。\n                        const bodyDirectManaged = typeof spec === 'string' && spec.toLowerCase().startsWith('link:')\n                            && isBodyDirectManagedLink(activeProfileDir, name, spec);\n                        const bodyDirectUpdate = bodyDirectManaged\n                            ? bodyDirectUpdateSpec(activeProfileDir, name, spec) : null;\n                        if (isLocalSpec(spec) && bodyDirectUpdate !== null) {\n                            // 用原渠道 spec 替换 link: 本体，走进下方既有的 git/npm\n                            // spec 分支；权限、脚本、供应链、并发保护全部保留。\n                            spec = bodyDirectUpdate;\n                        }\n                        else if (isLocalSpec(spec)) {\n                            if (!restore) {\n                                sendJson(response, 400, { error: 'locally linked plugins update from their checkout' });\n                                return;",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "routes.js",
    "id": "still-local-guard",
    "oldStr": "                                // Restore succeeds when the spec is no longer local, even if\n                                // the checkout already sat on the same version as latest.\n                                const afterSpec = readInstalled(config.profile, activeProfileDir)[name];\n                                const stillLocal = afterSpec !== undefined && isLocalSpec(afterSpec);\n                                if (stillLocal)\n                                    ok = false;\n                            }",
    "newStr": "                                // Restore succeeds when the spec is no longer local, even if\n                                // the checkout already sat on the same version as latest.\n                                const afterSpec = readInstalled(config.profile, activeProfileDir)[name];\n                                // 受管直装 link 更新后仍指向手仓版本目录（link:），\n                                // 属于已登记的受管来源，不算“未恢复的本地开发 checkout”。\n                                const stillLocal = afterSpec !== undefined && isLocalSpec(afterSpec)\n                                    && !isBodyManagedSpec(activeProfileDir, name, afterSpec)\n                                    && !isBodyDirectManagedLink(activeProfileDir, name, afterSpec);\n                                if (stillLocal)\n                                    ok = false;\n                            }",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "updates.js",
    "id": "npm-url-for-helper",
    "oldStr": "function npmUrl(path) {\n    return `${registryBase}/${path}`;\n}\n/** Read observable profile policy; do not infer effective external settings. */\nfunction readReleaseAgeExclusions(dir, name) {\n    const unknown = { kind: 'unknown' };",
    "newStr": "function npmUrl(path) {\n    return `${registryBase}/${path}`;\n}\n/** fish-body 直装来源可带 per-name registry：用它而非全局 registryBase 取该包 metadata。 */\nfunction npmUrlFor(path, base) {\n    const root = (typeof base === 'string' && base.trim()) ? base.replace(/\\/+$/, '') : registryBase;\n    return `${root}/${path}`;\n}\n/** Read observable profile policy; do not infer effective external settings. */\nfunction readReleaseAgeExclusions(dir, name) {\n    const unknown = { kind: 'unknown' };",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "updates.js",
    "id": "cache-key-direct",
    "oldStr": "    // answer immediately, and a cache keyed on the profile alone would serve\n    // the stable verdict for the rest of the TTL — reading as \"the setting did\n    // nothing\".\n    const cacheKey = `${activeProfileDir}\\u0000${options.holdYoungReleases === true ? 'hold' : 'any'}\\u0000${[...channelFor].map(([n, c]) => `${n}:${c}`).sort().join(',')}\\u0000${[...onlineSourceFor].map(([n, s]) => `${n}:${s}`).sort().join(',')}\\u0000${[...catalogNpmByRepo].map(([n, s]) => `${n}:${s}`).sort().join(',')}\\u0000${options.holdYoungReleases === true ? profilePolicyFingerprint(activeProfileDir) : ''}` + JSON.stringify([...(options.releaseSources ?? [])]);\n    if (!force && updatesCache?.key === cacheKey && Date.now() < updatesCache.recheckAt) {\n        return updatesCache.data;\n    }",
    "newStr": "    // answer immediately, and a cache keyed on the profile alone would serve\n    // the stable verdict for the rest of the TTL — reading as \"the setting did\n    // nothing\".\n    const cacheKey = `${activeProfileDir}\\u0000${options.holdYoungReleases === true ? 'hold' : 'any'}\\u0000${[...channelFor].map(([n, c]) => `${n}:${c}`).sort().join(',')}\\u0000${[...onlineSourceFor].map(([n, s]) => `${n}:${s}`).sort().join(',')}\\u0000${[...catalogNpmByRepo].map(([n, s]) => `${n}:${s}`).sort().join(',')}\\u0000${options.holdYoungReleases === true ? profilePolicyFingerprint(activeProfileDir) : ''}` + JSON.stringify([...(options.releaseSources ?? [])]) + JSON.stringify([...(options.directSourceFor ?? [])]);\n    if (!force && updatesCache?.key === cacheKey && Date.now() < updatesCache.recheckAt) {\n        return updatesCache.data;\n    }",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "updates.js",
    "id": "direct-channel-rebind",
    "oldStr": "    const result = {};\n    let nextCandidateMaturityAt = Infinity;\n    await Promise.all(Object.entries(installed).map(async ([name, spec]) => {\n        const version = readInstalledVersion(profile, name, activeProfileDir);\n        const normalizedSpec = spec.toLowerCase();\n        if (normalizedSpec.startsWith('file:')) {",
    "newStr": "    const result = {};\n    let nextCandidateMaturityAt = Infinity;\n    await Promise.all(Object.entries(installed).map(async ([name, spec]) => {\n        // fish-body 手仓直装受管 link：登记记录里的原渠道目标（github:owner/repo\n        // #path:/subdir 或 name@range）交回下方既有的 github/npm 比较链，得到真实\n        // latest/updateAvailable，而不是 link: 固定的 latest:null。\n        // 普通开发 link / generation link 没有 directSourceFor 项，维持原生行为。\n        const directChannel = options.directSourceFor?.get(name);\n        // 兼容两种值：新值为通道对象 {kind,spec,registryUrl,...}，旧夹具可能为纯字符串。\n        const directChannelSpec = directChannel && typeof directChannel === 'object' ? directChannel.spec : directChannel;\n        const directRegistry = directChannel && typeof directChannel === 'object' ? directChannel.registryUrl : null;\n        if (typeof spec === 'string' && spec.toLowerCase().startsWith('link:')\n            && typeof directChannelSpec === 'string' && directChannelSpec !== '')\n            spec = directChannelSpec;\n        const version = readInstalledVersion(profile, name, activeProfileDir);\n        const normalizedSpec = spec.toLowerCase();\n        if (normalizedSpec.startsWith('file:')) {",
    "pristineHits": 1,
    "patchedHits": 1
  },
  {
    "file": "updates.js",
    "id": "npm-url-for-usage",
    "oldStr": "                        return;\n                    }\n                }\n                const meta = (await fetchJson(npmUrl(`${encodeURIComponent(name)}/latest`)));\n                const stable = typeof meta.version === 'string' ? meta.version : null;\n                const channel = channelFor.get(name);\n                const latest = channel === undefined ? stable : await versionOnChannel(name, channel, stable);",
    "newStr": "                        return;\n                    }\n                }\n                const meta = (await fetchJson(npmUrlFor(`${encodeURIComponent(name)}/latest`, directRegistry)));\n                const stable = typeof meta.version === 'string' ? meta.version : null;\n                const channel = channelFor.get(name);\n                const latest = channel === undefined ? stable : await versionOnChannel(name, channel, stable);",
    "pristineHits": 1,
    "patchedHits": 1
  }
];

const sha = (s) => createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
const fileSha = (p) => sha(readFileSync(p));
const read = (p) => readFileSync(p, 'utf8');
const write = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data, 'utf8'); };
const count = (hay, needle) => hay.split(needle).length - 1;

/**
 * 部署适配（幂等）：对 libDir 下消费者文件逐条应用 PATCHES。
 *   - 若 newStr 已存在 → 该补丁已应用，跳过（重复执行安全）。
 *   - 否则 oldStr 必须恰好出现 1 次 → 精确替换；否则报版本不匹配（拒绝盲改）。
 *   - seam 文件从维护源 market-optional-seam.mjs 复制为 fish-body-optional.js。
 *   - 只在 libDir 落盘；调用方负责传隔离副本路径，绝不指向日常 node_modules。
 */
export function installAdaptation(libDir, { seamSource = join(dirname(fileURLToPath(import.meta.url)), 'market-optional-seam.mjs'), strictPristine = true } = {}) {
  const applied = [], skipped = [], issues = [];
  for (const p of PATCHES) {
    const fp = join(libDir, p.file);
    if (!existsSync(fp)) { issues.push(`缺少消费者文件 ${p.file}`); continue; }
    let text = read(fp);
    if (count(text, p.newStr) >= 1) { skipped.push(p.id); continue; }   // 已应用，幂等
    if (strictPristine && PRISTINE_HASHES[p.file] && fileSha(fp) !== PRISTINE_HASHES[p.file] && count(text, p.oldStr) !== 1) {
      issues.push(`${p.file} hash 非已知基线且 ${p.id} 锚点不唯一，拒绝盲改`); continue;
    }
    const hits = count(text, p.oldStr);
    if (hits !== 1) { issues.push(`${p.file} ${p.id} oldStr 出现 ${hits} 次（应为1），拒绝`); continue; }
    text = text.replace(p.oldStr, p.newStr);
    write(fp, text);
    applied.push(p.id);
  }
  // seam 文件：维护源 → 部署副本（存在且 hash 相同则跳过，幂等）
  let seamStatus = 'copied';
  if (existsSync(seamSource)) {
    const seamDst = join(libDir, HOST_CAPABILITY.seamFile);
    const seamHash = fileSha(seamSource);
    if (existsSync(seamDst) && fileSha(seamDst) === seamHash) seamStatus = 'alreadyPresent';
    else { copyFileSync(seamSource, seamDst); }
  } else { issues.push(`缺少维护源 seam：${seamSource}`); seamStatus = 'missing-source'; }
  return { ok: issues.length === 0, status: applied.length ? 'applied' : (skipped.length === PATCHES.length ? 'alreadyPresent' : 'partial'), applied, skipped, seamStatus, issues,
    hashes: Object.fromEntries([...HOST_CAPABILITY.consumerFiles, HOST_CAPABILITY.seamFile].map((f) => { const fp = join(libDir, f); return [f, existsSync(fp) ? fileSha(fp) : null]; })) };
}

/** 校验已部署适配：seam 存在 + 每条 newStr 唯一出现 + 可选 hash 基线。 */
export function verifyAdaptation(libDir, expectedHashes = {}) {
  const issues = [];
  const seam = join(libDir, HOST_CAPABILITY.seamFile);
  if (!existsSync(seam)) issues.push(`缺少适配文件 ${HOST_CAPABILITY.seamFile}`);
  for (const p of PATCHES) {
    const fp = join(libDir, p.file);
    if (!existsSync(fp)) { issues.push(`缺少消费者文件 ${p.file}`); continue; }
    const text = read(fp);
    if (count(text, p.newStr) !== 1) issues.push(`${p.file} ${p.id} 适配正文出现 ${count(text, p.newStr)} 次（应为1）`);
    if (expectedHashes[p.file] && fileSha(fp) !== expectedHashes[p.file]) issues.push(`${p.file} hash 与基线不符`);
  }
  return { ok: issues.length === 0, issues, hashes: Object.fromEntries(
    [...HOST_CAPABILITY.consumerFiles, HOST_CAPABILITY.seamFile].map((f) => { const fp = join(libDir, f); return [f, existsSync(fp) ? fileSha(fp) : null]; })) };
}

/** 手术式撤销：只把本适配的 newStr 精确还原为 oldStr，逐条逆序，不覆盖其他变更。 */
export function uninstallAdaptation(libDir, { removeSeam = true } = {}) {
  const removed = [], alreadyPristine = [], issues = [];
  for (const p of [...PATCHES].reverse()) {
    const fp = join(libDir, p.file);
    if (!existsSync(fp)) { issues.push(`缺少消费者文件 ${p.file}`); continue; }
    let text = read(fp);
    if (count(text, p.newStr) === 1) { text = text.replace(p.newStr, p.oldStr); write(fp, text); removed.push(p.id); }
    else if (count(text, p.oldStr) === 1) alreadyPristine.push(p.id);
    else issues.push(`${p.file} ${p.id} newStr/oldStr 都非唯一，跳过以避免破坏其他变更`);
  }
  let seamRemoved = false;
  if (removeSeam) {
    const seam = join(libDir, HOST_CAPABILITY.seamFile);
    // 只删 market 适配自身的 seam（含我们声明的标识），避免误删他人同名文件
    if (existsSync(seam) && read(seam).includes('fish-body.market.v1')) { rmSync(seam); seamRemoved = true; }
  }
  return { ok: issues.length === 0, removed, alreadyPristine, seamRemoved, issues };
}

/** 备份当前 lib 三文件到 backupDir（含 hash manifest），供审计/兜底回滚。 */
export function backupAdaptation(libDir, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const files = [...HOST_CAPABILITY.consumerFiles, HOST_CAPABILITY.seamFile];
  const hashes = {};
  for (const f of files) {
    const src = join(libDir, f);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(backupDir, f));
    hashes[f] = fileSha(src);
  }
  const manifest = { adapterId: ADAPTER_ID, version: ADAPTER_VERSION, dshmarket: HOST_CAPABILITY.dshmarket,
    backedUpAt: new Date().toISOString(), hashes };
  write(join(backupDir, 'fish-body-adapter-backup.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** 兜底全量回滚：仅在显式 force 时用备份覆盖（可能覆盖其他变更），默认拒绝并指引用 uninstallAdaptation。 */
export function restoreAdaptation(libDir, backupDir, { force = false } = {}) {
  const manifestPath = join(backupDir, 'fish-body-adapter-backup.json');
  if (!existsSync(manifestPath)) throw Object.assign(new Error('FH_MARKET_ADAPTER_NO_BACKUP'), { code: 'FH_MARKET_ADAPTER_NO_BACKUP' });
  const manifest = JSON.parse(read(manifestPath));
  if (manifest.adapterId !== ADAPTER_ID) throw Object.assign(new Error('FH_MARKET_ADAPTER_BACKUP_MISMATCH'), { code: 'FH_MARKET_ADAPTER_BACKUP_MISMATCH' });
  if (!force) return { ok: false, code: 'FH_MARKET_ADAPTER_USE_UNINSTALL', hint: '默认请用 uninstallAdaptation 手术式撤销；全量覆盖须显式 force:true' };
  for (const f of Object.keys(manifest.hashes ?? {})) copyFileSync(join(backupDir, f), join(libDir, f));
  return { ok: true, restored: Object.keys(manifest.hashes ?? {}), version: manifest.version, force: true };
}
