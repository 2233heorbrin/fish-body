/* fish-body · Client half
 * 通过真实 settings.section 扩展点注入「鱼的身体」设置页。
 * 组件自带 <style>，随组件卸载由 React 一并移除，不改宿主打包 CSS。
 */
window.__ModuleLoader__.load({
  id: 'fish-body',
  factory(require) {
    const React = require('react')
    let FishDataPanel
// BEGIN SHARED DATA CLIENT
// Embedded in this package's native client entry by tools/sync-client.mjs.
function installDataClient(React, ctx, component) {
  const h = React.createElement, base = '/api/fish-' + component + '/data'
  const current = () => {
    const rows = Object.values(ctx.sessions.list.getSnapshot().byId).filter(row => (row.retainedBy?.mainView || 0) > 0)
    return rows.length === 1 ? rows[0].id : null
  }
  const request = async input => {
    const response = await fetch(base, { credentials: 'same-origin', cache: 'no-store',
      ...(input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '数据初始化失败')
    return data
  }
  let attempted = null, busy = false, stopped = false
  const listeners = new Set()
  const notify = (value, error) => {
    if (!stopped && component === 'body') for (const listener of listeners) listener(value, error)
  }
  const initialize = async () => {
    const sessionId = current()
    if (busy || !sessionId || attempted === sessionId || stopped) return
    busy = true; attempted = sessionId
    try {
      const value = await request()
      if (!stopped && !value.root && value.status === 'pending-workspace') notify(await request({ action: 'initialize', sessionId }))
    } catch (error) { notify(null, error) }
    finally { busy = false }
  }
  const unsubscribe = ctx.sessions.list.subscribe(initialize)
  initialize()
  ctx.effect(() => () => { stopped = true; unsubscribe() })
  return function FishDataPanel({ onState } = {}) {
    const [value, setValue] = React.useState(null), [error, setError] = React.useState(''), [pending, setPending] = React.useState(false)
    const [expanded, setExpanded] = React.useState(false)
    React.useEffect(() => {
      if (component === 'body' && (error || (value && value.status !== 'ready'))) setExpanded(true)
    }, [value?.status, error])
    const commit = result => { setValue(result); onState?.(result) }
    React.useEffect(() => {
      if (component !== 'body') return
      const update = (value, error) => { if (error) setError(error.message); else { setError(''); commit(value) } }
      listeners.add(update)
      return () => listeners.delete(update)
    }, [])
    React.useEffect(() => { let live = true; request().then(value => { if (live) commit(value) }).catch(error => { if (live) setError(error.message) }); return () => { live = false } }, [])
    const run = async operation => {
      setPending(true); setError('')
      try { commit(await operation()) } catch (error) { setError(error.message) }
      finally { setPending(false) }
    }
    const select = () => run(async () => {
      const result = await ctx.remote.directoryPicker.pick()
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value) return request()
      return request({ action: 'select', path: result.value })
    })
    const open = section => run(async () => {
      const response = await fetch(base + '/open', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      return request()
    })
    const labels = { ready: '初始化完成', 'pending-workspace': '待选择工作区', 'invalid-root': '原目录失效，请选择新位置',
      'pending-initialization': '待补齐目录', 'invalid-config': '配置无效' }
    if (component === 'body') {
      const preparation = value?.dependencies
      const preparationLabels = { ready: '程序准备已完成', 'not-prepared': '程序尚未准备',
        'host-blocked': '宿主暂不支持完整安装接管', 'restart-required': '新位置已保存，请重新加载身体后使用' }
      const detail = error || value?.error || preparation?.error
      const failed = Boolean(error || value?.error || preparation?.status === 'failed')
      const retry = () => run(() => request({ action: 'retry' }))
      return h('section', { 'aria-label': '数据设置', className: 'fb-data' },
        failed ? h('div', { className: 'fb-data-issue' },
          h('p', { className: 'fb-error', role: 'alert' }, error || value?.error ? '数据操作失败，请重试。' : '程序准备失败，请重试。'),
          h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: retry }, pending ? '正在准备…' : '重试准备'))
          : preparation ? h('p', { className: 'fb-note', role: 'status' }, preparationLabels[preparation.status] || '程序准备：' + preparation.status) : null,
        detail ? h('details', { className: 'fb-data-error' },
          h('summary', null, '查看原始错误'), h('pre', null, detail)) : null,
        h('details', { className: 'fb-data-settings', open: expanded, onToggle: event => setExpanded(event.currentTarget.open) },
          h('summary', null, '数据设置', h('span', { className: 'fb-data-status', role: 'status' },
            value ? value.status === 'ready' ? '数据目录已绑定' : labels[value.status] || value.status : '正在读取配置…')),
          h('div', { className: 'fb-data-content' },
            value?.root ? h('p', null, '数据根目录：', value.root) : null,
            value?.profileDir ? h('p', null, 'Profile：', value.profileDir) : null,
            h('p', { className: 'fb-note' }, '切换位置只更新绑定，不会搬迁旧数据。程序依赖单独准备。'),
            h('div', { className: 'fb-data-actions' },
              h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: select }, value?.root ? '切换数据位置' : '选择文件夹'),
              h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: () => run(() => request({ action: 'initialize', sessionId: current() })) }, '使用当前对话工作区'),
              !failed ? h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: retry }, pending ? '正在准备…' : '重试准备') : null))))
    }
    return h('section', { 'aria-label': '数据与依赖', style: { marginBlock: '16px', overflowWrap: 'anywhere' } },
      h('h3', null, '数据与依赖'),
      h('p', { role: 'status' }, value ? labels[value.status] || value.status : '正在读取配置…'),
      value?.root ? h('p', null, '数据根目录：', value.root) : null,
      value?.profileDir ? h('p', null, 'Profile：', value.profileDir) : null,
      h('p', null, '切换位置不会搬迁旧数据。人格与记忆由你填写，程序依赖单独准备。'),
      value?.personality ? h('p', null, value.personality === 'empty-template' ? '人格尚未填写。' : '已有人格文件。', '记忆文档：', value.memory?.count || 0) : null,
      value?.dependencies ? h('p', { role: 'status' }, '程序准备：', value.dependencies.status,
        value.dependencies.error ? ' · ' + value.dependencies.error : '') : null,
      Object.entries(value?.paths || {}).map(([key, path]) => h('p', { key }, path, ' ',
        h('button', { type: 'button', disabled: pending, onClick: () => open(key) }, '打开文件夹'))),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', disabled: pending, onClick: select }, value?.root ? '切换数据位置' : '选择文件夹'),
        h('button', { type: 'button', disabled: pending, onClick: () => run(() => request({ action: 'initialize', sessionId: current() })) }, '使用当前对话工作区'),
        h('button', { type: 'button', disabled: pending, onClick: () => run(() => request({ action: 'retry' })) }, pending ? '正在准备…' : '重试准备')),
      error ? h('p', { role: 'alert' }, error) : null)
  }
}

