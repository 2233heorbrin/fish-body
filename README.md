# fish-body（鱼的身体）

> 当前任务分支实现运行与数据绑定解耦，尚未发布或部署。整个鱼脑仍为一个插件；双方不要求另一方存在、开启或先完成初始化。同宿主退出仍影响双方，不提供进程隔离。胃分析及显式原包选择机制属于后续工作块，本分支不宣称已经实现。

一个 DSH bundle，包含饭（固定上游材料）→胃（审查、依赖准备、构建）→手（受管包、决定、部署和恢复）的现有完整后端、设置页及内置 SHA-256。无需另找未发布的 fish-hand 后端。

**官方原版仍无安装事务扩展；配套扩展为隔离验证原型。** 根入口检测宿主明确导出的 `installTransactionExtensionVersion=1`，官方 rc.5 继续显示 `FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE`。扩展宿主按已选择 bundle 的 `dsh.installTransaction` 元数据调用现有后端，然后由原生执行器安装同一受管 tgz，保留兼容性、失败和恢复语义。插件不会自行修改宿主。

## 安装入口与运行要求

需要 DSH 和 Node `>=22.14`。已验证官方 `0.2.1-rc.5` 的插件生命周期、后端挂载与资源释放；完整安装接管已在同版本的指定实验扩展宿主中隔离验证，不外推为官方原版兼容。

