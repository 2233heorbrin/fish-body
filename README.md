# fish-body（鱼的身体）

## 饭·来源读取修正（0.0.7-dev.8，分支测试版）

> dev.8 修正饭·来源页「仓库插件显示无远端来源、插件市场却显示」：`rice-model.mjs` 按真实落盘布局（仓库内 / 父层 `来源.json` / `versions/<commit>/来源.json`）读取来源元数据，核实 `localRepositoryPath` 指向本仓库后才采用，名称 / `hasRemote` / 版本检查共用同一份元数据；本地材料不再被 `hint` 误标为 github。真正无来源仍 `unavailable`、不可比版本仍 `unknown`，不谎报最新。真实饭目录 GitHub 材料 `hasRemote` 由 1 提升至 17。五页 UI 与启停/状态透传沿用 dev.7。

## 鱼身体 UI 五页（0.0.7-dev.7，分支测试版）

> dev.7 在 dev.6 基础上修正设置页「目录失效」误报：宿主依赖错误（`dependencies.error`，如 `FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE`）不再混入目录问题判定；宿主依赖状态仍沿「程序准备」独立显示。五页 UI 与状态透传沿用 dev.6。

设置页「鱼的身体」提供顶部五导航（来自 `GET /api/fish-body/sections`）：总览读 overview 且单区失败单区显示；饭·来源列来源并手动检查远端版本（版本结论由后端给出、历史与失败不冒充当前结论）；胃·分析保留原任务流程且刷新只读不重扫；手·组件读 `GET /api/fish-body/plugin-switch/state`，把已登记 / 已安装 / 原生启用选择 / 实际运行反馈分开，满足条件的来源插件由用户手动启停（复用原生接口、连续点击防重复、失败给中文原因并重读状态、接口缺口如实显示证据）；设置与帮助整理目录绑定与诊断摘要（复制失败明确提示）。所有按钮只作用于当前页与当前对象，不批量、不自动安装、不写日常 Profile。

该 UI 的实现证据来自独立开发场景夹具（结果目录 `dev-scene/`）与 Edge 实渲截图；真实宿主桥接是否可用在本次分支开发中标为 unknown，交后续独立真机验收。未推送、未日常安装、未切日常插件、未重启日常 DSH、未合并 / 打 tag / Release / registry。

## 胃任务（0.0.7-dev.5，分支测试版）

本分支增加能力选择与两种产出；测试安装来源为 `github:2233heorbrin/fish-body#feat/stomach-split-tasks`，
这些任务入口不属于此前正式标签 v0.0.6。dev.2 增加中文结果分组、具名选择和可读方案；
dev.3 补齐有界源码查询、直接观察/全插件背景范围和讨论核证引导；dev.4 补强入口条件与功能归属证据（动作字面量、比较极性、多候选、早退截断、主体重赋值与归属路径），依赖不变；
dev.5 合并通用解释口径（调用≠效果、删除影响查读取者、条件极性结合早退、路径≠开关、源码静态≠运行证明）并守 16000B 实际响应预算；
已有真实 DSH 工具调用与材料产出证据，本次补修的真实模型中文解释及用户验收仍待完成；
本地专项与隔离浏览器验证不代替用户裁定或日常验收。版本变化可使旧分析见证失效，保留旧结果并明确选择新分析，不改写旧见证。
设置页的胃分区与现有 `fish_hand` 共用任务服务、Profile、身体绑定和关闭/closing 门禁。
先显式 initial / deep 或选择已有有效 analysisId，再创建任务：

```json
{"action":"task","taskOperation":"create","analysisId":"<valid-analysis-id>","taskMode":"compatibility"}
{"action":"task","taskOperation":"read","taskId":"<returned-task-id>","taskView":"capabilities","taskOptions":{"limit":5}}
{"action":"task","taskOperation":"update","taskId":"<task-id>","expectedRevision":1,"taskPatch":{"selected":["<capability-id>"]}}
```

模式为任务内的互斥选择，不是插件开关。`compatibility` 产出保留/排除能力、六类依赖决定、
接线提议、语义变化、附带行为接受情况和后续验收的方案；后续目标是一份保留原名、一个原生
开关的统一派生产物，本轮不改写候选、不打包或安装。`reverse` 产出组件说明、来源身份、
带原文件/行号/证据的源码片段、依赖上下文和独立化待办；引用既有快照，不复制整个插件，
不生成可运行的新插件。共享文件未证明相关的部分明确作为待判断上下文。

