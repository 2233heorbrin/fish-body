// W2 前端契约：三模式 UI / 切模式语义 / 饭页 sourceStatus 四值 / 手页原生安装与显式分析入口。
// client.js 是自注册脚本，不可直接 import 组件；这里做源码级契约断言（配合隔离真机截图验渲染）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
const has = re => re.test(src)

test('三模式标识齐全：off / compatibility / reverse', () => {
  assert.ok(has(/labels\s*=\s*\{\s*off:\s*'关闭胃'/), 'labels 需含 off 中文标签')
  assert.ok(has(/modeValues\s*=\s*\['off',\s*'compatibility',\s*'reverse'\]/), 'modeValues 需严格三值')
  assert.ok(has(/\['off',\s*'关闭胃'/), '模式卡需含 off 卡')
  assert.ok(has(/\['compatibility',\s*'兼容拆分'/), '模式卡需含兼容拆分卡')
  assert.ok(has(/\['reverse',\s*'逆向拆分'/), '模式卡需含逆向拆分卡')
})

test('radio 与模式卡只影响新请求：onClick/onChange 走 chooseMode，不 update 已有任务 mode', () => {
  assert.ok(has(/onChange:\s*\(\)\s*=>\s*chooseMode\(m\)/), 'radio 切换走 chooseMode')
  assert.ok(has(/onClick:\s*\(\)\s*=>\s*chooseMode\(value\)/), '模式卡切换走 chooseMode')
  // chooseMode 函数体内不得出现 update({mode}) 这类改写已确认任务的调用
  const body = src.match(/const chooseMode = \(value\) => \{([\s\S]*?)\n      \}/)
  assert.ok(body, 'chooseMode 定义存在')
  assert.ok(!/update\(\s*\{\s*mode:/.test(body[1]), 'chooseMode 不得 update 已开任务的 mode')
  assert.ok(/setMode\(value\)/.test(body[1]), 'chooseMode 必须 setMode')
  assert.ok(/persistMode\(value\)/.test(body[1]), 'chooseMode 必须持久化')
  assert.ok(!/task\s*\?\s*run\(\(\)\s*=>\s*update/.test(src), '模式卡/radio 不得再有 task?update 分支')
})

test('off 模式不建 analysis task：新建按钮有 guard', () => {
  assert.ok(has(/mode === 'off' \? '关闭胃模式不建分析任务'/), 'off 下按钮改文案')
  assert.ok(has(/if \(mode === 'off'\) throw Error/), 'off 下抛错拦住建任务')
  assert.ok(has(/taskOperation: 'create', analysisId, taskMode: mode/), '非 off 才带 taskMode 建任务')
})

test('模式持久化：GET 读回 defaultMode/mode，POST 写 {defaultMode}', () => {
  assert.ok(has(/body: JSON\.stringify\(\{ defaultMode: value \}\)/), 'POST 体 {defaultMode}')
  assert.ok(has(/fetch\('\/api\/fish-body\/state', \{ method: 'POST'/), 'POST 到 state 路由')
  assert.ok(has(/v\.defaultMode \?\? v\.mode/), '读回兼容 defaultMode ?? mode')
  assert.ok(has(/modeValues\.includes\(saved\)/), '读回只接受三值')
})

test('模式状态可见：aria-pressed 与"当前选择"标记', () => {
  assert.ok(has(/'aria-pressed': mode === value/), '模式卡有 aria-pressed')
  assert.ok(has(/mode === value \? h\(Tag, \{ tone: 'info' \}, '当前选择'\)/), '选中卡有可见标记')
})

test('饭页 sourceStatus 四值口径齐全', () => {
  assert.ok(has(/'registration-only': '来源已登记（未采材料）'/), 'registration-only 文案')
  assert.ok(has(/'material-absent': '材料未采集'/), 'material-absent 文案')
  assert.ok(has(/collected: '已保存材料'/), 'collected 文案')
  assert.ok(has(/'downloaded-pinned': '已固定原包'/), 'downloaded-pinned 文案')
  assert.ok(has(/x\.sourceStatus \?\? x\.source\?\.sourceStatus \?\? x\._meta\?\.sourceStatus/), '兼容三处落点')
})

test('饭页未采材料绝不显示"已保存"：状态分支与文案', () => {
  assert.ok(has(/sKey && !hasMaterial\(sKey\)/), 'stateTag 有未采材料分支')
  assert.ok(has(/'未采集分析材料'/), '未采材料如实提示')
  const detailKv = src.match(/\['来源登记状态', STATUS_TEXT\[statusOf\(pickedEntry\.info\.current\)\][\s\S]*?\],?/)
  assert.ok(detailKv, '详情含来源登记状态 KV')
  assert.ok(!/\['材料版本', pickedEntry\.info\.current\.localVersion \|\| '未记录'\]/.test(src), '材料版本不得无条件显示 localVersion')
  assert.ok(has(/'来源已登记 ≠ 材料已保存 ≠ 已安装 ≠ 安全'/), 'lead 不再宣称材料已保存')
})

test('手页原生安装·未拆分 + 显式分析入口 + 不自动分析', () => {
  assert.ok(has(/原生安装 · 未拆分/), '状态栏标明原生安装·未拆分')
  assert.ok(has(/从已装项进入分析/), '有显式分析入口')
  assert.ok(has(/当前不自动分析/), '明示不自动分析')
  assert.ok(has(/function HandPanel\(\{ onOpenFolder, sectionPath, onNavigate, onAnalysisReady \}\)/), 'HandPanel 接收 onNavigate + onAnalysisReady')
  assert.ok(has(/h\(HandPanel, \{ onOpenFolder: openFolder, sectionPath, onNavigate: switchTo, onAnalysisReady \}\)/), '分发处传 onNavigate + onAnalysisReady')
})

test('身体总开关独立于关闭胃', () => {
  assert.ok(has(/「关闭胃」是胃页的一种工作模式/), '有独立说明')
  assert.ok(has(/关闭胃不会关掉身体/), '明示关闭胃≠关身体')
})

test('#318：手页从已装项进入分析是真功能（就地二选一 + 带身份调端点 + 不改标记不 setMode）', () => {
  // 入口就地展开模式二选一（非纯导航、无 off）
  assert.ok(has(/'aria-expanded': analysisIntent === item\.pluginId/), '入口是就地展开开关而非直接导航')
  assert.ok(has(/setAnalysisIntent\(analysisIntent === item\.pluginId \? '' : item\.pluginId\)/), '展开/收起切换本卡片')
  assert.ok(has(/onClick: \(\) => enterAnalysis\(item, 'compatibility'\)/), '兼容拆分按钮调 enterAnalysis')
  assert.ok(has(/onClick: \(\) => enterAnalysis\(item, 'reverse'\)/), '逆向拆分按钮调 enterAnalysis')
  const entry = src.match(/item\.installed === true && typeof onAnalysisReady === 'function' \? h\('div', \{ className: 'fb-analysis-entry' \}([\s\S]*?) : null/)
  assert.ok(entry, '入口区仅限 installed===true 且有 onAnalysisReady')
  assert.ok(!/onNavigate\('stomach'\)/.test(entry[1]), '入口不再纯 onNavigate 导航')
  // enterAnalysis 函数体：带身份调端点，失败中文，不 setMode、不改 items
  const fn = src.match(/const enterAnalysis = async \(item, mode\) => \{([\s\S]*?)\n      \}/)
  assert.ok(fn, 'enterAnalysis 定义存在')
  assert.ok(/fetchJson\('\/api\/fish-body\/analyze-installed'/.test(fn[1]), '调编排端点')
  assert.ok(/body: JSON\.stringify\(\{ pluginId: item\.pluginId, nativeId: item\.nativeId, packageName: item\.packageName \|\| undefined, mode \}\)/.test(fn[1]), '带 pluginId/nativeId/packageName/mode 身份')
  assert.ok(/mode !== 'compatibility' && mode !== 'reverse'/.test(fn[1]), '模式严格两值无 off')
  assert.ok(/value\.error \|\| value\.message \|\| value\.reason/.test(fn[1]), '失败中文原因兼容 error/message/reason')
  assert.ok(/onAnalysisReady\(\{ taskId, analysisId: value\.analysisId \|\| '', pluginId: value\.pluginId \|\| item\.pluginId \}\)/.test(fn[1]), '成功回传 taskId/analysisId/pluginId')
  assert.ok(!/setMode\(/.test(fn[1]), 'enterAnalysis 不 setMode')
  assert.ok(!/setItems\(/.test(fn[1]), 'enterAnalysis 不改 items 标记')
})

test('#318：回跳落地 analysisTarget nonce → 胃页 load 同一 task', () => {
  assert.ok(has(/const \[analysisTarget, setAnalysisTarget\] = useState\(null\)/), 'FishBodySection 有 analysisTarget state')
  const cb = src.match(/function onAnalysisReady\(result\) \{([\s\S]*?)\n      \}/)
  assert.ok(cb, 'onAnalysisReady 定义存在')
  assert.ok(/nonce: Date\.now\(\)/.test(cb[1]), 'nonce 保证同一任务可重复触发')
  assert.ok(/switchTo\('stomach'\)/.test(cb[1]), '成功后切回胃页')
  assert.ok(has(/function StomachTasks\(\{ analysisTarget \}\)/), 'StomachTasks 接 analysisTarget prop')
  assert.ok(has(/h\(StomachTasks, \{ onOpenFolder: openFolder, sectionPath, analysisTarget \}\)/), '分发处传 analysisTarget')
  const effect = src.match(/if \(!analysisTarget \|\| !analysisTarget\.taskId\) return([\s\S]*?)\n      \}, \[analysisTarget\?\.nonce\]\)/)
  assert.ok(effect, 'nonce effect 存在')
  assert.ok(/run\(\(\) => load\(analysisTarget\.taskId\)\)/.test(effect[1]), 'nonce 变化 load 同一 taskId')
})

test('#315：load 旧任务不写回全局新请求 mode，任务模式只作只读展示', () => {
  const loadBody = src.match(/async function load\(id\) \{([\s\S]*?)\n      \}/)
  assert.ok(loadBody, 'load(id) 定义存在')
  assert.ok(!/setMode\(t\.mode\)/.test(loadBody[1]), 'load 路径不得 setMode(t.mode) 覆盖新请求默认')
  assert.ok(/setTask\(t\)/.test(loadBody[1]), 'load 仍写入已打开任务')
  // header 仍用 task.mode 只读展示（带"任务模式·"前缀 + title 提示）
  assert.ok(has(/title: '该任务自身模式（只读，不影响新任务默认）'/), 'header Tag 标明只读展示')
  assert.ok(has(/'任务模式·' \+ \(labels\[task\.mode\] \|\| task\.mode\)/), 'header 仍用 task.mode 展示该任务模式')
  // lead 只讲新请求默认，不再混用 task?.mode
  assert.ok(has(/'待当前 DSH 对话了解你的功能目标。新任务默认模式：' \+ labels\[mode\] \+ '。'/), 'lead 只讲新任务默认 mode')
  assert.ok(!has(/当前模式：' \+ labels\[task\?\.mode \|\| mode\]/), 'lead 不得再用 task?.mode || mode 混用')
})

test('#324：后端 rice-model 对外补 packageName/displayKey 展示归一字段，身份判定不动', () => {
  const rm = fs.readFileSync(path.join(here, '..', 'internal', 'backend', 'lib', 'rice-model.mjs'), 'utf8')
  assert.ok(/const displayKey = d\.pkgName \? `pkg:\$\{d\.pkgName\}` : `solo:\$\{d\.row\.id\}`/.test(rm), 'displayKey：有核实包名 pkg: 否则 solo:')
  assert.ok(/packageName: d\.pkgName \|\| null,/.test(rm), 'out 对外带 packageName')
  assert.ok(/\n\s*displayKey,/.test(rm), 'out 对外带 displayKey')
  assert.ok(/identityBasis: d\.identityBasis,/.test(rm), 'out 对外带 identityBasis')
})

test('#324：前端按 displayKey+渠道归一成一插件一卡，组内多来源逐条分述', () => {
  assert.ok(has(/const displayKeyOf = x => \(x && x\.displayKey \? String\(x\.displayKey\) : deriveGroupKey\(x\)\)/), 'displayKeyOf 优先后端 displayKey')
  const loop = src.match(/const groups = \[\][\s\S]*?for \(const x of \(items \|\| \[\]\)\) \{([\s\S]*?)\n      \}/)
  assert.ok(loop, 'groups 构造循环存在')
  assert.ok(/const key = displayKeyOf\(x\)/.test(loop[1]), 'groups 按 displayKey 归一（不含渠道），同插件并一卡')
  // 每渠道每插件恰好一项：entriesOf 用 buildChannels 按渠道筛，groupKey=group.key 与 pickKey 一致
  assert.ok(has(/out\.push\(\{ group, groupKey: group\.key, name: groupNameOf\(group\), info, install: installOf\(group\) \}\)/), 'entriesOf 每 group 每渠道一项')
  assert.ok(has(/const name: groupNameOf/ ) || has(/name: groupNameOf\(group\)/), '卡片名走 groupNameOf')
  assert.ok(has(/head\.packageName \|\| head\.groupName/), 'groupNameOf 优先后端核实包名')
  // 详情逐条列组内全部版本/来源，当前安装版本单列
  assert.ok(has(/const versionRowsOf = entry =>/), 'versionRowsOf 存在')
  const vr = src.match(/const versionRowsOf = entry => \{([\s\S]*?)\n      \}/)
  assert.ok(vr, 'versionRowsOf 定义存在')
  assert.ok(/'当前安装版本'/.test(vr[1]), '当前安装版本单列')
  assert.ok(/历史来源 · /.test(vr[1]), '其余标历史来源')
  assert.ok(/身份依据 ' \+ String\(r\.identityBasis/.test(vr[1]), '逐条带身份依据')
  assert.ok(has(/pickedEntry\.group\.rows\.length > 1 \? h\('div', \{ className: 'fb-ver-main' \}/), '多来源卡在详情展开版本清单')
})

test('#324：版本比较口径——当前安装版比较只认 installComparisonOf，材料来源标非安装升级', () => {
  const st = src.match(/const stateTag = entry => \{([\s\S]*?)\n      \}/)
  assert.ok(st, 'stateTag 定义存在')
  assert.ok(/installComparisonOf\(entry\.group, cs\)/.test(st[1]), '卡级比较用 installComparisonOf')
  assert.ok(/'当前安装版有新版本'/.test(st[1]), '卡级只报"当前安装版有新版本"')
  assert.ok(!/curCheck\?\.result\?\.comparison === 'newer'/.test(st[1]), '不再拿材料行 newer 冒卡级待升级')
  assert.ok(has(/'（仅该来源材料，非安装升级）'/), '材料来源版本结论标"非安装升级"')
  // 安装来源核实与已装事实分离：unconfirmed 带真实版本仍显示已装
  assert.ok(has(/'当前已装 ' \+ ver \+ '（来源未确认，存在内容等价历史记录）'/), 'unconfirmed 带版本显示已装事实')
})

test('#324：未采材料按钮如实——禁用材料目录入口、改按需采集文案', () => {
  const act = src.match(/\/\/ #324 未采材料行不引导到不存在的材料目录[\s\S]*?typeof onNavigate/)
  assert.ok(act, '详情按钮区存在')
  assert.ok(/!hasMaterial\(statusOf\(pickedEntry\.info\.current\)\)/.test(act[0]), '材料目录按钮按材料状态禁用')
  assert.ok(has(/'材料未采集，无可打开目录'/), '未采材料按钮文案')
  assert.ok(!has(/'到胃·分析查看'/), '不再用含糊的"到胃·分析查看"')
})

test('#327-2：饭页分析入口是如实导航——准确文案+title 不宣称已采集+导向手页真入口', () => {
  assert.ok(has(/'到胃工作区查看\/分析 →'/), '按钮文案改为准确的导航措辞')
  assert.ok(!has(/'用已装本体按需采集并进入分析'/), '不再用名不副实的"按需采集并进入分析"')
  assert.ok(has(/'跳转到胃工作区；按需采集与分析由显式分析请求完成，本页不预先采集'/), 'title 说明本页不预先采集')
  assert.ok(has(/如需按已装版本采集并进入分析，请到「手·组件」页从已装项进入分析/), 'fb-note 导向 #318 手页已装项分析真入口')
  // 纯导航语义不变：仍 onNavigate('stomach')，不碰 analyze-installed/不改数据状态
  const btn = src.match(/\/\/ #327-2 如实导航[\s\S]*?}, '到胃工作区查看\/分析 →'\)/)
  assert.ok(btn, '#327-2 按钮块存在')
  assert.ok(/onClick: \(\) => onNavigate\('stomach'\)/.test(btn[0]), 'onClick 仍是纯导航')
  assert.ok(!/analyze-installed|onAnalysisReady/.test(btn[0]), '不在饭页造分析编排')
})

test('#330：直装登记来源渠道优先——sourceKind npm/github 不被 local: sourceId 误判', () => {
  // 从源码抽出两个纯函数真实执行（client.js 是自注册脚本，不可直接 import）
  const m = src.match(/const installedSourceId = install =>[^\n]*\n\s*const installedChannel = install => \{[\s\S]*?\n      \}/)
  assert.ok(m, 'installedSourceId / installedChannel 定义存在')
  const installedChannel = new Function(m[0] + '\nreturn installedChannel')()
  // 直装 npm：source='direct-registration'、sourceId='local:...'，旧文本判定会误命中 local
  const npmInstall = { source: 'direct-registration', sourceId: 'local:饭/直装来源/dsh-meme/npm-xxx', directRegistration: { sourceKind: 'npm' } }
  assert.equal(installedChannel(npmInstall), 'npm', '直装 npm 登记应返回 npm 而非 local')
  const ghInstall = { source: 'direct-registration', sourceId: 'local:饭/直装来源/dsh-yyy/github-xxx', directRegistration: { sourceKind: 'github' } }
  assert.equal(installedChannel(ghInstall), 'github', '直装 github 登记应返回 github 而非 local')
  // 无 directRegistration 时原 fallback 一行不动
  assert.equal(installedChannel({ source: 'direct-registration', sourceId: 'local:foo' }), 'local', '无 sourceKind 时仍走原 local fallback')
  assert.equal(installedChannel({ source: '', sourceId: 'npm:bar' }), 'npm', '原 npm: sourceId fallback 保留')
  assert.equal(installedChannel({ source: 'github.com/a/b' }), 'github', '原 github source fallback 保留')
})

test('#330b：currentSourceOf 从 inline 补 directRegistration 渠道字段，fromResult 优先不变、旧来源不回归', () => {
  // 抽出纯函数真实执行（client.js 是自注册脚本，不可直接 import）
  const fm = src.match(/const installedSourceId = install =>[^\n]*\n\s*const installedChannel = install => \{[\s\S]*?\n      \}/)
  assert.ok(fm, 'installedSourceId / installedChannel 定义存在')
  const installedChannel = new Function(fm[0] + '\nreturn installedChannel')()
  const installedSourceId = new Function(fm[0] + '\nreturn installedSourceId')()
  const cm = src.match(/const currentSourceOf = group => \{[\s\S]*?\n      \}/)
  assert.ok(cm, 'currentSourceOf 定义存在')
  const makeCurrentSourceOf = new Function('checks', 'installedSourceId', 'installedChannel', 'channelOf', cm[0] + '\nreturn currentSourceOf')

  const sid = 'local:饭/直装来源/dsh-meme/npm-b1752e2b4af2b2fd'
  // dev21 场景：checks 的 install 无 directRegistration；inline install 有 directRegistration.sourceKind=npm
  const inlineInstall = { state: 'installed', source: 'direct-registration', sourceId: sid, installedVersion: '0.1.86', directRegistration: { sourceKind: 'npm' } }
  const row = { id: sid, localVersion: '0.1.86', sourceType: 'npm', install: inlineInstall }
  const fromResult = { state: 'installed', sourceId: sid, installedVersion: '0.1.86', comparison: 'same' } // 无 directRegistration
  const checks = { [sid]: { result: { install: fromResult } } }
  const picked = makeCurrentSourceOf(checks, installedSourceId, installedChannel, () => 'npm')({ rows: [row] })
  assert.ok(picked, 'currentSourceOf 应命中已装来源')
  assert.equal(installedChannel(picked.install), 'npm', 'fromResult 无 dr 时应从 inline 补渠道 → npm 而非 local')
  assert.equal(picked.install.directRegistration?.sourceKind, 'npm', 'directRegistration 已补齐')
  assert.equal(picked.install.comparison, 'same', 'fromResult 优先：其余字段 comparison 未被 inline 覆盖')
  assert.equal(checks[sid].result.install.directRegistration, undefined, 'checks 原对象未被污染（补挂是新对象）')

  // 无 dr 旧来源：fromResult 与 inline 都无 directRegistration，仍走原 fallback（不凭空赋 npm）
  const oldInline = { state: 'installed', source: 'direct-registration', sourceId: sid, installedVersion: '0.1.86' }
  const oldRow = { id: sid, localVersion: '0.1.86', sourceType: 'npm', install: oldInline }
  const oldChecks = { [sid]: { result: { install: { state: 'installed', sourceId: sid, installedVersion: '0.1.86' } } } }
  const oldPick = makeCurrentSourceOf(oldChecks, installedSourceId, installedChannel, () => 'npm')({ rows: [oldRow] })
  assert.ok(oldPick, '旧来源仍应命中')
  assert.equal(installedChannel(oldPick.install), 'local', '无 directRegistration 的旧来源走原 local fallback，不回归')
})
