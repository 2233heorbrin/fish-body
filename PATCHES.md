# 本机补丁与正式源码对应关系

## 0.0.5-dev.1：原包更新来源保留候选

公开维护源在 `original-source.mjs`、`market-runtime.mjs`、`market-prepare.mjs` 和原生事务入口。它们传递用户来源与本次固定内容；repair 保留原分支/标签，不把解析提交当作新的更新渠道。远端原包要求匹配宿主的 `fixedPackageSourcesVersion=1`，没有身体自身免检。

宿主独立维护 `install-source.mjs` 及普通部署/明确original续接调用方。它在原生锁内临时组合 pnpm 12 resolver 与既有 hooks，让 pnpm 保留直接依赖来源、写入固定解析和实际归档完整性；同时核对发布文件。等待释放锁、status不新增决定、重新持锁继续和原生失败恢复沿用 v2。不是安装file之后孤立手改manifest，也不需要重写市场更新算法；既有消费者读取原生manifest和lock。原包归档仍可能被lock引用，不可随意删除。

这些宿主变更仍不随公开身体包部署。旧身体首次接入通过原有pending/original交接，由已部署的新宿主消费其已保存的来源/提交/原包，再安装新身体；不能假设下载中的新身体会先接管自身。本候选的实际验收和部署结果分别记录，开发版本不覆盖v0.0.4。

## 0.0.4：安装决定与实验宿主 v2

身体维护源为 `internal/install-transaction.js`、`internal/backend/lib/market-{prepare,runtime,source}.mjs` 及既有编排／工具入口。采集原包后再分析，返回具体依据与未知项；不再替用户默认接受全部未知。匹配的正常工具安装意图及已有正式批准仍可继续。严格的正式受管批准接口及原完整性检查保留，原包安装结果不冒充审查通过。

配套 rc.5 实验扩展 v2 单独维护宿主 `install-transaction.mjs`、新增 `install-decision.mjs` 及原生结果接线：首次调用返回待决定并释放 Profile 锁，后续 CLI 明确指定引用、动作、目标后重新加锁；胃导入或工厂失效仍可提供原生入口。原生部署前拒绝和原生已经完成的恢复需在结果中标明，避免扩展重复恢复，恢复钩子仍执行一次。完整补丁、维护源及重放／恢复材料由宿主交付维护，不在身体包静默部署。

只支持该扩展的真实契约，不宣称官方原版或旧 v1 已具备两阶段继续能力；没有改写胃识别算法或自动脑区拆分。安装／原包／原生继续、脚本策略、用户开关、受影响 repair／批次和独立绑定已有针对性隔离证据；任务分支已完成远端交付及指定日常环境接入，用户确认独立启停、页面和目录按钮。完整第三方市场安装链和插件页自动发现更新仍未验收。

manager v2、鱼脑releaseExact及市场client-only唯一挂载兼容修复分别由宿主/市场维护，不混入本包。当前没有公开可下载的配套补丁发行物，完整支持限于环境维护者已部署匹配扩展的rc.5环境；具体交付限制见README。0.0.4只整理版本/说明，不把本机补丁目录或私人配置打包。

## Windows 默认 pnpm 补修（0.0.3 GitHub 源码交付）

`fix/windows-pnpm-command` 在既有 main 基线上维护 `runtime-programs.mjs` 和 `w6-package.mjs`，不覆盖宿主扩展。原生宿主的 `{command:'pnpm'}` 在 Windows 不能直接交给 Node execFileSync；统一命令描述现在按配置环境的 PATH 选择 pnpm，将标准 npm 全局 / 包内 `.bin` shim 对应的 pnpm 包声明解析为 exe 或 JS bin。JS bin 复用严格 Node 选择，直接 exe 与显式 Node/DSH + JS、参数顺序和环境保持原配置。未配置时保留随包 pnpm 后备；不存在或未知布局的显式配置不后备。没有承诺支持任意自定义 shell 脚本。

已验收 tgz 的独立安装副本通过专项 13 项与受影响检查 54 项，均无失败或跳过。默认配置的普通 Node 和 DSH Node 模式真实安装链通过，后者保留 perf/compat import、worker-events require 和 fork 继承；显式 JS / exe 作正常对照。专项回归还覆盖配置环境、常见 shim 布局、无效显式配置、原始错误脱敏及准备 IPC 到最终事务结果。下方 74 项及宿主验收数量保留为此前阶段证据，不累计到本轮。

2026-11-15，修复先通过复审并完成本地提交与 main fast-forward 合并，保留 `fix/windows-pnpm-command` 分支；该本地收尾阶段未推送、未创建发布标签、未发布、未接入日常。随后保持版本 0.0.3，通过 GitHub main 与 annotated tag `v0.0.3` 交付源码，固定来源为 `github:2233heorbrin/fish-body#v0.0.3`。版本交付只整理 README/CHANGELOG/PATCHES，运行代码、测试逻辑、依赖及打包规则不变；最终候选包核对提交树及已验收包字节，复用上述证据，不宣称重新完成远端安装实测。GitHub 首次安装、旧版更新与插件页发现更新仍待隔离验收；未创建 GitHub Release、未发布 registry、未接入日常。宿主扩展仍独立维护，未知 shim 不作兼容承诺。

## 既有准备进程修复