`taskOperation` 支持 list/create/read/update/produce/confirm/output。
list 的 taskView=analyses 列当前 Profile 的分析元数据（使用时再次校验），默认列任务；
分析元数据包含 kind 和明确的 initialAnalysisId，页面将任务结果与深查初扫来源分开；
未识别初扫关联时要求明确选择，不把 deep 结果当 initial，也不自动扫描。
read 的 taskView=overview/capabilities/dependencies/unknowns。列表和产出读取都使用
`taskOptions.offset/limit` 与返回的 nextOffset，默认5项、最多20项，保留诊断和坐标。
produce/confirm/update 必须提供当前 expectedRevision；output 可指定 outputRevision 读取
明确标记的历史产出，仍校验其分析来源。不会自动重跑分析。

整体分类的程序候选与判断分开保存；无命中保持 unknown，状态访问不自动等于脑记忆。
能力补充、分类判断、依赖决定和确认需显式 origin={kind:user|current-model,actor,reason}，
这是调用方归属声明，不是身份认证。addCapabilities 中提供 name/category/evidenceRefs；
classification 中提供 value/evidenceRefs；dependencyDecisions 中提供 id/decision/rationale/
origin/evidenceRefs，可补 proposedChange 和 businessSemanticChange=yes|no|unknown。
保留、收窄、排除或待判断均须具体理由；附带行为须独立、明确的用户归属接受，不随能力选择
自动接受。unknowns 是带来源的补充问题，既有分析限制另行保留。
同一分析和依赖的有效补充证据随决定保留；显式替换或清空引用仍可生效，更换分析则重置。

依赖的 `scope.direct` 是所选声明内语法观察，`scope.background` 是全插件背景，均不证明业务必需。
相关观察优先；数量、示例截断与实际决定引用分别记录，旧任务读取时补范围说明而不迁移文件。
state-access 不自动等于记忆或独立服务；附带行为规则仅覆盖部分 prompt/route 线索，不穷举副作用。
模型应区分当前接线、工具控制、拟人限制/奖励和返回状态，再讨论保留或替换及必要适配。

模式、能力、内容或判断变化推进版本并清除原确认；旧产出保留。切换 analysisId 需新结果有效，
并清空旧选择/判断；源码、Profile、绑定或实现见证失配拒绝旧结论。模型确认只记为模型意见，
仍待用户确认；用户确认也不授权适配或部署。所有脑区行为限定插件作用域，不写鱼脑全局数据。

页面按插件显示名、初步/深入分析及时间选择结果，按插件、模式、时间和状态继续任务，
无需手工填写内部编号。默认展示目标、保留/排除功能、模型建议、使用影响和下一步；
编号、源码路径、证据、诊断和原始产出放入技术详情，按需分页读取。
没有适用说明时显示“待当前 DSH 对话解释方案”，不伪造推荐。

当前对话模型先核对必要证据，再解释功能并推荐取舍，只询问真正影响需求或行为的选择。
`taskPatch.explanation` 可记录 `origin:{kind:"current-model",actor,reason}`、goal、
recommendation、retained/excluded（capabilityId、可选 label、reason、evidenceRefs）、
impacts（dependencyId、text、evidenceRefs）、questions（text、可选能力/依赖引用、evidenceRefs）、
nextSteps 和 evidenceRefs。说明名是模型表述，不是程序自动发现的中文功能名。
引用须属于当前分析，功能取舍须符合当前选择。说明绑定 analysisId 和当前方案 revision；
模式、能力或相关判断变化后不再作为当前推荐显示。仅更新说明是对同一方案版本的注解，
不推进方案 revision、不更改选择/决定/确认，也不重写已有产出；null 可清除说明。
旧任务没有此字段仍可读取。模型归属为调用方声明，不代替用户真实接受。

页面不会自动请求模型；“复制到当前 DSH 对话”仅复制定位和讨论提示，不发送消息或源码。
通过 task read/update/produce/output 讨论材料和记录选择。
新任务写入身体绑定根的 `鱼的胃/任务/<插件显示名>-拆分任务/<taskId>`，只存方案和材料；
同一任务切换模式不变目录，旧的 `任务/<taskId>` 继续可列举、读写和引用，不迁移旧数据。
程序及未来派生运行产物仍归鱼的手维护。当前没有执行适配/安装按钮，不改变原审批策略。

