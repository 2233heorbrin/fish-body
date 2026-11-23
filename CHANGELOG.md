# 更新记录

## 0.0.7-dev.22 — 2026-11-23（Codex #330b 自动版本检查下渠道标签残留修正）

- 自动版本检查下直装渠道标签残留修正（dev.21 真机发现的最后一处显示 bug）：dev.21 给 `installedChannel` 加的 `directRegistration.sourceKind` 优先判定已对，但 `currentSourceOf` 循环 `for (const ins of [fromResult, inline])` 里 `fromResult=checks[row.id]?.result?.install` 先命中 installed——页面 mount 自动跑 check-versions 填充 checks，而 check-version 返回的 install 只有 `{sourceId,state,installedVersion,comparison}`、无 directRegistration → `installedChannel` 读不到 sourceKind → 回退 `sourceId='local:…'` → 误报「本地材料·0.1.86」。修正：循环前把 fromResult 规范化为 effectiveFromResult——installed 且缺 directRegistration 且 inline 有时，浅挂一份 `{...fromResult, directRegistration: inline.directRegistration}`，循环改用 effectiveFromResult；fromResult 其余字段/优先语义不变、不污染 checks 原对象、无 directRegistration 旧来源仍走原 fallback。后端/installedChannel/安装/注册/身份判定/installLine-carrier 全不碰、不伪造渠道。
- 验证：node --check、UI 契约 41/41 + w2 前端 19/19（新增 #330b 三条断言：fromResult 无 dr + inline 有 dr → npm 不误判 local + 其余字段未被覆盖 + checks 原对象未污染 + 无 dr 旧来源走 fallback）+ 饭来源 9/9 + review-fix 4/4；隔离 harness 开自动 check 宽窄真机图「实际安装 npm · 0.1.86（当前安装）」showsNpm=true/showsLocalWrong=false、零 pageerror/console error。开工/完工门命中 §5/§9（依赖循环、插件装卸旧教训，与只补显示字段无关，报告如实记录）。仅本地测试分支与隔离验证，未合并 / tag / Release / registry / 未装日常。

## 0.0.7-dev.21 — 2026-11-23（Codex #330 直装渠道标签显示收尾）

- 直装来源渠道显示修正（唯一显示收尾）：`client.js:1165` `installedChannel` 函数开头优先读 `install.directRegistration?.sourceKind`（npm/github，rice-model.mjs:451 已输出），命中直接返回真实渠道；旧 source/sourceId 文本判定 fallback 一行不动。修的是 dev.20 真机图「实际安装」把 npm 直装误显示成「本地材料·0.1.86」——因 direct-registration 的 `sourceId='local:饭/直装来源/dsh-meme/npm-…'` 命中 `/^local:/` 落 local 分支。安装/注册/身份判定全不变、不改后端。
- 验证：node --check、UI 契约 41/41 + w2 前端 18/18（新增 #330 定向断言：directRegistration.sourceKind=npm|github + sourceId='local:…' → 返回 npm/github 而非 local，无 sourceKind 时原 fallback 保留）+ 饭来源 9/9 + review-fix 4/4；宽窄真机图 DOM「实际安装 npm · 0.1.86（当前安装）」showsNpm=true/showsLocalWrong=false、零 pageerror/console error。开工/完工门命中 §10（依赖循环教训，与只改显示字段无关，报告如实记录）。仅本地测试分支与隔离验证，未合并 / tag / Release / registry / 未装日常。

## 0.0.7-dev.20 — 2026-11-23（Codex #327 饭来源与证据定向收尾：直装登记接入 / 按钮文案 / 报告 JSON）

- 饭·当前安装来源接入本轮直装登记（Codex #327 第1项）：`rice-model.mjs` 新增 import `listDirectSources`（只读、依赖无环）与 `resolveInstalls` 内「直装登记优先判定」层 `directRegistrationFor(e,directSources)`——包名归一相等 + 该行确属 `registration-only` 直装登记 + 同名多条用 linkRealPath/bodyPath/contentIdentity.version 交叉只认唯一条，三条件全满足才产出 `state:'installed', source:'direct-registration'`；未命中原样走旧 `mapInstalled`（install-mapping 一行未动）。历史同包不同 id/bodyPath 仍 unconfirmed 不冒当前、卸载后 realpath 消失自动撤当前、unconfirmed basis 按真实原因（交叉未通过/无匹配登记）写，不再一律归因「内容等价历史」。不伪造 formalDecision/analysisApproved、不改 client。
- 饭·分析入口按钮名副其实（第2项）：`client.js` 按钮「用已装本体按需采集并进入分析」→「到胃工作区查看/分析 →」+ title 说明本页不预先采集，fb-note 导向「手·组件」页已装项分析真入口（#318 已通过），onClick 仍纯导航；不碰手页、不造编排、不调 analyze-installed。
- 隔离集成报告 JSON 修正（第4项，仅 evidence 非源码）：`dev19-ui-update-PASS.json` 非法拼接 dep → 真实完整序列化值 + depSource；`dev19-peer-client-evidence.json` 保留 dshToolsResolveError + 补 hostObserverPeerImport 原始结果 + evidenceBoundary 分清「插件目录直接 resolve 失败」与「宿主 installAnchor 解析成功」两场景。
- 验证：反例 5/5（登记精确识别/历史不冒当前/卸载撤当前/同名不同源/文案真实性）、w2 前端 17/17 + UI 契约 41/41 + 饭来源 9/9 + review-fix 4/4、仓库 rice-source 9/9 + rice-group 21/21 + install-wiring 10/10、既往 W2 六套无回归、`node --check` 全过、开工/完工门命中无。GitHub 真实 subdir 无样本仍 unknown、反例用 junction 模拟 link 未复现真实宿主前端点击链路，按四类分栏如实标注。仅本地测试分支与隔离验证，未合并 / tag / Release / registry / 未装日常。

## 0.0.7-dev.19 — 2026-11-23（Codex #324 四项定向补修：配置接线 / 子包路径 / 饭一插件一卡 / 真集成证据）

