# UI 三态夹具（test/fixtures/ui-scenarios）

仅供 `test/ui-*.test.mjs` 与 B 的独立开发场景 harness 使用的**独立示例数据**。全部虚构示例，不接日常数据、不联网、不读写真实 Profile、不切换真实插件。

## 命名约定（主模型拍板）

文件名 `<name>.<state>.json`：
- name ∈ `overview` | `sources` | `check-version` | `plugin-switch` | `sections`
- state ∈ `normal` | `error` | `recover` | `empty` | `historical` | `incomparable` | `unverified` | `unavailable`

每个 JSON 顶层是对应 v1.1 接口的**完整返回体**；另有 `endpoint`/`state`/`note` 元字段说明用途，前端 harness 读取时忽略元字段、把整个文件当响应体注入即可。

## 各夹具对齐的契约点

- `overview.*`：返回 `{ok,items:[{key,title,summary,state,href}]}`；`state`∈empty/ok/partial/error，局部失败只标该项。
- `sources.*`：`sourceType`∈github/npm/local/unknown；列表查询不触发下载安装。
- `check-version.*`：`result.state`∈ok/incomparable/unavailable/error/historical；**`comparison` 由后端算**，非 ok 态必为 `unknown`；`checkedAt` 与 `lastSuccessAt` 分开。
- `plugin-switch.*`：顶层统一为 GET 只读状态结构 `{ok:true,items:[{pluginId,nativeId,installed,enabled,runtime,registered,source,message}]}`；缺口态顶层 `{ok:false,error:{code:'native-api-unavailable',message,evidence}}`。POST 启停样例放在同文件的 `postResult` 字段。
  - `plugin-switch.unverified.json`：登记≠运行未验证——`enabled:null`、`runtime:'unknown'`、`registered:true`，不给假成功。
  - `plugin-switch.error.json`：原生接口缺口，error 带 `code`+`message`+`evidence`（查过的位置与判定理由）。
- `sections.normal.json`：五项固定顺序，保留 rice/stomach/hand 原 ID 与 path，overview/settings 的 `path:null`。

## 给 B 的开发场景入口建议（不改 client.js）

B 的 harness 拦截真实组件发出的请求（`GET /api/fish-body/*`、`POST /api/fish-body/*`），按场景开关用同名夹具顶层响应体直接回复；组件和请求契约不变，不复制旧静态 HTML、不另造一套假 UI。用 URL 参数（如 `?uiScenario=error`）选择场景，切换器只在开发构建存在、不进生产、不绕过真实授权。模拟界面验证与真实后端测试分别记录，夹具不冒充日常安装/运行证据。