## 源码分析与按需取证（0.0.6）

本版新增 `fish_hand` 的 `analyze` / `query` 动作；submit/review/approve/reject/status
和安装决定沿用原有语义。正式来源为 `github:2233heorbrin/fish-body#v0.0.6`，
交给 DSH 原生插件管理安装。运行实现及依赖与已验收测试版 `0.0.6-dev.1`
（提交 `33e8a793dd5eee6c3c60f23a36977d3f5c21b382`）一致，仅整理版本和发布说明。
该测试版已通过真实 DSH 对话的工具可见性、初扫、关联深查、分页查询和有效复用验收；
深查保留 7 项关系不完整。此处复用测试版证据，不声称正式版已重新调用模型。
仅用户明确请求分析时启动独立 Node 子进程，不执行候选入口、可执行配置、构建、
安装脚本或模型请求。启用身体、status、query 均不启动深查；身体关闭或 closing
时拒绝新动作，已接纳操作按现有在途机制收尾。

对话工具参数示例（`path` 由用户明确指定源码目录的绝对路径）：

```json
{"action":"analyze","analysisType":"initial","analysisSource":{"kind":"local","path":"<absolute-source-directory>"}}
```

返回 `analysisId` 后按需读取，而非把完整分析 JSON 注入对话：

```json
{"action":"query","analysisId":"<returned-id>","queryType":"summary","queryOptions":{"limit":5}}
{"action":"query","analysisId":"<returned-id>","queryType":"file","queryOptions":{"file":"index.js","line":10}}
{"action":"query","analysisId":"<returned-id>","queryType":"file","queryOptions":{"view":"source","file":"index.js","line":10,"offset":0,"limit":5}}
{"action":"query","analysisId":"<returned-id>","queryType":"evidence","queryOptions":{"id":"initial/E0001","limit":3}}
{"action":"query","analysisId":"<returned-id>","queryType":"capability","queryOptions":{"name":"<candidate-name>"}}
{"action":"query","analysisId":"<returned-id>","queryType":"phase","queryOptions":{"function":"apply","stage":"用户指定的注册阶段问题"}}
```

file 省略 view 时仍查询已有记录；显式 `view:"source"` 才读取当前有效分析清单内的已验证 UTF-8
快照行段。行号从1起，offset 是该行内从0起的 Unicode 码点偏移；每页最多20段、每段600码点，
受响应预算限制。使用返回的 `page.nextLine` **和** `page.nextOffset` 续读，包括超长单行。
返回实际行/列、行尾和截断状态，不生成证据 ID；analysisId、run 和文件坐标标识上下文归属。
摘要明确区分已存片段截断与摘要截断，descriptionOrigin 标识作者声明，不能据此证明入口支持。
结论涉及动作范围时，应核对配置、筛选和早退；冲突或缺少条件须明确，initial 不证明完整行为。
源码视图不启动扫描器，不读取范围外文件或执行源码；实现见证变化仍会使旧结果失效，不能修补旧见证。

`evidence` 使用返回的完整命名空间 ID；`file` 是源码相对文件名，不能用它读取任意
结果文件。默认 5 项、最多 20 项、整个工具返回最多 16000 字节；用 `nextOffset`
继续。保留原始文件、坐标单位和 JSON pointer，以及 revision/conflict/supplement
关系。事实、语法候选、解释、unknown、any、多来源、条件和截断分别可见。

显式深查：同样的 `analysisSource`，使用 `analysisType:"deep"`；可加
`initialAnalysisId:"<initial-id>"` 合并同内容的初扫证据与修订关系。
这是整批 JS/TS 源码深查，不是按函数增量。初扫结果本身不能冒充深查。
同类型请求可传原 `analysisId` 复用；跨类型、缺失/未知类型、源码、有效规则、
配置或分析器版本改变会拒绝，不覆盖旧结果或自动重跑。