- 配置接线（维护源 Profile 作用域）：`market-runtime.mjs` 新增 `withProfileStateScope`（`value.apply(adapter,args)` 保 this、forProfile fallback 也包作用域），`install-transaction.js` 用作用域包装后的 `managedDirectLink`/`directSourceRecord`/`directUpdateTarget` 替代裸摊平对象，去掉 probe 全进程 `FISH_HAND_STATE` 依赖——正常启动即按每 Profile 自动接线市场来源识别/检查/更新，不再靠环境变量补通。修的是 `FH_STATE_MISSING` 产品遗漏，隔离启动 shim 与之分开。
- GitHub 子包路径：`installed-analysis.mjs` GitHub 分支 `materialPath` 从完整仓 `entry.repoDir` 收窄到 `repoDir/subdir`（realpath 后），subdir 权威取 `entry.subdir` + found 兜底，两次 `path.relative` 越界防护，空 subdir 保持整仓不回归，npm 分支未动——从已装项进入分析不再纳入兄弟包/仓根。
- 饭·一插件一卡归一（Codex #324 第3点）：`rice-model.mjs` 仅加展示层字段 `displayKey`/`packageName`（身份核实逻辑不动），`client.js` 按核实包名归一成每渠道每插件一行、详情头改「含未核实来源」、卡级「有新版本」只认安装版比较、材料行 newer 标「仅该来源材料，非安装升级」、版本清单逐条列当前安装/历史来源+身份依据、未采材料按钮如实禁用并改「用已装本体按需采集并进入分析」。
- 验证：配置接线 A/B 决定性证据 7/7+5/5（裸 adapter 识别不到来源 vs 作用域 adapter 识别、错指环境变量仍优先）、子包路径专项 15/15 + 回归 13/13+13/13（夹具测、无真实子包样本如实标注）、前端 16/16 + UI 契约 41/41 + 饭来源 9/9 + review-fix 4/4；源码 `node --check` 全过、开工/完工门命中无。真 DSH 插件隔离集成（真市场 UI 点击/干净卸载/真 peer import）见执行报告，证据分层不抬高。仅本地测试分支与隔离验证，未合并 / tag / Release / registry / 未装日常。

## 0.0.7-dev.18 — 2026-11-23（#318 收尾：四阻塞修复 + 从已装项进入分析 + 真 DSH 插件验收）

- 分支冻结修复：直装来源 `refKind` 区分 pin/ref/default，`requestedRef` 原样保留、已装 commit 降级为纯内容身份，分支/浮动 ref 继续跟踪、40hex pin 原样保留（更新渠道与内容身份分离）。
- 可分发市场适配：`market-compat-adapter` v1.1.0 内嵌 14 条由 pristine→适配副本精确生成的补丁，补 `installAdaptation`（幂等）/`uninstallAdaptation`（手术式只撤自身）/`verifyAdaptation`；restore 默认拒绝全量覆盖，修复 CURRENT_CHANGED 误报。
- 产物内容寻址：`revisionOf` 纳入 integrity/registry/spec，`body-prep` 暂存后原子 rename 切换，同源同版复用不重装、身份冲突拒覆盖，不对被引用目录重装。
- 脚本授权边界：`runtimeReadiness` 只读判定（ready/needs-build/no-entry），`--ignore-scripts` 只装依赖不跑生命周期、不冒充可运行。
- 从已装项进入分析：手页就地选兼容/逆向 → `POST /api/fish-body/analyze-installed` → 按已装来源采材料（GitHub codeload / npm 真实 bodyPath）→ 建分析+建任务，回到同一插件；不切插件、不建 off 任务、不伪造批准。
- 三值白名单单点化：index.js/backend-entry.js/tasks.mjs 统一引用 intake-mode.mjs 的 `INTAKE_MODES`/`DEFAULT_INTAKE_MODE`/`INTAKE_MODE_KEY`。
- 验证：全量回归 121 项 + 真 DSH 插件（dsh-meme）四类分栏 E2E 8/8（原生安装/真实运行/市场更新/GitHub 样本），本体入仓 realpath/登记/真 Cordis 加载/0.1.81→0.1.86 更新/新版入仓旧版保留。

## 0.0.7-dev.17 — 2026-11-23（胃三模式与手插件仓接入测试版）

- 主人「就先按照这样、开始做吧」授权（Codex #300 交接、#309 收口）；从 dev.16 commit 1c6353b 开 feat/body-intake-modes-warehouse 分支，原 8 项 untracked 保留。三职责 Agent 按唯一文件归属并行实施 + 主模型集成胶水。
- 胃三模式（off/compatibility/reverse）：`internal/analysis/intake-mode.mjs` 单点白名单 INTAKE_MODES + DEFAULT='compatibility' + `readPersistedIntakeMode` / `resolveIntakeMode`（显式>持久化>默认）；tasks.mjs `create(off)` 独立短路返回 `{mode:'off',phase:'skipped',status:'registration-only',skipped:true,taskId:null}`，不建任务、不产 plan/materials、不调模型、不伪造批准、不落 task.json；artifact/produce/confirm 加 off 抛错防落 reverse 分支，update 拒旧任务 patch→off（切模式只影响新请求）；conversation.mjs 加 off 独立直装口径 prompt + DISCUSSION_GUIDE【六、off】。
- 默认工作模式持久化（主模型集成层）：backend-entry.js 的 configureBackend 把 `intakeMode` 并入保留字段（重写 conf 前读旧值、仅接受三值否则默认 compatibility，重启不回退）；index.js `/api/fish-body/state` 扩 GET/HEAD/POST，GET 带出 `defaultMode`、POST 收 `{defaultMode}` 原子改写 fish-body-state.json 的 intakeMode 回读，非法值 400；与部署用 `mode:'production'` 语义分离、不碰数据根/绑定/其它 profile。
- 前端 client.js：三模式卡（三列/窄屏一列、aria-pressed、当前选择 Tag）+ chooseMode 只影响新请求不改已开任务 + 模式持久化读写；饭页 sourceStatus 四值（collected/downloaded-pinned/registration-only/material-absent）渲染、未采材料绝不显示"已保存"；手页「原生安装·未拆分」+「从已装项进入分析」显式入口 + 身体总开关独立于关闭胃；off 建任务按钮拦截（双保险，后端短路兜底）。
- 市场直装与来源（纵向链）：`market-direct-source.mjs`（真实已装来源唯一读取/登记）、`market-optional-seam.mjs`（市场 seam 维护源）、original-source.mjs 共用入口 installedSourceRecord、market-prepare.mjs off 直装立即返回 `{directInstall:true,analysis:null,authorization:'intake-off-direct'}` 跳过 runW2W3/review/approve；market-runtime.mjs 暴露直装方法 + deploy 后登记来源；rice-model.mjs 顶层 sourceStatus 四值。隔离副本 dshmarket routes.js/updates.js 同步（directSourceFor 贯穿 updateCheckInputs + summary/单条/列表三处 checkUpdates + cacheKey + updates.js 比较链 + stillLocal，受管 link 走原渠道 spec 不查 catalog 不换 npm latest；普通 dev link/generation link 不误接管）。三处纠正=来源判定与分析批准分离 / 读来源接回原渠道不换源 / 完整消费者。
- 验证：node --check 全 changed 文件 exit0；UI 契约 41/41、W2 前端 9/9、off 专项 8/8、rice-source 9/9、rice-group 21/21、install-wiring 10/10、review-fix 4/4、纵向链反例 12/12 fail0；三组改动合并同一工作树无组合回归（主模型集成复核全量真跑）。非本次引入 FAIL：stomach-entry-conditions.test.mjs 1/14（line433 正则与 off 六段文案不符）、backend-install-decision 缺前置——已标清非本轮。仅本地测试分支与隔离验证，未合并 / tag / Release / registry / 未装日常。

