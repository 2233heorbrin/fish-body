# 本机补丁与正式源码对应关系

2026-11-14，本地维护版本 0.0.3。维护分支 `fix/install-chain` 从 0.0.2 起步，验证通过后合回本地 `main`；本轮不推送、打发布标签或更新生产宿主。

| 本机补丁 | 身体源码的现有维护入口 | 本轮处理 |
|---|---|---|
| FH-P-001：pnpm 生成的 `.bin` 入口部署核验 | `internal/backend/lib/w6-deploy.mjs` | 已有按声明限定生成入口的实现，保留；不复制旧版整文件 |
| FH-P-002：只读包管理命令、市场审查与批准 | `internal/backend/fish-hand-admission-gate.mjs`、`lib/market-source.mjs`、`lib/review.mjs`、`fish-hand-orchestrator.mjs` | 已纳入源码，保留当前包内适配与精确准入 |
| FH-P-003：市场准备、依赖与产包链路 | `internal/backend/lib/market-prepare.mjs`、`market-runtime.mjs`、`w6-package.mjs` | 已纳入源码；这次移植其后发现的中文解包修复 |
| FH-P-004：原生 CLI 单个 npm 包安装前准备 | `internal/install-transaction.js` → `lib/market-runtime.mjs` | 公开版已有对应准备链，要求宿主的安装事务扩展；本机 `native-cli-install.mjs` 与宿主 `operations.js` 接线仍按宿主补丁单独维护 |
| 2026-11-14 中文文件名 tar 热补丁 | `internal/backend/lib/w6-package.mjs`、`market-source.mjs` | 用显式依赖的 Node tar 库替代相关系统 tar 调用，覆盖来源解包与产物回解 |
| 新检出目录的换行漂移 | `.gitattributes` | 固定文本 LF，保持内置 SHA 工具与 Git 中原始模块的字节及固定哈希一致 |

各路径相对于本仓库；本表表示逻辑归属，不表示不同宿主版本的文件哈希应相同。身体源码使用包内依赖、每 Profile 状态与可选宿主接口，本机旧私有包不能整文件覆盖到这里。

## 本次升级的验证范围

从本分支打出真实 tgz，独立安装后运行相关后端、部署内容及原生生命周期测试；新增中文路径的实际采集、产包与解包验证，并保留非法路径、链接和摘要不符的拒绝用例。实际运行的测试结果在本机交付报告中记录。

## 仍待单独修复

- 桌面宿主下 Node 候选选择、继承环境及准备子进程退出诊断；`EPIPE` 本身不能确定全部退出原因。
- 将局部 Map 的 `memory.set()` 误判为宿主记忆操作的检查器误报。
- 官方原版宿主缺少安装事务扩展的限制仍成立。已有部署文件中的热补丁，需要新进程加载后才可验证；直接重试同一进程中的已缓存 ESM 模块不会重载修改。

升级以正式源码和生成产物为准，禁止把当前磁盘哈希直接覆盖历史补丁基线来消除漂移。