2026-11-15，本地维护版本 0.0.3。先前 `fix/install-chain` 已形成当前基线；`fix/prepare-process-stability` 完成准备进程修复及指定扩展宿主的隔离验收，该工作块已作本地提交与合并收尾，未推送、打发布标签或更新生产宿主。

| 本机补丁 | 身体源码的现有维护入口 | 本轮处理 |
|---|---|---|
| FH-P-001：pnpm 生成的 `.bin` 入口部署核验 | `internal/backend/lib/w6-deploy.mjs` | 已有按声明限定生成入口的实现，保留；不复制旧版整文件 |
| FH-P-002：只读包管理命令、市场审查与批准 | `internal/backend/fish-hand-admission-gate.mjs`、`lib/market-source.mjs`、`lib/review.mjs`、`fish-hand-orchestrator.mjs` | 已纳入源码，保留当前包内适配与精确准入 |
| FH-P-003：市场准备、依赖与产包链路 | `internal/backend/lib/market-prepare.mjs`、`market-runtime.mjs`、`w6-package.mjs` | 已纳入源码；这次移植其后发现的中文解包修复 |
| FH-P-004：原生 CLI 单个 npm 包安装前准备 | `internal/install-transaction.js` → `lib/market-runtime.mjs` | 公开版已有对应准备链，要求宿主的安装事务扩展；本机 `native-cli-install.mjs` 与宿主 `operations.js` 接线仍按宿主补丁单独维护 |
| 2026-11-14 中文文件名 tar 热补丁 | `internal/backend/lib/w6-package.mjs`、`market-source.mjs` | 用显式依赖的 Node tar 库替代相关系统 tar 调用，覆盖来源解包与产物回解 |
| 新检出目录的换行漂移 | `.gitattributes` | 固定文本 LF，保持内置 SHA 工具与 Git 中原始模块的字节及固定哈希一致 |
| 2026-11-14 桌面运行时与准备进程稳定性 | internal/backend/lib/runtime-programs.mjs、market-runtime.mjs、market-prepare.mjs、w6-package.mjs | 严格处理 DSH_NODE，逐个验证后备候选；补齐 IPC 回调、常驻错误、stderr/退出状态和取消收尾；不增加自动重试 |
| 运行时选择缓存 | `internal/backend/lib/runtime-programs.mjs` | 缓存服从当前 DSH_NODE、Electron 模式及实际选择输入；命中时保留当前工作负载环境，覆盖无参数生产调用路径 |
| rc.5 安装事务初始化异常收口 | 配套宿主的 `installTransactionExtensionVersion=1` / bundle 的 `dsh.installTransaction` 接口 | 模块导入、工厂初始化和执行共用宿主事务错误边界；维护源、部署与可重放补丁在宿主扩展中独立维护，不属于本包实现 |

各路径相对于本仓库；本表表示逻辑归属，不表示不同宿主版本的文件哈希应相同。身体源码使用包内依赖、每 Profile 状态与可选宿主接口，本机旧私有包不能整文件覆盖到这里。

## 此前准备进程修复的验证范围

实际 tgz 独立安装后的相关回归为 74 pass / 0 fail / 0 skip，包含分发验证，不重复累计。准备进程专项测试实际执行包内 `market-prepare.mjs`，覆盖普通 Node、DSH.exe run-as-node、无效显式配置、无参数缓存路径、PATH shim、启动/预加载/导入/IPC/取消和结果后异常退出。

指定官方 `0.2.1-rc.5` 基线的实验扩展宿主已通过真实原生 CLI 安装/更新、准备子进程、受管产物、原生部署、实际 Loader、部署前取消及身体关闭/重开接管验证。配套宿主初始化异常补修另通过 15 项扩展回归和 13 项真实入口断言；普通 Node 与实际 DSH.exe 的 Node 模式均验证无效 DSH_NODE 受控失败、未部署不恢复、解除故障后成功，并验证部署后失败恢复及错误传播。维护源、部署模块和完整补丁重放文件一致。

本地收尾保持上述运行代码与测试不变；最终包只更新说明文件，复用同代码的既有安装和真实链证据，不宣称新包重新跑过全部安装链。实际证据位置由本机维护报告记录，不随本包分发。

## 仍待单独修复

- DSH.exe Node 模式的真实原生安装入口已验证，桌面外壳完整环境交接仍未验证。
- 历史生产 EPIPE 的精确触发路径仍为 unknown；修复后的诊断会保留前因，但不反推既往根因。
- 将局部 Map 的 `memory.set()` 误判为宿主记忆操作的检查器误报。
- 官方原版 rc.5 缺少安装事务扩展的限制仍成立；实验扩展不作为官方内置能力发布。指定日常环境已独立接入扩展，不代表其他安装环境自动获得；已缓存的 ESM 不会因磁盘文件变化自动重载。

升级以正式源码和生成产物为准，禁止把当前磁盘哈希直接覆盖历史补丁基线来消除漂移。

旧 W6-A 隔离辅助函数 `w6-runner.mjs` 中的 `makeRunPnpm()` / `runnerFact()` 保留历史本机测试定位；它们不是正式安装链调用的入口，也不属于跨机器兼容承诺。该模块中正式路径复用的登记与探针函数不读取这项旧定位。此处注明测试范围，本次不改动这些运行字节。
