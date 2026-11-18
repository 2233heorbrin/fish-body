# 安装产物回归

`stomach-tasks.test.mjs` 从真实独立包运行胃任务及生产 HTTP/fish_hand 接口。
设置 `FISH_TEST_INSTALL_ROOT` 为独立安装根、`FISH_TASK_TEST_ROOT` 为尚不存在的隔离目录，
运行 `node --test test/stomach-tasks.test.mjs`。使用自建混合插件和真实采集清单，
不依赖 experiments 或私人样本；覆盖两种产出、版本确认、归属、分页与原文坐标、
来源篡改、Profile/绑定和 off/closing。确认归属为合成测试，不代表真实用户已裁定。
可在系统 Node 和 `ELECTRON_RUN_AS_NODE=1` 的 DSH Node 模式运行；不代表日常部署或模型对话。

`install-source-preservation.test.mjs` 验证实际包的普通插件/身体自身原包部署及 repair 转交同一来源契约、宿主能力缺失与原包变化在部署前拒绝。它不代替宿主原生 resolver、pnpm、明确续接、真实更新消费者及远端安装验收；这些在匹配扩展的合成环境另验。

`backend-install-decision.test.mjs` 要求独立安装产物和 `FISH_DSH_TEST_ANCHOR` 指向本轮实验宿主 v2；不会用旧 v1 或官方宿主冒充。覆盖实际采集／分析、具体混合操作证据、未知形态、既有正式批准复用、原包内容绑定、import／同步与异步工厂故障、按目标决定、取消、未部署不恢复、部署后恢复及恢复失败、胃不可用和准备进程超时。合成授权仅用于夹具，业务不默认接受残留风险。真实 CLI→明确继续→原生部署→Loader 及真实 repair／批次／重载须另验；单测不代表桌面按钮通过。

测试实现从 FISH_TEST_INSTALL_ROOT/node_modules/fish-body 加载；先打包并在独立目录安装，不能将变量指向源码根代替安装产物。

`analysis-tools.test.mjs` 从实际 `fish_hand` 定义和 handler 验证 initial/deep、复用类型、
五类按需查询、证据修订与截断、Profile 隔离及关闭收尾。需要独立安装包的
`FISH_TEST_INSTALL_ROOT`、尚不存在的 `FISH_ANALYSIS_TEST_ROOT`，以及调用方明确选择的
`FISH_ANALYSIS_REAL_SOURCE`（已有 extras 接线的源码快照，仅解析文本）。它不扫描工作区找样本。
测试写入、示例返回和计数保存在测试根；候选入口、配置和安装脚本设有执行陷阱。
同时保留初扫诊断和深查诊断；合并结果不会因另一份结果无语法错误而升级为完整。
可在系统 Node 或 `ELECTRON_RUN_AS_NODE=1` 的 DSH Node 模式运行同一测试；后者不代表真实对话验收。

`analysis-request-source.test.mjs` 专项使用真实采集算法生成公开合成夹具，
不需要私人文件。设置 `FISH_TEST_INSTALL_ROOT`、尚不存在的 `FISH_REQUEST_TEST_ROOT`
及全新的 `FISH_ANALYSIS_LOAD_LOG` 文件路径，再运行：

```text
node --import ./test/analysis-loads.mjs --import ./test/analysis-request-race.mjs --test test/analysis-request-source.test.mjs
```

子进程也必须继承这两个预加载：将相同的 `--import` 参数（使用绝对 file: URL）
放入 `NODE_OPTIONS`。加载日志用于证明同名同长度篡改在实际分析器启动前拒绝；
race 辅助仅在测试显式设定的夹具路径注入复制竞争。测试覆盖首次 request、
关联初扫、后续复用/查询、清单绑定、被分析器忽略的文件、local 与 Profile 语义。
这些 test 文件不进入发布包，正式运行不依赖它们或 experiments。

独立数据绑定专项：`node --test test/distribution.test.mjs test/independent-binding.test.mjs test/binding-consumers.test.mjs`。消费者测试还需 `FISH_DSH_TEST_ANCHOR` 指向隔离 rc.5 宿主；验证原生组合中的旧 fishRoot、旧后端投影、独立绑定优先级、切根和失效后的旧事务拒绝，以及原完整性校验后已卸载 SHA 所属实例不再注册工具。

backend-prepare-process.test.mjs 的环境配置：

- FISH_TEST_INSTALL_ROOT：必需，独立安装根。
- FISH_TEST_WORK_ROOT：可选，专项证据与夹具目录；默认使用 tmpdir() 下的新目录。
- FISH_TEST_PNPM：可选，已准备好的 pnpm 直接可执行文件绝对路径。未设置时使用安装产物依赖中的 pnpm/bin/pnpm.mjs；其平台二进制也需按 pnpm 自身安装要求准备好。普通准备与构建回归不会因缺少 pnpm 而跳过。
- FISH_TEST_DSH_EXEC_PATH：可选，真实桌面 DSH 可执行文件绝对路径。未设置时仅桌面集成项 skip，实际桌面集成状态为 unknown；显式提供但无效时测试失败。

示例命令：node --test test/backend-prepare-process.test.mjs。

`backend-package-manager.test.mjs` 同样加载独立安装产物，覆盖 Windows 默认 pnpm、标准全局和 `.bin` 布局、配置 PATH/env 与参数、显式 exe / JS、无效配置及诊断分类；真实准备 IPC 用例核对最终 adapter 失败结果。Windows 夹具不执行自定义 shim 内容。真实 DSH + pnpm JS 项沿用 `FISH_TEST_DSH_EXEC_PATH`，未提供时明确 skip；其余普通必需回归照常执行。

完整默认配置宿主验收须另走真实 `pluginManager/installBundle`、准备 pack、原生部署和 Loader；单项命令解析或 `--version` 成功不代表该链已通过。桌面 Node 模式验收保留实际 perf/compat imports 与 worker-events require，不加载日常 instance-link。

测试启动的 DSH 进程使用 ELECTRON_RUN_AS_NODE=1，验证运行时、准备入口和生命周期；这不代表完整 DSH 宿主安装事务接入通过。Electron 模式缓存用例用受控探针错误模拟启动模式要求，避免启动桌面 GUI，真实运行路径由配置了 DSH 的集成项覆盖。

运行前把 TEMP/TMP/TMPDIR、HOME/USERPROFILE、APPDATA/LOCALAPPDATA、DSH_HOME/DSH_AGENTS_HOME、npm cache、pnpm home/store 及 FISH_HAND_STATE 指向隔离根；仅改变 cwd 不满足隔离要求。测试不负责安装缺失依赖，也不应使用生产状态配置。
