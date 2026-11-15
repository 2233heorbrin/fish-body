# 本机补丁与正式源码对应关系

## Windows 默认 pnpm 补修（已复审，本地收尾）

`fix/windows-pnpm-command` 在既有 main 基线上维护 `runtime-programs.mjs` 和 `w6-package.mjs`，不覆盖宿主扩展。原生宿主的 `{command:'pnpm'}` 在 Windows 不能直接交给 Node execFileSync；统一命令描述现在按配置环境的 PATH 选择 pnpm，将标准 npm 全局 / 包内 `.bin` shim 对应的 pnpm 包声明解析为 exe 或 JS bin。JS bin 复用严格 Node 选择，直接 exe 与显式 Node/DSH + JS、参数顺序和环境保持原配置。未配置时保留随包 pnpm 后备；不存在或未知布局的显式配置不后备。没有承诺支持任意自定义 shell 脚本。

已验收 tgz 的独立安装副本通过专项 13 项与受影响检查 54 项，均无失败或跳过。默认配置的普通 Node 和 DSH Node 模式真实安装链通过，后者保留 perf/compat import、worker-events require 和 fork 继承；显式 JS / exe 作正常对照。专项回归还覆盖配置环境、常见 shim 布局、无效显式配置、原始错误脱敏及准备 IPC 到最终事务结果。下方 74 项及宿主验收数量保留为此前阶段证据，不累计到本轮。

2026-11-15，修复已通过复审并完成本地提交与 main fast-forward 合并，保留 `fix/windows-pnpm-command` 分支，版本仍为 0.0.3。收尾仅调整说明，运行代码、测试逻辑、依赖及打包规则不变；最终候选包核对提交树与已验收包的文件字节，复用上述安装与测试证据，不宣称说明调整后的 tgz 重新完成整套安装实测。本轮未推送、未创建发布标签、未发布、未接入日常；宿主扩展仍独立维护，未知 shim 不作兼容承诺。

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

## 本次升级的验证范围

实际 tgz 独立安装后的相关回归为 74 pass / 0 fail / 0 skip，包含分发验证，不重复累计。准备进程专项测试实际执行包内 `market-prepare.mjs`，覆盖普通 Node、DSH.exe run-as-node、无效显式配置、无参数缓存路径、PATH shim、启动/预加载/导入/IPC/取消和结果后异常退出。

指定官方 `0.2.1-rc.5` 基线的实验扩展宿主已通过真实原生 CLI 安装/更新、准备子进程、受管产物、原生部署、实际 Loader、部署前取消及身体关闭/重开接管验证。配套宿主初始化异常补修另通过 15 项扩展回归和 13 项真实入口断言；普通 Node 与实际 DSH.exe 的 Node 模式均验证无效 DSH_NODE 受控失败、未部署不恢复、解除故障后成功，并验证部署后失败恢复及错误传播。维护源、部署模块和完整补丁重放文件一致。

本地收尾保持上述运行代码与测试不变；最终包只更新说明文件，复用同代码的既有安装和真实链证据，不宣称新包重新跑过全部安装链。实际证据位置由本机维护报告记录，不随本包分发。

## 仍待单独修复

- DSH.exe Node 模式的真实原生安装入口已验证，桌面外壳完整环境交接仍未验证。
- 历史生产 EPIPE 的精确触发路径仍为 unknown；修复后的诊断会保留前因，但不反推既往根因。
- 将局部 Map 的 `memory.set()` 误判为宿主记忆操作的检查器误报。
- 官方原版 rc.5 缺少安装事务扩展的限制仍成立；实验扩展不作为官方内置能力发布。生产尚未采用本次修复，实际接线核对与升级须独立安排；已缓存的 ESM 不会因磁盘文件变化自动重载。

升级以正式源码和生成产物为准，禁止把当前磁盘哈希直接覆盖历史补丁基线来消除漂移。
