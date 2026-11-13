# fish-body（鱼的身体）

> DeepSeek Harness（DSH）上的「身体层」插件：把**流程入口、目录查看、开关状态**收在一处，并让内置工具按开关上下线。
>
> The "body" layer of a DSH agent framework: one place for the workflow entry, directory browsing and the on/off switch, plus a switch-driven tool mount.

---

## 这是什么

`fish-body` 是一个 DSH 宿主侧插件，给 agent 框架补上**「身体」这一层的可见与可控性**：

- 在设置页里告诉人「饭（来源仓）→ 胃（审查暂存）→ 手（安装审批）」这条流程当前是否可用；
- 提供只读的分区元数据与「打开文件夹」动作，让人不用记路径；
- 挂一个 **SHA-256 工具**（`utility_sha256`）给 agent 用，但**只在身体开启时挂载**，关闭即下线。

它**不是**插件市场，也不替 agent 做安装决定——安装与审批由「鱼的手（fish-hand）」负责，`fish-body` 只提供入口与开关投影。

## 功能

| 功能 | 说明 |
|---|---|
| **设置页分区** | 注册 `GET /api/fish-body/sections`、`GET /api/fish-body/state`、`POST /api/fish-body/open`；`client.js` 渲染成设置页卡片 |
| **身体总开关（phase）** | 开关的唯一事实来源是 profile 的 `dsh.profile.bundles` 是否包含 `fish-body`（以及 patch 行是否 `disabled: true`）；三态 `on / closing / off`，读不到按 **on** 处理（绝不误关） |
| **流程停启** | `off` 时不再启动「饭→胃→手」流程，页面显示「已关闭，等待原生重载」 |
| **内置 SHA-256 工具** | 通过 `ctx.inject(['tools'], …)` 动态挂载；运行门校验失败被隔离在 effect 内，**不影响分区接口** |
| **打开文件夹** | 只接受白名单里的分区 id，固定参数调 `explorer.exe`，不拼 shell、不接受外部路径 |

## 安装

```bash
# 方式一：从 GitHub 直接装
dsh plugin --profile <profile> add github:2233heorbrin/fish-body

# 方式二：克隆后本地装
git clone https://github.com/2233heorbrin/fish-body.git
dsh plugin --profile <profile> add file:<克隆路径>/fish-body
```

装好后在 **设置 → 插件** 里能看到「鱼的身体」，打开开关即可。

## 配置（不用改源代码）

```yaml
# profile 的 cordis.patch.yml 里，fish-body 这一行
- id: fish-body
  name: fish-body
  config:
    fishRoot: "D:/你的工作区"          # 可选；默认取环境变量 FISH_HAND_FRAMEWORK_ROOT，再退回作者路径
    profileDir: "…/profiles/<name>"    # 可选；默认取 profileContext
    sections:                           # 可选；按分区覆盖
      rice:    { title: "我的饭仓",   path: "E:/my-farm/rice" }
      hand:    { path: "E:/my-farm/hand" }
      stomach: { path: "E:/my-farm/stomach" }
```

- `fishRoot` 会把默认的 `饭 / 鱼的手 / 鱼的胃` 三个路径整体换根；
- `sections.<id>.path` 可以只改某一个分区；
- 三者都不给时，仍用仓库里的默认值（作者本机路径），因此**别的机器上手必须设置 `fishRoot` 或 `sections`**。

## 依赖

| 依赖 | 关系 | 缺失后果 |
|---|---|---|
| `@deepseek-ai/fish-hand-admission-gate`（鱼手准入包，提供 `lib/body-switch.mjs`） | **可选**（`peerDependenciesMeta.optional`） | 已做保护：解析失败时身体照常加载，**分区与页面可用**，只是没有 `phase` 投影（`/api/fish-body/state` 不注册） |
| `fish-hand-runtime-gate` + `fish-hand-utility-sha256` | **可选** | 内置 `utility_sha256` 不挂载；分区与开关不受影响 |

> 说明：本仓库**不包含**「饭→胃→手」流程的完整实现（下载、审查、审批、安装）。那部分属于鱼手（fish-hand）的准入链路，本仓库只发布身体侧的入口与开关投影。

## 已知限制

1. **「饭→胃→手」流程需要鱼手**：只装 `fish-body` 只能看到入口与开关；真正执行安装/审批的是鱼手，未安装时该流程不可用（不会报错，只是状态为不可用）。
2. **默认路径是作者本机路径**：`index.js` 里的 `SECTIONS` 默认值指向作者的 `D:/deepseek框架`。请在 profile 配置里设置 `fishRoot` 或 `sections`（见上）。
3. **关闭身体的边界**：关闭后撤下的是**本插件提供的流程入口、设置页与内置工具**；已在 profile 里安装的独立插件（如 `dsh-context`）**不受影响**，普通插件安装继续走 DSH 原生机制。
4. **模型不能自行开启身体**：开关必须由用户在插件页操作。

## 目录结构

```
fish-body/
├── index.js                 宿主侧：分区路由 / 开关状态 / 工具挂载（config 驱动）
├── client.js                客户端：设置页 UI
├── cordis.patch.yml         bundle 补丁：把本插件插入 profile 的层叠
├── internal/
│   ├── runtime-gate.js      调运行门做插件校验（可选，缺失即降级）
│   └── utility-sha256.js    L0 工具包装
├── locale/{en,zh}.json      文案
└── icon.svg
```

## 设计约定

- 开关只认配置，不写额外状态文件；
- 工具挂载失败只记录错误码，绝不拖垮分区接口；
- 不碰凭据：不读、不存任何 token/密钥；
- 打开路径白名单：只认固定分区 id，拒绝路径穿越。

## 许可

MIT © 2026 酥软大肥鱼（2233heorbrin）