## 0.0.7-dev.16 — 2026-11-22（鱼身体主导航迁移 + 饭页 GitHub/npm 两渠道布局测试版）

- 鱼身体入口从设置侧栏迁到 DSH 主侧栏：client.js 注册 main keyed panel + sidebar.panellist，返回会话按钮走 `ctx.get('layout')?.selectPanel(null)` 回到原会话，不再藏在设置页里。
- 饭·来源页改为认可图布局：左侧紧凑插件列表 + 右侧唯一详情；GitHub 仓库 / npm 两渠道分段切换（seg 按钮 + 键盘左右），当前所看渠道只影响显示哪份材料、不代表安装切换；缺材料时给出明确提示；材料版本 / 安装状态 / 来源关联未确认口径不变。
- 按 Codex #283 四处设计偏差修正饭页渲染层：①版本结论（远端版本 / 中文结论 / 当前安装比较）改为正文默认可见、仅技术细节折叠（新增 `.fb-ver-main` / `versionSummary`）；②`stateTag` 只按当前渠道材料的有效检查判定，不拿同组其它渠道 / 历史的 `newer` 冒充；③`.fb-rice-list` 加 `max-height:460px` + `overflow-y:auto`，窄版 `max-height:220px` 也不铺开；④来源链接统一标「查看来源」（无专门更新说明字段）、去掉正文操作组与 `renderCheck` 的重复链接；另面包屑改「鱼的身体 · 工作区」。
- 仅前端 client.js 接线与布局改动，后端与依赖不动。验证：node --check 通过、UI 契约测试 41/41、注入法真实渲染全绿；本轮 dev.16 另完成本地打包（client.js 与工作树逐字节一致）+ 隔离 DSH 原生安装 + Edge 真机截图，详见本目录执行报告。仅本地测试分支与隔离打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.15 — 2026-11-22（Codex dev.14 五次复核 URL 大小写一处定向补修定版测试版）

- 按 Codex dev.14 第五次复核退回的唯一一处定向补修（其余路径身份反例/契约/追加测试/真机 context+meme/界面接线/包 SHA 全部通过保留，不重做 UI、不重跑整套 U/H/E）：`resolutionIdentity` 旧实现对整条远端 URL `.toLowerCase()`，把大小写敏感的 pathname（如 `DEMO.tgz` vs `demo.tgz`）也归一导致同名误认。改为标准 `new URL()`——`protocol`/`host` 按 WHATWG 标准归一（hostname 小写、去默认端口），`pathname`（仅去尾斜杠）/`search`/`hash` 原样保留大小写，重建 `url:` 引用；非标准 URL 兜底只小写 scheme+host、path 段保留；`file:` 继续走 pathIdentity、`ref:` 去掉一律小写；保留 `url:`/`path:`/`ref:` 类别前缀杜绝跨类误判。仅改 `internal/backend/lib/install-mapping.mjs` 一处 + 2 条 URL 大小写专项测试，其他生产文件/版本签名文件不动。
- 验证：Codex URL 身份探针 2 条改前 pass:false → 改后全 pass:true（registry 大写旧资源 vs 当前小写依赖→unconfirmed、lock 当前小写却先选大写残留→正确选中写 demo.tgz），Codex 原件备份恢复未覆盖；全套 103/103 fail0、install-wiring 10/10、dev9 五反例 9/9、dev14 路径身份 5 条 / dev12 契约 5 条 / dev11 追加 3 条不回归、node --check 0；真机 dsh-context `market-69e6828c` / dsh-meme `market-d08423f7` 仍精确 installed/sourceId 关联、同内容其余 unconfirmed。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.14 — 2026-11-22（Codex dev.13 四次复核路径身份 4 缺陷返修定版测试版）

- 按 Codex 对 dev.13 四次复核退回的 4 类路径身份缺陷逐条返修（原 A/C 职责不变，非重做视觉/非扩功能）。共同根因：`install-mapping.mjs` 旧 `normalizeResolution` 把任何 URL/file 引用截成最后文件名（`split(/[\\/]/).pop()` 只留 demo.tgz，丢掉 host、old/new 目录、a/b 提交目录），lock 与 registry 两路都按尾段判同导致同名误认。①删 `normalizeResolution`，新增 `resolutionIdentity(value,baseDir)`：去 pnpm peer 后缀、远端 URL 保 host+完整路径（`url:`）、file 按所在 lock/Profile 基目录用 `path-identity.mjs` 的 `pathIdentity` 解析完整规范路径（`path:`）、其余按引用（`ref:`），带类别前缀杜绝跨类误判。②registry 三源（当前声明 / registry 行 / 正式决定）spec 交叉核要求完整引用身份全等，要求当前 `declaredSpec` 存在否则不命中；同名不同制品 / 目录 / 提交不再冒认 installed。③新增 `targetProfileMatches`：含路径走 `samePath` 完整规范路径，legacy 纯目录名在父目录下 resolve 后比，不再 `basename` 通配（不同目录同名 fish-main 必拒）。④当前 package.json 无该依赖声明时，仅 node_modules 残留 + 旧 registry 不放行 installed。保留 40 位完整提交号匹配与 sourceId 尾段取 requestId 契约；有效 registry 正例与真机 dsh-context/dsh-meme 继续 installed 不一刀切。
- 验证：Codex 路径身份探针 `rice-dev13-paths-Codex.mjs` 复跑 4 条修后全 pass=true（lock 同名不同完整引用 / registry 旧制品 vs 新声明 / targetProfile 同名不同目录 / 当前无依赖声明全降 unconfirmed）、正例 real-registry-valid-control 仍 installed；dev12 契约 5 条 / dev11 追加 3 条 / dev9 五类反例全不回归；全套 97/97、node --check 全 0。真机 registry 读回 dsh-context `market-69e6828c` / dsh-meme `market-d08423f7` 精确 installed/sourceId 关联、同内容其余历史全 unconfirmed。独立验收 U 88/88 + H 41/41 + E 九场景收敛、9 张实际页面图逐张看图、快照 SHA 三方 7 文件 byte-identical + 硬断言 dsh-context 0.83.1、生产真缺陷 0；pageerror 9-injected/0-control 如实判 harness 壳副作用。远端版本仍为 mock 未联网真查。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.13 — 2026-11-22（Codex dev.12 三次复核 3 类真实缺陷返修定版测试版）

