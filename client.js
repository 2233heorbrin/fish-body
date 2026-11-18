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
      const [task, setTask] = useState(null), [caps, setCaps] = useState([]), [deps, setDeps] = useState(null)
      const [analyses, setAnalyses] = useState([]), [analysisOffset, setAnalysisOffset] = useState(null)
      const [analysisId, setAnalysisId] = useState(''), [taskId, setTaskId] = useState(''), [sourcePath, setSourcePath] = useState('')
      const [initialId, setInitialId] = useState('')
      const [mode, setMode] = useState('compatibility'), [busy, setBusy] = useState(false), [issue, setIssue] = useState('')
      const [output, setOutput] = useState(null), [judgment, setJudgment] = useState('unknown'), [reason, setReason] = useState('')
      const [unknowns, setUnknowns] = useState(null)
      const [editing, setEditing] = useState(null), [decision, setDecision] = useState('pending'), [depReason, setDepReason] = useState('')
      const [change, setChange] = useState(''), [semantic, setSemantic] = useState('unknown'), [accept, setAccept] = useState(false)
      const labels = { compatibility: '兼容拆分', reverse: '逆向拆分', tool: '工具类', brain: '脑区类', mixed: '混合类', unknown: 'unknown / 待判断',
        'selection-pending': '待选择能力', 'plan-pending': '方案待讨论', 'plan-awaiting-confirmation': '方案待确认 / 待执行', 'materials-produced': '组件材料已产出（未解耦）',
        'confirmed-with-open-questions': '已记录确认，仍有待定项', 'confirmed-awaiting-separate-execution': '已确认，执行另行授权', 'materials-confirmed': '组件材料已确认（未解耦）', 'model-reviewed-awaiting-user': '已记录模型意见，待用户确认',
        implementation: '直接实现候选', 'shared-state-initialization': '共享服务、状态与初始化', 'lifecycle-release': '生命周期与释放', 'resources-programs': '资源与外部程序', 'incidental-behavior': '附带行为', 'unresolved-relation': '无法判断的关系',
        pending: '待判断', retain: '保留', narrow: '收窄', exclude: '排除' }
      async function api(args, route = 'task') {
        const response = await fetch('/api/fish-hand/' + route, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
        const value = await response.json()
        if (!response.ok || !value.ok) throw Error(value.error || value.result?.message || value.result?.validity?.reasons?.join('; ') || '结果失效，请刷新并明确选择新的分析。')
        return value.result
      }
      async function run(fn) { if (busy) return; setBusy(true); setIssue(''); try { await fn() } catch (e) { setIssue(e.message) } finally { setBusy(false) } }
      async function listAnalyses(offset = 0) {
        const r = await api({ taskOperation: 'list', taskView: 'analyses', taskOptions: { offset, limit: 20 } })
        setAnalyses(old => offset ? [...old, ...r.page.items] : r.page.items); setAnalysisOffset(r.page.nextOffset)
      }
      function chooseAnalysis(id, result = analyses.find(a => a.id === id)) {
        setAnalysisId(id)
        setInitialId(result?.kind === 'initial' ? id : result?.kind === 'deep' ? result.initialAnalysisId || '' : '')
      }
      useEffect(() => { run(() => listAnalyses()) }, [])
      async function load(id) {
        const t = await api({ taskOperation: 'read', taskId: id }); setTask(t); setTaskId(id); setMode(t.mode); chooseAnalysis(t.analysisId); setOutput(null)
        setJudgment(t.judgment?.value || 'unknown'); setReason(t.judgment?.origin?.reason || '')
        const rows = []; let offset = 0
        do { const r = await api({ taskOperation: 'read', taskId: id, taskView: 'capabilities', taskOptions: { offset, limit: 20 } }); rows.push(...r.page.items); offset = r.page.nextOffset } while (offset !== null)
        setCaps(rows); setDeps((await api({ taskOperation: 'read', taskId: id, taskView: 'dependencies', taskOptions: { limit: 5 } })).page)
        setUnknowns((await api({ taskOperation: 'read', taskId: id, taskView: 'unknowns', taskOptions: { limit: 5 } })).page)
      }
      async function update(patch) { const t = await api({ taskOperation: 'update', taskId: task.taskId, expectedRevision: task.revision, taskPatch: patch }); await load(t.taskId) }
      const attribution = why => ({ kind: 'user', actor: '设置页使用者', reason: why })
      const button = (name, action) => h('button', { type: 'button', className: 'fb-tab', disabled: busy, onClick: () => run(action) }, name)
      const field = (name, value, change, placeholder = '') => h('label', { className: 'fb-task-field' }, name, h('input', { value, disabled: busy, placeholder, onChange: e => change(e.target.value) }))
      const nav = (p, fetchPage) => p ? h('div', { className: 'fb-data-actions' }, h('span', null, p.total + ' 项 · 当前 ' + (p.offset + 1) + '–' + (p.offset + p.items.length)), p.offset > 0 ? button('上一页', () => fetchPage(Math.max(0, p.offset - p.limit))) : null, p.nextOffset !== null ? button('下一页', () => fetchPage(p.nextOffset)) : null) : null
      const modeChoices = h('fieldset', { disabled: busy, className: 'fb-task-modes' }, h('legend', null, '任务模式'), ['compatibility', 'reverse'].map(m => h('label', { key: m }, h('input', { type: 'radio', name: 'stomach-mode', value: m, checked: mode === m, onChange: () => task ? run(() => update({ mode: m })) : setMode(m) }), labels[m])))
      const readOutput = async offset => setOutput(await api({ taskOperation: 'output', taskId: task.taskId, taskOptions: { offset, limit: 5 } }))
      return h('section', { className: 'fb-tasks', 'aria-label': '胃任务' },
        h('h3', null, '能力选择与产出'),
        h('p', { className: 'fb-note' }, '兼容模式形成统一派生插件的待确认方案；逆向模式提供组件源码和证据材料。本页不执行适配、不制作安装包、不安装，也不会调用模型。'),
        modeChoices,
        h('details', { open: !task }, h('summary', null, '分析来源与任务入口'),
          h('label', { className: 'fb-task-field' }, '已有分析结果', h('select', { value: analyses.some(a => a.id === analysisId) ? analysisId : '', disabled: busy, onChange: e => chooseAnalysis(e.target.value) }, h('option', { value: '' }, '选择当前 Profile 的结果'), analyses.map(a => h('option', { key: a.id, value: a.id }, a.id + ' · ' + (a.kind || 'unknown') + ' · ' + a.status)))),
          analysisOffset !== null ? button('更多分析结果', () => listAnalyses(analysisOffset)) : null,
          field('任务分析结果 analysisId', analysisId, chooseAnalysis, '用于创建任务，可选择 initial 或 deep'),
          h('label', { className: 'fb-task-field' }, '深查关联的 initial 初扫', h('select', { value: initialId, disabled: busy, onChange: e => setInitialId(e.target.value) },
            h('option', { value: '' }, '请明确选择同源 initial 结果'),
            initialId && !analyses.some(a => a.kind === 'initial' && a.id === initialId) ? h('option', { value: initialId }, initialId + ' · 已明确关联的 initial') : null,
            analyses.filter(a => a.kind === 'initial').map(a => h('option', { key: a.id, value: a.id }, a.id + ' · initial')))),
          h('p', { className: 'fb-note' }, initialId ? '深查使用上方明确的初扫关联；后端仍校验来源及有效性。任务结果可独立选择 initial 或 deep。' : '尚未确定初扫关联：请在上方选择同源 initial（可加载更多结果），或先明确源码并点击 initial 初扫。查看结果不会自动扫描。'),
          field('明确源码目录', sourcePath, setSourcePath, '源码目录绝对路径，仅只读分析'),
          h('div', { className: 'fb-data-actions' }, button('开始 initial 初扫', async () => { const r = await api({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'local', path: sourcePath } }, 'analysis'); chooseAnalysis(r.analysisId, r); await listAnalyses() }),
            button('显式 deep 深查', async () => { if (!initialId) throw Error('请先明确选择同源 initial 初扫结果；不会自动重新扫描。'); const r = await api({ action: 'analyze', analysisType: 'deep', analysisSource: { kind: 'local', path: sourcePath }, initialAnalysisId: initialId }, 'analysis'); chooseAnalysis(r.analysisId, r); await listAnalyses() }),
            button('创建任务', async () => { const r = await api({ taskOperation: 'create', analysisId, taskMode: mode }); await load(r.taskId) })),
          field('任务 ID', taskId, setTaskId), button('读取任务', () => load(taskId))),
        busy ? h('p', { role: 'status' }, '正在处理…') : null,
        issue ? h('p', { className: 'fb-error', role: 'alert' }, issue) : null,
        task ? h('div', null,
          h('p', { className: 'fb-path' }, task.taskId + ' · 版本 ' + task.revision),
          h('p', { role: 'status', 'aria-live': 'polite' }, labels[task.phase] || task.phase),
          button('刷新任务', () => load(task.taskId)),
          h('h4', null, '整体分类'),
          h('p', null, '程序候选：' + labels[task.classification.value] + '（未确认）'), h('p', { className: 'fb-note' }, task.classification.reason),
          h('p', { className: 'fb-path' }, '依据：' + task.classification.evidenceRefs.join(', ')),
          h('p', null, task.judgment ? '已记录判断：' + labels[task.judgment.value] + ' · ' + task.judgment.origin.kind : '模型 / 用户判断待讨论'),
          h('label', { className: 'fb-task-field' }, '用户分类判断', h('select', { value: judgment, disabled: busy, onChange: e => setJudgment(e.target.value) }, ['unknown', 'tool', 'brain', 'mixed'].map(v => h('option', { key: v, value: v }, labels[v])))),
          field('判断理由', reason, setReason), button('记录用户判断', () => update({ classification: { value: judgment, origin: attribution(reason), evidenceRefs: task.classification.evidenceRefs } })),
          h('h4', null, '选择保留能力'),
          caps.length ? caps.map(c => h('label', { key: c.id, className: 'fb-task-cap' }, h('input', { type: 'checkbox', checked: task.selected.includes(c.id), disabled: busy, onChange: e => { const checked = e.target.checked; run(() => update({ selected: checked ? [...task.selected, c.id] : task.selected.filter(id => id !== c.id) })) } }), c.name + ' · ' + c.category + ' · ' + c.origin.kind, h('small', null, c.id + ' / ' + c.evidenceRefs.join(', ')))) : h('p', null, '没有自动识别的能力；可在当前对话补充有来源的能力，不默认当作工具类。'),
          h('h4', null, '依赖与待定项'), h('p', { className: 'fb-note' }, '模块闭包只是候选范围。共享服务、any 或 unknown 都需要具体讨论，不自动判定必须保留、删除或无法拆分。'),
          deps?.items.map(d => h('div', { key: d.id, className: 'fb-task-dep' }, h('strong', null, labels[d.kind] + ' · ' + labels[d.decision]), h('p', null, d.rationale), h('small', null, d.id + ' · 引用 ' + d.evidenceRefs.join(', ') + (d.scope.truncated ? ' · 证据有截断，使用 query 分页读取' : '')),
            button('编辑依赖决定', async () => { setEditing(d.id); setDecision(d.decision); setDepReason(d.rationale); setChange(d.proposedChange || ''); setSemantic(d.businessSemanticChange); setAccept(false) }))),
          nav(deps, async offset => setDeps((await api({ taskOperation: 'read', taskId: task.taskId, taskView: 'dependencies', taskOptions: { offset, limit: 5 } })).page)),
          editing ? h('fieldset', { disabled: busy }, h('legend', null, '依赖决定 · ' + editing), h('select', { 'aria-label': '处理决定', value: decision, onChange: e => setDecision(e.target.value) }, ['pending', 'retain', 'narrow', 'exclude'].map(v => h('option', { key: v, value: v }, labels[v]))), field('决定理由', depReason, setDepReason), field('拟调整接线（未执行）', change, setChange),
            h('label', null, '业务语义变化', h('select', { value: semantic, onChange: e => setSemantic(e.target.value) }, ['unknown', 'yes', 'no'].map(v => h('option', { key: v, value: v }, v)))),
            editing.endsWith(':D5') ? h('label', null, h('input', { type: 'checkbox', checked: accept, onChange: e => setAccept(e.target.checked) }), '明确接受本条理由中说明的附带行为') : null,
            button('保存依赖决定', async () => { await update({ dependencyDecisions: [{ id: editing, decision, rationale: depReason, origin: attribution(depReason), proposedChange: change, businessSemanticChange: semantic, acceptIncidental: accept, ...(accept ? { acceptanceReason: depReason } : {}) }] }); setEditing(null) })) : null,
          h('details', null, h('summary', null, '待定项 · ' + task.unknownCount), unknowns?.items.map((u, i) => h('p', { key: i }, u.text + ' · ' + u.origin.kind + ' · ' + u.evidenceRefs.join(', '))), nav(unknowns, async offset => setUnknowns((await api({ taskOperation: 'read', taskId: task.taskId, taskView: 'unknowns', taskOptions: { offset, limit: 5 } })).page))),
          h('p', { className: 'fb-note' }, '诊断：' + JSON.stringify(task.completeness.runs.map(r => ({ run: r.name, ...r.completeness })))),
          h('p', { className: 'fb-note' }, '当前对话可用 fish_hand action=task，taskId=' + task.taskId + ' 读取 / 补充判断；更新需 expectedRevision=' + task.revision + '。原始证据用 action=query、analysisId=' + task.analysisId + ' 分页读取。页面不会代替模型作出判断。'),
          h('div', { className: 'fb-data-actions' }, button(task.mode === 'compatibility' ? '生成兼容方案' : '生成逆向材料', async () => { await api({ taskOperation: 'produce', taskId: task.taskId, expectedRevision: task.revision }); await load(task.taskId); await readOutput(0) }),
            button('读取当前产出', () => readOutput(0)), button('确认当前方案版本', async () => { const why = reason.trim(); if (!why) throw Error('请填写本次确认理由；确认不代表部署授权。'); await api({ taskOperation: 'confirm', taskId: task.taskId, expectedRevision: task.revision, taskConfirmation: attribution(why) }); await load(task.taskId) })),
          h('p', { className: 'fb-note' }, '变更模式、能力或内容会使原确认失效，旧产出保留。确认仅针对当前版本；适配和安装尚未开放。'),
          task.outputs.map(o => h('p', { key: o.revision, className: 'fb-path' }, '版本 ' + o.revision + ' · ' + o.kind + ' · ' + o.path)),
          output ? h('section', { 'aria-label': '产出内容' }, h('h4', null, '产出内容'), h('pre', { className: 'fb-task-output' }, JSON.stringify(output.page.items, null, 2)), nav(output.page, readOutput)) : null) : null)
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