// END SHARED DATA CLIENT
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const STYLE = `
.fb-root{box-sizing:border-box;max-width:720px;width:100%;color:var(--dsw-alias-label-primary, #1f2328);font:inherit;font-size:14px;line-height:1.6}
.fb-root *,.fb-root *::before,.fb-root *::after{box-sizing:border-box}
.fb-head{margin:0 0 20px}
.fb-title{margin:0;display:flex;align-items:center;gap:8px;font-size:18px;font-weight:600;line-height:1.4}
.fb-title .fb-icon,.fb-name .fb-icon{color:var(--dsw-alias-brand-primary, #2f6feb)}
.fb-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary, #5b6570);font-size:13px}
.fb-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px}
.fb-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary, #5b6570);background:transparent;border:1px solid var(--dsw-alias-border-l2, #d3d8de);border-radius:var(--dsw-radius-sm, 6px);cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.fb-tab:hover{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))}
.fb-tab[aria-pressed="true"]{color:var(--dsw-alias-brand-primary, #2f6feb);border-color:var(--dsw-alias-brand-primary, #2f6feb);background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));background:color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6feb) 12%, transparent);font-weight:600}
.fb-tab:focus-visible,.fb-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #2f6feb);outline-offset:2px}
.fb-detail{border:1px solid var(--dsw-alias-border-l2, #d3d8de);background:var(--dsw-alias-bg-layer-1, transparent);border-radius:var(--dsw-radius-md, 10px);padding:18px 20px 20px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-border-l2, #d3d8de) 35%, transparent)}
.fb-name{margin:0;display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600}
.fb-desc{margin:6px 0 0;color:var(--dsw-alias-label-secondary, #5b6570);font-size:13px}
.fb-label{margin:18px 0 6px;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary, #5b6570)}
.fb-path{margin:0;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary, #1f2328);background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l1, #e2e6ea);border-radius:var(--dsw-radius-sm, 6px);user-select:text;-webkit-user-select:text;word-break:break-all;overflow-wrap:anywhere}
.fb-actions{margin-top:18px;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.fb-open{appearance:none;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary-foreground, #fff);background:var(--dsw-alias-label-primary, #0f1115);border:1px solid transparent;border-radius:var(--dsw-radius-sm, 6px);cursor:pointer}
.fb-open[aria-disabled="true"]{opacity:.6;cursor:default}
.fb-error{margin:12px 0 0;font-size:12.5px;color:var(--dsw-alias-label-error, #c0392b);word-break:break-all}
.fb-error-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.fb-note{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary, #5b6570)}
.fb-data{margin:16px 0 20px;overflow-wrap:anywhere}
.fb-data-settings{margin-top:12px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1, #e2e6ea)}
.fb-data summary{cursor:pointer;font-size:13px;font-weight:600}
.fb-data summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary, #2f6feb);outline-offset:2px}
.fb-data-status{margin-left:12px;font-weight:400;color:var(--dsw-alias-label-secondary, #5b6570)}
.fb-data-content{padding-top:8px}
.fb-data-content p{margin:8px 0;font-size:13px}
.fb-data-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.fb-data-issue{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.fb-data-issue .fb-error{margin:0}
.fb-data-error{margin-top:8px}
.fb-data-error pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.fb-data button:disabled{opacity:.6;cursor:default}
.fb-retry{margin-top:10px}
.fb-icon{flex:0 0 auto;display:block}
.fb-tasks{margin-top:24px;border-top:1px solid var(--dsw-alias-border-l1,#e2e6ea);padding-top:16px;overflow-wrap:anywhere}
.fb-tasks h4{margin:24px 0 8px}.fb-tasks small{display:block;color:var(--dsw-alias-label-secondary,#5b6570)}
.fb-task-field{display:block;margin:12px 0}.fb-task-field input,.fb-task-field select{display:block;width:100%;margin-top:4px}
.fb-tasks input:not([type=checkbox]):not([type=radio]),.fb-tasks select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#b0b8c2);border-radius:6px;padding:6px 8px;max-width:100%}
.fb-task-modes{display:flex;gap:20px;flex-wrap:wrap;margin:16px 0;border:1px solid var(--dsw-alias-border-l1,#e2e6ea);border-radius:6px}
.fb-task-cap{display:block;padding:8px 0}.fb-task-cap input,.fb-task-modes input{margin-right:8px;accent-color:var(--dsw-alias-brand-primary,#2f6feb)}
.fb-task-dep{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e2e6ea)}.fb-task-dep p{margin:4px 0}
.fb-task-output{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-2,#f4f6f8);padding:12px;font-size:12px;max-height:480px;overflow:auto}
.fb-tasks :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6feb);outline-offset:2px}.fb-tasks button:disabled{opacity:.6;cursor:default}
.fb-tasks summary{cursor:pointer;padding:8px 0;font-weight:600}.fb-task-technical{margin-top:24px;border-top:1px solid var(--dsw-alias-border-l1,#e2e6ea)}
.fb-task-readable{margin-top:24px}.fb-task-readable h3{margin-bottom:8px}.fb-task-readable li{margin:8px 0}.fb-task-readable ul,.fb-task-readable ol{padding-inline-start:24px}
.fb-tasks select{min-width:0}.fb-tasks fieldset{min-width:0;margin-inline:0}.fb-task-modes{padding:12px}.fb-tasks .fb-data-actions{align-items:center}
@media(max-width:480px){.fb-detail{padding:14px}.fb-tasks .fb-data-actions{gap:8px}.fb-tasks .fb-tab{padding:8px 10px}.fb-task-modes{gap:12px}}
`

    /* 统一风格线性图标：内联 SVG stroke，无图标库，文字标签始终保留。 */
    function Icon(kind, size) {
      const paths = {
        layers: [
          h('path', { d: 'M12 3 3 8l9 5 9-5-9-5Z' }),
          h('path', { d: 'M3 13l9 5 9-5' })
        ],
        folder: [
          h('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' })
        ],
        external: [
          h('path', { d: 'M14 4h6v6' }),
          h('path', { d: 'M20 4 11 13' }),
          h('path', { d: 'M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5' })
        ]
      }
      return h('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': 'true', focusable: 'false', className: 'fb-icon'
      }, ...(paths[kind] || []))
    }

    function StomachTasks() {
      const [task, setTask] = useState(null), [caps, setCaps] = useState(null), [deps, setDeps] = useState(null), [unknowns, setUnknowns] = useState(null)
      const [analyses, setAnalyses] = useState([]), [tasks, setTasks] = useState([]), [analysisOffset, setAnalysisOffset] = useState(null), [taskOffset, setTaskOffset] = useState(null)
      const [analysisId, setAnalysisId] = useState(''), [taskId, setTaskId] = useState(''), [sourcePath, setSourcePath] = useState(''), [initialId, setInitialId] = useState('')
      const [mode, setMode] = useState('compatibility'), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [notice, setNotice] = useState('')
      const [technical, setTechnical] = useState(false), [output, setOutput] = useState(null), [outputRevision, setOutputRevision] = useState('')
      const [judgment, setJudgment] = useState('unknown'), [reason, setReason] = useState('')
      const [editing, setEditing] = useState(null), [decision, setDecision] = useState('pending'), [depReason, setDepReason] = useState('')
      const [change, setChange] = useState(''), [semantic, setSemantic] = useState('unknown'), [accept, setAccept] = useState(false)
      const labels = { compatibility: '兼容拆分', reverse: '逆向拆分', tool: '工具类', brain: '脑区类', mixed: '混合类', unknown: '待判断',
        'selection-pending': '待选择功能', 'plan-pending': '方案待讨论', 'plan-awaiting-confirmation': '方案待确认 / 待执行', 'materials-produced': '源码材料已产出',
        'confirmed-with-open-questions': '已记录确认，仍有待定项', 'confirmed-awaiting-separate-execution': '已确认，执行另行授权', 'materials-confirmed': '源码材料已确认',
        'model-reviewed-awaiting-user': '已记录模型意见，待用户确认', implementation: '直接实现候选', 'shared-state-initialization': '共享服务、状态与初始化',
        'lifecycle-release': '生命周期与释放', 'resources-programs': '资源与外部程序', 'incidental-behavior': '附带行为', 'unresolved-relation': '无法判断的关系',
        pending: '待判断', retain: '保留', narrow: '收窄', exclude: '排除', initial: '初步分析', deep: '深入分析', ready: '分析已完成', 'diagnostic-partial': '有诊断待核对' }
      const nameOf = r => r?.plugin?.displayName || r?.plugin?.name || '未命名插件'
      const timeOf = r => { const d = new Date(r?.updatedAt || r?.createdAt); return Number.isNaN(d.getTime()) ? '时间未记录' : d.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }
      const analysisLabel = r => nameOf(r) + '｜' + (labels[r.kind] || '类型待核对') + '｜' + timeOf(r)
      const taskLabel = r => nameOf(r) + '｜' + (labels[r.mode] || '模式待核对') + '｜' + timeOf(r) + '｜' + (labels[r.status] || r.status)
      function recovery(error) {
        if (/ID_INVALID|尚未选择/.test(error)) return '尚未选择分析结果或任务，请先从列表中选择。'
        if (/REVISION_CONFLICT/.test(error)) return '任务已被更新，请刷新任务后再保存。'
        if (/PROFILE_MISMATCH|SCOPE_MISMATCH|ROOT_RELOAD_REQUIRED/.test(error)) return '结果不属于当前 Profile 或数据绑定，请选择当前列表中的结果；绑定变更后需由用户重新加载身体。'
        if (/INVALID|SOURCE_CHANGED|identity changed|source changed|fixed source content|not completed|valid initial/.test(error)) return '来源或结果已失效，请保留旧材料，明确选择有效的同源分析；如需新分析，请在高级操作中主动发起。'
        if (/No output/.test(error)) return '当前版本尚未产出，请先生成方案或材料；也可在技术详情中选择已有产出版本。'
        if (/at least one/.test(error)) return '请先选择至少一项要保留的功能，再生成方案或材料。'
        if (/ENOENT/.test(error)) return '未找到结果，请刷新列表并重新选择，旧材料不会自动搬迁。'
        if (/off|已关闭|closing|正在关闭/.test(error)) return '身体已关闭或正在收尾，请等待；需要开启时由用户操作原插件开关。'
        if (/Failed to fetch|NetworkError/.test(error)) return '未能连接身体服务，请检查当前连接后重试。'
        if (/[\u4e00-\u9fff]/.test(error)) return error
        return '本次操作未完成。请刷新任务并核对选择；原始原因可在下方展开查看。'
      }
      async function api(args, route = 'task') {
        const response = await fetch('/api/fish-hand/' + route, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
        const value = await response.json()
        if (!response.ok || !value.ok) throw Error(value.error || value.message || value.result?.message || value.result?.validity?.reasons?.join('; ') || '结果不可用，请检查身体状态并选择有效分析。')
        return value.result
      }
      async function run(fn) { if (busy) return; setBusy(true); setIssue(''); setNotice(''); try { await fn() } catch (e) { setIssue(e.message) } finally { setBusy(false) } }
      async function list(kind, offset = 0) {
        const r = await api({ taskOperation: 'list', ...(kind === 'analyses' ? { taskView: 'analyses' } : {}), taskOptions: { offset, limit: 20 } })
        const put = kind === 'analyses' ? setAnalyses : setTasks
        put(old => offset ? [...old.filter(a => !r.page.items.some(b => a.id === b.id)), ...r.page.items] : r.page.items)
        ;(kind === 'analyses' ? setAnalysisOffset : setTaskOffset)(r.page.nextOffset)
      }
      function chooseAnalysis(id, row = analyses.find(a => a.id === id)) {
        setAnalysisId(id); setInitialId(row?.kind === 'initial' ? id : row?.kind === 'deep' ? row.initialAnalysisId || '' : '')
      }
      useEffect(() => { run(() => Promise.all([list('analyses'), list('tasks')])) }, [])
      async function readPage(id, view, offset = 0) { return (await api({ taskOperation: 'read', taskId: id, taskView: view, taskOptions: { offset, limit: 5 } })).page }
      async function load(id) {
        if (!id) throw Error('尚未选择任务，请先从列表中选择。')
        const t = await api({ taskOperation: 'read', taskId: id })
        setTask(t); setTaskId(id); setMode(t.mode); chooseAnalysis(t.analysisId, { kind: t.analysisKind, initialAnalysisId: t.initialAnalysisId }); setOutput(null); setOutputRevision(''); setEditing(null)
        setJudgment(t.judgment?.value || 'unknown'); setReason(t.judgment?.origin?.reason || '')
        setCaps(await readPage(id, 'capabilities')); setDeps(null); setUnknowns(null)
      }
      async function update(patch) {
        const t = await api({ taskOperation: 'update', taskId: task.taskId, expectedRevision: task.revision, taskPatch: patch })
        await load(t.taskId); await list('tasks')
      }
      const attribution = why => ({ kind: 'user', actor: '设置页使用者', reason: why })
      const button = (name, action) => h('button', { type: 'button', className: 'fb-tab', disabled: busy, onClick: () => run(action) }, name)
      const field = (name, value, change, placeholder = '') => h('label', { className: 'fb-task-field' }, name, h('input', { value, disabled: busy, placeholder, onChange: e => change(e.target.value) }))
      const nav = (p, fetchPage) => p ? h('div', { className: 'fb-data-actions' }, h('span', null, p.total ? p.total + ' 项 · 当前 ' + (p.offset + 1) + '–' + (p.offset + p.items.length) : '暂无条目'), p.offset > 0 ? button('上一页', () => fetchPage(Math.max(0, p.offset - p.limit))) : null, p.nextOffset !== null ? button('下一页', () => fetchPage(p.nextOffset)) : null) : null
      const explanation = task?.explanation
      function featureList(key, title) {
        const facts = task.features?.[key] || [], explained = explanation?.[key] || []
        const rows = facts.map(f => ({ ...f, annotation: explained.find(e => e.capabilityId === f.id) }))
        const total = key === 'retained' ? task.selected.length : task.features?.excludedCount || 0
        return h('section', null, h('h4', null, title), rows.length ? h('ul', null, rows.map(f => h('li', { key: f.id }, f.annotation?.label || f.name, f.annotation ? h('p', { className: 'fb-note' }, '模型理由：' + f.annotation.reason) : null))) : h('p', { className: 'fb-note' }, key === 'retained' ? '尚未选择，请在下方勾选要保留的功能。' : '当前没有排除的功能候选。'), total > rows.length ? h('p', { className: 'fb-note' }, '共 ' + total + ' 项，完整功能请按下方分页查看。') : null)
      }
      async function readOutput(offset = 0, revision = outputRevision) { setOutput(await api({ taskOperation: 'output', taskId: task.taskId, ...(revision ? { outputRevision: Number(revision) } : {}), taskOptions: { offset, limit: 5 } })) }
      const modeChoices = h('fieldset', { disabled: busy, className: 'fb-task-modes' }, h('legend', null, '任务模式'), ['compatibility', 'reverse'].map(m => h('label', { key: m }, h('input', { type: 'radio', name: 'stomach-mode', checked: mode === m, onChange: () => task ? run(() => update({ mode: m })) : setMode(m) }), labels[m])))
      return h('section', { className: 'fb-tasks', 'aria-label': '胃任务', 'aria-busy': busy },
        h('h3', null, '功能取舍与方案'),
        h('p', { className: 'fb-note' }, '先选分析结果，再按功能讨论取舍。兼容模式产出待执行方案，逆向模式产出源码理解材料。'),
        h('label', { className: 'fb-task-field' }, '继续已有任务', h('select', { value: tasks.some(a => a.id === taskId) ? taskId : '', disabled: busy, onChange: e => { const id = e.target.value; if (id) run(() => load(id)) } }, h('option', { value: '' }, '选择插件任务'), tasks.map(a => h('option', { key: a.id, value: a.id }, taskLabel(a))))),
        taskOffset !== null ? button('更多任务', () => list('tasks', taskOffset)) : null,
        h('label', { className: 'fb-task-field' }, '已有分析结果', h('select', { value: analyses.some(a => a.id === analysisId) ? analysisId : '', disabled: busy, onChange: e => chooseAnalysis(e.target.value) }, h('option', { value: '' }, '选择插件、分析类型和时间'), analyses.map(a => h('option', { key: a.id, value: a.id }, analysisLabel(a))))),
        h('div', { className: 'fb-data-actions' }, button('刷新列表', () => Promise.all([list('analyses'), list('tasks')])), analysisOffset !== null ? button('更多分析结果', () => list('analyses', analysisOffset)) : null,
          button('用所选分析新建任务', async () => { if (!analysisId) throw Error('尚未选择分析结果，请先从列表中选择。'); const r = await api({ taskOperation: 'create', analysisId, taskMode: mode }); await load(r.taskId); await list('tasks') })),
        modeChoices,
        busy ? h('p', { role: 'status' }, '正在处理，请稍候…') : null,
        notice ? h('p', { role: 'status' }, notice) : null,
        issue ? h('div', null, h('p', { className: 'fb-error', role: 'alert' }, recovery(issue)), h('details', null, h('summary', null, '原始错误详情'), h('pre', { className: 'fb-task-output' }, issue))) : null,
        task ? h('div', { className: 'fb-task-readable' },
          h('h3', null, nameOf(task)),
          h('p', { role: 'status', 'aria-live': 'polite' }, labels[task.phase] || task.phase),
          button('刷新任务', () => load(task.taskId)),
          h('h4', null, '当前目标'), h('p', null, explanation?.goal || '待当前 DSH 对话了解你的功能目标。当前模式：' + labels[task.mode] + '。'),
          h('p', { className: 'fb-note' }, '整体分类：' + labels[task.classification.value] + '（程序候选，尚非语义结论）' + (task.judgment ? '；已记录' + (task.judgment.origin.kind === 'current-model' ? '模型' : '用户') + '判断：' + labels[task.judgment.value] : '；待当前对话讨论。')),
          featureList('retained', '当前保留的功能'), featureList('excluded', '计划排除的功能'),
          h('h4', null, '模型推荐及理由'),
          explanation ? h('div', null, h('p', null, explanation.recommendation), h('p', { className: 'fb-note' }, '当前模型说明 · ' + explanation.origin.actor + '（调用方声明归属，不代表用户已接受）'))
            : h('p', null, task.explanationState === 'stale' ? '任务内容已改变，旧说明不再适用。待当前 DSH 对话重新解释方案。' : '待当前 DSH 对话解释方案。已有选择和分析事实如下，页面不会代替模型推荐。'),
          button('复制到当前 DSH 对话', async () => { if (!navigator.clipboard?.writeText) throw Error('浏览器未开放复制权限，请在技术详情中复制讨论提示。'); await navigator.clipboard.writeText(task.conversation.prompt); setNotice('讨论提示已复制，请粘贴到当前 DSH 对话；尚未发送。') }),
          h('h4', null, '使用影响与待选问题'),
          explanation ? h('div', null, h('ul', null, explanation.impacts.map((x, i) => h('li', { key: 'i' + i }, x.text))), explanation.questions.length ? h('ul', null, explanation.questions.map((x, i) => h('li', { key: 'q' + i }, x.text))) : h('p', { className: 'fb-note' }, '模型未提出额外问题；这不表示依赖已获得用户确认。'))
            : h('p', null, '依赖中有 ' + task.counts.pending + ' 项待判断。请让当前对话先核对相关证据，再讨论真正影响使用的取舍。'),
          h('h4', null, '当前进度与下一步'),
          explanation?.nextSteps?.length ? h('ol', null, explanation.nextSteps.map((x, i) => h('li', { key: i }, x))) : h('p', null, '先讨论并记录功能取舍，再形成' + (task.mode === 'compatibility' ? '兼容方案；适配、验证、打包和安装另行处理。' : '源码材料；独立化和新插件开发另行处理。')),
          h('p', { className: 'fb-note' }, task.outputs.length ? '已保留 ' + task.outputs.length + ' 份历史产出。确认仅针对具体方案版本，不授予执行或安装权限。' : '当前尚未产出方案或材料。'),
          h('h4', null, '选择保留功能'),
          caps?.items.length ? caps.items.map(c => h('label', { key: c.id, className: 'fb-task-cap' }, h('input', { type: 'checkbox', checked: task.selected.includes(c.id), disabled: busy, onChange: e => { const checked = e.target.checked; run(() => update({ selected: checked ? [...task.selected, c.id] : task.selected.filter(id => id !== c.id) })) } }), c.name, h('small', null, labels[c.category] + ' · ' + (c.origin.kind === 'program' ? '程序候选，待解释' : c.origin.kind === 'current-model' ? '模型补充' : '用户补充')))) : h('p', null, '没有自动识别的功能；可由当前对话核对证据并补充，不默认当作工具类。'),
          nav(caps, async offset => setCaps(await readPage(task.taskId, 'capabilities', offset))),
          h('div', { className: 'fb-data-actions' }, button(task.mode === 'compatibility' ? '生成兼容方案' : '生成逆向材料', async () => { await api({ taskOperation: 'produce', taskId: task.taskId, expectedRevision: task.revision }); await load(task.taskId); await list('tasks') })),
          h('p', { className: 'fb-note' }, '功能、模式或相关决定改变后，原确认失效，旧产出保留。此处不执行适配、不生成安装包，也不运行源码。')) : null,
        h('details', { className: 'fb-task-technical', open: technical, onToggle: e => { const open = e.currentTarget.open; setTechnical(open); if (open && task && !deps && !busy) run(async () => { setDeps(await readPage(task.taskId, 'dependencies')); setUnknowns(await readPage(task.taskId, 'unknowns')) }) } },
          h('summary', null, '技术详情 / 高级操作'),
          h('h4', null, '分析新源码（只读，不执行）'),
          field('待分析插件源码文件夹', sourcePath, setSourcePath, '明确的源码目录绝对路径'),
          h('label', { className: 'fb-task-field' }, '深入分析关联的初步分析', h('select', { value: initialId, disabled: busy, onChange: e => setInitialId(e.target.value) }, h('option', { value: '' }, '请选择同源初步分析'),
            initialId && !analyses.some(a => a.id === initialId && a.kind === 'initial') ? h('option', { value: initialId }, '已明确关联的初步分析（后端仍核验）') : null,
            analyses.filter(a => a.kind === 'initial').map(a => h('option', { key: a.id, value: a.id }, analysisLabel(a))))),
          h('p', { className: 'fb-note' }, initialId ? '已记录明确初扫关联。深入分析不会把当前 deep 结果作为 initial。' : '请先明确选择同源初步分析；查看结果不扫描，也不会自动任选初扫。'),
          h('div', { className: 'fb-data-actions' }, button('开始初步分析', async () => { if (!sourcePath.trim()) throw Error('请填写待分析插件源码文件夹；仅静态分析，不运行插件。'); const r = await api({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'local', path: sourcePath } }, 'analysis'); chooseAnalysis(r.analysisId, r); await list('analyses') }),
            button('深入分析（显式）', async () => { if (!initialId) throw Error('尚未确定初扫关联，请先选择同源初步分析；不会自动重新扫描。'); if (!sourcePath.trim()) throw Error('请填写待分析插件源码文件夹，后端将核对它与初扫同源。'); const r = await api({ action: 'analyze', analysisType: 'deep', analysisSource: { kind: 'local', path: sourcePath }, initialAnalysisId: initialId }, 'analysis'); chooseAnalysis(r.analysisId, r); await list('analyses') })),
          field('分析结果内部编号', analysisId, chooseAnalysis), field('任务内部编号', taskId, setTaskId), button('按编号读取任务', () => load(taskId)),
          task ? h('div', null,
            h('p', { className: 'fb-path' }, '任务 ' + task.taskId + ' · 方案版本 ' + task.revision + ' · 分析 ' + task.analysisId),
            h('p', null, task.classification.reason), h('p', { className: 'fb-path' }, '分类依据：' + task.classification.evidenceRefs.join(', ')),
            h('label', { className: 'fb-task-field' }, '用户分类判断', h('select', { value: judgment, disabled: busy, onChange: e => setJudgment(e.target.value) }, ['unknown', 'tool', 'brain', 'mixed'].map(v => h('option', { key: v, value: v }, labels[v])))),
            field('判断或确认理由', reason, setReason),
            h('div', { className: 'fb-data-actions' }, button('记录用户判断', () => update({ classification: { value: judgment, origin: attribution(reason), evidenceRefs: task.classification.evidenceRefs } })),
              button('确认当前方案版本', async () => { if (!reason.trim()) throw Error('请填写本次确认理由；确认不代表部署授权。'); await api({ taskOperation: 'confirm', taskId: task.taskId, expectedRevision: task.revision, taskConfirmation: attribution(reason) }); await load(task.taskId) })),
            h('h4', null, '依赖决定与证据'),
            button('刷新技术分页', async () => { setDeps(await readPage(task.taskId, 'dependencies')); setUnknowns(await readPage(task.taskId, 'unknowns')) }),
            deps?.items.map(d => h('div', { key: d.id, className: 'fb-task-dep' }, h('strong', null, labels[d.kind] + ' · ' + labels[d.decision]), h('p', null, d.rationale), h('small', null, d.id + ' · ' + d.evidenceRefs.join(', ') + (d.scope.truncated ? ' · 候选证据截断，请用 query 分页核对' : '')),
              button('编辑依赖决定', async () => { setEditing(d.id); setDecision(d.decision); setDepReason(d.rationale); setChange(d.proposedChange || ''); setSemantic(d.businessSemanticChange); setAccept(false) }))),
            nav(deps, async offset => setDeps(await readPage(task.taskId, 'dependencies', offset))),
            editing ? h('fieldset', { disabled: busy }, h('legend', null, '依赖决定 · ' + editing),
              h('label', null, '处理决定', h('select', { value: decision, onChange: e => setDecision(e.target.value) }, ['pending', 'retain', 'narrow', 'exclude'].map(v => h('option', { key: v, value: v }, labels[v])))),
              field('决定理由', depReason, setDepReason), field('拟调整接线（未执行）', change, setChange),
              h('label', null, '业务语义变化', h('select', { value: semantic, onChange: e => setSemantic(e.target.value) }, ['unknown', 'yes', 'no'].map(v => h('option', { key: v, value: v }, { unknown: '待判断', yes: '涉及变化', no: '不涉及变化' }[v])))),
              editing.endsWith(':D5') ? h('label', null, h('input', { type: 'checkbox', checked: accept, onChange: e => setAccept(e.target.checked) }), '明确接受本条理由中说明的附带行为') : null,
              button('保存依赖决定', async () => { await update({ dependencyDecisions: [{ id: editing, decision, rationale: depReason, origin: attribution(depReason), proposedChange: change, businessSemanticChange: semantic, acceptIncidental: accept, ...(accept ? { acceptanceReason: depReason } : {}) }] }); setEditing(null) })) : null,
            h('h4', null, '完整待定项（分页）'),
            unknowns?.items.map((u, i) => h('p', { key: i }, u.text + ' · ' + u.origin.kind + ' · ' + u.evidenceRefs.join(', '))),
            nav(unknowns, async offset => setUnknowns(await readPage(task.taskId, 'unknowns', offset))),
            h('details', null, h('summary', null, '来源、有效性与分析诊断'), h('pre', { className: 'fb-task-output' }, JSON.stringify({ source: task.source, completeness: task.completeness, capabilities: caps?.items, confirmation: task.confirmation }, null, 2))),
            h('details', null, h('summary', null, '讨论提示（仅复制，不发送）'), h('p', null, task.conversation.prompt)),
            h('h4', null, '当前及历史产出（按需读取）'),
            h('label', { className: 'fb-task-field' }, '产出版本', h('select', { value: outputRevision, onChange: e => { setOutputRevision(e.target.value); setOutput(null) } }, h('option', { value: '' }, '当前方案版本'), task.outputs.map(o => h('option', { key: o.revision, value: o.revision }, '版本 ' + o.revision + ' · ' + (o.mode === 'compatibility' ? '兼容方案' : '逆向材料'))))),
            button('读取产出详情', () => readOutput()),
            task.outputs.map(o => h('p', { key: o.revision, className: 'fb-path' }, '版本 ' + o.revision + ' · ' + o.path)),
            output ? h('section', { 'aria-label': '产出技术内容' }, h('p', null, output.historical ? '历史产出，不能冒充当前方案。' : '当前版本产出'), h('pre', { className: 'fb-task-output' }, JSON.stringify(output.page.items, null, 2)), nav(output.page, offset => readOutput(offset))) : null) : null))
    }
    function FishBodySection() {
      const [sections, setSections] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [active, setActive] = useState(null)
      const [retryKey, setRetryKey] = useState(0)
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(null)
      const [lifecycle, setLifecycle] = useState(null)
      const mountedRef = useRef(true)
      const activeRef = useRef(null)
      const tabRefs = useRef([])

      useEffect(() => () => { mountedRef.current = false }, [])
      useEffect(() => {
        let disposed = false
        let timer
        const read = async () => {
          try {
            const response = await fetch('/api/fish-body/state', { credentials: 'same-origin', cache: 'no-store' })
            if (response.ok) {
              const value = await response.json()
              if (!disposed) setLifecycle(value)
            }
          } catch (_) {
            // Native unload can remove the endpoint before React unmounts.
          } finally { if (!disposed) timer = window.setTimeout(read, 500) }
        }
        read().catch(() => {})
        return () => { disposed = true; window.clearTimeout(timer) }
      }, [])
      useEffect(() => { activeRef.current = active }, [active])

      /* 可重试的加载：retryKey 递增即重新拉取，失败文案保持简短。 */
      useEffect(() => {
        let cancelled = false
        setLoadError(null)
        setSections(null)
        fetch('/api/fish-body/sections', { credentials: 'same-origin', cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then((data) => {
            if (cancelled) return
            const list = Array.isArray(data) ? data
              : (data && Array.isArray(data.sections) ? data.sections : null)
            if (list && list.length) {
              setSections(list)
              /* 数据到达后以第一项为默认；重试用仍保留有效的当前分区。 */
              setActive((prev) => list.some((item) => item.id === prev) ? prev : list[0].id)
            } else setLoadError('无法加载分区信息。')
          })
          .catch(() => { if (!cancelled) setLoadError('无法加载分区信息。') })
        return () => { cancelled = true }
      }, [retryKey])

      const current = sections ? sections.find((item) => item.id === active) : null

      /* 切换只换内容，绝不触发打开文件夹。 */
      function switchTo(id) {
        setActive(id)
        setError(null)
      }

      /* 方向键 / Home / End 在分段间移动焦点并切换；Tab、Enter、Space 保持原生行为。 */
      function onTabKeyDown(event, index) {
        const list = sections || []
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % list.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = list.length - 1
        else return
        if (next < 0 || !list[next]) return
        event.preventDefault()
        const node = tabRefs.current[next]
        if (node && typeof node.focus === 'function') node.focus()
        switchTo(list[next].id)
      }

      async function openFolder() {
        if (pending) return
        const requested = active
        setPending(true)
        setError(null)
        /* 组件已卸载或分区已切换时不写错误，避免失败落到别的 tab；pending 仍需复位。 */
        const stillCurrent = () => mountedRef.current && activeRef.current === requested
        try {
          const response = await fetch('/api/fish-body/open', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ section: requested })
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || !data || !data.ok) {
            if (stillCurrent()) {
              const message = (data && data.error) || '打开失败。'
              setError(data && data.reason ? message + ' ' + data.reason : message)
            }
          }
        } catch (_) {
          if (stillCurrent()) setError('无法连接后端。')
        } finally {
          if (mountedRef.current) setPending(false)
        }
      }

      const tabs = h('div', { className: 'fb-tabs', role: 'tablist', 'aria-label': '分区' },
        (sections || []).map((item, index) => h('button', {
          key: item.id,
          ref: (node) => { tabRefs.current[index] = node },
          type: 'button',
          className: 'fb-tab',
          role: 'tab',
          'aria-pressed': active === item.id ? 'true' : 'false',
          'aria-selected': active === item.id ? 'true' : 'false',
          onClick: () => switchTo(item.id),
          onKeyDown: (event) => onTabKeyDown(event, index)
        }, item.title))
      )

      let body
      if (loadError) {
        body = h('div', null,
          h('p', { className: 'fb-note', role: 'status' }, loadError),
          h('button', {
            type: 'button',
            className: 'fb-tab fb-retry',
            onClick: () => setRetryKey((key) => key + 1)
          }, '重试')
        )
      } else if (!sections) {
        body = h('p', { className: 'fb-note', role: 'status' }, '正在加载…')
      } else if (!current) {
        body = h('p', { className: 'fb-note', role: 'status' }, '分区信息不可用。')
      } else {
        body = h('div', { className: 'fb-detail' },
          h('h3', { className: 'fb-name' }, Icon('layers', 17), current.title),
          h('p', { className: 'fb-desc' }, current.description),
          h('div', { className: 'fb-label' }, Icon('folder', 14), '文件夹'),
          h('p', { className: 'fb-path' }, current.path),
          h('div', { className: 'fb-actions' },
            h('button', {
              type: 'button',
              className: 'fb-open',
              'aria-disabled': pending ? 'true' : 'false',
              'aria-busy': pending ? 'true' : 'false',
              onClick: openFolder
            }, Icon('external', 15), pending ? '正在打开…' : '打开文件夹')
          ),
          error ? h('p', { className: 'fb-error', role: 'alert' },
            error,
            h('br'),
            h('span', { className: 'fb-error-path' }, current.path)
          ) : null
        )
      }

      return h('div', { className: 'fb-root' },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE } }),
        h('div', { className: 'fb-head' },
          h('h2', { className: 'fb-title' }, Icon('layers', 18), '鱼的身体'),
          h('p', { className: 'fb-sub' }, '管理插件来源、处理过程与可用工具。'),
          lifecycle ? h('p', { className: 'fb-sub', role: 'status', 'aria-live': 'polite' }, lifecycle.message) : null,
          h('p', { className: 'fb-sub' }, '「鱼的身体」由插件页原生开关统一控制：关闭后「饭→胃→手」统一接入流程、本设置页与内置 SHA-256 工具一并停用；如需按该流程安装，请由用户在插件页手动开启「鱼的身体」，模型不得自行开启。关闭期间普通插件安装仍走 DSH 原生机制，已安装的独立插件（如 dsh-context）不受影响。')
        ),
        h(FishDataPanel, { onState: () => setRetryKey(key => key + 1) }),
        tabs,
        body,
        current?.id === 'stomach' ? h(StomachTasks) : null
      )
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.directoryPicker'],
      apply(ctx) {
        FishDataPanel = installDataClient(React, ctx, 'body')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'fish-body',
          order: 20,
          label: () => '鱼的身体'
        }, FishBodySection))
      }
    }
  }
})