- 按 Codex 对 dev.12 三次复核退回的 3 类真实缺陷逐条返修（原 A/B/C 职责不变，非重做视觉/非扩功能）：①安装映射改为消费真实鱼手安装契约——`install-mapping.mjs` 新增 `readRealInstall` 只读交叉核真实 registry 行（`state=installed` + `requestId`/`formalDecisionId`）+ active 正式决定（`targetProfile`/制品摘要）+ 请求记录，来源 id 尾段与 `requestId` 精确关联，能在多条同内容 market 历史中定位当前那一条（不挑首条）；`registry state=installed` 或 `active` 决定单独不算运行态，须交叉核对；npm 64 位 pinnedCommit 当材料摘要不做 git commit；不硬编码 id/profile。单条 / 列表 / 批量三入口统一基于全量来源集合算安装映射再按 id 挑回，修「列表批量 unconfirmed、单条 installed」分裂。（`readLockEvidence` 只认当前 root importer、沿直接依赖 resolution 精确匹配、subdir 缺 directory 证据即 unconfirmed，保留有效安装正例不一刀切。）
- ②版本检查：远端真取数成功时结果携带本次获取时间（`fetchedAt`），缓存复用不刷新 `lastSuccessAt`、真实新成功推进 `lastSuccessAt`（08:00 首查→08:10 force 真成功→前进到 08:10），两个方向同时守。
- 验证：Codex 契约探针 5 条修复后全 pass=true（other-importer / same-version-stale / subdir-missing / single-list-batch-agree / real-success-force-time）、真机 registry 读回 dsh-context `market-69e6828c` 与 dsh-meme `market-d08423f7` 判 installed/sourceId 精确关联、同内容其余历史全 unconfirmed；全套 92/92、dev.9 五类来源反例 9/9 不回归、node --check 全 0。独立验收 U 78/78 + H 36/36 + E 九场景收敛、8 图逐张看图、快照 SHA 三方统一扩 7 文件 + 硬断言 dsh-context 0.83.1、生产真缺陷 0；pageerror 如实判 harness 壳副作用（control=0）。远端版本仍为 mock 未联网真查。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.12 — 2026-11-22（Codex dev.11 二次复核 5 条真实缺陷返修定版测试版）

- 按 Codex 对 dev.11 二次复核退回的 5 条真实缺陷逐条返修（原 A/B/C 职责不变，非重做视觉/非扩功能）：①同一安装事实在 `publicSources` 组头 / `attachInstallToSources` 逐条 / 版本结果 install / 页面四处统一——抽 `resolveInstalls` 逐来源映射共用，`sourceId` 仅 installed 才回显已核实关联、其余收口 null，内容等价（同摘要）多条全降 unconfirmed 不挑首条；②pnpm lock 命中只认当前 importer/direct dependency 条目（`entry.direct` 门），完整提交 + owner/repo/subdir 全核，残留 lock / 前 7 位子串不再冒认当前安装；③前端当前来源按 `result.install.sourceId` 证据优先精确匹配（匹配不到显示「当前使用来源未确认」不硬选 rows[0]），market UUID 收进技术详情不出正文，删去无排序依据的「该渠道最新记录」改「已保存记录」；④npm 声明仓库冲突的包（如同包同时 acme/one + acme/two）分键 `pkg:包名@owner/repo`，不再合回同名裸键；⑤`RAW_CACHE.fetchedAt` 作原始成功取数时间，缓存复用不刷新 `lastSuccessAt`（08:00 首查后 08:10/08:20 复用仍为 08:00），`checkedAt` 保持本次返回时间。保留已通过的异步路由 / `attachInstallToSources` 接线 / force / 失败冷却 / 跨批去重。
- 验证：Codex 追加反例探针 3 条 pass=true（old-nondirect-lock / conflicting-npm / cached-original-fetch-time）、real-per-source-install 观察 8 行全 unconfirmed；全套 85/85、dev.9 五类来源反例 9/9 不回归、node --check 全 0。独立验收 U 64/64 + H 30/30 + E 九场景收敛、8 张单卡特写 + 1 张全页逐张看图、快照 SHA 三方统一 + 硬断言 dsh-context 0.83.1、fork/冲突/同版/当前行/安装比较两对象五类正反例真抓到、生产真缺陷 0；8 条 duplicate-factory pageerror 如实判为 harness 壳替换副作用（control=0）非产品缺陷。远端版本仍为 mock 未联网真查。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.11 — 2026-11-22（分组与自动查版本返修收口测试版）

- 按 Codex dev.10 复核退回 6 点 + 父模型追查的第 7 点返修，饭·来源归组与自动查版本定版。①纯 npm 同包同 registry 历史材料（无 GitHub 实际材料）现按包名+声明规范仓库归一成一张卡 `pkg:`、`identityBasis=package-manifest`，不再各自 solo；前端先 GH/npm/本地渠道分层、渠道内折叠历史，当前使用来源醒目。②安装映射改写真实 pnpm lockfile v6/v9（YAML 按 importers/packages 结构解析，不再猜第二个 @）；同版本不足以确认来源，须 lock/安装决定按 owner/repo/subdir/commit/version 精确映射才判 installed，否则「当前安装来源未确认」不冒认。③安装比较按安装版本真算：新增 `install:{sourceId,state,installedVersion,comparison}`，`comparison=versionComparison(安装版, 远端版)` 仅在 installed 且检查成功时计算，材料基线 `comparison` 独立不变；材料 1.0 / 实装 2.0 / 远端 1.5 显示「当前安装版较新」与「与保存材料比较」两对象分开，不误报安装版有新版。④`force` 重查同时绕过成功缓存与失败冷却、失败保留 historical/unknown 不伪装 ok、跨批次同远端 inflight 去重只发 1 请求、取数时间不冒称本次联网。⑤单条 `check-version` 与批量 `check-versions` 全套异步（execFileAsync 超时受控、并发上限 3），用户「重新检查」不再同步阻塞宿主。⑥三张验收图接真实读模型快照（`listRiceSources → publicSources → /sources` 路由，硬断言 dsh-context GitHub 本地版本 0.83.1），只对远端网络 mock；异常场景图明确命名 `fixture-*`，不冒充真机。⑦（父模型追查）修复生产 `check-version(s)` 路由未注入 `_install` 基线导致 `result.install` 永远缺失的链路缺口——`rice-model` 新增 `attachInstallToSources` 逐条注入、与 `/sources` 同口径，仅测试夹具手填才绿灯的问题不再存在。
- 验证：专项 `fish-body-install-wiring` 3/3（真路由非夹具）、全套 83/83、dev.9 五类来源反例 9/9 不回归、Codex 两探针六项全 PASS；独立验收 U 56/56 + H 25/25 + E 九场景收敛、真实快照 33 材料行→26 组→26 卡、fork/冲突/同版三误并正反例真抓到、生产真缺陷 0。真实日常原生服务/远端版本仍为 mock 未联网真查。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.10 — 2026-11-21（饭·来源按插件归组 + 远端版本自动查测试版）

