# fish-body（鱼的身体）

> DeepSeek Harness（DSH）上的「身体层」插件：把**流程入口、目录查看、开关状态**收在一处，并让 L0 工具按开关动态上下线。
>
> The "body" layer of a DSH agent framework: one place for the workflow entry, directory browsing and the on/off switch, and a switch-driven mount for L0 tools.

---

## 这是什么

`fish-body` 是一个 DSH 宿主侧插件，给 agent 框架补上**「身体」这一层的可见与可控性**：

- 在一个设置页里告诉人「饭（来源仓）→ 胃（审查/暂存）→ 手（安装/审批）」这条流程当前是否可用；
- 提供只读的目录元数据与「打开文件夹」动作，让人不用记路径；
- 挂一个 **SHA-256 工具**（`utility_sha256`）给 agent 用，但**只在身体开启时才挂载**，关闭即下线。

它**不是**插件市场，也不替 agent 做安装决定——安装与审批由「鱼的手（fish-hand）」那套负责，`fish-body` 只提供入口与开关投影。

## 功能与作用

| 功能 | 说明 |
|---|---|
| **设置页分区** | 通过 `connection.fetch` 注册 `GET /api/fish-body/sections`、`GET /api/fish-body/state`、`POST /api/fish-body/open`；前端 `client.js` 渲染成设置页里的分区卡片 |
| **身体总开关（phase）** | 开关状态的唯一事实来源是 profile 的 `dsh.profile.bundles` 里是否包含 `fish-body`（以及 patch 里该行是否 `disabled: true`）。`on / closing / off` 三态，读不到就按 **on** 处理（绝不误关） |
| **流程停启** | `off` 时：不再启动「饭→胃→手」流程，前端显示「已关闭，等待原生重载」；`on` 时恢复 |
| **内置 SHA-256 工具** | 通过 `ctx.inject(['tools'], …)` 动态挂载 `utility_sha256`，由 fish-hand 运行门（`internal/runtime-gate.js`）校验插件注册表后激活；失败被隔离在 effect 内，**不影响分区接口** |
| **打开文件夹** | `POST /api/fish-body/open` 只接受白名单里的分区 id，固定参数调 `explorer.exe`，不拼 shell、不接受外部路径 |
| **客户端 UI** | `client.js` 注入 DSH 设置页（`@deepseek-ai/dsh-client-ui-settings`），显示三态与分区入口 |

## 安装

### 方式一：从 GitHub 直接装（推荐）

```bash
dsh plugin --profile <你的 profile> add github:2233heorbrin/fish-body
```

### 方式二：插件市场

在 DSH 的插件市场里搜索 `fish-body`，或粘贴仓库地址安装。

### 方式三：本地开发

```bash
git clone https://github.com/2233heorbrin/fish-body.git
dsh plugin --profile <你的 profile> add file:<绝对路径>/fish-body
```

安装后在 **设置 → 插件** 里能看到「鱼的身体」，打开开关即可。

## 可选依赖

`internal/runtime-gate.js` 与 `internal/utility-sha256.js` 是给「鱼的手」运行门用的适配层：

- 如果 profile 里还装了 `fish-hand-runtime-gate` + `fish-hand-utility-sha256`，`utility_sha256` 会被正常挂载；
- 如果没装，**分区与开关照常工作**，只是 `utility_sha256` 不出现（失败被隔离，不影响其他功能）。

## 关闭方式

- 在插件页关掉开关，或从 profile 的 `dsh.profile.bundles` 里移除 `fish-body`；
- 关闭后「饭→胃→手」流程与本设置页停用，**已安装的其他插件不受影响**；
- 模型不能自行开启，必须由用户在插件页手动开启。

## 目录结构

```
fish-body/
├── index.js                 宿主侧：分区路由 / 开关状态 / 工具挂载
├── client.js                客户端：设置页 UI
├── cordis.patch.yml         bundle 补丁：把本插件插入 profile 的层叠
├── internal/
│   ├── runtime-gate.js      调 fish-hand 运行门做插件校验（可选）
│   └── utility-sha256.js    L0 工具包装
├── locale/{en,zh}.json      文案
└── icon.svg
```

## 设计约定

- **开关只认配置，不做隐式状态**：phase 由 profile 的 bundles/patch 推导，不写额外状态文件。
- **失败隔离**：工具挂载失败只记录错误码，绝不拖垮分区接口。
- **不碰凭据**：本插件不读、不存任何 token/密钥。
- **打开路径白名单**：只认固定分区 id，拒绝路径穿越。

## 许可

MIT © 2026 酥软大肥鱼（2233heorbrin）