已有请求可选择 `analysisSource:{"kind":"request","requestId":"<existing-id>"}`：
只读当前 Profile 请求所指的饭中固定材料，不制造新安装意图。提交和内容身份来自
既有采集记录，分析层不重新联网证明该提交；进入分析前会按原采集清单校验完整
文件集合、逐文件内容及登记摘要（含分析器忽略的文件），再核对实际分析快照。
材料或清单失配时明确拒绝，不重新采集、不改写登记或自动改走 local；复用、查询
和关联初扫也沿用此检查。local 仍分析明确选择的当前目录，不要求采集清单。
新结果写入身体绑定根的 `鱼的胃/分析/<插件显示名>-分析结果/<analysisId>`；
显示名优先使用插件清单已有名称，否则保留实际包名；Windows 必要字符处理只影响外层分组。
同名插件和重复分析以内部唯一编号区分，不覆盖。新旧目录由同一定位实现读取；
旧的 `分析/<analysisId>` 保持原位可用，不修改见证或为目录重扫。记录完整 Profile 所属身份，
跨 Profile 拒绝读取。切换绑定不迁移旧结果。失效结果不能继续作为有效证据引用。

固定依赖为 dependency-cruiser 18.8.0、ast-grep CLI 0.51.3、ts-morph 28.0.0。
当前 native launcher 验证范围为 Windows x64；使用官方 ast-grep 可选平台包的
直接二进制路径，安装可禁用生命周期脚本，无需全局分析器。初扫依赖的 Node 支持范围
为 22、24 或 >=26；身体原有 Node 最低要求不变，其他 Node 版本不声称分析可用。
系统 Node 与 DSH 内嵌 Node 的专项验证和测试版真实 DSH 对话验收分别记录；
真实对话已验证工具可调用并提供分析材料，不代表静态分析已证明可安全拆分。
原有 manager v2、来源保留、releaseExact、市场兼容扩展仍按下文独立维护。

支持边界：JS/TS 模块图、结构观察及有限语法追踪；初扫另有 Python/Rust/C/C++
结构规则。其他语言、打包代码、二进制可以清点，但不保证依赖分析、反编译或提取。
模块闭包不是能力的最小依赖；局部同名修订不是“无脑区行为”；无命中不是行为不存在。
阶段来自人工问题；静态关系不能证明可达性、取消、卸载或资源释放。解析失败及追踪
不完整保留 diagnostic-partial；有界追踪、any 和动态关系仍有已知限制，
不输出“拆分成功”或“安全可安装”。目前没有模式选择入口、兼容拆分或逆向拆分执行流程，
也没有组件改写、候选安装或运行验证；它只是分析材料入口。

维护入口为 `internal/analysis/`；实验命令仅封装正式模块，不在正式包内。
独立安装包专项见 `test/analysis-tools.test.mjs`，需设
`FISH_TEST_INSTALL_ROOT` 与全新 `FISH_ANALYSIS_TEST_ROOT`；不指向日常 Profile。

> 0.0.5 提供安装来源保留修复。身体与鱼脑各自启停，不要求另一方存在、开启或先完成初始化。同宿主退出仍影响双方，不提供进程隔离。显式继续入口依赖单独维护的实验宿主扩展 v2，不随身体包安装。

一个 DSH bundle，包含饭（固定上游材料）→胃（审查、依赖准备、构建）→手（受管包、决定、部署和恢复）的现有完整后端、设置页及内置 SHA-256。无需另找未发布的 fish-hand 后端。

**官方原版仍无安装事务扩展。** 根入口识别宿主明确导出的 `installTransactionExtensionVersion=1|2`；本版本的待决定／原包／原生继续流程要求 v2。官方 rc.5 继续显示 `FISH_NATIVE_INSTALL_INTERCEPT_UNAVAILABLE`。扩展宿主按已选择 bundle 的 `dsh.installTransaction` 元数据调用后端，最终仍由原生执行器安装，保留兼容性、脚本策略、失败和恢复语义。插件不会自行修改宿主。

## 安装入口与运行要求

需要 Node `>=22.14`。已验证 Windows、DSH `0.2.1-rc.5` 及指定扩展环境的生命周期、后端挂载与资源释放；完整安装接管的证据属于扩展环境，不外推为官方原版兼容。其他宿主版本、macOS 和 Linux 未验证。

当前正式版本为 `0.0.6`，通过 GitHub main 与 annotated tag `v0.0.6` 交付；旧版本标签保持不动。固定版本安装来源为：