- 饭·来源页从「一条来源一张卡」改为「一个插件一张卡」：以经核实的 `packageName` / 实际 `owner/repo(/subdir)` 归并身份（groupKey=`pkg:` / `gh:` / `solo:`），卡内 GitHub / npm / 本地来源分层展开、同一来源的历史 market 材料折叠进「历史获取记录」；`id` / 哈希 / 路径仅留在技术详情折叠。安装来源/版本只按当前 Profile 的 lock / 安装决定与同版本精确映射显示，证据不足标「当前安装来源未确认」，不冒认、不按包名无条件归并。
- 防误并（Codex #241）：包名相同≠同源——fork 保留原包名而 repository 指上游的，按实际 owner/repo 独立成键、不并回上游；npm 仓库关系缺失/冲突的单列 `solo:` + `unconfirmed`、不吸入 GitHub 组；同版本多 market 材料仅 lock 精确命中那条显示已安装（全页安装徽标仅 1 条）。无法确认身份的卡显式标「来源关联未确认」。
- 远端版本自动查：进入饭页自动查远端元数据（不下载/不安装），先出本地卡再补结果；同一远端 raw 按 repo 复用去重、结果按来源 id 隔离，成功缓存建议 1 小时、失败冷却 5 分钟、可手动「重新检查全部」强制重查；已安装版本比较与源材料比较分开标注。对 `check-version(s)` 采用最小异步改造 + 并发上限 3 / 超时 20s / 错误脱敏，不阻塞宿主、不调模型、不开后台轮询；失败 / 403 / 版本不可比保留 `unknown` 或历史结果，不谎报最新。新增 `POST /check-versions` 批量只读接口：后端自行枚举已登记来源白名单、只接受可选 `force` 布尔（额外键/非布尔→400），防开放代理。
- 验证：`fish-body-rice-group` 8/8、`fish-body-autocheck` 9/9、全套 71/71、独立验收 U 33/33 + H 22/22 + E 四张真机截图逐张看图，防误并三条正反例均真抓到；dev.9 五类来源反例不回归。仅本地测试分支与打包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.9 — 2026-11-21（来源读取补修复核收口测试版）

- 复核收口 dev.8 的来源读取补修（Codex #230 四点）：①`classifyType` 不再用 `/^local/` 前缀误伤带真实 GitHub upstream 的 `local-git-fixture`（如 dsh-context），只认明确的 `local-copy` / `local-first-party` / `sourcePlatform=local`；dsh-context 归回 GitHub、正确显示远端来源与版本检查入口。②`projectSource` 强化关联确认——空对象拒绝、必须有指向本仓库的 `localRepositoryPath` 才命中、`versions` 只读索引固定提交不扫其他提交冒充。③来源 id 解析分离 `#subdir`，不再把 monorepo 子包名吞进 repo；新增 `sourceMaterialName` 子包匹配，防串兄弟子包。④测试移正：无关父层测试放到实际候选父层（非空测）、新增缺关联 / 固定提交 / monorepo 子包三例、本机实机核对移到结果目录探针不纳入开源测试。
- 主人反馈的「GitHub 来源显示无法检查、npm 来源能查版本」经实测为环境网络差异 + 本会话临时状态：`api.github.com` 在无代理时限流（403），npm registry 可达；当前网络下 GitHub 与 npm 两条来源都能正确查到远端版本并判「有新版本」，`check-version` 逻辑正确、不谎报最新。归类 bug 修复后 GitHub 来源不再被误标「本地材料」。
- 验证：`test/fish-body-rice-source.test.mjs` 9/9、必要回归（review-fix + ui-contract + ui-plugin-switch）45/45、`node --check` 0；真实读模型 36 项中 github19 / hasRemote19 / local6，dsh-fish / cyanwell / fish-body / dsh-context 均有远端来源、本地项保持本地。仅本地测试分支与实际包验证，未合并 / tag / Release / registry。

## 0.0.7-dev.8 — 2026-11-20（饭·来源读取缺陷补修测试版）

- 修正饭·来源页「仓库插件显示无远端来源、插件市场却显示」：`rice-model.mjs` 原索引分支只读 `repositoryPath` 仓库子目录内的 `来源.json`，而真实来源元数据在父层 `饭/github.com/<owner>/<repo>/来源.json` 或当前采集的 `versions/<commit>/来源.json`，导致 GitHub 材料 `hasRemote=false`、误判「无远端来源」。
- 按三种真实落盘布局读取来源（仓库内 / 父层 / `versions/<commit>`），用 `localRepositoryPath` 精确指向本仓库 + owner/repository 与索引 id 比对核实关联，拒绝邻居/同名误配；名称、`hasRemote`、远端版本检查共用同一份补齐的元数据。真正无来源保持 `unavailable`，有来源但版本不可比仍 `unknown`，不谎报「已是最新」。
- `classifyType` 尊重显式本地类型/平台（`local-copy` / `local-first-party` / `sourcePlatform=local`），本地材料不再被索引分区 `hint='github'` 误标为远端来源。
- 新增聚焦测试 7 项（旧布局父层 / versions 布局 / 仓库内布局 / 真无来源 / 无关父层不误配 / 本地两类 / 真实饭目录成批识别），先以旧代码回放确认捕获缺陷再修；`rice-model.mjs` `node --check` 0、新测试 7/7、既有 UI 契约相关 45/45 通过。
- 不重新下载插件、不自动更新来源、不改原材料/索引、不新增运行时 git 扫描；仅本地测试分支与打包验证，未合并 main / 正式发布 / 恢复兼容拆分工作块。

## 0.0.7-dev.7 — 2026-11-20（鱼身体 UI 预览对齐 + 设置误报修正测试版）

