// Embedded in this package's native client entry by tools/sync-client.mjs.
export function installDataClient(React, ctx, component) {
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
    const [copyState, setCopyState] = React.useState('')
    const [history, setHistory] = React.useState([])
    React.useEffect(() => {
      if (component === 'body' && (error || (value && value.status !== 'ready'))) setExpanded(true)
    }, [value?.status, error])
    const pushHistory = (kind, message) => setHistory(old => [{ at: new Date().toLocaleString('zh-CN', { hour12: false }), kind, message: String(message || '').slice(0, 400) }, ...old].slice(0, 8))
    React.useEffect(() => { if (error) pushHistory('读取/操作', error) }, [error])
    const commit = result => { setValue(result); onState?.(result) }
    React.useEffect(() => {
      if (component !== 'body') return
      const update = (value, error) => { if (error) setError(error.message); else { setError(''); commit(value) } }
      listeners.add(update)
      return () => listeners.delete(update)
    }, [])
    React.useEffect(() => { let live = true; request().then(value => { if (live) commit(value) }).catch(error => { if (live) setError(error.message) }); return () => { live = false } }, [])
    const run = async (operation, label) => {
      setPending(true); setError(''); setCopyState('')
      try { const result = await operation(); if (label) pushHistory(label, '完成'); return result } catch (error) { if (label) pushHistory(label, error.message); setError(error.message) }
      finally { setPending(false) }
    }
    const select = () => run(async () => {
      const result = await ctx.remote.directoryPicker.pick()
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value) return request()
      return request({ action: 'select', path: result.value })
    }, '选择目录')
    const open = section => run(async () => {
      const response = await fetch(base + '/open', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      return request()
    }, '打开文件夹')
    const summaryText = () => {
      const detail = error || value?.error || value?.dependencies?.error || ''
      return [
        '鱼的身体 · 数据诊断摘要',
        '状态：' + (value?.status || '未读取'),
        '数据根目录：' + (value?.root || '未绑定'),
        'Profile：' + (value?.profileDir || '未记录'),
        '程序准备：' + (value?.dependencies?.status || '未记录'),
        '最近问题：' + (detail || '无'),
        '诊断记录：' + (history.length ? history.map(x => x.at + ' ' + x.kind + '：' + x.message).join(' / ') : '无')
      ].join('\n')
    }
    const copy = async () => {
      setCopyState('')
      const text = summaryText()
      try {
        if (!navigator.clipboard?.writeText) throw new Error('浏览器未开放复制权限')
        await navigator.clipboard.writeText(text)
        setCopyState('ok')
      } catch (_) { setCopyState('fail') }
    }
    const labels = { ready: '初始化完成', 'pending-workspace': '待选择工作区', 'invalid-root': '原目录失效，请选择新位置',
      'pending-initialization': '待补齐目录', 'invalid-config': '配置无效' }
    if (component === 'body') {
      const preparation = value?.dependencies
      const preparationLabels = { ready: '程序准备已完成', 'not-prepared': '程序尚未准备',
        'host-blocked': '宿主暂不支持完整安装接管', 'restart-required': '新位置已保存，请重新加载身体后使用' }
      const detail = error || value?.error || preparation?.error
      const failed = Boolean(error || value?.error || preparation?.status === 'failed')
      const retry = () => run(() => request({ action: 'retry' }), '重试准备').then(result => { if (result) commit(result) })
      const diag = h('section', { className: 'fb-diag', 'aria-label': '近期诊断' },
        h('h4', null, '近期诊断'),
        history.length ? h('ul', { className: 'fb-diag-list' }, history.map((x, i) => h('li', { key: x.at + i },
          h('span', null, x.at + ' · ' + x.kind, '：', x.message),
          h('details', null, h('summary', null, '展开详情'), h('pre', null, x.message)))))
          : h('p', { className: 'fb-note' }, '暂无诊断记录；下方操作的结果会显示在这里。'),
        h('p', { className: 'fb-note' }, '摘要只含目录、状态与错误文字，不含凭据、人格或记忆内容；复制仅在本地生成文本，不发送、不上传。'),
        h('div', { className: 'fb-data-actions' },
          h('button', { type: 'button', className: 'fb-tab', onClick: copy }, '复制诊断摘要'),
          copyState === 'ok' ? h('span', { className: 'fb-copy-ok', role: 'status' }, '已复制到剪贴板，请自行粘贴。') : null,
          copyState === 'fail' ? h('span', { className: 'fb-error', role: 'alert' }, '复制失败：浏览器未开放剪贴板权限，请手动选择上方文本复制。') : null))
      return h('section', { 'aria-label': '数据设置', className: 'fb-data' },
        failed ? h('div', { className: 'fb-data-issue' },
          h('p', { className: 'fb-error', role: 'alert' }, error || value?.error ? '数据操作失败，请重试。' : '程序准备失败，请重试。'),
          h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: retry }, pending ? '正在准备…' : '重试准备'))
          : preparation ? h('p', { className: 'fb-note', role: 'status' }, preparationLabels[preparation.status] || '程序准备：' + preparation.status) : null,
        detail ? h('details', { className: 'fb-data-error' },
          h('summary', null, '查看原始错误'), h('pre', null, detail)) : null,
        h('details', { className: 'fb-data-settings', open: expanded, onToggle: event => setExpanded(event.currentTarget.open) },
          h('summary', null, '数据设置（技术细节）', h('span', { className: 'fb-data-status', role: 'status' },
            value ? value.status === 'ready' ? '数据目录已绑定' : labels[value.status] || value.status : '正在读取配置…')),
          h('div', { className: 'fb-data-content' },
            value?.root ? h('p', null, '数据根目录：', value.root) : null,
            value?.profileDir ? h('p', null, 'Profile：', value.profileDir) : null,
            h('p', { className: 'fb-note' }, '切换位置只更新绑定，不会搬迁旧数据。程序依赖单独准备。'),
            h('div', { className: 'fb-data-actions' },
              h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: select }, value?.root ? '切换数据位置' : '选择文件夹'),
              h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: () => run(() => request({ action: 'initialize', sessionId: current() }), '使用当前工作区') }, '使用当前对话工作区'),
              !failed ? h('button', { type: 'button', className: 'fb-tab', disabled: pending, onClick: retry }, pending ? '正在准备…' : '重试准备') : null))),
        diag)
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