当前版本为 `0.0.3`，通过 [GitHub 仓库 2233heorbrin/fish-body](https://github.com/2233heorbrin/fish-body) 的 main 与 annotated tag `v0.0.3` 交付源码。固定版本安装来源为：

```text
github:2233heorbrin/fish-body#v0.0.3
```

将该来源交给 DSH 原生插件管理。开发者也可在仓库根执行 `npm pack --ignore-scripts`，把生成的 `fish-body-0.0.3.tgz` 作为 `file:<绝对 tgz 路径>` 使用。启停以原生插件选择为准，不增加第二个总开关。完整安装接管需要上述指定 rc.5 实验宿主扩展，该扩展不随身体包静默安装；“换用线上版本”另需市场可选接口支持。

**源码版本交付不等于远端安装或更新已验收。** 0.0.3 的 GitHub 首次安装、从旧版更新及插件页发现更新仍待隔离验证；本版本未创建 GitHub Release、未发布 npm/其他 registry，也未升级日常环境。

## 首次初始化与数据

每个 DSH Profile 分别保存 `fish-brain-data.json` 和 `fish-body-data.json`。本包只维护 `<Profile>/fish-body-data.json`，结构沿用：

```json
{"schema":"fish-profile-data/v1","root":"<绝对数据根目录>","components":["body"],"origin":"conversation-workspace"}
```

- 有效独立绑定优先。独立文件存在但无效或根失效时明确报错，不回退到共享文件或另一方位置；可以在本包数据设置中明确重新选择。
- 首次升级才读取旧 `fish-data.json` 和本包明确旧配置；所有来源指向同一根时登记原位置，只补本组件缺失结构，不覆盖正文、迁移或删除数据。来源冲突显示具体来源，等待用户选择，不猜测。身体还核对旧后端投影 `fish-body-state.json:frameworkRoot`，停机事务按宿主原生组合读取旧 fishRoot。
- 独立绑定建立后忽略旧共享文件及旧配置的后续修改；不改写另一方绑定或删除共享文件。另一方继续使用旧版不会带动本包切根。
- 真正新装时只使用明确寻址的对话工作区；不用 cwd、最近会话或安装目录推断位置。无工作区时显示待选择入口。
- 双方可明确选择相同或不同根。切换一方不改变另一方绑定或位置，不自动搬迁旧数据。保存新路径不表示运行实例已经换根；已挂载实例提示需要原生重载，身体旧事务拒绝继续向旧根工作。
- 降级到旧版不会自动读取独立绑定的新根。旧版仍可能使用旧共享文件或旧配置；降级前需核对位置，不能承诺自动反向同步。
- 数据页保留初始化、目录打开、手动切换、失败详情及重试；目录初始化与程序准备分别显示，host-blocked 不表示完整功能就绪。

## 后端与自动程序依赖

身体初始化 `<根>/饭`、`鱼的胃/{来源审查,脑组件,手组件}`、`鱼的手/{插件仓,插件注册表,运行数据,审计日志}`。身体独立绑定是数据根权威；`<Profile>/fish-body-state.json` 是后端运行路径投影，不要把它当成另一份需要手动维护的根配置。

完整后端在 `internal/backend/`，保留已实现的源码包身份、GitHub 子目录/固定 commit/归档回退、批准复用、依赖生命周期语义、产包、部署原有文件完整性、正常 .bin 生成入口及失败恢复。市场适配复用既有可选 `fish-body.market.v1` 接口，按 Profile 注册、随身体卸载撤销；没有该接口的市场不宣称已适配。

固定正常依赖：`yaml@2.8.1`、`pnpm@12.4.2`、`npm@11.6.2`、`tar@7.5.23`。npm 发布包采集与构建产物回解使用 Node 的 tar 库处理 UTF-8 文件名，不依赖 Git for Windows 的安装位置；Git 来源采集仍沿用既有外部工具。优先使用宿主 ProfileContext 提供的包管理命令，缺省使用包内声明的 pnpm；npm 生命周期执行器来自声明的 npm 依赖，不依赖作者机器的隐藏安装。Node 优先严格校验宿主显式提供的 DSH_NODE，无效即失败；未配置时才逐个验证当前进程和 PATH 候选。Electron 运行时须保留 ELECTRON_RUN_AS_NODE=1 等所需环境。自身无 install/build 脚本；候选插件确需执行的生命周期钩子仍按现有授权处理。

不需要安装鱼脑；身体不读取人格或记忆。普通工具安装意图、权限、新增执行范围和完整性沿用原流程；不是通过放宽准入来解决发行问题。

Windows 默认 pnpm 按配置 PATH/PATHEXT 选择同一安装，支持标准 npm 全局或 `node_modules/.bin` 布局的 pnpm shim，依据对应包声明执行 exe 或 JS bin。显式可执行文件、Node/DSH + pnpm JS、参数顺序和配置环境保持原选择；无效显式配置明确失败，不静默改用另一套安装。不解释任意 shim 内容，也不承诺所有 Corepack 或第三方脚本布局兼容。

## 原生开关和限制

关闭身体插件时，本 Profile 已接纳的身体操作先收尾，期间拒绝新流程；实际 Cordis 卸载释放路由、fish_hand 及 utility_sha256，另一个 Profile 和独立工具保持可用。已有文件和记录保留，不主动开关独立插件。

扩展宿主仅在身体 bundle 已选择时调用事务入口；关闭后原生安装不读取身体注册表、不产生身体审计。普通启用、停用不经过安装事务。既有独立插件不随身体卸载。官方原版和扩展版的验收必须分别报告。

普通 Node 与实际 DSH.exe 的 Node 模式已完成真实 CLI 故障、解除故障后的安装和 Loader 验证；默认 pnpm 在保留实际 perf/compat imports、worker-events require 的隔离宿主中也完成安装及 Loader 验证。桌面外壳完整环境交接仍未验证。历史生产 EPIPE 的精确触发路径仍为 unknown，生产尚未采用本次修复。实现归属与验收范围见 [PATCHES.md](PATCHES.md)。

## 开发验证

将发行物独立安装在临时目录，设置 `FISH_TEST_INSTALL_ROOT`；官方原生测试另设 `FISH_DSH_TEST_ANCHOR` 为临时官方宿主 package.json。

```sh
node --test test/distribution.test.mjs test/backend-*.test.mjs test/official-native.test.mjs
```

包含真实本地产包、依赖生命周期、源码身份、Git/归档替身、本地离线 pnpm 安装与部署校验、多 Profile 状态隔离及原生卸载。网络测试不是 GitHub 在线验收；路由与文件夹打开测试使用最小连接/桌面 opener 接缝，不是完整桌面点击验收。未在生产安装或重启，没有真实市场安装验收。

历史 W6-A 本机隔离辅助函数 `internal/backend/lib/w6-runner.mjs` 的 `makeRunPnpm()` / `runnerFact()` 保留旧验收机器的宿主定位，仅供对应历史本机测试，不是跨机器安装入口；正式插件安装链不调用这两个函数。不能据此宣称这些旧辅助入口可在其他机器通用运行。当前安装产物回归按 [test/README.md](test/README.md) 使用明确的隔离根和可配置工具路径。

MIT，第三方来源与许可见 THIRD-PARTY-NOTICES.md。

## 受管产物保留

身体停用、卸载或切根不删除旧手目录中的受管 tgz、登记和数据。已安装的独立插件保持自己的生命周期；原生离线修复或重装仍可能需要 manifest 中 file: 指向的原 tgz，不能把这些文件当作可随意清理的缓存。