- 在 dev.6 基础上按认可预览图对齐鱼身体五页 UI：总览 / 饭·来源 / 胃·分析 / 手·组件 / 设置与帮助的内容区版式、信息层级、状态口径与异常态逐页收敛；同 CSS 尺度对照图与逐页必要差异见结果目录。本轮同时含前端展示与后端最小接线改动，并非仅前端。
- 后端最小状态 / 启停接线：`index.js` 的 `pickManager()` 按需惰性探测宿主本地 pluginManager（`ctx.get('pluginManager')` → `ctx.pluginManager` → 旧 remote 两路兼容，找到即停、单探针抛错跳过），`registered` 用手登记真值不被缺口覆盖，`/plugin-switch/state` 透传可判别 code（`native-api-unavailable` / `read-state-failed` / `unmappable-target`）；`plugin-switch.mjs` 身份不明补 `unmappable-target`。不改宿主 / 协议，缺口仍降级不画假成功。
- 修正设置页「目录失效」误报：`dataProblem` 只依据目录类状态（`invalid-root` / `pending-workspace` / `pending-initialization` / `invalid-config`）与顶层 `error` 判定，彻底移除宿主依赖错误（`dependencies.error`，如 `FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE`）对目录问题的影响；宿主依赖状态仍沿设置页「程序准备 / 宿主暂不支持完整安装接管」独立显示，不因本次修正消失。
- 浏览器两场景实测：状态 `ready` + `dependencies.status=host-blocked` 不再显示「原数据目录不可访问」且保留宿主依赖状态提示；状态 `invalid-root` 仍显示「原数据目录不可访问」。`node --check` 与既有 41 项 UI 契约测试通过。
- 仅本地测试分支与打包验证；未日常安装、未重启或改动日常 DSH、未切插件、未推送 / 合并 / 打 tag / Release / registry，不覆盖已日常安装的 dev.6。

## 0.0.7-dev.6 — 2026-11-20（鱼身体 UI 五页分支测试版）

- 设置页「鱼的身体」由单一分区扩为顶部五导航：总览 / 饭·来源 / 胃·分析 / 手·组件 / 设置与帮助；导航项来自 `GET /api/fish-body/sections` 的固定五项，方向键 / Home / End 焦点与切换保留，局部失败只影响该区。
- 总览读 `GET /api/fish-body/overview`，三区独立空态 / 读取失败，点卡片进入对应页；该页不发打开目录请求。
- 饭·来源读 `GET /api/fish-body/sources`，手动按钮才调 `POST /api/fish-body/check-version`；中文名、本地版本、来源说明与目录入口常显；版本结论只读后端 `comparison`，前端不做字符串比较；失败 / 历史标「历史结果·当前未确认」「暂时无法检查」，不显示假「已最新 / 有新版」；`checkedAt` 与 `lastSuccessAt` 分开。
- 胃·分析保留既有任务、模式、选择确认、服务端验证、分页与复制讨论，刷新只读当前状态、不自动重扫 / 生成 / 安装；按基线重排展示。
- 手·组件读 `GET /api/fish-body/plugin-switch/state` 真实原生状态，已登记 / 已安装 / 启用选择 / 实际运行反馈分开；按来源插件分组，只有已安装且身份映射明确且接口可用才给启动 / 关闭按钮；操作调 `POST /api/fish-body/plugin-switch`，分显「启用选择 / 操作中 / 本次请求结果」，连续点击防重复，失败给中文原因并重读只读状态；缺口 `native-api-unavailable` 显示核查证据，不画假成功。
- 设置与帮助收纳数据绑定、选择目录、当前工作区与重试准备，技术细节默认折叠；新增近期诊断与「复制诊断摘要」，复制失败明确提示手动复制；摘要不含凭据 / 人格 / 记忆，不发送不上传。
- 新增独立开发场景入口（结果目录 dev-scene，不进生产导航）：复用真实 client.js 组件与 C 的 `test/fixtures/ui-scenarios/` 夹具切换正常 / 错误 / 恢复 / 空态 / 历史 / 不可比较 / 登记未验证；Edge 实渲五页正常与异常、1180 与窄面板截图见结果目录。
- 仅本地分支开发 / 独立测试 / 本地提交；未重启或改动日常 DSH，未切日常插件，未部署日常 Profile，未推送 / 合并 / 打 tag / Release / registry。

## 0.0.7-dev.5 — 2026-11-20（解释引导通用口径小修测试版）

- 合并并替换 `internal/analysis/conversation.mjs` 的讨论引导措辞为通用解释口径（不硬编码案例）：①调用语法≠实际效果，断言运行效果须核对实参/被调分支/早退，并区分语法调用、局部静态推论与运行效果；②删除/停用影响须查已知读取者、准入与提示消费者及其他触发路径，不从停一处推全停；③当前依赖≠适配后仍必需、路径≠配置开关、提示≠程序强制/死锁；④permissionGate 结合比较极性与 then/else、早退解释；⑤源码行段=坐标非证明，但核对过的实现可支持局部静态判断，不升级为运行证明；⑥入口归属按功能上下文(name/run/scope)查，全局 unknown≠各功能无法归属。
- 引导体量 2934B→3078B（净 +144B），实际工具响应仍守 16000B 预算；无新增分析引擎或模型请求，无功能实现变化（仅措辞）。
- 复用有效功能证据；新实际包经 analysis-context 与 stomach-tasks 真实路径验证通过。

## 0.0.7-dev.4 — 2026-11-19（入口条件与功能归属证据补修测试版）

- 入口条件证据补强：动作只认 AST 字符串字面量或无插值模板，`getText` 回退与字段名正则不再产出动作值；比较证据携带运算符、字面量所在侧与分支极性（`==`/`===`→then 真、else 假；`!=`/`!==` 反之），宽松比较不升级为严格证明。
- 动作候选改为多候选 `actionCandidates`，存在歧义时不收敛单值（`acceptsAction=null`），禁止以全局首项、同名参数或作者描述跨函数配对；同层显式 `return`/`throw` 之后不可达的调用不再产出候选但仍保留 `return sink()` 调用事实；主体被重新赋值后降级为 unknown 而不冒充已确认动作。
- 功能归属区分 direct/associated/background：只有从所选声明的回调出发存在真实调用边才归 associated，兄弟功能自调用或缺少关系路径的降级 background/unknown；模块导入闭包只作 background，不虚增直接入口。
- 新增纯合成内存反例测试（v2/v3）覆盖比较极性、多候选、早退截断、主体重赋值与归属路径；既有入口专项与回归保持通过。
- 仅更新测试分支 feat/stomach-split-tasks，不合并 main、不创建标签或 Release、不发布 registry；依赖版本保持。真实模型中文解释与用户功能取舍仍待日常对话验收。

## 0.0.7-dev.3 — 2026-11-19（证据上下文与候选范围补修测试版）

