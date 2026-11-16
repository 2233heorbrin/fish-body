# 安装产物回归

`backend-install-decision.test.mjs` 要求独立安装产物和 `FISH_DSH_TEST_ANCHOR` 指向本轮实验宿主 v2；不会用旧 v1 或官方宿主冒充。覆盖实际采集／分析、具体混合操作证据、未知形态、既有正式批准复用、原包内容绑定、import／同步与异步工厂故障、按目标决定、取消、未部署不恢复、部署后恢复及恢复失败、胃不可用和准备进程超时。合成授权仅用于夹具，业务不默认接受残留风险。真实 CLI→明确继续→原生部署→Loader 及真实 repair／批次／重载须另验；单测不代表桌面按钮通过。

测试实现从 FISH_TEST_INSTALL_ROOT/node_modules/fish-body 加载；先打包并在独立目录安装，不能将变量指向源码根代替安装产物。

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
