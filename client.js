/*
 * Shell platform switcher — browser half.
 *
 * Loaded by the DSH module loader as a plain factory-form CJS module: only
 * `react` is requested from the shell module table; no @deepseek-ai client
 * package is imported.
 *
 * The control is one preference row in Settings → General
 * (`settings.general.item`), not a composer chip: the shell backend is a
 * property of this machine and this profile, so it belongs beside the other
 * profile-wide preferences and applies to every session at once.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-shell-switcher',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'shell-platform'
    const API_BASE = '/shell-platform/api'
    const REQUEST_TIMEOUT = 8000
    const SWITCH_POLL_INTERVAL = 150
    const SWITCH_POLL_BUDGET = 14

    const DICT = {
      en: {
        group: 'Shell platform',
        title: 'Shell platform',
        description: 'Choose the shell backend this profile runs commands with. Applies to every session on this machine.',
        current: 'Current backend: {executor}',
        unconfined: 'unconfined',
        switchTo: 'Switch the shell backend to {name}',
        switching: 'Switching the shell backend…',
        failed: 'Could not switch the shell backend',
        unreachable: 'Could not read the shell backend',
        windows: 'Windows',
        linux: 'Linux',
        android: 'Android',
        macos: 'macOS',
        win: 'Win',
      },
      zh: {
        group: 'Shell 平台',
        title: 'Shell 平台',
        description: '选择这个 profile 运行命令所用的 shell 后端。整机、整份 profile 生效，与单个对话无关。',
        current: '当前后端：{executor}',
        unconfined: '不受沙箱约束',
        switchTo: '将 shell 后端切换为 {name}',
        switching: '正在切换 shell 后端…',
        failed: '切换 shell 后端失败',
        unreachable: '无法读取 shell 后端',
        windows: 'Windows',
        linux: 'Linux',
        android: 'Android',
        macos: 'macOS',
        win: 'Win',
      },
    }

    const FALLBACK_OPTIONS = [
      { id: 'windows', label: 'Windows', short: 'Win', shell: 'pwsh', confined: true },
      { id: 'linux', label: 'Linux', short: 'Linux', shell: 'bash', confined: true },
      { id: 'android', label: 'Android', short: 'Android', shell: 'bash', confined: false },
      { id: 'macos', label: 'macOS', short: 'macOS', shell: 'bash', confined: true },
    ]

    const STYLE = `
.shp-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.shp-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:16px}
.shp-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.shp-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.shp-error{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.shp-seg{display:inline-flex;align-items:center;gap:2px;flex:none;box-sizing:border-box;height:36px;padding:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.shp-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:32px;margin:0;padding:0 10px;border:none;border-radius:calc(var(--dsw-radius-md) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;cursor:pointer;-webkit-appearance:none;appearance:none;transition:background-color 120ms ease,color 120ms ease}
.shp-btn:hover:not(:disabled):not([aria-pressed='true']){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.shp-btn[aria-pressed='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 0.5px var(--dsw-alias-border-l1)}
.shp-btn[data-pending='true']{color:var(--dsw-alias-brand-primary)}
.shp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.shp-btn:disabled{cursor:default;opacity:.6}
@media (max-width:640px){.shp-row{flex-wrap:wrap;gap:8px}.shp-text{flex-basis:100%;padding-right:0}.shp-seg{width:100%;justify-content:space-between}}
`

    function prefersZh() {
      try {
        const language = window.navigator && typeof window.navigator.language === 'string'
          ? window.navigator.language
          : (document.documentElement && document.documentElement.lang) || ''
        return /^zh/i.test(String(language))
      } catch {
        return false
      }
    }

    function interpolate(text, params) {
      if (!params || typeof text !== 'string') return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function fallbackT(key, params) {
      const dict = prefersZh() ? DICT.zh : DICT.en
      const text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      return interpolate(text, params)
    }

    function createTranslator(ctx) {
      let bound = null
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS)
      } catch {
        bound = null
      }
      return function t(key, params) {
        if (typeof key !== 'string' || key === '') return ''
        let text = null
        if (bound) {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value !== '' && value !== key) text = value
          } catch {
            text = null
          }
        }
        if (text === null) text = fallbackT(key, params)
        return typeof text === 'string' ? text : String(text)
      }
    }

    async function requestJson(method, route, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT) : null
      try {
        const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } }
        if (body !== undefined) {
          init.headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(body)
        }
        if (controller) init.signal = controller.signal
        const response = await fetch(API_BASE + route, init)
        let payload = null
        try { payload = await response.json() } catch { payload = null }
        if (!response.ok) {
          const detail = payload && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error : 'HTTP ' + response.status
          throw new Error(detail)
        }
        if (!payload || typeof payload !== 'object') throw new Error('unreadable response')
        return payload
      } finally {
        if (timer !== null) window.clearTimeout(timer)
      }
    }

    function normalizeOptions(payload) {
      const rows = payload && Array.isArray(payload.options) ? payload.options : []
      const out = []
      for (const row of rows) {
        if (!row || typeof row.id !== 'string') continue
        const known = FALLBACK_OPTIONS.find(item => item.id === row.id)
        if (!known) continue
        out.push({
          id: row.id,
          label: typeof row.label === 'string' && row.label !== '' ? row.label : known.label,
          short: known.short,
          shell: typeof row.shell === 'string' && row.shell !== '' ? row.shell : known.shell,
          confined: row.confined !== false,
        })
      }
      return out.length > 0 ? out : FALLBACK_OPTIONS
    }

    function ShellPlatformRow(props) {
      const injected = props && typeof props === 'object' ? props : {}
      const t = typeof injected.t === 'function' ? injected.t : fallbackT
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const aliveRef = React.useRef(true)

      React.useEffect(() => {
        aliveRef.current = true
        let cancelled = false
        requestJson('GET', '/state')
          .then(payload => {
            if (!cancelled && aliveRef.current) setState(payload)
          })
          .catch(() => {
            if (!cancelled && aliveRef.current) setError(t('unreachable'))
          })
        return () => {
          cancelled = true
          aliveRef.current = false
        }
      }, [])

      const options = state ? normalizeOptions(state) : FALLBACK_OPTIONS
      const currentId = state && typeof state.platform === 'string' ? state.platform : null

      const choose = (id) => {
        if (pending !== null) return
        if (id === currentId && error === '') return
        setPending(id)
        setError('')
        requestJson('POST', '/select', { platform: id })
          .then(async () => {
            let last = null
            for (let attempt = 0; attempt < SWITCH_POLL_BUDGET; attempt += 1) {
              await new Promise(resolve => window.setTimeout(resolve, SWITCH_POLL_INTERVAL))
              try {
                last = await requestJson('GET', '/state')
                if (last && last.platform === id) break
              } catch {
                // The host plugin restarts while the selection is applied.
              }
            }
            if (!aliveRef.current) return
            setPending(null)
            if (last && last.platform === id) {
              setState(last)
              return
            }
            setError(t('failed'))
          })
          .catch((failure) => {
            if (!aliveRef.current) return
            setPending(null)
            const message = failure && typeof failure.message === 'string' ? failure.message : ''
            setError(message !== '' ? message : t('failed'))
          })
      }

      const labelFor = (option) => {
        const key = option.id
        const localized = t(key)
        return localized !== key && localized !== '' ? localized : option.label
      }

      const executor = state && typeof state.executor === 'string' ? state.executor : ''
      const currentLine = executor === ''
        ? t('description')
        : t('current', { executor }) + (currentId === 'android' ? ` (${t('unconfined')})` : '')

      const buttons = options.map(option => {
        const name = labelFor(option)
        return h('button', {
          key: option.id,
          type: 'button',
          className: 'shp-btn',
          'aria-pressed': option.id === currentId,
          'aria-label': t('switchTo', { name }),
          'data-pending': pending === option.id ? 'true' : undefined,
          title: t('switchTo', { name }),
          disabled: pending !== null,
          onClick: () => choose(option.id),
        }, pending === option.id ? '…' : option.short)
      })

      return h('div', { className: 'shp-row' },
        h('div', { className: 'shp-text' },
          h('div', { className: 'shp-title' }, t('title')),
          h('div', { className: 'shp-desc' }, pending !== null ? t('switching') : currentLine),
          error !== '' ? h('div', { className: 'shp-error', role: 'alert' }, error) : null,
        ),
        h('div', { className: 'shp-seg', role: 'group', 'aria-label': t('group') }, buttons),
      )
    }

    function apply(ctx) {
      const t = createTranslator(ctx)

      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh })
        } catch {
          return () => {}
        }
      }, 'shell-platform: copy')

      ctx.effect(() => {
        try {
          const tag = document.createElement('style')
          tag.dataset.plugin = NS
          tag.textContent = STYLE
          document.head.append(tag)
          return () => { tag.remove() }
        } catch {
          return () => {}
        }
      }, 'shell-platform: style')

      ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'shell-platform',
        order: -10,
        locale: NS,
        inject: () => ({ t }),
      }, ShellPlatformRow)), 'shell-platform: settings row')
    }

    return { inject: ['slots', 'locale'], apply, ShellPlatformRow }
  },
})