- file 查询默认仍查已有记录；显式 view=source 按需读取当前有效分析的已验证快照，返回真实行列、截断及 nextLine/nextOffset，支持超长行续读，不启动分析器或执行源码。片段明确区分已存/摘要截断，作者描述不作为运行事实。
- 六类依赖候选分开呈现所选声明内观察和全插件背景，直接观察优先，数量与引用对应；不把语法状态访问或模块闭包当作必需脑区/最小依赖，不穷举所有附带行为。保留已有决定、归属、理由及补充引用，显式替换或删除仍有效。
- 当前DSH对话引导要求核对入口筛选和早退，区分作者声明、当前耦合、工具控制、拟人行为及其他副作用，再用自然语言解释使用影响和取舍；不新增模型服务或自动对话。
- 沿用原来源、Profile、绑定及内容有效性边界；版本/实现变化可使旧分析见证失效，保留材料，不修补见证或自动重扫。compatibility仍仅方案，reverse仍仅理解材料，不实施适配、派生包或候选安装。真实模型是否正确使用新材料待后续对话验收。
- 仅更新测试分支，不合并main、不创建标签或Release、不发布registry；依赖版本保持。

## 0.0.7-dev.2 — 2026-11-18（中文结果与自然语言交互测试版）

- 新分析和任务按插件已有显示名分组，内部唯一编号保留；统一定位继续读取旧直放 ID 目录，不迁移旧材料。设置页按插件、类型、时间及任务状态选择，技术编号、源码路径、诊断和原始产出折叠分页。
- 默认展示功能取舍、模型建议、使用影响和下一步；可选 explanation 使用 current-model 归属并绑定当前分析和方案版本，内容变化后失效，仅更新说明不改变选择、依赖或用户确认，不重写历史产出。
- fish_hand 正式说明和返回引导现有对话模型核对证据后用自然语言推荐；页面只复制讨论提示，不自动发送或调用模型，没有说明时如实显示待解释。
- 保持 compatibility 仅产出待执行方案、reverse 仅产出理解材料的边界；不执行适配、不制作派生安装包、不安装候选、不声明完整解耦。版本变化可能使旧分析见证失效，保留旧结果，不修改见证或自动重扫。
- 本地双运行时专项及隔离浏览器已验证运行实现；本版从任务分支交付，新增中文引导的真实 DSH 模型讨论与用户功能取舍待验收，不创建正式标签或 Release、不发布 registry。

## 0.0.7-dev.1 — 2026-11-18（胃模式任务分支测试版）

- 胃设置页和 fish_hand task 共用 Profile/绑定作用域的任务状态：compatibility/reverse、整体分类候选及有来源判断、能力选择、六类依赖决定、版本确认与分页读取。
- compatibility 产出待确认的统一派生方案；reverse 产出引用既有快照的组件源码片段和证据材料。模式、能力或内容变化使旧确认失效，历史产出保留；复用现有来源/快照/实现见证及关闭/closing 检查，不自动分析或调用模型。
- 同一分析/能力/依赖的有效补充证据随决定保留，显式替换/清空有效，换分析重置；页面区分当前结果与关联 initial，连续 deep 不误传 deep ID，缺少初扫关联时提示且不自动扫描。
- 仅完成选择与产出；没有候选适配、可安装派生包、完整解耦或候选运行验收，不写鱼脑全局人格/记忆/心情。测试分支来源为 feat/stomach-split-tasks，用户日常页面及真实对话验收待完成；未修改正式标签。

## 0.0.6 — 2026-11-18

- 正式交付 `fish_hand analyze/query`：initial 初扫、显式 deep 及 initialAnalysisId 关联、按需分页、同类型有效复用；查询不自动重跑。
- request 按原采集协议核对完整固定内容和登记绑定，再核对实际快照；变更后拒绝首次分析、关联初扫、复用和查询，保留旧材料。local 不声明上游提交、不强制采集清单。
- 运行实现和依赖与已验收的 0.0.6-dev.1（33e8a793dd5eee6c3c60f23a36977d3f5c21b382）一致；本次只调整版本、lock 和发布说明。复用测试版真实 DSH 对话证据，不声称正式版已重新调用模型。
- 真实对话确认工具可调用并提供分析材料：初扫、深查各执行一次，深查关联初扫，分页和有效复用未重扫；deep 保留 diagnostic-partial 的 7 项关系不完整。有界追踪、any、动态关系仍有限制，静态证据不是安全拆分证明。
- 目前没有模式选择、兼容拆分、逆向拆分执行流程、候选安装或运行验证。Windows x64、Node 22/24/>=26 分析范围及指定 DSH rc.5 宿主扩展要求见 README，其他平台未验证。
- 通过 main 和新 annotated v0.0.6 交付；不创建 GitHub Release，不发布 registry，不改写旧版本记录。

## 0.0.6-dev.1 — 2026-11-18（分支测试版）

- 新增 `fish_hand analyze/query`：initial 初扫、显式 deep 深查及通过 initialAnalysisId 关联同内容初扫；同类型有效结果可复用，查询按需分页且不自动重跑。
- request 来源按既有采集算法核对完整文件集合、逐文件内容、登记摘要及实际分析快照；内容或清单失配明确拒绝，查询与复用沿用同一校验。local 保留明确选择当前目录的语义。
- 返回保留命名空间证据、未知项、截断和 diagnostic-partial；结果按 Profile 隔离，源码、配置或实现见证改变后旧结果失效但保留。
- 固定分析依赖；当前原生分析器验证范围为 Windows x64，Node 22、24 或 >=26，DSH 支持与独立宿主扩展要求见 README。没有新增依赖安装脚本执行授权。
- 这是只读分析材料入口，尚未实现组件拆分、候选安装或运行验证。仅交付任务分支测试版，真实 DSH 模型对话验收待完成；不创建正式标签、Release 或 registry 发布，不改写 0.0.5 历史记录。

## 0.0.5 — 2026-11-17

- 原包部署向匹配宿主传递原始更新来源、固定提交和已审归档；普通安装与 repair 共用规则，不再只留下无法供原生 GitHub 更新识别的 file: 直接依赖。
- 明确 original 续接由宿主保存和消费同一固定内容；后续更新重新固定分析，不增加身体自身免检特例。
- repair 的内容采集仍使用固定提交，更新来源保留原先分支/标签，不把本次解析提交误存为后续渠道。
- 来源保留需要独立维护的 fixedPackageSourcesVersion=1 宿主适配及 pnpm 12 resolver；缺失时明确失败，不静默丢失来源。身体关闭继续原生透传，真实本地包不转换成远端来源。
- 由已验收的 0.0.5-dev.1 整理为正式版，运行实现不变；保留旧标签。原生更新 API 已验证，桌面更新按钮未点击；固定标签不自动追踪未来版本。
- 审查失败、超时或结论不明时可明确选择本次已固定原包，不冒充分析通过；下载、身份、归档及完整性错误不能绕过。

