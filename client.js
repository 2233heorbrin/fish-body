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
      const value = result.value ? await request({ action: 'select', path: result.value }) : await request()
      commit(value)
      return value
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

// END SHARED DATA CLIENT
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    const STYLE = `
.fb-root{--fb-label:#1f2328;--fb-label2:#5b6570;--fb-brand:#2f6feb;--fb-border:#d3d8de;--fb-border1:#e2e6ea;--fb-bg2:rgba(128,128,128,.08);--fb-radius:10px;--fb-sm:6px;--fb-err:#c92a2a;--fb-errbg:#fff5f5;--fb-errborder:#ffc9c9;--fb-warn:#d9480f;--fb-warnbg:#fffaf3;--fb-warnborder:#ffc9a3;--fb-ok:#1a7f37;--fb-okbg:#eaf7ee;--fb-okborder:#b7e2c4;box-sizing:border-box;width:100%;max-width:none;color:var(--fb-label);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6}
.fb-root *,.fb-root *::before,.fb-root *::after{box-sizing:border-box}
.fb-root button,.fb-root input,.fb-root select{font-family:inherit}
.fb-crumb{margin:0 0 10px;color:var(--fb-label2);font-size:12.5px}
.fb-title{margin:0;color:var(--fb-label);font-size:20px;font-weight:600;line-height:1.4}
.fb-sub{margin:4px 0 18px;color:var(--fb-label2);font-size:13px}
.fb-demo{display:inline-block;margin:0 0 18px;padding:3px 10px;border:1px solid #ffe0a3;border-radius:6px;background:#fff7e6;color:#8a5a00;font-size:12px}
.fb-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px;border-bottom:1px solid var(--fb-border1)}
.fb-nav{appearance:none;display:inline-flex;align-items:center;padding:9px 12px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--fb-label2);font-size:13.5px;line-height:1.4;cursor:pointer}
.fb-nav:hover{color:var(--fb-label);background:rgba(128,128,128,.05)}
.fb-nav[aria-pressed="true"]{color:var(--fb-brand);border-bottom-color:var(--fb-brand);font-weight:600}
.fb-nav:focus-visible,.fb-tab:focus-visible,.fb-open:focus-visible,.fb-mitem:focus-visible{outline:2px solid var(--fb-brand);outline-offset:2px}
/* 主导航工作区外壳：返回按钮在 fb-root 外，外壳自带同样的变量/字体/内边距，避免贴边与样式丢失（#286-1） */
.fb-mainpage{--fb-label:#1f2328;--fb-label2:#5b6570;--fb-brand:#2f6feb;--fb-border:#d3d8de;--fb-border1:#e2e6ea;--fb-bg2:rgba(128,128,128,.08);--fb-radius:10px;--fb-sm:6px;--fb-err:#c92a2a;--fb-errbg:#fff5f5;--fb-errborder:#ffc9c9;--fb-warn:#d9480f;--fb-warnbg:#fffaf3;--fb-warnborder:#ffc9a3;--fb-ok:#1a7f37;--fb-okbg:#eaf7ee;--fb-okborder:#b7e2c4;box-sizing:border-box;min-height:100%;padding:16px 20px 28px;overflow-y:auto;overscroll-behavior:contain;color:var(--fb-label);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6}
.fb-mainpage *,.fb-mainpage *::before,.fb-mainpage *::after{box-sizing:border-box}
.fb-mainbar{display:flex;align-items:center;margin:0 0 14px}
.fb-mainbar .fb-back{margin:0}
.fb-page{margin:0}
.fb-sec{margin:0 0 22px}
.fb-tasks-incomplete .fb-stomach-full{display:none}
.fb-sec>:first-child{margin-top:0}
.fb-sec h3{margin:0 0 10px;color:var(--fb-label);font-size:15px;font-weight:600;line-height:1.5}
.fb-sec h4{margin:14px 0 8px;font-size:13.5px;font-weight:600}
.fb-subtle{font-size:12.5px;color:var(--fb-label2)}
.fb-note{margin:8px 0 0;font-size:12.5px;color:var(--fb-label2)}
.fb-lead{margin:0 0 18px;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:var(--fb-bg2);font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.fb-lead b{font-weight:600}
.fb-btn,.fb-tab,.fb-open{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;margin:8px 8px 0 0;padding:6px 12px;border:1px solid var(--fb-border);border-radius:var(--fb-sm);background:#fff;color:var(--fb-label);font-size:12.5px;line-height:1.5;cursor:pointer;white-space:nowrap}
.fb-btn:hover,.fb-tab:hover,.fb-open:hover{background:#fafbfc}
.fb-tab[aria-pressed="true"],.fb-tab.fb-primary{border-color:#b9d0fb;background:#f5f9ff;color:var(--fb-brand)}
.fb-tab.fb-dark,.fb-open.fb-dark{border-color:#1f2328;background:#1f2328;color:#fff}
.fb-tab.fb-dark:hover,.fb-open.fb-dark:hover{background:#343a40;color:#fff}
.fb-tab:disabled,.fb-open:disabled,.fb-mitem:disabled{opacity:.55;cursor:default}
.fb-actions{margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:0}
.fb-tag,.fb-badge{display:inline-block;margin-left:6px;padding:1px 8px;border:1px solid var(--fb-border);border-radius:20px;background:#fff;color:var(--fb-label2);font-size:11px;font-weight:600;line-height:1.6;white-space:nowrap}
.fb-tag.ok,.fb-badge.ok{border-color:var(--fb-okborder);background:var(--fb-okbg);color:var(--fb-ok)}
.fb-tag.warn,.fb-badge.warn{border-color:var(--fb-warnborder);background:var(--fb-warnbg);color:var(--fb-warn)}
.fb-tag.err,.fb-badge.error{border-color:var(--fb-errborder);background:var(--fb-errbg);color:var(--fb-err)}
.fb-tag.info,.fb-badge.info{border-color:#b9d0fb;background:#f5f9ff;color:var(--fb-brand)}
.fb-tag.demo{border-color:#ffe0a3;background:#fff7e6;color:#8a5a00}
.fb-chip{display:inline-block;margin:0 6px 6px 0;padding:3px 11px;border:1px solid var(--fb-border);border-radius:20px;background:#fff;color:var(--fb-label2);font-size:12px;line-height:1.6;white-space:nowrap}
.fb-chip.done{border-color:var(--fb-okborder);background:var(--fb-okbg);color:var(--fb-ok)}
.fb-chip.cur{border-color:var(--fb-warnborder);background:var(--fb-warnbg);color:var(--fb-warn)}
.fb-stage{display:flex;flex-wrap:wrap;gap:0;margin:0 0 4px}
.fb-kv{display:grid;grid-template-columns:100px minmax(0,1fr);gap:5px 10px;margin:8px 0 0;font-size:13px}
.fb-kv .fb-k{color:var(--fb-label2)}
.fb-kv .fb-v{overflow-wrap:anywhere}
.fb-code{display:inline-block;padding:1px 7px;border:1px solid #ffe0a3;border-radius:var(--fb-sm);background:#fff7e6;color:#8a5a00;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.fb-path{margin:0;padding:8px 10px;border:1px solid var(--fb-border1);border-radius:var(--fb-sm);background:#fafbfc;color:var(--fb-label2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;overflow-wrap:anywhere;user-select:text}
.fb-foot{margin:10px 0 0;padding-top:14px;border-top:1px solid var(--fb-border1);color:var(--fb-label2);font-size:12.5px;line-height:1.7}
.fb-item{margin:0 0 11px;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-item:last-child{margin-bottom:0}
.fb-item-head{display:flex;flex-wrap:wrap;gap:0;align-items:center;margin-bottom:6px}
.fb-item-head strong{font-size:13.5px;font-weight:600}
.fb-ih{margin:0 0 4px;font-size:13.5px;font-weight:600}
.fb-steps{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
.fb-step{padding:4px 12px;border:1px solid var(--fb-border1);border-radius:20px;color:var(--fb-label2);font-size:12.5px;line-height:1.6}
.fb-step.on{border-color:var(--fb-warnborder);background:var(--fb-warnbg);color:var(--fb-warn);font-weight:600}
.fb-errbox{margin:14px 0;padding:12px 15px;border:1px solid var(--fb-errborder);border-radius:var(--fb-radius);background:var(--fb-errbg);color:var(--fb-err);font-size:13px;line-height:1.7}
.fb-errbox .fb-et{margin:0 0 4px;font-size:13.5px;font-weight:600;color:var(--fb-err)}
.fb-errbox p{margin:4px 0}
.fb-warnbox{margin:14px 0;padding:12px 15px;border:1px solid var(--fb-warnborder);border-radius:var(--fb-radius);background:var(--fb-warnbg);color:var(--fb-warn);font-size:13px;line-height:1.7}
.fb-warnbox strong{font-size:13.5px}
.fb-warnbox p{margin:4px 0;color:var(--fb-label)}
.fb-tech{margin-top:12px;padding:8px 12px;border:1px solid var(--fb-border1);border-radius:var(--fb-sm);background:#fafbfc;font-size:12.5px;color:var(--fb-label2)}
.fb-tech summary{cursor:pointer;color:var(--fb-label);font-size:12.5px}
.fb-tech>div{padding-top:8px}
.fb-listwrap{display:flex;align-items:stretch;gap:14px}
.fb-mlist{flex:0 0 220px;min-width:0;overflow:hidden;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-mitem{appearance:none;display:block;width:100%;padding:11px 13px;border:0;border-bottom:1px solid var(--fb-border1);background:#fff;color:var(--fb-label);font-size:13px;line-height:1.6;text-align:left;cursor:pointer}
.fb-mitem:last-child{border-bottom:0}
.fb-mitem:hover{background:#fafbfc}
.fb-mitem.sel{background:#f0f5ff;box-shadow:inset 3px 0 0 var(--fb-brand)}
.fb-mitem .fb-mi-title{font-weight:600}
.fb-mitem .fb-mi-sub{margin-top:2px;color:var(--fb-label2);font-size:12px}
.fb-detail{flex:1;min-width:0;padding:14px 16px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-detail h4{margin:0 0 10px;font-size:14px;font-weight:600}
.fb-detail h4 .fb-tag,.fb-detail h4 .fb-badge{vertical-align:middle}
.fb-detail .fb-actions{margin-top:10px}
.fb-rice-tool{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.fb-seg{display:inline-flex;border:1px solid var(--fb-border);border-radius:8px;overflow:hidden}
.fb-seg button{appearance:none;font:inherit;font-size:12.5px;padding:6px 14px;background:#fff;color:var(--fb-label2);border:0;cursor:pointer;line-height:1.6}
.fb-seg button+button{border-left:1px solid var(--fb-border)}
.fb-seg button.on{background:var(--fb-brand);color:#fff;font-weight:600}
.fb-seg button:focus-visible{outline:2px solid var(--fb-brand);outline-offset:-2px}
.fb-rice-progress{margin:8px 0;font-size:12.5px;color:var(--fb-label2)}
.fb-rice-hint{margin:8px 0;padding:6px 10px;border:1px solid var(--fb-okborder);border-radius:var(--fb-sm);background:var(--fb-okbg);color:var(--fb-ok);font-size:12.5px;line-height:1.6}
.fb-rice-layout{display:flex;align-items:flex-start;gap:14px}
.fb-rice-list{flex:0 0 220px;min-width:0;max-height:460px;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-rice-item{appearance:none;display:block;width:100%;padding:11px 13px;border:0;border-bottom:1px solid var(--fb-border1);background:#fff;color:var(--fb-label);font-size:13px;line-height:1.6;text-align:left;cursor:pointer}
.fb-rice-item:last-child{border-bottom:0}
.fb-rice-item:hover{background:#fafbfc}
.fb-rice-item.sel{background:#f0f5ff;box-shadow:inset 3px 0 0 var(--fb-brand)}
.fb-rice-item:focus-visible{outline:2px solid var(--fb-brand);outline-offset:-2px}
.fb-rice-item-nm{font-weight:600}
.fb-rice-item-sf{margin-top:2px;color:var(--fb-label2);font-size:12px}
.fb-rice-detail{flex:1;min-width:0;padding:14px 16px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-rice-detail-h{display:flex;flex-wrap:wrap;align-items:center;gap:0 6px;margin-bottom:10px}
.fb-rice-detail-h h4{margin:0;font-size:14px;font-weight:600}
.fb-rice-detail .fb-actions{margin-top:10px}
.fb-rice-empty{color:var(--fb-label2);text-align:center;padding:26px 14px}
.fb-rice-local{margin-top:12px;font-size:12.5px;color:var(--fb-label2)}
@media(max-width:700px){.fb-rice-layout{flex-direction:column}.fb-rice-list{flex:1 1 auto;width:100%;max-height:220px;display:block;overflow-y:auto}.fb-rice-item{border-bottom:1px solid var(--fb-border1)}}
.fb-ver-main{margin:12px 0;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:var(--fb-bg2);font-size:13px;line-height:1.7}
.fb-ver-main .fb-et{margin:0 0 6px;color:var(--fb-label);font-size:13.5px;font-weight:600}
.fb-ver-main .fb-kv{grid-template-columns:110px minmax(0,1fr)}
.fb-verbox{margin:12px 0;padding:12px 14px;border:1px solid var(--fb-warnborder);border-radius:var(--fb-radius);background:var(--fb-warnbg);font-size:13px;line-height:1.7}
.fb-verbox .fb-et{margin:0 0 6px;color:var(--fb-warn);font-size:13.5px;font-weight:600}
.fb-verbox .fb-kv{grid-template-columns:100px 1fr}
.fb-verbox .fb-v{font-weight:600}
.fb-verbox.fb-verbox-err{border-color:var(--fb-errborder);background:var(--fb-errbg)}
.fb-verbox.fb-verbox-err .fb-et{color:var(--fb-err)}
.fb-grp{margin:0 0 12px;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-grp:last-child{margin-bottom:0}
.fb-grp>h4{margin:0 0 8px;font-size:13.5px;font-weight:600}
.fb-comp{padding:10px 0;border-top:1px solid var(--fb-border1)}
.fb-comp:first-of-type{border-top:0}
.fb-comp-grid{display:grid;grid-template-columns:168px minmax(0,1fr);gap:14px}
.fb-cn{min-width:0}
.fb-cn strong{display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere}
.fb-cn .fb-tag,.fb-cn .fb-badge{margin:4px 0 0}
.fb-cd{min-width:0;font-size:12.5px;color:var(--fb-label2);overflow-wrap:anywhere}
.fb-cd .fb-kv{margin-top:4px;font-size:12.5px}
.fb-cd .fb-kv .fb-k{color:var(--fb-label2)}
.fb-statebar{margin:0 0 18px;padding:12px 14px;border:1px solid var(--fb-warnborder);border-radius:var(--fb-radius);background:var(--fb-warnbg);color:var(--fb-label);font-size:13px;line-height:1.7}
.fb-statebar b{color:var(--fb-warn)}
.fb-mode-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}
.fb-mode-card{padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff;cursor:pointer;text-align:left}
.fb-mode-card.on{border-color:var(--fb-brand);background:#f5f9ff}
.fb-mode-card strong{display:block;font-size:13.5px;font-weight:600}
.fb-mode-card>span{display:block;margin-top:4px;color:var(--fb-label2);font-size:12.5px;line-height:1.6}
.fb-feat-card{margin:0 0 11px;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-feat-card:last-child{margin-bottom:0}
.fb-feat-card h4{margin:0 0 6px;font-size:13.5px;font-weight:600}
.fb-feat-card p{margin:3px 0;font-size:12.5px;line-height:1.7}
.fb-feat-card b{color:var(--fb-label2);font-weight:600}
.fb-cap-row{display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--fb-border1)}
.fb-cap-row:last-child{border-bottom:0}
.fb-cap-row .fb-tag,.fb-cap-row .fb-badge{margin:0;flex:0 0 auto}
.fb-cap-t{font-size:13.5px;font-weight:600}
.fb-cap-d{margin-top:2px;color:var(--fb-label2);font-size:12.5px}
.fb-state-row{display:flex;flex-wrap:wrap;gap:0;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--fb-border1)}
.fb-state-row:last-child{border-bottom:0}
.fb-state-row .fb-badge{margin:0 10px 0 0;flex:0 0 auto}
.fb-state-row .fb-state-text{flex:1;min-width:0}
.fb-state-row strong{font-size:13.5px}
.fb-state-row p{margin:2px 0 0;color:var(--fb-label2);font-size:12.5px}
.fb-next{margin:0;padding-left:22px}
.fb-next li{margin:8px 0;font-size:13px}
.fb-error{margin:8px 0 0;color:var(--fb-err);font-size:12.5px;overflow-wrap:anywhere}
.fb-error-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.fb-retry{margin-top:10px}
.fb-icon{flex:0 0 auto;display:block}
.fb-tasks{margin-top:0}
.fb-tasks h4{margin:14px 0 8px;font-size:13.5px}
.fb-tasks small{display:block;color:var(--fb-label2);font-size:12px}
.fb-task-field{display:block;margin:10px 0;font-size:12.5px}
.fb-task-field input,.fb-task-field select,.fb-tasks input:not([type=checkbox]):not([type=radio]),.fb-tasks select{display:block;width:100%;max-width:100%;margin-top:4px;padding:6px 8px;border:1px solid var(--fb-border);border-radius:var(--fb-sm);background:#fff;color:var(--fb-label);font:inherit;font-size:12.5px}
.fb-tasks input[type=checkbox],.fb-tasks input[type=radio]{accent-color:var(--fb-brand)}
.fb-task-modes{display:flex;flex-wrap:wrap;gap:16px;margin:10px 0;padding:10px 12px;border:1px solid var(--fb-border1);border-radius:var(--fb-sm);font-size:12.5px}
.fb-task-cap{display:block;padding:6px 0;font-size:12.5px}
.fb-task-dep{padding:10px 0;border-bottom:1px solid var(--fb-border1)}
.fb-task-dep:last-child{border-bottom:0}
.fb-task-dep p{margin:4px 0;font-size:12.5px}
.fb-task-output{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;margin:8px 0;padding:10px;border:1px solid var(--fb-border1);border-radius:var(--fb-sm);background:#fafbfc;color:var(--fb-label2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.fb-tasks :focus-visible{outline:2px solid var(--fb-brand);outline-offset:2px}
.fb-tasks button:disabled{opacity:.55;cursor:default}
.fb-tasks summary{cursor:pointer;padding:4px 0;font-weight:600}
.fb-task-readable ul,.fb-task-readable ol{padding-inline-start:22px}
.fb-detail-grid{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);gap:16px;margin-top:10px}
.fb-detail-grid ul{list-style:none;margin:0;padding:0}
.fb-detail-grid li{margin:0 0 6px}
.fb-detail-grid li button{width:100%;justify-content:flex-start;text-align:left}
.fb-note-box{margin:12px 0;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:var(--fb-bg2);color:var(--fb-label2);font-size:12.5px}
.fb-data{margin:14px 0 18px;overflow-wrap:anywhere}
.fb-data-settings{margin-top:12px;padding:12px 0;border-top:1px solid var(--fb-border1)}
.fb-data summary{cursor:pointer;font-size:12.5px;font-weight:600}
.fb-data summary:focus-visible{outline:2px solid var(--fb-brand);outline-offset:2px}
.fb-data-status{margin-left:12px;font-weight:400;color:var(--fb-label2)}
.fb-data-content{padding-top:8px}
.fb-data-content p{margin:8px 0;font-size:12.5px}
.fb-data-actions{display:flex;flex-wrap:wrap;align-items:center;gap:0;margin-top:10px}
.fb-data-issue{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.fb-data-issue .fb-error{margin:0}
.fb-data-error{margin-top:8px}
.fb-data-error pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.fb-data button:disabled{opacity:.55;cursor:default}
.fb-diag{margin-top:14px;padding-top:14px;border-top:1px solid var(--fb-border1)}
.fb-diag h4{margin:0 0 8px;font-size:15px}
.fb-diag-list{list-style:none;padding:0;margin:0}
.fb-diag-list li{margin:8px 0;padding:12px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff;font-size:12.5px}
.fb-diag-list li strong{font-size:13.5px}
.fb-diag-list pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:6px 0 0}
.fb-copy-ok{margin-left:8px;color:var(--fb-ok);font-size:12px}
.fb-rice-progress{margin:12px 0;padding:10px 14px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:var(--fb-bg2);color:var(--fb-label2);font-size:12.5px}
.fb-rice-card{margin:0 0 14px;padding:14px 16px;border:1px solid var(--fb-border1);border-radius:var(--fb-radius);background:#fff}
.fb-rice-card:last-child{margin-bottom:0}
.fb-rice-card-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.fb-rice-card-h h4{margin:0;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.fb-rice-desc{margin:6px 0 10px;color:var(--fb-label2);font-size:12.5px;line-height:1.7}
.fb-rice-channel{margin-top:12px;padding-top:10px;border-top:1px solid var(--fb-border1)}
.fb-rice-channel h5{margin:0 0 6px;font-size:13px;font-weight:600}
.fb-rice-channel .fb-source-row{padding-top:6px}
.fb-source-row{padding:10px 0;border-top:1px solid var(--fb-border1)}
.fb-source-row:first-child{border-top:0}
.fb-source-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.fb-source-title{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.fb-source-meta{margin:4px 0 0;color:var(--fb-label2);font-size:12.5px;line-height:1.7}
.fb-source-detail{margin-top:8px}
.fb-history{margin-top:10px}
.fb-history summary{cursor:pointer;font-size:12.5px;font-weight:600}
.fb-history .fb-source-row{margin-top:8px}
@media(max-width:760px){.fb-listwrap{display:block}.fb-mlist{flex:auto;width:100%;margin-bottom:12px}.fb-comp-grid{grid-template-columns:1fr;gap:6px}.fb-mode-grid{grid-template-columns:1fr}.fb-kv{grid-template-columns:88px minmax(0,1fr)}}
@media(max-width:480px){.fb-nav{padding:9px 10px}.fb-lead,.fb-item,.fb-detail,.fb-grp,.fb-tech{padding-left:12px;padding-right:12px}.fb-detail-grid{grid-template-columns:1fr}.fb-actions,.fb-data-actions{gap:6px}.fb-foot{font-size:12px}}
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
      const [task, setTask] = useState(null), [caps, setCaps] = useState(null), [deps, setDeps] = useState(null), [unknowns, setUnknowns] = useState(null), [unknownsOpen, setUnknownsOpen] = useState(false)
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
      const statusText = task ? (labels[task.status] || labels[task.phase] || String(task.status || task.phase || '未确认')) : '未选择任务'
      const incomplete = !!task && (/partial|未完成|diagnostic-partial/.test(String(task.status || task.phase || '')) || task.completeness === false || task.completeness?.complete === false)
      const flow = ['1 选择插件', '2 查看功能', '3 讨论取舍', '4 查看方案', '5 查看产出']
      const flowIndex = incomplete ? 2 : !analysisId ? 0 : !task ? 1 : (task.outputs?.length || task.confirmation) ? 4 : task.explanation ? 3 : 2
      const stageTone = index => index === flowIndex ? 'cur' : index < flowIndex ? 'done' : null
      const copyDiscussion = async () => {
        if (!task) throw Error('尚未选择任务，请先选择任务。')
        if (!navigator.clipboard?.writeText) throw Error('浏览器未开放复制权限，请在技术详情中复制讨论提示。')
        await navigator.clipboard.writeText(task.conversation.prompt)
        setNotice('讨论内容已复制，请粘贴到当前 DSH 对话；尚未发送。')
      }
      const viewPlan = async () => {
        if (!task) throw Error('尚未选择任务，请先选择任务。')
        await readOutput()
        setNotice('已读取当前或所选版本的产出详情，见技术详情。')
      }
      const viewUnknowns = async () => {
        if (!task) throw Error('尚未选择任务，请先选择任务。')
        setDeps(await readPage(task.taskId, 'dependencies'))
        setUnknowns(await readPage(task.taskId, 'unknowns'))
        setUnknownsOpen(true)
        setNotice('已读取当前任务的未完成项（只读分页），不重扫、不生成包。')
      }
      const featureText = (f, key) => {
        const ann = (explanation?.[key] || []).find(e => e.capabilityId === f.id)
        return {
          title: ann?.label || f.name || '未命名功能',
          what: f.description || f.summary || ann?.label || '当前分析未提供做什么的说明。',
          how: f.usage || ann?.usage || '当前分析未提供怎么用，待当前 DSH 对话核对。',
          got: f.outcome || ann?.outcome || '当前分析未提供得到什么，待当前 DSH 对话核对。'
        }
      }
      const retained = task?.features?.retained || []
      const excluded = task?.features?.excluded || []
      const selectRows = [
        ['继续任务', h('select', { value: tasks.some(a => a.id === taskId) ? taskId : '', disabled: busy, onChange: e => { const id = e.target.value; if (id) run(() => load(id)) } },
          h('option', { value: '' }, '选择插件任务'), tasks.map(a => h('option', { key: a.id, value: a.id }, taskLabel(a))))],
        taskOffset !== null ? null : null,
        ['分析结果', h('select', { value: analyses.some(a => a.id === analysisId) ? analysisId : '', disabled: busy, onChange: e => chooseAnalysis(e.target.value) },
          h('option', { value: '' }, '选择插件、分析类型和时间'), analyses.map(a => h('option', { key: a.id, value: a.id }, analysisLabel(a))))]
      ].filter(Boolean)
      return h('div', { className: 'fb-page fb-tasks' + (incomplete ? ' fb-tasks-incomplete' : ''), 'aria-busy': busy },
        h('div', { className: 'fb-lead' }, '查看分析过程、已保存的功能选择与产出。刷新任务状态只读取当前状态，不会自动重扫、生成包或安装；本页不替你选择确认。'),
        issue ? h('div', { className: 'fb-errbox', role: 'alert' }, h('p', { className: 'fb-et' }, '本次操作未完成'), h('p', null, recovery(issue)),
          h('details', { className: 'fb-tech' }, h('summary', null, '原始错误详情'), h('pre', { className: 'fb-task-output' }, issue))) : null,
        notice ? h('p', { className: 'fb-note', role: 'status' }, notice) : null,
        busy ? h('p', { className: 'fb-note', role: 'status' }, '正在处理，请稍候…') : null,
        h('div', { className: 'fb-item' },
          h('div', { className: 'fb-item-head' },
            h('strong', null, task ? nameOf(task) : '尚未选择插件任务'),
            h(Tag, { tone: incomplete ? 'err' : task ? 'warn' : '' }, statusText),
            task ? h(Tag, { tone: null }, labels[task.mode] || task.mode) : null),
          h('div', { className: 'fb-steps' }, flow.map((step, i) => h('span', { key: step, className: 'fb-step' + (i === flowIndex ? ' on' : '') }, step))),
          task ? h('div', { className: 'fb-actions' }, button('刷新任务状态', () => load(task.taskId))) : h('div', { className: 'fb-actions' },
            button('刷新列表', () => Promise.all([list('analyses'), list('tasks')])),
            taskOffset !== null ? button('更多任务', () => list('tasks', taskOffset)) : null,
            analysisOffset !== null ? button('更多分析结果', () => list('analyses', analysisOffset)) : null),
          h(Tech, { title: task ? '更换任务 / 新建任务（折叠，默认不展示）' : '选择任务（默认展开）' },
            h('div', { className: 'fb-kv' }, selectRows.reduce((out, [label, node], i) => {
              out.push(h('span', { className: 'fb-k', key: 'k' + i }, label))
              out.push(h('span', { className: 'fb-v', key: 'v' + i }, node))
              return out
            }, [])),
            h('div', { className: 'fb-actions' }, button('用所选分析新建任务', async () => {
              if (!analysisId) throw Error('尚未选择分析结果，请先从列表中选择。')
              const r = await api({ taskOperation: 'create', analysisId, taskMode: mode })
              await load(r.taskId); await list('tasks')
            })))),
        incomplete ? h('div', { className: 'fb-warnbox', role: 'status' },
          h('strong', null, '本次分析未完成 · 部分结果待核对'),
          h('p', null, '发生什么：本次分析停在中间步骤，尚未产出完整结论。'),
          h('p', null, h('b', null, '影响：'), '未完成的结果暂不可据此下结论；不算分析已完成，也不代表当前方案已验收。已保存的功能选择与历史材料仍保留。'),
          h('p', null, '下一步：查看未完成项，或在当前 DSH 对话核对后刷新任务状态。')) : null,
        incomplete && task ? h('section', { className: 'fb-sec' },
          h('h3', null, '已保存的功能选择（来自上次，仍可查看）'),
          retained.length ? h('div', null, retained.map(f => {
            const text = featureText(f, 'retained')
            return h('p', { key: f.id, className: 'fb-note' }, h('b', null, text.title + ' — '), text.what)
          })) : h('p', { className: 'fb-note' }, '当前没有可查看的已保存功能选择。')) : null,
        incomplete && task ? h('section', { className: 'fb-sec' },
          h('h3', null, '操作'),
          h('div', { className: 'fb-actions' },
            button('查看未完成项', viewUnknowns),
            button('刷新任务状态', () => load(task.taskId)),
            button('复制讨论内容', copyDiscussion)),
          h('p', { className: 'fb-note' }, '刷新任务状态只读取当前状态，不会自动重扫、生成包或安装。'),
          unknownsOpen ? h('section', { className: 'fb-sec', 'aria-label': '未完成项（只读）' },
            h('h3', null, '未完成项（只读）'),
            unknowns?.items?.length ? h('ul', null, unknowns.items.map((u, i) => h('li', { key: i }, u.text))) : h('p', { className: 'fb-note' }, '暂无记录的未完成项'),
            nav(unknowns, async offset => setUnknowns(await readPage(task.taskId, 'unknowns', offset)))) : null,
          h(Tech, { title: '技术详情（折叠，默认不展示）' },
            unknownsOpen && unknowns?.items?.length ? h('details', null, h('summary', null, '未完成项技术编号（只读）'), h('pre', { className: 'fb-task-output' }, JSON.stringify(unknowns.items.map(u => ({ text: u.text, origin: u.origin.kind, evidenceRefs: u.evidenceRefs })), null, 2))) : null,
            h('p', { className: 'fb-path' }, '任务 ' + task.taskId + ' · 版本 ' + task.revision + ' · 分析 ' + task.analysisId),
            h('p', { className: 'fb-note' }, '完成度：' + (task.completeness?.complete === false || task.completeness === false ? '部分结果待核对' : '以服务端结果为准')),
            h('details', null, h('summary', null, '讨论提示（仅复制，不发送）'), h('p', null, task.conversation.prompt))),
          h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 本次未完成的结果暂不可据此下结论；确认与安装由用户另行决定。')) : null,
        h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '当前模式'),
          h('div', { className: 'fb-mode-grid' }, [['compatibility', '兼容拆分', '保留选定功能，并拟定与已有组件的适配方案。'], ['reverse', '逆向拆分', '理解并提取组件实现与依赖；后续开发由用户或模型另行决定。']].map(([value, title, desc]) =>
            h('button', { key: value, type: 'button', className: 'fb-mode-card' + (mode === value ? ' on' : ''), disabled: busy,
              onClick: () => task ? run(() => update({ mode: value })) : setMode(value) },
              h('strong', null, title, mode === value ? h(Tag, { tone: 'info' }, '当前选择') : null),
              h('span', null, desc))))),
        h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '本次目标'),
          h('div', { className: 'fb-lead' }, explanation?.goal || '待当前 DSH 对话了解你的功能目标。当前模式：' + labels[task?.mode || mode] + '。'),
          task ? h('p', { className: 'fb-note' }, '整体分类：' + labels[task.classification.value] + '（程序候选，尚非语义结论）' + (task.judgment ? '；已记录' + (task.judgment.origin.kind === 'current-model' ? '模型' : '用户') + '判断：' + labels[task.judgment.value] : '；待当前对话讨论。')) : null),
        task ? h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '当前保留的功能 — 做什么 / 怎么用 / 得到什么'),
          retained.length ? retained.map(f => {
            const text = featureText(f, 'retained')
            return h('div', { key: f.id, className: 'fb-feat-card' },
              h('h4', null, text.title),
              h('p', null, h('b', null, '做什么：'), text.what),
              h('p', null, h('b', null, '怎么用：'), text.how),
              h('p', null, h('b', null, '得到什么：'), text.got),
              f.annotation?.reason ? h('p', { className: 'fb-note' }, '模型理由：' + f.annotation.reason) : null)
          }) : h('p', { className: 'fb-note' }, '尚未选择功能，请在技术详情中勾选要保留的功能。'),
          caps?.items.length ? null : h('p', { className: 'fb-note' }, '没有自动识别的功能；可由当前对话核对证据并补充。'),
          nav(caps, async offset => setCaps(await readPage(task.taskId, 'capabilities', offset)))) : null,
        task ? h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '计划排除的功能'),
          excluded.length ? h('div', null, excluded.map(f => {
            const text = featureText(f, 'excluded')
            return h('p', { key: f.id, className: 'fb-note' }, h('b', null, text.title + ' — '), text.what, f.annotation?.reason ? '（模型理由：' + f.annotation.reason + '）' : '')
          })) : h('p', { className: 'fb-note' }, '当前没有排除的功能候选。'),
          (task.features?.excludedCount || 0) > excluded.length ? h('p', { className: 'fb-note' }, '共 ' + task.features.excludedCount + ' 项，完整功能请按技术详情分页查看。') : null) : null,
        task ? h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '模型建议与理由'),
          h('div', { className: 'fb-lead' }, explanation?.recommendation || (task.explanationState === 'stale' ? '任务内容已改变，旧说明不再适用。待当前 DSH 对话重新解释方案。' : '待当前 DSH 对话解释方案；已有选择和分析事实如下，页面不会代替模型推荐。')),
          explanation ? h('p', { className: 'fb-note' }, '当前模型说明 · ' + explanation.origin.actor + '（调用方声明归属，不代表用户已接受）') : null,
          h('h4', null, '使用影响与待选问题'),
          explanation ? h('ul', null, explanation.impacts.map((x, i) => h('li', { key: 'i' + i }, x.text)), explanation.questions.length ? explanation.questions.map((x, i) => h('li', { key: 'q' + i }, x.text)) : h('li', null, '模型未提出额外问题；这不表示依赖已获得用户确认。')) : h('p', null, '依赖中有 ' + task.counts.pending + ' 项待判断，请让当前对话先核对证据。')) : null,
        task ? h('section', { className: 'fb-sec fb-stomach-full' },
          h('h3', null, '当前进度与下一步'),
          h('div', { className: 'fb-stage' }, flow.map((step, i) => h(Chip, { key: step, tone: stageTone(i) }, step))),
          h('p', { className: 'fb-note' }, task.outputs.length ? '已保留 ' + task.outputs.length + ' 份历史产出。确认仅针对具体方案版本，不授予执行或安装权限。' : '当前尚未产出方案或材料。'),
          explanation?.nextSteps?.length ? h('ol', { className: 'fb-next' }, explanation.nextSteps.map((x, i) => h('li', { key: i }, x))) : h('p', { className: 'fb-note' }, '先讨论并记录功能取舍，再形成' + (task.mode === 'compatibility' ? '兼容方案；适配、验证、打包和安装另行处理。' : '源码材料；独立化和新插件开发另行处理。')),
          h('div', { className: 'fb-actions' },
            button('复制讨论内容', copyDiscussion),
            button('查看方案 / 产出', viewPlan),
            typeof onOpenFolder === 'function' && sectionPath ? h('button', { type: 'button', className: 'fb-tab', disabled: busy, onClick: onOpenFolder }, '打开数据目录') : null,
            button('刷新任务状态', () => load(task.taskId))),
          h(Tech, { title: '技术详情（依赖 / 确认 / 产出 / 高级操作，默认折叠）' },
            h('p', { className: 'fb-path' }, '任务 ' + task.taskId + ' · 方案版本 ' + task.revision + ' · 分析 ' + task.analysisId),
            h('p', { className: 'fb-note' }, task.classification.reason),
            h('p', { className: 'fb-path' }, '分类依据：' + task.classification.evidenceRefs.join(', ')),
            h('h4', null, '功能勾选'),
            caps?.items.length ? caps.items.map(c => h('label', { key: c.id, className: 'fb-task-cap' },
              h('input', { type: 'checkbox', checked: task.selected.includes(c.id), disabled: busy, onChange: e => { const checked = e.target.checked; run(() => update({ selected: checked ? [...task.selected, c.id] : task.selected.filter(id => id !== c.id) })) } }),
              c.name, h('small', null, labels[c.category] + ' · ' + (c.origin.kind === 'program' ? '程序候选，待解释' : c.origin.kind === 'current-model' ? '模型补充' : '用户补充')))) : h('p', null, '没有自动识别的功能。'),
            nav(caps, async offset => setCaps(await readPage(task.taskId, 'capabilities', offset))),
            h('div', { className: 'fb-actions' }, button(task.mode === 'compatibility' ? '生成兼容方案' : '生成逆向材料', async () => { await api({ taskOperation: 'produce', taskId: task.taskId, expectedRevision: task.revision }); await load(task.taskId); await list('tasks') })),
            h('p', { className: 'fb-note' }, '功能、模式或相关决定改变后，原确认失效，旧产出保留。此处不执行适配、不生成安装包，也不运行源码。'),
            h('h4', null, '用户分类判断与版本确认'),
            h('label', { className: 'fb-task-field' }, '用户分类判断', h('select', { value: judgment, disabled: busy, onChange: e => setJudgment(e.target.value) }, ['unknown', 'tool', 'brain', 'mixed'].map(v => h('option', { key: v, value: v }, labels[v])))),
            field('判断或确认理由', reason, setReason),
            h('div', { className: 'fb-actions' },
              button('记录用户判断', () => update({ classification: { value: judgment, origin: attribution(reason), evidenceRefs: task.classification.evidenceRefs } })),
              button('确认当前方案版本', async () => { if (!reason.trim()) throw Error('请填写本次确认理由；确认不代表部署授权。'); await api({ taskOperation: 'confirm', taskId: task.taskId, expectedRevision: task.revision, taskConfirmation: attribution(reason) }); await load(task.taskId) })),
            h('h4', null, '依赖决定与证据'),
            button('刷新技术分页', async () => { setDeps(await readPage(task.taskId, 'dependencies')); setUnknowns(await readPage(task.taskId, 'unknowns')) }),
            deps?.items.map(d => h('div', { key: d.id, className: 'fb-task-dep' },
              h('strong', null, labels[d.kind] + ' · ' + labels[d.decision]), h('p', null, d.rationale),
              h('small', null, d.id + ' · ' + d.evidenceRefs.join(', ') + (d.scope.truncated ? ' · 候选证据截断，请用 query 分页核对' : '')),
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
            h('h4', null, '分析新源码（只读，不执行）'),
            field('待分析插件源码文件夹', sourcePath, setSourcePath, '明确的源码目录绝对路径'),
            h('label', { className: 'fb-task-field' }, '深入分析关联的初步分析', h('select', { value: initialId, disabled: busy, onChange: e => setInitialId(e.target.value) }, h('option', { value: '' }, '请选择同源初步分析'),
              initialId && !analyses.some(a => a.id === initialId && a.kind === 'initial') ? h('option', { value: initialId }, '已明确关联的初步分析（后端仍核验）') : null,
              analyses.filter(a => a.kind === 'initial').map(a => h('option', { key: a.id, value: a.id }, analysisLabel(a))))),
            h('div', { className: 'fb-actions' },
              button('开始初步分析', async () => { if (!sourcePath.trim()) throw Error('请填写待分析插件源码文件夹；仅静态分析，不运行插件。'); const r = await api({ action: 'analyze', analysisType: 'initial', analysisSource: { kind: 'local', path: sourcePath } }, 'analysis'); chooseAnalysis(r.analysisId, r); await list('analyses') }),
              button('深入分析（显式）', async () => { if (!initialId) throw Error('尚未确定初扫关联，请先选择同源初步分析。'); if (!sourcePath.trim()) throw Error('请填写待分析插件源码文件夹，后端将核对它与初扫同源。'); const r = await api({ action: 'analyze', analysisType: 'deep', analysisSource: { kind: 'local', path: sourcePath }, initialAnalysisId: initialId }, 'analysis'); chooseAnalysis(r.analysisId, r); await list('analyses') })),
            field('分析结果内部编号', analysisId, chooseAnalysis), field('任务内部编号', taskId, setTaskId), button('按编号读取任务', () => load(taskId)),
            h('h4', null, '当前及历史产出（按需读取）'),
            field('产出版本', outputRevision, v => { setOutputRevision(v); setOutput(null) }),
            h('div', { className: 'fb-actions' }, button('读取产出详情', () => readOutput())),
            task.outputs.map(o => h('p', { key: o.revision, className: 'fb-path' }, '版本 ' + o.revision + ' · ' + o.path)),
            output ? h('section', { 'aria-label': '产出技术内容' }, h('p', null, output.historical ? '历史产出，不能冒充当前方案。' : '当前版本产出'), h('pre', { className: 'fb-task-output' }, JSON.stringify(output.page.items, null, 2)), nav(output.page, offset => readOutput(offset))) : null),
          h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 刷新任务状态只读，不自动重扫；确认与安装由用户另行决定。')) : h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 选择已有任务或分析结果后，可查看功能取舍、方案与产出。'))
    }

    /* ---------- 五页组件（全部内联在同一 factory 内，遵守浏览器单文件约定） ---------- */
    async function fetchJson(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(options || {}) })
      let data = null
      try { data = await response.json() } catch (_) { /* 非 JSON 响应按失败处理 */ }
      if (!response.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + response.status)
      return data
    }
    function Retry({ onRetry, pending }) {
      return h('button', { type: 'button', className: 'fb-tab fb-retry', disabled: !!pending, onClick: onRetry }, pending ? '重试中…' : '重试')
    }
    function stateBadge(value) {
      const map = {
        empty: ['info', '暂无数据'], ok: ['ok', '有数据'], partial: ['warn', '部分完成'], error: ['error', '读取失败'],
        true: ['ok', '已登记'], false: ['neutral', '未登记'], unknown: ['warn', '未确认']
      }
      const pair = map[String(value)] || ['neutral', String(value || '未标注')]
      return h('span', { className: 'fb-badge ' + pair[0] }, pair[1])
    }
    function Tag({ tone, children }) { return h('span', { className: 'fb-tag' + (tone ? ' ' + tone : '') }, children) }
    function Chip({ tone, children }) { return h('span', { className: 'fb-chip' + (tone ? ' ' + tone : '') }, children) }
    function KV({ rows }) {
      return h('div', { className: 'fb-kv' }, rows.reduce((out, row) => {
        if (!row) return out
        out.push(h('span', { className: 'fb-k', key: row[0] + '-k' }, row[0]))
        out.push(h('span', { className: 'fb-v', key: row[0] + '-v' }, row[1]))
        return out
      }, []))
    }
    function Foot({ children }) { return h('p', { className: 'fb-foot' }, children) }
    function Tech({ title, children }) { return h('details', { className: 'fb-tech' }, h('summary', null, title), h('div', null, children)) }

    function OverviewPanel({ onNavigate }) {
      const [data, setData] = useState(null)
      const [issue, setIssue] = useState('')
      const [loading, setLoading] = useState(true)
      const [retryKey, setRetryKey] = useState(0)
      const liveRef = useRef(true)
      useEffect(() => { liveRef.current = true; return () => { liveRef.current = false } }, [retryKey])
      useEffect(() => {
        let cancelled = false
        setLoading(true); setIssue(''); setData(null)
        fetchJson('/api/fish-body/overview')
          .then(value => { if (!cancelled && liveRef.current) setData(value) })
          .catch(error => { if (!cancelled && liveRef.current) setIssue(error.message) })
          .finally(() => { if (!cancelled && liveRef.current) setLoading(false) })
        return () => { cancelled = true }
      }, [retryKey])
      const items = Array.isArray(data?.items) ? data.items : []
      const caps = [
        ['ok', '可用', '插件来源 · 饭', '保存插件上游源码与下载材料，作为分析输入。'],
        ['ok', '可用', '分析与拆分 · 胃 · 功能选择', '查看分析结果、挑选保留与排除的功能。'],
        ['ok', '可用', '兼容方案 / 逆向材料生成', '兼容产出适配方案，逆向产出理解材料。'],
        ['ok', '可用', '目录入口与内置 SHA-256 校验工具', '打开数据目录、按随包校验和释放。'],
        ['todo', '待接入', '兼容可安装派生产物 / 一键适配', '方案之后的安装尚未实现，本页不放可执行安装按钮。']
      ]
      /* 阶段只认明确事实：接口未给出 stages 就一律未确认，不照抄预览里的示例完成态。 */
      const stageValue = key => data?.stages?.[key] || 'unknown'
      const stageChip = (key, label) => {
        const v = stageValue(key)
        return h(Chip, { tone: v === 'done' ? 'done' : v === 'current' ? 'cur' : null },
          (v === 'done' ? '✓ ' : v === 'current' ? '◐ ' : '○ ') + label + (v === 'done' || v === 'current' ? '' : '（未确认）'))
      }
      const abnormal = items.filter(x => x.state === 'error' || x.state === 'partial')
      const issueCard = item => {
        const bad = item.state === 'error'
        return h('div', { key: item.key, className: 'fb-item fb-issue-card' },
          h('div', { className: 'fb-item-head' },
            h('strong', null, item.title || item.key),
            h(Tag, { tone: bad ? 'err' : 'warn' }, bad ? '读取失败' : '部分完成')),
          h(KV, { rows: [
            ['发生什么', item.summary || (bad ? '该分区状态读取失败，具体原因未返回。' : '该分区部分内容待核对。')],
            ['影响', bad ? '本分区当前结论暂不可用；其他分区不受影响。' : '本分区部分结论可查看，但未完成项需核对后才能据此判断。'],
            ['下一步', bad ? '核对数据位置或稍后重试，再到对应分区查看。' : '到对应分区查看未完成项，核对后再判断。']
          ] }),
          ['rice', 'stomach', 'hand'].includes(item.key) ? h('div', { className: 'fb-actions' },
            h('button', { type: 'button', className: 'fb-tab fb-primary', onClick: () => { if (typeof onNavigate === 'function') onNavigate(item.key) } },
              '到「' + (item.title || item.key) + '」查看')) : null)
      }
      const progress = h('section', { className: 'fb-sec' },
        h('h3', null, '总体进度'),
        h('div', { className: 'fb-stage' },
          stageChip('analysis', '分析完成'), stageChip('plan', '方案生成'),
          stageChip('adapter', '适配验证'), stageChip('install', '安装')),
        h('p', { className: 'fb-note' }, '总览接口只提供分区摘要，未提供具体任务的阶段证据；没有明确选定的任务时，四个阶段一律显示「未确认」。'))
      const retryBox = issue ? h('div', null, h('p', { className: 'fb-error', role: 'alert' }, '总览读取失败：' + issue), h(Retry, { onRetry: () => setRetryKey(k => k + 1) })) : null
      const lead = h('div', { className: 'fb-lead' },
        '鱼的身体把一条线串起来：',
        h('b', null, '插件从哪来（饭）→ 怎么分析拆分（胃）→ 装成什么组件（手）'),
        abnormal.length ? '。下面汇总 ' + abnormal.length + ' 处局部异常；身体整体仍可使用。'
          : '。下面说明身体能做什么、进度如何确认，以及你可以从哪里继续。')
      if (abnormal.length) return h('div', { className: 'fb-page' },
        lead,
        h('section', { className: 'fb-sec' },
          h('h3', null, '需要留意的 ' + abnormal.length + ' 处'),
          abnormal.map(issueCard),
          h('p', { className: 'fb-note' }, '以上按概览接口返回的真实分区状态生成；单项失败不代表整个身体故障，也不代表身体被关闭。')),
        progress,
        retryBox,
        loading ? h('p', { className: 'fb-note', role: 'status' }, '正在读取总览…') : null,
        h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 本页为只读概览，不打开文件夹、不启动分析、不检查版本；异常来自分区摘要，不代表真实安装或运行。'))
      return h('div', { className: 'fb-page' },
        lead,
        retryBox,
        h('section', { className: 'fb-sec' },
          h('h3', null, '目前做到哪一步'),
          h('div', { className: 'fb-stage' },
            stageChip('analysis', '分析完成'), stageChip('plan', '方案生成'),
            stageChip('adapter', '适配验证'), stageChip('install', '安装')),
          h('p', { className: 'fb-note' }, '没有明确选定的任务时，四个阶段一律显示「未确认」。请在「胃·分析」选择任务后查看真实状态。')),
        h('section', { className: 'fb-sec' },
          h('h3', null, '身体能做什么 — 已具备与待接入分开看'),
          caps.map(([tone, label, title, desc]) => h('div', { key: title, className: 'fb-cap-row' },
            h(Tag, { tone: tone === 'ok' ? 'ok' : 'warn' }, label),
            h('div', null, h('div', { className: 'fb-cap-t' }, title), h('div', { className: 'fb-cap-d' }, desc))))),
        h('section', { className: 'fb-sec' },
          h('h3', null, '用户下一步做什么'),
          h('ol', { className: 'fb-next' },
            h('li', null, '在「饭·来源」核对已保存的来源材料，作为分析输入。'),
            h('li', null, '在「胃·分析」选择已有任务或分析结果，查看功能取舍与方案进度。'),
            h('li', null, '在「手·组件」查看登记与原生状态；是否启用由你在原生插件开关中决定。'))),
        h('section', { className: 'fb-sec' },
          h('h3', null, '三个分区的当前状态'),
          h('p', { className: 'fb-note' }, '状态来自同一份只读概览；某一项读取失败只影响该项，点击「查看」进入对应分区。'),
          loading ? h('p', { className: 'fb-note', role: 'status' }, '正在读取总览…') : null,
          !loading && !issue && !items.length ? h('div', { className: 'fb-note-box' }, '暂无分区摘要。') : null,
          items.length ? items.map(item => h('div', { key: item.key, className: 'fb-state-row' },
            stateBadge(item.state),
            h('div', { className: 'fb-state-text' },
              h('strong', null, item.title || item.key),
              h('p', null, item.summary || '暂无说明。')),
            ['rice', 'stomach', 'hand'].includes(item.key) ? h('button', {
              type: 'button', className: 'fb-tab',
              onClick: () => { if (typeof onNavigate === 'function') onNavigate(item.key) }
            }, '查看') : null)) : null),
        h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 本页为只读概览，不打开文件夹、不启动分析、不检查版本；能力标记不代表真实安装或运行。'))
    }

    /* 同会话版本检查缓存：切页重入不重复打网络；成功 1h，失败 5min 冷却。 */
    const riceAutoCache = new Map()
    const RICE_AUTO_TTL = 60 * 60 * 1000
    const RICE_FAIL_COOLDOWN = 5 * 60 * 1000

    function RicePanel({ onNavigate, sectionPath }) {
      const [items, setItems] = useState(null)
      const [issue, setIssue] = useState('')
      const [checks, setChecks] = useState({})
      const [retryKey, setRetryKey] = useState(0)
      const [pendingOpen, setPendingOpen] = useState(false)
      const [openIssue, setOpenIssue] = useState('')
      const [expanded, setExpanded] = useState({})
      const [auto, setAuto] = useState({ phase: 'idle', message: '', checkedAt: null, dedupCount: null })
      const [viewChannel, setViewChannel] = useState('github')
      const [picked, setPicked] = useState({ github: null, npm: null })
      const [switchHint, setSwitchHint] = useState('')
      const pickRef = useRef({ github: null, npm: null })
      const scrollRef = useRef({ github: 0, npm: 0 })
      const listRef = useRef(null)
      const segRefs = useRef({})
      const liveRef = useRef(true)
      const autoStartedRef = useRef(false)
      useEffect(() => { liveRef.current = true; autoStartedRef.current = false; return () => { liveRef.current = false } }, [retryKey])
      useEffect(() => { const n = listRef.current; if (n) n.scrollTop = scrollRef.current[viewChannel] || 0 }, [viewChannel])
      useEffect(() => {
        let cancelled = false
        setIssue(''); setItems(null); setChecks({}); setExpanded({}); setAuto({ phase: 'idle', message: '', checkedAt: null, dedupCount: null })
        fetchJson('/api/fish-body/sources')
          .then(value => { if (!cancelled && liveRef.current) { const loaded = Array.isArray(value?.items) ? value.items : []; setItems(loaded) } })
          .catch(error => { if (!cancelled && liveRef.current) setIssue(error.message) })
        return () => { cancelled = true }
      }, [retryKey])

      const compareText = { newer: '有新版', same: '已是最新', localNewer: '本地较新', unknown: '版本关系未确认' }
      const sourceLabel = type => ({ github: 'GitHub 仓库', local: '本地材料', remote: '远端仓库', npm: 'npm 包' }[String(type || '').toLowerCase()] || '来源材料')
      const sourceTone = type => ({ github: 'info', npm: 'info', local: '', remote: '' }[String(type || '').toLowerCase()] || '')
      const isFailedResult = r => !r || ['error', 'unavailable', 'incomparable', 'historical'].includes(r.state)
      const rememberResult = (id, result) => {
        const failed = isFailedResult(result)
        riceAutoCache.set(id, { result, failed, checkedAt: Date.now(), failedAt: failed ? Date.now() : null })
      }
      const applyResults = (results, message, checkedAt, dedupCount) => {
        const rows = Array.isArray(results) ? results : []
        if (!liveRef.current) return
        if (rows.length) {
          const patch = {}
          for (const row of rows) {
            if (!row || !row.id) continue
            patch[row.id] = { pending: false, result: row.result || null, error: '' }
            rememberResult(row.id, row.result || null)
          }
          setChecks(old => ({ ...old, ...patch }))
        }
        setAuto({ phase: 'done', message: message || '', checkedAt: checkedAt || new Date().toISOString(), dedupCount: typeof dedupCount === 'number' ? dedupCount : null })
      }
      const runBatch = async force => {
        setAuto({ phase: 'checking', message: force ? '正在重新检查远端版本…' : '正在检查远端版本…', checkedAt: null, dedupCount: null })
        try {
          const value = await fetchJson('/api/fish-body/check-versions', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(force ? { force: true } : {})
          })
          applyResults(value?.results, value?.dedupCount ? '远端共用 ' + value.dedupCount + ' 次查询；结果按来源分别归档。' : '', value?.checkedAt, value?.dedupCount)
        } catch (error) {
          if (!liveRef.current) return
          setAuto({ phase: 'error', message: '自动版本检查暂不可用：' + error.message, checkedAt: null, dedupCount: null })
        }
      }
      useEffect(() => {
        if (!items || !items.length || autoStartedRef.current) return
        autoStartedRef.current = true
        const now = Date.now()
        const restored = {}
        let needBatch = false
        let newest = null
        for (const x of items) {
          if (!x.hasRemote) continue
          const cached = riceAutoCache.get(x.id)
          if (!cached) { needBatch = true; continue }
          if (cached.failed && now - (cached.failedAt || 0) < RICE_FAIL_COOLDOWN) { restored[x.id] = cached.result; continue }
          if (!cached.failed && now - (cached.checkedAt || 0) < RICE_AUTO_TTL) { restored[x.id] = cached.result; continue }
          needBatch = true
        }
        if (Object.keys(restored).length) {
          const patch = {}
          for (const id of Object.keys(restored)) patch[id] = { pending: false, result: restored[id], error: '' }
          setChecks(old => ({ ...old, ...patch }))
          if (cachedNewest(items, riceAutoCache)) newest = cachedNewest(items, riceAutoCache)
        }
        if (!needBatch) {
          setAuto({ phase: 'done', message: '本次会话已检查，使用会话缓存；失败项仍在冷却期。', checkedAt: newest, dedupCount: null })
          return
        }
        runBatch(false)
      }, [items])

      function cachedNewest(rows, cache) {
        const times = rows.map(x => cache.get(x.id)?.checkedAt).filter(Boolean)
        return times.length ? new Date(Math.max(...times)).toISOString() : null
      }

      const check = async (id, force) => {
        if (checks[id]?.pending) return
        setChecks(old => ({ ...old, [id]: { ...(old[id] || {}), pending: true, error: '' } }))
        try {
          const value = await fetchJson('/api/fish-body/check-version', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(force ? { id, force: true } : { id })
          })
          const result = value?.result || null
          if (liveRef.current) {
            setChecks(old => ({ ...old, [id]: { pending: false, result: result || old[id]?.result || null, error: result ? '' : '版本结论尚未返回，保留上次结果。' } }))
            rememberResult(id, result || { state: 'error', error: '版本结论尚未返回' })
          }
        } catch (error) {
          const failed = { state: 'error', error: error.message }
          if (liveRef.current) {
            setChecks(old => ({ ...old, [id]: { pending: false, result: old[id]?.result || null, error: error.message } }))
            rememberResult(id, failed)
          }
        }
      }
      const open = async () => {
        if (!sectionPath || pendingOpen) return
        setPendingOpen(true); setOpenIssue('')
        try {
          const value = await fetchJson('/api/fish-body/open', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'rice' })
          })
          if (!value?.ok && liveRef.current) setOpenIssue(value?.error || '打开失败。')
        } catch (error) { if (liveRef.current) setOpenIssue(error.message) }
        finally { if (liveRef.current) setPendingOpen(false) }
      }

      /* 真实 sources 里 name 常统一为「仓库」：用 id/path 提取 owner/repo、包名或 local/xxx。 */
      const baseName = x => {
        const id = String(x.id || '').trim()
        const raw = String(x.name || '').trim()
        let candidate = ''
        if (id.startsWith('github.com/')) candidate = id.slice('github.com/'.length)
        else if (id.startsWith('@') || /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(id)) candidate = id
        else if (raw && !/^(仓库|来源|包|package|plugin)$/i.test(raw)) candidate = raw
        else candidate = String(x.path || '').replace(/^饭\//, '').replace(/\/仓库$/, '') || id
        candidate = candidate.replace(/\/仓库$/, '').replace(/^饭\//, '').trim()
        if (!candidate || /^(仓库|来源|包|package|plugin)$/i.test(candidate)) candidate = id || '未命名来源'
        return candidate
      }
      const nameCounts = {}
      for (const x of (items || [])) { const n = baseName(x); nameCounts[n] = (nameCounts[n] || 0) + 1 }
      const displayName = x => {
        const id = String(x.id || '')
        const base = baseName(x)
        const n = base.replace(/market-[0-9a-f]{8}-[0-9a-f-]+/gi, '市场记录')
        if (id.startsWith('npm:')) {
          const rest = id.slice(4)
          const pkg = packageNameOf(x) || rest.split('/')[0] || n.split('/')[0] || '未命名来源'
          return /market-/i.test(rest) ? pkg + ' · npm 市场记录' : pkg + ' · npm 包'
        }
        if ((nameCounts[base] || 0) < 2) return n
        return n + ' · ' + sourceLabel(x.sourceType)
      }
      const packageNameOf = x => String(x.packageNameFromManifest || x.packageName || x.package || '').trim()
      const deriveGroupKey = x => {
        if (x.groupKey) return String(x.groupKey)
        const pkg = packageNameOf(x).toLowerCase()
        if (pkg) return 'pkg:' + pkg
        const m = String(x.id || '').match(/^github\.com\/([^/]+)\/([^/#]+)(?:#(.+))?$/i)
        if (m) return 'gh:' + m[1] + '/' + m[2] + (m[3] ? '#' + encodeURIComponent(m[3]) : '')
        return 'solo:' + String(x.id || '')
      }
      const groups = []
      const indexByKey = new Map()
      for (const x of (items || [])) {
        const key = deriveGroupKey(x)
        if (!indexByKey.has(key)) {
          indexByKey.set(key, groups.length)
          groups.push({ key, rows: [] })
        }
        groups[indexByKey.get(key)].rows.push(x)
      }
      const checkTag = id => {
        const c = checks[id]
        if (!c || c.pending) return null
        if (c.error || c.result?.state === 'error') return h(Tag, { tone: 'err' }, '暂时无法检查')
        if (c.result?.state === 'historical') return h(Tag, { tone: 'err' }, '历史结果·当前未确认')
        if (c.result?.state !== 'ok') return null
        const cmp = c.result.comparison
        if (cmp === 'newer') return h(Tag, { tone: 'warn' }, '有新版本')
        if (cmp === 'same') return h(Tag, { tone: 'ok' }, '已是最新')
        if (cmp === 'local-newer') return h(Tag, { tone: 'info' }, '本地较新')
        return h(Tag, { tone: 'warn' }, '版本未确认')
      }
      const installTag = install => {
        if (!install) return null
        if (install.state === 'installed') {
          const v = install.version || install.installedVersion || '版本未记录'
          const src = install.source || installedChannel(install) || ''
          return h(Tag, { tone: 'ok' }, '当前安装 ' + v + (src ? ' · ' + src : ''))
        }
        if (install.state === 'unconfirmed') return h(Tag, { tone: 'warn' }, '当前安装来源未确认')
        if (install.state === 'not-installed') return h(Tag, { tone: 'info' }, '未安装')
        return h(Tag, { tone: 'info' }, '安装状态未确认')
      }
      function renderCheck(item, compareTarget) {
        const c = checks[item.id]
        if (!c) return null
        if (c.pending) return h('p', { className: 'fb-note', role: 'status' }, '正在检查远端版本…')
        if (c.error) return h('div', { className: 'fb-verbox fb-verbox-err', role: 'alert' },
          h('p', { className: 'fb-et' }, '远端版本暂时无法检查'),
          h('p', null, '本次检查未完成；本地材料仍可用，只是「现在是否最新」尚未确认。'),
          h(KV, { rows: [['本地版本', item.localVersion || '未记录'], ['错误说明', c.error]] }),
          h('div', { className: 'fb-actions' },
            h('button', { type: 'button', className: 'fb-tab fb-primary', onClick: () => check(item.id, true) }, '重新检查'),
            h(Tech, { title: '查看错误详情' }, h('pre', { className: 'fb-task-output' }, c.error))))
        const r = c.result
        if (!r) return h('p', { className: 'fb-note' }, '本次检查没有返回结果。')
        const failed = r.state === 'historical' || r.state === 'error' || r.state === 'unavailable' || r.state === 'incomparable'
        if (failed) return h('div', { className: 'fb-verbox fb-verbox-err', role: r.state === 'historical' ? 'status' : 'alert' },
          h('p', { className: 'fb-et' }, '远端版本暂时无法检查'),
          h('p', null, r.state === 'historical' ? '上次成功结果保留如下，不代表当前状态。' : '本次没有取得可核实的远端版本。'),
          r.state === 'historical' ? h('p', null, h(Tag, { tone: 'err' }, '历史结果·当前未确认')) : null,
          h(KV, { rows: [
            ['本地版本', r.localVersion || item.localVersion || '未记录'],
            ['远端版本', r.remoteVersion || '未取得'],
            ['上次成功', r.lastSuccessAt || '无']
          ] }),
          h('p', { className: 'fb-note' }, '上面的远端版本不是本次结论；本次未确认，也不推断存在新版本。'),
          h('div', { className: 'fb-actions' },
            h('button', { type: 'button', className: 'fb-tab fb-primary', onClick: () => check(item.id, true) }, '重新检查'),
            h(Tech, { title: '查看错误详情' }, h('pre', { className: 'fb-task-output' }, JSON.stringify(r, null, 2)))))
        const cmp = r.comparison || 'unknown'
        const target = compareTarget || '保存材料'
        if (cmp === 'newer') {
          const updateUrl = item.remoteUrl || item.url || r.remoteUrl || r.url || ''
          return h('div', { className: 'fb-verbox' },
            h('p', { className: 'fb-et' }, '发现新版本 · 与' + target + '比较'),
            h(KV, { rows: [
              ['本地版本', r.localVersion || item.localVersion || '未记录'],
              ['远端版本', r.remoteVersion || '未记录'],
              ['检查时间', r.checkedAt || '未记录']
            ] }),
            h('p', { className: 'fb-note' }, '只表示该来源有新版本，不代表已安装版可无缝切换；版本结论只读取后端比较。'),
            h('div', { className: 'fb-actions' }, updateUrl
              ? h('a', { className: 'fb-tab', href: updateUrl, target: '_blank', rel: 'noreferrer' }, '查看来源')
              : null))
        }
        return h('div', { className: 'fb-verbox' },
          h('p', { className: 'fb-et' }, compareText[cmp] || '版本关系未确认'),
          h(KV, { rows: [
            ['本地版本', r.localVersion || item.localVersion || '未记录'],
            ['远端版本', r.remoteVersion || '未记录'],
            ['检查时间', r.checkedAt || '未记录']
          ] }),
          h('p', { className: 'fb-note' }, '版本比较只读取后端结论，前端不做字符串比较。'))
      }
      const sourceRow = (x, compareTarget) => {
        const openDetail = !!expanded[x.id]
        const pending = x.hasRemote && (auto.phase === 'checking' || !!checks[x.id]?.pending)
        const savedAt = x.fetchedAt || x.checkedAt || x.savedAt || x.updatedAt || ''
        return h('div', { key: x.id, className: 'fb-source-row' },
          h('div', { className: 'fb-source-head' },
            h('span', { className: 'fb-source-title' }, displayName(x)),
            h(Tag, { tone: sourceTone(x.sourceType) }, sourceLabel(x.sourceType)),
            x.localVersion ? h(Tag, { tone: 'info' }, '本地 ' + x.localVersion) : null,
            checks[x.id]?.result?.install?.state === 'installed' && checks[x.id].result.install.installedVersion
              ? h(Tag, { tone: 'info' }, '安装版 ' + checks[x.id].result.install.installedVersion) : null,
            checkTag(x.id)),
          h('p', { className: 'fb-source-meta' }, pending ? '正在检查远端版本…' :
            (savedAt ? '已有可读时间：' + String(savedAt) + '；' : '') +
            (x.hasRemote ? '远端来源已登记，版本结论以后端检查为准；未检查时不推断是否最新。' : '本地材料，无远端来源，不标「已是最新」。')),
          h('div', { className: 'fb-actions' },
            h('button', { type: 'button', className: 'fb-tab', 'aria-expanded': openDetail ? 'true' : 'false', onClick: () => setExpanded(old => ({ ...old, [x.id]: !old[x.id] })) }, openDetail ? '收起来源' : '查看来源'),
            x.hasRemote ? h('button', { type: 'button', className: 'fb-tab', disabled: !!checks[x.id]?.pending, onClick: () => check(x.id, true) }, checks[x.id]?.pending ? '正在检查…' : '重新检查') : null),
          openDetail ? h('div', { className: 'fb-source-detail' },
            h(KV, { rows: [
              ['来源类型', sourceLabel(x.sourceType) + '（' + (x.sourceType || '未标注') + '）'],
              ['本地版本', x.localVersion || '未记录'],
              ['远端来源', x.hasRemote ? '已登记' : '无'],
              ['身份依据', String(x.identityBasis || (deriveGroupKey(x).startsWith('solo:') ? 'unconfirmed' : '未记录'))]
            ] }),
            checks[x.id]?.result?.install?.state === 'installed' && ['newer', 'same', 'local-newer'].includes(checks[x.id].result.install.comparison)
              ? h('p', { className: 'fb-note' }, '安装比较：' + (installCompareText[checks[x.id].result.install.comparison] || '版本关系未确认') + '（安装版本 ' + (checks[x.id].result.install.installedVersion || '未记录') + '，与远端版本比较）。')
              : null,
            renderCheck(x, compareTarget),
            h(Tech, { title: '技术详情（来源编号与目录）' },
              h(KV, { rows: [['来源编号', x.id], ['目录路径', x.path || '未记录']] }))) : null)
      }
      const channelOf = x => {
        const t = String(x.sourceType || '').toLowerCase()
        if (t === 'github' || t === 'remote' || String(x.id || '').startsWith('github.com/')) return 'github'
        if (t === 'npm' || String(x.id || '').startsWith('npm:')) return 'npm'
        return 'local'
      }
      const channelLabel = { github: 'GitHub 来源', npm: 'npm 来源', local: '本地材料' }
      const installedSourceId = install => String(install?.sourceId || install?.sourceItemId || install?.materialId || '')
      const installedChannel = install => {
        const sid = installedSourceId(install)
        const raw = String(install?.source || '').toLowerCase()
        if (raw.includes('github') || /^github\.com\//i.test(sid)) return 'github'
        if (raw.includes('npm') || /^npm:/i.test(sid) || /^@[^/]+\//.test(sid)) return 'npm'
        if (raw.includes('local') || /^local:/i.test(sid)) return 'local'
        return ''
      }
      const isInstalledRow = (x, install) => {
        if (!install || install.state !== 'installed') return false
        const sid = installedSourceId(install)
        if (sid && String(x.id || '') === sid) return true
        const ch = installedChannel(install)
        const ver = install.installedVersion || install.version
        return !!ch && ch === channelOf(x) && !!ver && String(x.localVersion || '') === String(ver)
      }
      const currentSourceOf = group => {
        const byId = new Map(group.rows.map(r => [String(r.id || ''), r]))
        const fallback = []
        for (const row of group.rows) {
          const fromResult = checks[row.id]?.result?.install
          const inline = row._install?.state ? row._install : (row.install?.state === 'installed' ? row.install : null)
          for (const ins of [fromResult, inline]) {
            if (ins?.state !== 'installed') continue
            const sid = installedSourceId(ins)
            const exact = sid ? byId.get(sid) : null
            if (exact) return { row: exact, install: ins, basis: 'sourceId 精确匹配' }
            fallback.push({ row: sid ? { id: sid, sourceType: ins.source || '' } : row, install: ins, basis: '渠道与版本匹配' })
          }
        }
        const carrier = group.rows.find(r => r.install?.state === 'installed') || group.rows.find(r => r._install?.state === 'installed')
        const ci = carrier?.install?.state === 'installed' ? carrier.install : (carrier?._install?.state === 'installed' ? carrier._install : null)
        if (ci) {
          const sid = installedSourceId(ci)
          const exact = sid ? byId.get(sid) : null
          if (exact) return { row: exact, install: ci, basis: '组头安装记录精确匹配' }
        }
        for (const item of fallback) {
          const ch = installedChannel(item.install)
          const ver = item.install.installedVersion || item.install.version
          if (ch && ver && String(item.row.localVersion || '') === String(ver)) {
            const matched = group.rows.find(r => channelOf(r) === ch && String(r.localVersion || '') === String(ver))
            if (matched) return { row: matched, install: item.install, basis: item.basis }
          }
        }
        return null
      }
      const installComparisonOf = (group, currentSource) => {
        if (!currentSource || currentSource.install?.state !== 'installed') return null
        const target = installedSourceId(currentSource.install) || currentSource.row.id
        const direct = checks[currentSource.row.id]?.result
        const directMatches = !!direct?.install && String(direct.install.sourceId || '') === String(target)
        const linked = group.rows.map(x => checks[x.id]?.result).find(r => r?.install && String(r.install.sourceId || '') === String(target))
        const r = directMatches ? direct : linked || direct
        if (!r || r.install?.state !== 'installed') return null
        return ['newer', 'same', 'local-newer'].includes(r.install.comparison) ? r.install.comparison : null
      }
      const installCompareText = { newer: '当前安装版有新版本', same: '当前安装版已是最新', 'local-newer': '当前安装版较新' }
      const buildChannels = (group, currentSource) => {
        const map = new Map()
        for (const x of group.rows) {
          const ch = channelOf(x)
          if (!map.has(ch)) map.set(ch, [])
          map.get(ch).push(x)
        }
        return ['github', 'npm', 'local'].filter(ch => map.has(ch)).map(ch => {
          const rows = map.get(ch)
          const current = rows.find(r => currentSource && r.id === currentSource.row.id) || rows[0]
          const marked = !!currentSource && current.id === currentSource.row.id
          return { key: ch, label: channelLabel[ch], current, history: rows.filter(r => r.id !== current.id), marked }
        })
      }

      /* 渲染层：按渠道查看的紧凑左列表 + 右唯一详情（数据逻辑全部复用上方 groups/buildChannels/checks/install） */
      const segLabel = { github: 'GitHub 仓库', npm: 'npm' }
      const groupNameOf = group => {
        const head = group.rows[0] || {}
        return String(head.groupName || packageNameOf(head) || displayName(head) || '未命名来源')
      }
      const installOf = group => {
        const cs = currentSourceOf(group)
        if (cs && cs.install) return cs.install
        const row = group.rows.find(r => r.install || r._install)
        return row ? (row._install && row._install.state ? row._install : row.install) : null
      }
      // 当前渠道下每个插件一条（用该渠道 current 记录，历史折叠进详情）
      const entriesOf = ch => {
        const out = []
        for (const group of groups) {
          const channels = buildChannels(group, currentSourceOf(group))
          const info = channels.find(c => c.key === ch)
          if (!info) continue
          out.push({ group, groupKey: group.key, name: groupNameOf(group), info, install: installOf(group) })
        }
        return out
      }
      const entries = entriesOf(viewChannel)
      // 默认选中当前渠道第一项：picked 尚未设置或旧键不在本渠道时回退，保证详情区始终有内容
      const pickKey = (picked[viewChannel] && entries.some(e => e.groupKey === picked[viewChannel]))
        ? picked[viewChannel] : (entries.length ? entries[0].groupKey : null)
      const pickedEntry = entries.find(e => e.groupKey === pickKey) || null
      const localOnly = groups.filter(g => {
        const chans = buildChannels(g, currentSourceOf(g)).map(c => c.key)
        return chans.length && chans.every(c => c === 'local')
      })
      const selectEntry = (ch, key) => {
        pickRef.current = { ...pickRef.current, [ch]: key }
        setPicked(pickRef.current)
        setSwitchHint('')
      }
      const chooseOnSwitch = target => {
        if (target === viewChannel) return
        if (listRef.current) scrollRef.current[viewChannel] = listRef.current.scrollTop
        const curKey = picked[viewChannel] || pickRef.current[viewChannel] || (entries.length ? entries[0].groupKey : null)
        const currentEntry = entries.find(e => e.groupKey === curKey)
        const targetEntries = entriesOf(target)
        const targetKeys = targetEntries.map(e => e.groupKey)
        let next, hint = ''
        if (currentEntry && targetKeys.includes(currentEntry.groupKey)) {
          next = currentEntry.groupKey // 同插件在目标渠道有材料则保留
        } else {
          const prev = picked[target] || pickRef.current[target]
          next = (prev && targetKeys.includes(prev)) ? prev : (targetEntries.length ? targetEntries[0].groupKey : null)
          if (currentEntry) {
            const nextName = next ? (targetEntries.find(e => e.groupKey === next) || {}).name || '空' : '空'
            hint = '当前插件「' + currentEntry.name + '」没有 ' + segLabel[target] + ' 材料，已显示「' + nextName + '」。'
          }
        }
        pickRef.current = { ...pickRef.current, [target]: next }
        setPicked(pickRef.current)
        setSwitchHint(hint)
        setViewChannel(target)
      }
      const segKeyDown = (event, ch) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const target = ch === 'github' ? 'npm' : 'github'
        chooseOnSwitch(target)
        const node = segRefs.current[target]
        if (node && typeof node.focus === 'function') node.focus()
      }
      const installLine = install => {
        if (!install || install.state !== 'installed') return install && install.state === 'unconfirmed' ? '当前安装来源未确认' : '未安装'
        const ch = installedChannel(install)
        const ver = install.version || install.installedVersion || '版本未记录'
        return (ch ? segLabel[ch] || channelLabel[ch] : install.source || '来源') + ' · ' + ver + '（当前安装）'
      }
      // 版本结论正文：默认可见远端版本/中文结论/当前安装比较，技术细节才折叠（#283-1）
      const versionSummary = entry => {
        const row = entry.info.current
        const c = checks[row.id]
        const r = c && c.result
        const rows = []
        // 沿旧 renderCheck 语义：请求失败(c.error)与失败态(state)都不把远端版本当当前结论（#286-4）
        const failedState = r && ['historical', 'error', 'unavailable', 'incomparable'].includes(r.state)
        if (c && c.error) {
          rows.push(['版本结论', '本次未确认（远端检查失败）'])
        } else if (c && c.pending) {
          rows.push(['远端版本', '正在检查…'])
          rows.push(['版本结论', '正在检查远端版本…'])
        } else if (failedState) {
          // 历史/失败态的远端版本只能是"上次成功"，不能标成当前
          rows.push(['远端版本', (r.remoteVersion ? r.remoteVersion + '（上次成功）' : '未取得')])
          rows.push(['版本结论', '本次未确认，不推断是否最新'])
          if (r.lastSuccessAt) rows.push(['上次成功时间', r.lastSuccessAt])
        } else if (r) {
          rows.push(['远端版本', r.remoteVersion || '未取得'])
          rows.push(['版本结论', compareText[r.comparison] || '版本关系未确认'])
        } else {
          rows.push(['版本结论', '尚未检查，未确认是否最新'])
        }
        const instCmp = installComparisonOf(entry.group, currentSourceOf(entry.group))
        if (instCmp) rows.push(['当前安装版比较', installCompareText[instCmp] || '版本关系未确认'])
        return h('div', { className: 'fb-ver-main' },
          h('p', { className: 'fb-et' }, c && c.error ? '远端版本暂时无法检查' : '版本结论（后端）'),
          h(KV, { rows }),
          (c && c.error) || failedState ? h('p', { className: 'fb-note' }, '上面的远端版本不是本次结论；本次未确认。') : null,
          h(Tech, { title: '版本检查技术细节（后端原始数据）' }, renderCheck(row, '保存材料')))
      }
      const stateTag = entry => {
        if (entry.group.key.startsWith('solo:') || entry.group.rows.some(r => r.identityBasis === 'unconfirmed') || !packageNameOf(entry.group.rows[0]))
          return h(Tag, { tone: 'warn' }, '来源关联未确认')
        // 只按当前所看渠道的代表材料（current）的有效检查表达状态；不拿同组其它渠道/历史的 newer 冒充本渠道更新
        const curCheck = checks[entry.info.current?.id]
        if (curCheck?.result && ['historical', 'error', 'unavailable', 'incomparable'].includes(curCheck.result.state))
          return h(Tag, { tone: 'warn' }, '版本未确认')
        if (curCheck?.result?.comparison === 'newer') return h(Tag, { tone: 'warn' }, '有新版本 · 与保存材料比较')
        return h(Tag, { tone: 'ok' }, '材料已就绪')
      }
      return h('div', { className: 'fb-page' },
        h('div', { className: 'fb-lead' }, '这一页保存插件的原始源码与来源材料，作为「胃」分析的输入；',
          h('b', null, '材料已保存 ≠ 已安装 ≠ 安全'), '，是否安装、是否信任由用户在别处决定。本页列表只读，不下载、不执行脚本、不安装。'),
        issue ? h('div', null, h('p', { className: 'fb-error', role: 'alert' }, '来源列表读取失败：' + issue), h(Retry, { onRetry: () => setRetryKey(k => k + 1) })) : null,
        !issue && !items ? h('p', { className: 'fb-note', role: 'status' }, '正在读取来源…') : null,
        !issue && items && !items.length ? h('div', { className: 'fb-note-box' }, '暂无已登记来源。') : null,
        items && items.length ? h('section', { className: 'fb-sec' },
          h('h3', null, '已保存的材料（点选查看）'),
          h('div', { className: 'fb-rice-tool' },
            h('div', { className: 'fb-seg', role: 'tablist', 'aria-label': '来源渠道' },
              h('button', {
                type: 'button', role: 'tab', key: 'github', ref: node => { segRefs.current.github = node },
                className: viewChannel === 'github' ? 'on' : '', 'aria-selected': viewChannel === 'github' ? 'true' : 'false',
                tabIndex: viewChannel === 'github' ? 0 : -1,
                onClick: () => chooseOnSwitch('github'), onKeyDown: e => segKeyDown(e, 'github')
              }, 'GitHub 仓库'),
              h('button', {
                type: 'button', role: 'tab', key: 'npm', ref: node => { segRefs.current.npm = node },
                className: viewChannel === 'npm' ? 'on' : '', 'aria-selected': viewChannel === 'npm' ? 'true' : 'false',
                tabIndex: viewChannel === 'npm' ? 0 : -1,
                onClick: () => chooseOnSwitch('npm'), onKeyDown: e => segKeyDown(e, 'npm')
              }, 'npm')),
            h('button', { type: 'button', className: 'fb-tab fb-primary', disabled: auto.phase === 'checking', onClick: () => runBatch(true) },
              auto.phase === 'checking' ? '正在检查…' : '重新检查全部')),
          auto.phase === 'checking' ? h('p', { className: 'fb-rice-progress', role: 'status' }, '正在检查远端版本… 本地来源已显示，可直接查看。') : null,
          auto.phase === 'error' ? h('div', { className: 'fb-warnbox', role: 'status' },
            h('p', null, '远端版本自动检查暂不可用：' + auto.message),
            h('p', null, '本地来源与已保存材料不受影响；可稍后重新检查，失败不推断是否最新。')) : null,
          auto.phase === 'done' && auto.message ? h('p', { className: 'fb-note' }, auto.message) : null,
          switchHint ? h('p', { className: 'fb-rice-hint', role: 'status' }, switchHint) : null,
          h('div', { className: 'fb-rice-layout' },
            h('div', { className: 'fb-rice-list', role: 'listbox', 'aria-label': segLabel[viewChannel] + ' 插件列表', ref: listRef },
              entries.length ? entries.map(e => h('button', {
                type: 'button', key: e.groupKey, className: 'fb-rice-item' + (e.groupKey === pickKey ? ' sel' : ''),
                role: 'option', 'aria-selected': e.groupKey === pickKey ? 'true' : 'false',
                onClick: () => selectEntry(viewChannel, e.groupKey)
              },
                h('div', { className: 'fb-rice-item-nm' }, e.name),
                h('div', { className: 'fb-rice-item-sf' }, (e.info.current.localVersion ? e.info.current.localVersion + ' · ' : '') + '已保存'))) : null),
            pickedEntry ? h('div', { className: 'fb-rice-detail' },
              h('div', { className: 'fb-rice-detail-h' },
                h('h4', null, pickedEntry.name), stateTag(pickedEntry)),
              h(KV, { rows: [
                ['名称', pickedEntry.name],
                ['所看渠道', segLabel[viewChannel] + '（仅查看该渠道材料，不代表安装切换）'],
                ['实际安装', installLine(pickedEntry.install)],
                ['材料版本', pickedEntry.info.current.localVersion || '未记录'],
                ['来源', sourceLabel(pickedEntry.info.current.sourceType) + '（' + pickedEntry.info.label + '）']
              ] }),
              versionSummary(pickedEntry),
              h('p', { className: 'fb-note' }, '当前所看渠道只影响这里显示哪份材料，不切换安装来源。材料已保存 ≠ 已安装 ≠ 安全。'),
              h('div', { className: 'fb-actions' },
                sectionPath ? h('button', { type: 'button', className: 'fb-tab', disabled: pendingOpen, onClick: open }, pendingOpen ? '正在打开…' : '打开材料目录（唯一入口）') : null,
                typeof onNavigate === 'function' ? h('button', { type: 'button', className: 'fb-tab', onClick: () => onNavigate('stomach') }, '到胃·分析查看') : null,
                pickedEntry.info.current.hasRemote ? h('button', { type: 'button', className: 'fb-tab', disabled: !!checks[pickedEntry.info.current.id]?.pending, onClick: () => check(pickedEntry.info.current.id, true) }, checks[pickedEntry.info.current.id]?.pending ? '正在检查…' : '重新检查') : null),
              openIssue ? h('p', { className: 'fb-error', role: 'alert' }, openIssue) : null,
              pickedEntry.info.history.length ? h(Tech, { title: '该渠道历史记录（' + pickedEntry.info.history.length + '，折叠）' }, pickedEntry.info.history.map(x => sourceRow(x, '保存材料'))) : null,
              h(Tech, { title: '技术详情（折叠，默认不展示，不按哈希选择）' },
                h(KV, { rows: [
                  ['归组键', pickedEntry.group.key],
                  ['身份依据', String(pickedEntry.group.rows[0].identityBasis || '未记录')],
                  ['安装依据', String(pickedEntry.install?.basis || currentSourceOf(pickedEntry.group)?.basis || '未提供')],
                  ['目录路径', pickedEntry.group.rows[0].path || '未记录']
                ] }),
                h('pre', { className: 'fb-task-output' }, JSON.stringify({ group: pickedEntry.group, channels: buildChannels(pickedEntry.group, currentSourceOf(pickedEntry.group)).map(c => ({ channel: c.key, current: c.current.id, history: c.history.map(x => x.id) })), checks: pickedEntry.group.rows.map(x => ({ id: x.id, check: checks[x.id] || null })) }, null, 2))))
            : h('div', { className: 'fb-rice-detail fb-rice-empty', role: 'status' }, '暂无 ' + segLabel[viewChannel] + ' 材料')),
          localOnly.length ? h('div', { className: 'fb-rice-local' },
            '仅本地材料的插件：',
            h(Tech, { title: '查看本地材料列表（' + localOnly.length + '）' }, localOnly.map(g => sourceRow(g.rows[0], '保存材料')))) : null) : null,
        h(Foot, null, '鱼的脑是独立设置项，不并入身体页面。 · 本页只读取来源目录与后端版本结论，不下载、不安装、不分析；检查按钮不代表安装授权。'))
    }

    function HandPanel({ onOpenFolder, sectionPath }) {
      const [items, setItems] = useState(null)
      const [issue, setIssue] = useState('')
      const [gap, setGap] = useState(null)
      const [ops, setOps] = useState({})
      const [copyState, setCopyState] = useState('')
      const [retryKey, setRetryKey] = useState(0)
      const [openIssue, setOpenIssue] = useState('')
      const [pendingOpen, setPendingOpen] = useState(false)
      const liveRef = useRef(true)
      useEffect(() => { liveRef.current = true; return () => { liveRef.current = false } }, [retryKey])
      const refresh = () => {
        let cancelled = false
        setIssue(''); setGap(null)
        fetchJson('/api/fish-body/plugin-switch/state')
          .then(value => {
            if (cancelled || !liveRef.current) return
            const code = value?.error?.code || value?.code
            if (value?.ok === false && isGapCode(code)) { setGap(value.error || value); setItems(null) }
            else setItems(Array.isArray(value?.items) ? value.items : [])
          })
          .catch(error => { if (!cancelled && liveRef.current) setIssue(error.message) })
        return () => { cancelled = true }
      }
      useEffect(() => refresh(), [retryKey])
      const toggle = async (item, enabled) => {
        if (ops[item.pluginId]?.pending) return
        setOps(old => ({ ...old, [item.pluginId]: { pending: true, error: '' } }))
        try {
          const value = await fetchJson('/api/fish-body/plugin-switch', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pluginId: item.pluginId, enabled })
          })
          if (value?.ok === false && isGapCode(value?.error?.code || value?.code)) {
            if (liveRef.current) { setGap(value.error || value); setOps(old => ({ ...old, [item.pluginId]: { pending: false, error: '' } })) }
            return
          }
          if (liveRef.current) setOps(old => ({ ...old, [item.pluginId]: { pending: false, result: value?.result || null, error: '' } }))
        } catch (error) {
          if (liveRef.current) setOps(old => ({ ...old, [item.pluginId]: { pending: false, error: error.message } }))
        } finally {
          if (liveRef.current) refresh()
        }
      }
      const open = async () => {
        if (!sectionPath || pendingOpen) return
        setPendingOpen(true); setOpenIssue('')
        try {
          const value = await fetchJson('/api/fish-body/open', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'hand' })
          })
          if (!value?.ok && liveRef.current) setOpenIssue(value?.error || '打开失败。')
        } catch (error) { if (liveRef.current) setOpenIssue(error.message) }
        finally { if (liveRef.current) setPendingOpen(false) }
      }
      const groups = {}
      for (const item of (items || [])) { const key = item.pluginId || '未标注插件'; (groups[key] = groups[key] || []).push(item) }
      const runtimeLabel = { unknown: '暂无反馈', running: '正在运行', stopped: '已停止', error: '加载或运行失败' }
      const requestLabel = { on: '已提交启动请求', off: '已提交关闭请求', error: '请求失败' }
      /* 后端 row.code 是可判别的缺口证据：桥未挂上 / 读失败 / 身份歧义只报无法核实。 */
      const gapCodes = new Set(['native-api-unavailable', 'read-state-failed', 'identity-ambiguous'])
      const isGapCode = code => gapCodes.has(String(code || ''))
      const bridgeUncertain = item => {
        const text = String(item?.source || '') + ' ' + String(item?.message || '')
        if (isGapCode(item?.code) || isGapCode(item?.error?.code)) return true
        return item?.enabled === null && item?.runtime === 'unknown' &&
          (!item?.nativeId || /未就绪|未确认|native-read-failed|stale-bridge|读取原生状态失败/.test(text))
      }
      const installedLabel = item => {
        if (bridgeUncertain(item)) return '未确认（桥未就绪）'
        if (item.installed === true) return '已安装'
        if (/未找到|不存在|not found|identity|映射/.test(String(item.message || ''))) return '未安装（宿主列表未找到）'
        return '未确认'
      }
      const enabledLabel = item => bridgeUncertain(item) ? '无法核实' : item.enabled === true ? '已启用' : item.enabled === false ? '已关闭' : '未确认'
      const runtimeText = item => bridgeUncertain(item) ? '暂无反馈' : runtimeLabel[item.runtime] || '暂无反馈'
      const registeredLabel = item => item.registered === true ? '已登记' : item.registered === false ? '未登记（依据当前登记证据）' : bridgeUncertain(item) ? '无法核实' : '未标注'
      const copySummary = async () => {
        if (!navigator.clipboard?.writeText) { setCopyState('浏览器未开放复制权限'); return }
        const summary = Object.keys(groups).map(pluginId => groups[pluginId].map(item => [
          item.pluginId, registeredLabel(item), installedLabel(item), enabledLabel(item), runtimeText(item), item.source || ''
        ].join('\t')).join('\n')).join('\n')
        await navigator.clipboard.writeText(summary)
        setCopyState('已复制诊断摘要，未发送')
      }
      return h('div', { className: 'fb-page' },
        h('div', { className: 'fb-statebar' },
          h('b', null, '状态口径：'), '已登记 ≠ 已安装 ≠ 已加载 ≠ 实测可用。原生桥未挂上或服务未知时显示「无法核实 / 未知 / 暂无反馈」，不把它写成「未安装」；没有运行证据的组件不声称可用。'),
        gap ? h('div', { className: 'fb-warnbox', role: 'status' },
          h('strong', null, '原生启停接口缺口 · 无法核实'),
          h('p', null, '当前宿主未提供可核实的原生插件启停接口，因此不提供启停按钮；下方状态只反映已登记与可核实信息，不代表正在运行。'),
          h('details', { className: 'fb-tech' },
            h('summary', null, '缺口说明与核查证据（技术详情）'),
            gap.message ? h('p', { className: 'fb-note' }, gap.message) : null,
            gap.evidence ? h('pre', { className: 'fb-task-output' }, typeof gap.evidence === 'string' ? gap.evidence : JSON.stringify(gap.evidence, null, 2)) : null)) : null,
        issue ? h('div', null, h('p', { className: 'fb-error', role: 'alert' }, '原生状态读取失败：' + issue), h(Retry, { onRetry: () => setRetryKey(k => k + 1) })) : null,
        !gap && !issue && !items ? h('p', { className: 'fb-note', role: 'status' }, '正在读取原生状态…') : null,
        !gap && !issue && items && !items.length ? h('div', { className: 'fb-note-box' }, '暂无可核实的来源插件状态。') : null,
        h('section', { className: 'fb-sec' },
          Object.keys(groups).length || !gap ? h('h3', null, '按来源插件分组（脑区 / 工具 / 混合只是标签，不是唯一拆分边界）') : h('p', { className: 'fb-note' }, '原生接口未核实，暂无可核实的分组状态。'),
          Object.keys(groups).map(pluginId => h('div', { key: pluginId, className: 'fb-grp' },
            h('h4', null, pluginId),
            groups[pluginId].map(item => {
              const op = ops[item.pluginId] || {}
              const uncertain = bridgeUncertain(item)
              const text = String(item.message || '') + ' ' + String(item.source || '')
              const explicitlyMissing = !uncertain && item.installed === false && /未找到|不存在|not found/.test(text)
              const readOnly = !!item.readOnlyReason || /只读|内置|不可独立开关|readOnly/i.test(text)
              const identityBad = isGapCode(item.code) || /多个原生条目|identity-ambiguous|无法确定/.test(text)
              /* runtime=unknown / enabled=null 不是禁用条件：启停正是要改变启用态；只看真实可操作性。 */
              const canSwitch = item.installed === true && !!item.nativeId && gap === null && !uncertain && !explicitlyMissing && !readOnly && !identityBad
              const whyNo = uncertain || identityBad ? '当前原生状态无法核实，不提供启停按钮。'
                : explicitlyMissing ? '宿主管理器明确确认没有该原生条目，不提供启停按钮。'
                : readOnly ? '宿主标记只读或内置，不提供独立启停按钮。'
                : !item.installed ? '安装状态未确认，不提供启停按钮。'
                : !item.nativeId ? '身份映射未核实，不提供启停按钮。'
                : '当前原生可操作性未核实，不提供启停按钮。'
              return h('div', { key: item.pluginId, className: 'fb-comp' },
                h('div', { className: 'fb-comp-grid' },
                  h('div', { className: 'fb-cn' },
                    h('strong', null, item.displayName || item.name || item.pluginId),
                    h(Tag, { tone: item.registered === true ? 'ok' : uncertain ? 'warn' : '' }, registeredLabel(item)),
                    h(Tag, { tone: uncertain ? 'warn' : item.runtime === 'error' ? 'err' : '' }, runtimeText(item))),
                  h('div', { className: 'fb-cd' },
                    h('p', { className: 'fb-note', style: { marginTop: 0 } }, item.description || '登记信息未提供组件说明；不推断能力范围。'),
                    h(KV, { rows: [
                      ['用途', item.description || '未提供用途说明'],
                      ['来源插件', item.pluginId],
                      ['依赖', '未提供'],
                      ['安装状态', installedLabel(item)],
                      ['启用状态', enabledLabel(item)],
                      ['运行情况', runtimeText(item)]
                    ] }),
                    op.result ? h('p', { className: 'fb-note' }, '本次操作结果：', h(Tag, { tone: op.result.state === 'error' ? 'err' : 'info' }, requestLabel[op.result.state] || op.result.state || '未知'), '（仅表示请求已提交，不代表运行正常）') : null,
                    op.error ? h('p', { className: 'fb-error', role: 'alert' }, '启停失败：' + op.error) : null,
                    canSwitch ? h('div', { className: 'fb-actions' },
                      h('button', { type: 'button', className: 'fb-tab', disabled: op.pending || item.enabled === true, onClick: () => toggle(item, true) }, op.pending ? '操作中…' : '启动'),
                      h('button', { type: 'button', className: 'fb-tab', disabled: op.pending || item.enabled === false, onClick: () => toggle(item, false) }, op.pending ? '操作中…' : '关闭'))
                      : h('p', { className: 'fb-note' }, whyNo),
                    h('details', { className: 'fb-tech' },
                      h('summary', null, '技术详情（原生 ID、来源与原始说明）'),
                      h(KV, { rows: [
                        ['原生 ID', item.nativeId || '未核实'],
                        ['状态来源', item.source || '未标注'],
                        ['状态代码', item.code || item.error?.code || '未标注'],
                        ['原始说明', item.message || '无']
                      ] }),
                      op.result?.message ? h('p', { className: 'fb-note' }, '请求原文：' + op.result.message) : null))))
            })))),
        h('section', { className: 'fb-sec' },
          h('h3', null, '启停与来源管理'),
          h('div', { className: 'fb-lead' }, '启停只操作来源插件本身：身体内部不为每个拆出功能新建开关，也不把独立插件绑到身体的一个开关上。安装与更新走 DSH 原生入口，本页不另造更新器。'),
          h('div', { className: 'fb-actions' },
            h('button', { type: 'button', className: 'fb-tab', disabled: true, title: '由宿主原生插件页提供' }, '到 DSH 原生插件页管理'),
            sectionPath ? h('button', { type: 'button', className: 'fb-tab', disabled: pendingOpen, onClick: open }, pendingOpen ? '正在打开…' : '打开组件目录（唯一入口）') : null,
            h('button', { type: 'button', className: 'fb-tab', onClick: copySummary }, '复制诊断摘要')),
          copyState ? h('p', { className: 'fb-note', role: 'status' }, copyState) : null,
          openIssue ? h('p', { className: 'fb-error', role: 'alert' }, openIssue) : null,
          h(Tech, { title: '长路径与技术记录（折叠）' },
            h('p', { className: 'fb-path' }, sectionPath || '此分区没有绑定目录。'),
            h('p', { className: 'fb-note' }, '复制摘要只在本地生成文本，不发送、不上传。缺口态不画假启停成功按钮。')),
        h(Foot, null, '鱼的脑是独立设置项，不并入身体页面，也不加入人格 / 记忆编辑器。 · 启停按钮仅提交请求，实际加载状态需刷新只读状态入口确认。')))
    }

    function SettingsPanel({ onState, lifecycle, bodyDataState }) {
      const phaseLabels = { on: '已开启', off: '已停用', closing: '正在关闭', unknown: '未确认' }
      const stateRows = lifecycle ? [
        ['状态', lifecycle.phase ? (phaseLabels[lifecycle.phase] || lifecycle.phase) : '未确认'],
        lifecycle.message ? ['说明', lifecycle.message] : null,
        lifecycle.application === 'restart-required' ? ['补充说明', '需要重启后生效'] : null
      ].filter(Boolean) : []
      const dataStatus = bodyDataState?.status || ''
      const dataError = bodyDataState?.error || ''
      const dataProblem = dataStatus === 'invalid-root' || dataStatus === 'pending-workspace' || dataStatus === 'pending-initialization' || dataStatus === 'invalid-config' || !!dataError
      const revealData = focus => {
        const box = document.querySelector('.fb-data-settings')
        if (box) box.open = true
        window.setTimeout(() => {
          const buttons = document.querySelectorAll('.fb-data-settings button')
          if (focus) (buttons[0] || buttons[1])?.click()
        }, 0)
      }
      return h('div', { className: 'fb-page' },
        h('section', { className: 'fb-sec' },
          h('h3', null, '当前运行状态'),
          lifecycle ? h('div', { className: 'fb-item' }, h(KV, { rows: stateRows })) : h('p', { className: 'fb-note', role: 'status' }, '运行状态暂未读取。')),
        dataProblem ? h('section', { className: 'fb-sec' },
          h('h3', null, '数据目录问题'),
          h('div', { className: 'fb-errbox', role: 'alert' },
            h('p', { className: 'fb-et' }, dataStatus === 'pending-workspace' ? '待选择数据目录' : '原数据目录不可访问'),
            h(KV, { rows: [
              ['发生什么', dataError || '当前绑定没有可用的数据目录。'],
              ['影响', '身体暂时读不到已有绑定与材料索引；既有绑定记录不会自动迁移。'],
              ['下一步', '核对位置，或选择正确的数据目录。']
            ] }),
            h('div', { className: 'fb-actions' },
              h('button', { type: 'button', className: 'fb-tab fb-primary', onClick: () => revealData(false) }, '核对位置'),
              h('button', { type: 'button', className: 'fb-tab', onClick: () => revealData(true) }, '选择正确目录')))) : null,
        h('section', { className: 'fb-sec' },
          h('h3', null, '数据目录与来源绑定'),
          h('p', { className: 'fb-note' }, '目录绑定只用于读取来源与诊断记录；选择目录不会迁移数据，也不会自动更换既有绑定。'),
          h(FishDataPanel, { onState: typeof onState === 'function' ? onState : undefined })),
        h('section', { className: 'fb-sec' },
          h('h3', null, '运行纪律与工程约束'),
          h('div', { className: 'fb-lead' }, '「鱼的身体」由插件页原生开关统一控制：关闭后「饭→胃→手」统一接入流程、本设置页与内置 SHA-256 工具一并停用；如需按该流程安装，请由用户在插件页手动开启。'),
          h(Tech, { title: '展开完整纪律说明' },
            h('p', { className: 'fb-note' }, '启停只操作用户点击的目标来源插件：不批量、不安装卸载、不写 Profile，也不自动启用脑或身体。登记状态不等于已安装、已加载或实测可用；没有运行证据一律显示「暂无反馈」。'),
            h('p', { className: 'fb-note' }, '身体自身未加载或关闭时，可能没有自己的设置页可打开；此时应看 DSH 原生插件页的错误提示，不能理解为「卸载后还能自报错误」。'))),
        h(Foot, null, '鱼的脑是独立设置项，不并入身体页面，也不加入人格 / 记忆编辑器。 · 诊断记录只含操作名称、时间、错误码与简要原因；复制摘要只在本地生成文本。'))
    }

    function FishBodySection() {
      const [sections, setSections] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [active, setActive] = useState(null)
      const [retryKey, setRetryKey] = useState(0)
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(null)
      const [lifecycle, setLifecycle] = useState(null)
      const [bodyDataState, setBodyDataState] = useState(null)
      const mountedRef = useRef(true)
      const activeRef = useRef(null)
      const tabRefs = useRef([])
      /* 记录已同步到 sections 的数据根目录：undefined=尚未建立基线。
         初次只读 GET 只建立基线、不重建整页；只有真正切根才递增 retryKey。 */
      const knownRootRef = useRef(undefined)

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
          className: 'fb-nav',
          role: 'tab',
          'aria-pressed': active === item.id ? 'true' : 'false',
          'aria-selected': active === item.id ? 'true' : 'false',
          onClick: () => switchTo(item.id),
          onKeyDown: (event) => onTabKeyDown(event, index)
        }, item.title)))

      const heads = {
        overview: ['鱼的身体', '管理插件来源、处理过程与可用工具。'],
        rice: ['鱼的饭 · 插件来源与材料', '保存其他插件的原始源码与来源，供胃分析。'],
        stomach: ['鱼的胃 · 分析与拆分', '查看分析过程、已保存的功能选择与产出。'],
        hand: ['鱼的手 · 组件与能力', '查看接入的组件、它们提供的能力和来源。'],
        settings: ['鱼的身体 · 设置与帮助', '查看数据位置与近期诊断记录。']
      }
      const head = heads[active] || heads.overview

      /* 五页分发：页头统一在此渲染，页面组件只输出内容区，避免重复标题与双层卡。 */
      let body
      if (loadError) {
        body = h('div', null,
          h('p', { className: 'fb-note', role: 'status' }, loadError),
          h('button', { type: 'button', className: 'fb-tab fb-retry', onClick: () => setRetryKey((key) => key + 1) }, '重试'))
      } else if (!sections) {
        body = h('p', { className: 'fb-note', role: 'status' }, '正在加载…')
      } else if (!current) {
        body = h('p', { className: 'fb-note', role: 'status' }, '分区信息不可用。')
      } else {
        const id = current.id
        const sectionPath = current.path
        if (id === 'overview') body = h(OverviewPanel, { onNavigate: switchTo })
        else if (id === 'rice') body = h(RicePanel, { onNavigate: switchTo, sectionPath })
        else if (id === 'stomach') body = h(StomachTasks, { onOpenFolder: openFolder, sectionPath })
        else if (id === 'hand') body = h(HandPanel, { onOpenFolder: openFolder, sectionPath })
        else if (id === 'settings') body = h(SettingsPanel, {
          onState: dataState => {
            setBodyDataState(dataState)
            const nextRoot = dataState && dataState.root ? dataState.root : null
            if (knownRootRef.current === undefined) { knownRootRef.current = nextRoot; return }
            if (knownRootRef.current !== nextRoot) { knownRootRef.current = nextRoot; setRetryKey(key => key + 1) }
          },
          lifecycle,
          bodyDataState
        })
        else body = h('div', { className: 'fb-note-box' }, '未知分区：' + id)
      }

      return h('div', { className: 'fb-root' },
        h('style', { dangerouslySetInnerHTML: { __html: STYLE } }),
        h('div', { className: 'fb-head' },
          h('p', { className: 'fb-crumb' }, '鱼的身体 · 工作区'),
          h('h2', { className: 'fb-title' }, head[0]),
          h('p', { className: 'fb-sub' }, head[1])),
        tabs,
        error ? h('p', { className: 'fb-error', role: 'alert' }, error) : null,
        body)
    }

    // 主导航入口：宿主侧栏把「鱼的身体」当一等工作区面板派发；主内容区直接显示整页。
    // 图标只用 currentColor 画线，尺寸/激活态由宿主经 props 传入；返回会话走宿主布局 selectPanel(null)，
    // 会话不切换（消息、草稿、后台任务按 sessionId 天然保留）。原生启停仍走宿主 slot 生命周期。
    const PANEL_ID = 'fish-body'
    const backToConversation = ctx => () => {
      const layout = ctx.get('layout')
      if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
    }
    function FishBodyMainPage({ backToConversation: back } = {}) {
      return h('div', { className: 'fb-mainpage' },
        h('div', { className: 'fb-mainbar' },
          h('button', { type: 'button', className: 'fb-tab fb-back', onClick: typeof back === 'function' ? back : undefined }, '返回会话')),
        h(FishBodySection))
    }
    function FishBodySidebarIcon({ size, active } = {}) {
      const edge = typeof size === 'number' && size > 0 ? Math.min(20, Math.max(16, size)) : 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': active ? 2 : 1.7,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': 'true', focusable: 'false', className: 'fb-panel-icon'
      },
        h('path', { d: 'M12 3 3 8l9 5 9-5-9-5Z' }),
        h('path', { d: 'M3 13l9 5 9-5' }))
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.directoryPicker'],
      apply(ctx) {
        FishDataPanel = installDataClient(React, ctx, 'body')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          label: () => '鱼的身体',
          inject: () => ({ backToConversation: backToConversation(ctx) })
        }, FishBodyMainPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => '鱼的身体'
        }, FishBodySidebarIcon))
      }
    }
  }
})