```text
github:2233heorbrin/fish-body#v0.0.6
```

将所选来源交给 DSH 原生插件管理。开发者也可在仓库根执行 `npm pack --ignore-scripts`，把对应版本 tgz 作为 `file:<绝对 tgz 路径>` 使用。启停以原生插件选择为准，不增加第二个总开关。完整安装接管需要指定 rc.5 实验宿主扩展，该扩展不随身体包静默安装；“换用线上版本”另需市场可选接口支持。

公开候选已在指定扩展环境验证 GitHub 首次安装、旧版更新和原生加载，来源保留修复分支随后完成日常原生安装及真实更新 API 检查。用户确认该候选的脑 UI、身体设置页和目录按钮正常；独立启停复用此前验证。正式版仅整理版本与交付说明，运行实现与已验收候选一致。原生更新 API 已验证，桌面更新按钮尚未点击，不能由 API 成功推定桌面交互通过；未创建 GitHub Release，未发布 npm/其他 registry。

### 扩展交付限制

两阶段决定需要 manager v2（`installTransactionExtensionVersion=2`、原生 `install-decision` 入口和对应结果/恢复契约）；鱼脑另需 `agentLoop.releaseExact`。市场 client-only 资源占位的唯一挂载修复也是独立兼容补丁，不属于身体包，也不保证任意市场版本都需要同一补丁。

本版本的原包来源保留还要求匹配宿主导出 `fixedPackageSourcesVersion=1`，并支持 pnpm 12 的原生 resolver。普通原包安装、明确 `original` 续接和 repair 采用同一规则：manifest 与 lock 的 GitHub specifier 保留用户所选分支或标签，解析身份绑定本次已审提交，归档地址和完整性记录本次实际原包。缺少扩展时明确拒绝丢失来源的远端部署，不以插件名称免检，也不修改官方宿主。

临时 resolver 由宿主在原生安装锁内接入并撤下，保留原有 pnpm hooks、脚本授权和供应链检查；manifest/lock 由 pnpm 生成，不在 `file:` 安装后手改。实际发布文件逐字节核对，依赖按包声明由 pnpm 解析，正常生成文件不混作原包；不要求不同压缩渠道的 tgz 天然相同。原包仍可能被锁文件引用，不能当临时缓存删除。显式续接不重新读取已变化的分支；后续明确更新才重新采集分析。固定标签保持固定，不自动改成追踪未来版本的渠道。

这些扩展目前没有公开可下载的配套补丁发行物。本仓库不会静默安装它们，完整流程只支持环境维护者已经按实际宿主基线部署并核验的指定 rc.5 环境。其他用户应先向环境维护者取得独立维护、带来源/许可证/应用和恢复说明的匹配扩展；缺少这些材料时不能按官方原版全功能即装即用操作。这里不提供虚构下载地址或作者机器路径作为安装步骤。

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

### 安装分析与明确继续（实验宿主 v2）

身体开启且可用时，脑、UI 和其他候选都经过既有采集与静态分析，不要求鱼脑先启动。不预设所有候选为工具；事实、候选判断、未知项和具体操作位置分别返回。缺少线索不证明运行安全，也不会把全部未知风险自动记为已接受。范围匹配的普通工具安装意图及同内容、同 Profile 的有效既有批准继续复用；新增具体人格／记忆操作或无法判定的形态会返回待决定，不静默安装。

待决定返回 `DSH_INSTALL_DECISION_REQUIRED`、决定引用、目标编号及证据，exit=2；当前调用结束，Profile 安装锁释放。用户与模型讨论后，可以从同一个原生 CLI 明确继续（命令中的占位符取自本次结果）：

```text
dsh plugin --profile <p> install-decision <决定引用> status
dsh plugin --profile <p> install-decision <决定引用> original <目标编号>
dsh plugin --profile <p> install-decision <决定引用> native <目标编号>
dsh plugin --profile <p> install-decision <决定引用> reject <目标编号>
dsh plugin --profile <p> install-decision <决定引用> cancel <目标编号>
```

审查失败、超时或结论不明且原包已成功固定时，用户可以明确选择本次原包；这不等于分析通过，也不是自动放行。下载、身份、归档或完整性错误不能借此绕过。

