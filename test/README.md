# 安装产物回归

测试实现从 FISH_TEST_INSTALL_ROOT/node_modules/fish-body 加载；先打包并在独立目录安装，不能将变量指向源码根代替安装产物。

backend-prepare-process.test.mjs 的环境配置：

- FISH_TEST_INSTALL_ROOT：必需，独立安装根。
- FISH_TEST_WORK_ROOT：可选，专项证据与夹具目录；默认使用 tmpdir() 下的新目录。
- FISH_TEST_PNPM：可选，已准备好的 pnpm 直接可执行文件绝对路径。未设置时使用安装产物依赖中的 pnpm/bin/pnpm.mjs；其平台二进制也需按 pnpm 自身安装要求准备好。普通准备与构建回归不会因缺少 pnpm 而跳过。
- FISH_TEST_DSH_EXEC_PATH：可选，真实桌面 DSH 可执行文件绝对路径。未设置时仅桌面集成项 skip，实际桌面集成状态为 unknown；显式提供但无效时测试失败。

示例命令：node --test test/backend-prepare-process.test.mjs。

测试启动的 DSH 进程使用 ELECTRON_RUN_AS_NODE=1，验证运行时、准备入口和生命周期；这不代表完整 DSH 宿主安装事务接入通过。Electron 模式缓存用例用受控探针错误模拟启动模式要求，避免启动桌面 GUI，真实运行路径由配置了 DSH 的集成项覆盖。

运行前把 TEMP/TMP/TMPDIR、HOME/USERPROFILE、APPDATA/LOCALAPPDATA、DSH_HOME/DSH_AGENTS_HOME、npm cache、pnpm home/store 及 FISH_HAND_STATE 指向隔离根；仅改变 cwd 不满足隔离要求。测试不负责安装缺失依赖，也不应使用生产状态配置。
