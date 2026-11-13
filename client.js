/* fish-body · Client half
 * 通过真实 settings.section 扩展点注入「鱼的身体」设置页。
 * 组件自带 <style>，随组件卸载由 React 一并移除，不改宿主打包 CSS。
 */
window.__ModuleLoader__.load({
  id: 'fish-body',
  factory(require) {
    const React = require('react')
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
.fb-retry{margin-top:10px}
.fb-icon{flex:0 0 auto;display:block}
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
        tabs,
        body
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
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