## 0.0.4 — 2026-11-16

### 胃分析与两阶段安装决定

- 原包采集先于分析，保留目标身份、固定提交／归档、具体操作证据和未知项；不再统一标为工具或自动接受全部未知风险。
- 匹配的普通工具安装意图和有效既有批准可复用；分析失败／超时／待讨论时返回本次原包选择，胃未初始化或失效时返回本次原生选择，不自动初始化或回退。
- 配套实验宿主 v2 提供释放锁后的明确继续／取消入口，按目标绑定内容；保留启停、原生检查、一次部署及恢复结果。宿主扩展独立维护，不随包安装，不是官方 rc.5 能力。
- repair／多包保留目标决定和已完成结果；同内容已批准 npm 请求重采集不再重置正式批准。独立安装测试从 pnpm 实际包目录解析已有依赖。

### 脑与身体运行／数据解耦

- 数据根改由 fish-body-data.json 独立维护；数据页、后端根校验和原生事务统一解析旧位置与独立绑定。
- 切根后旧事务明确要求重载，不改动脑绑定或删除旧受管包。
- 完成异步校验时若工具所属上下文已卸载，不再向该旧实例注册 SHA 工具；原完整性校验保留。
- 保留现有折叠数据设置与下方目录页签。

### 设置页

- 精简身体设置页：目录路径和打开操作集中在现有饭／手／胃页签卡片，数据根、Profile 和绑定操作收进默认折叠的“数据设置”；未绑定或配置异常时自动展开。
- 目录绑定与程序准备分开表述；准备失败保留重试入口和可展开的原始错误。不改变绑定或迁移规则，不修复后端重复路由注册问题。
- 补齐身体客户端目录选择器的原生注入声明；自动初始化完成或失败时刷新已打开的身体设置面板和目录卡片。

### 交付与验证范围

- 根包及锁文件同步为0.0.4，固定来源 `github:2233heorbrin/fish-body#v0.0.4`；运行内容保持已验收任务分支，不创建 GitHub Release、不发布 registry。
- 已有公开候选的隔离远端首次安装/旧版更新、原生重载与失败恢复证据；日常分支完成原生安装和独立启停，用户确认页面、目录按钮以及关闭身体后后端与内置SHA-256停用。正式版本不把这些旧证据写成重新执行整套测试。
- 两阶段决定依赖独立manager v2；市场client-only修复不随本包分发。扩展尚无公开下载发行物，完整支持范围与交付限制见README。插件页自动发现更新、完整第三方市场链及旧问题仍单独保留。

## 0.0.3 — 2026-11-15（GitHub 源码版本）

- 2026-11-15 Windows pnpm 补修（已复审并本地合并）：默认 pnpm 按配置 PATH 定位所选安装，通过标准全局或 `node_modules/.bin` 布局的包声明找到 exe / JS 入口，不执行任意 shim 内容。保留显式命令、参数顺序、配置环境和 Electron 模式；不支持的 shim 明确失败，不静默换用其他安装。
- pnpm 失败沿既有事务结果保留脱敏后的原始错误码、消息、实际调用和阶段，区分命令解析、进程创建、非零退出与结果处理；准备子进程退出 0 不代表包管理或事务成功。
- 将本机中文文件名解包热补丁移植到正式源码：npm 发布包采集与产包回解统一使用声明的 `tar@7.5.23`，不硬编码 Git for Windows 路径、不改写上游文件名。
- 保留 npm 发布包路径和链接检查、摘要核验、W6-B 精确产物准入及部署内容校验。
- 固定 Git 文本换行为 LF，防止 Windows 新检出目录改变内置 SHA 工具的字节并触发固定哈希拒绝；保持原始模块与哈希判据。
- 准备进程按“可执行程序＋启动环境”选择 Node：显式 DSH_NODE 无效时明确失败，未配置时逐个直执行验证候选并跳过 shell shim。
- 运行时缓存随 DSH_NODE、Electron 模式、执行程序、PATH/PATHEXT/SystemRoot 或工作目录变化失效；缓存命中仍使用当前工作负载环境。回归覆盖无参数生产缓存路径，桌面集成路径改为显式测试配置。
- 准备父子进程现会等待 close 汇总结果，持续处理进程与 IPC 错误，保留并脱敏 stderr、退出码、信号和原始错误码；取消不重放准备事务。
- pnpm 与已授权生命周期调用复用同一运行时环境；实际 tgz 的独立安装测试覆盖普通 Node、DSH.exe run-as-node、启动/预加载/导入/IPC/取消和结果后异常退出。
- 2026-11-15：指定 rc.5 实验扩展宿主的真实原生 CLI 安装/更新、受管产物、Loader、取消及关闭/重开接管已取得隔离证据。配套宿主另完成事务导入/工厂初始化异常收口，普通 Node 与 DSH.exe Node 模式的故障→解除→成功及部署后恢复验证通过；宿主扩展独立维护，不随本包安装。
- 既有本机补丁的归属与合入范围见 [补丁同步说明](PATCHES.md)。本机 DSH 宿主接线不随身体插件静默安装。

此前中文解包、准备进程及 Windows pnpm 修复阶段分别完成本地提交与合并，当时未推送或部署生产。本次保持版本 0.0.3，以 GitHub main 和 annotated tag `v0.0.3` 交付源码，固定来源为 `github:2233heorbrin/fish-body#v0.0.3`；未创建 GitHub Release、未发布 registry、未部署生产。本次只整理发布说明并核对内容，复用已验收实现的 13 项专项、54 项受影响检查及真实安装链证据；远端首次安装、旧版更新和插件页发现更新仍待隔离验收，不宣称发布说明包已重新安装实测。官方原版 rc.5 不具备完整安装事务扩展；DSH.exe Node 模式通过不等于桌面外壳完整交接已验证。历史生产 EPIPE 的精确触发路径仍为 unknown，局部 Map 的记忆审查误报仍未修复。

## 0.0.2 — 2026-11-13

- 将完整饭→胃→手后端纳入身体发行包，不再依赖未发布的本机鱼手模块。
- 与鱼脑共享每 Profile 的数据根目录，支持首次初始化与手动切根。
- 接入配套宿主安装事务与市场可选接口，支持更新、取消及失败恢复。
- 修复身体更新自身时，把审查正则文本误判为人格操作的问题。
- 正确识别 npm 随包分发依赖的锁定来源，保留原有脚本授权检查。

完整统一安装流程需要配套实验宿主扩展；未修改的官方 rc.5 仍显示接口缺失。Windows 原生目录选择器与 Explorer 点击验收尚未完成。