`original` 用于已经采集并固定的原包：npm 使用原发布归档；Git 使用选定提交／子目录的 `npm pack --ignore-scripts` 文件，不构建、不拆分或改写源码。继续只消费这份保存内容，不重新解析可变分支。`native` 仅用于胃未初始化、根失效或导入／启动不可用且尚无固定原包的本次操作；该入口在宿主层，不依赖身体工具或页面能否加载，也不要求先初始化数据。没有分析通过的记录，不伪造受管批准。

每个目标单独决定；repair 在所有待决定目标明确选择前不部署，多包操作返回此前实际完成结果及后续待决定引用。重复安装、`--yes`、超时或模型判断都不是选择。拒绝／取消不部署本次目标。下载、包身份、归档或完整性失败继续失败，不提供这种放行。原包安装不授权脑区合并、人格记忆覆盖，也不保证未知插件运行时不会产生这些行为；按实际发现及已有授权判断。

决定与 Profile、目标、操作及固定文件对应；依赖变化须重新分析，文件变化拒绝继续。等待期间身体可关闭、切根；继续不持有旧实例或写旧根，原生启停选择和脚本策略保留。不提供永久自动绕过授权。决定文件及其原包保存在 Profile 的 `.plugin-manager/install-decisions`，已安装依赖仍可能引用原包，不能随意删除。

这是 CLI／manager 参数入口，不表示桌面新增按钮已经实现或验收。`fish_hand` 的 review／approve 仍用于独立材料审查及明确范围的正式受管批准；返回材料不等于用户已决定，也不用伪造全部残留风险接受来选择原包。

关闭身体插件时，本 Profile 已接纳的身体操作先收尾，期间拒绝新流程；实际 Cordis 卸载释放路由、fish_hand 及 utility_sha256，另一个 Profile 和独立工具保持可用。已有文件和记录保留，不主动开关独立插件。

扩展宿主仅在身体 bundle 已选择时调用事务入口；关闭后原生安装不读取身体注册表、不产生身体审计。普通启用、停用不经过安装事务。既有独立插件不随身体卸载。官方原版和扩展版的验收必须分别报告。

普通 Node 与实际 DSH.exe 的 Node 模式已完成真实 CLI 故障、解除故障后的安装和 Loader 验证；默认 pnpm 在保留实际 perf/compat imports、worker-events require 的隔离宿主中也完成安装及 Loader 验证。日常指定扩展环境的原生安装与重载、独立开关已验证，页面及目录按钮由用户确认；完整第三方市场安装链和插件页自动发现更新不因此视为通过。历史 EPIPE 的精确触发路径仍为 unknown。实现归属与验收范围见 [PATCHES.md](PATCHES.md)。

## 开发验证

将发行物独立安装在临时目录，设置 `FISH_TEST_INSTALL_ROOT`；官方原生测试另设 `FISH_DSH_TEST_ANCHOR` 为临时官方宿主 package.json。

```sh
node --test test/distribution.test.mjs test/backend-*.test.mjs test/official-native.test.mjs
```

包含真实本地产包、依赖生命周期、源码身份、Git/归档替身、本地离线 pnpm 安装与部署校验、多 Profile 状态隔离及原生卸载。测试中的网络替身不是 GitHub 在线验收；路由与文件夹打开的自动化测试使用最小连接/桌面 opener 接缝。实际远端安装及用户页面/目录操作证据单独记录，不能由自动化接缝推定；完整第三方市场安装链仍未验收。

历史 W6-A 本机隔离辅助函数 `internal/backend/lib/w6-runner.mjs` 的 `makeRunPnpm()` / `runnerFact()` 保留旧验收机器的宿主定位，仅供对应历史本机测试，不是跨机器安装入口；正式插件安装链不调用这两个函数。不能据此宣称这些旧辅助入口可在其他机器通用运行。当前安装产物回归按 [test/README.md](test/README.md) 使用明确的隔离根和可配置工具路径。

MIT，第三方来源与许可见 THIRD-PARTY-NOTICES.md。

## 受管产物保留

身体停用、卸载或切根不删除旧手目录中的受管 tgz、登记和数据。已安装的独立插件保持自己的生命周期；原生离线修复或重装仍可能需要 manifest 中 file: 指向的原 tgz，不能把这些文件当作可随意清理的缓存。
