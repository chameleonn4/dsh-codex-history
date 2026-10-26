/**
 * Codex History — client half.
 *
 * Renders a composer-dock entry that lists the Codex conversations found in
 * ~/.codex/sessions and lets the user hand one of them to the current DSH
 * session (import as context) or to the composer draft.
 */
/**
 * The bundle can be executed more than once in one page (a stale boot-graph row
 * pointing at an older package name, or a hot reload). The module system rejects
 * a second factory registration for the same id, so the extra executions are
 * swallowed here instead of failing the whole script.
 */
if (!globalThis.__dshCodexHistoryClientExecuted) {
  globalThis.__dshCodexHistoryClientExecuted = true
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-codex-history',
      factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'codex-history'
    /**
     * The locale service refuses a second registration for the same namespace and
     * locale, so a hot-reloaded bundle would keep rendering the dictionary of its
     * first run. The disposer of that first registration is parked on the global
     * object, where it survives the module reload and can release the namespace.
     */
    const DISPOSER_KEY = '__dshCodexHistoryLocaleDisposer'

    const DICT = {
      zh: {
        button: 'Codex 历史',
        heading: '本地 Codex 会话',
        search: '搜索标题或工作目录',
        refresh: '刷新',
        close: '关闭',
        empty: '没有找到 Codex 会话。',
        unavailable: '无法读取 Codex 历史目录。',
        import: '导入对话',
        draft: '填入输入框',
        worklog: '工作要点',
        loading: '读取中…',
        imported: '已导入到当前会话',
        copied: '已填入输入框',
        failed: '操作失败',
        messages: '{count} 条消息',
        dir: '目录',
        since: '起始日期',
        until: '截止日期',
        noWorklog: '没有可显示的工作要点。',
        tools: '{count} 次工具调用',
        failedCalls: '{count} 次失败',
        closeWorklog: '收起要点',
        source: '来自其他机器的会话',
      },
      en: {
        button: 'Codex history',
        heading: 'Local Codex sessions',
        search: 'Search title or working directory',
        refresh: 'Refresh',
        close: 'Close',
        empty: 'No Codex session found.',
        unavailable: 'The Codex history directory is not readable.',
        import: 'Import',
        draft: 'To draft',
        worklog: 'Work log',
        loading: 'Loading…',
        imported: 'Imported into the current session',
        copied: 'Written into the composer draft',
        failed: 'Action failed',
        messages: '{count} messages',
        dir: 'Directory',
        since: 'From date',
        until: 'To date',
        noWorklog: 'No work log to show.',
        tools: '{count} tool calls',
        failedCalls: '{count} failures',
        closeWorklog: 'Hide work log',
        source: 'A session shared by another machine',
      },
    }

    /** @type {(key: string, params?: Record<string, unknown>) => string} */
    let t = (key) => key
    /** @type {{ subscribe?: (fn: () => void) => () => void } | null} */
    let localeService = null

    const apiUrl = (path) => {
      const relative = String(path).replace(/^\/+/u, '')
      if (typeof document === 'undefined') return `/${relative}`
      const url = new URL(relative, document.baseURI)
      return `${url.pathname}${url.search}`
    }

    const formatTime = (value) => {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const buildDraft = (session) => {
      const messages = Array.isArray(session?.messages) ? session.messages : []
      const lines = []
      for (const message of messages.slice(-30)) {
        const text = String(message?.text ?? '').trim()
        if (!text) continue
        const role = message.role === 'user' ? 'User' : 'Assistant'
        lines.push(`${role}: ${text}`)
      }
      const head = `[Codex history] ${session?.title ?? session?.id ?? ''} (${session?.id ?? ''})`
      return [head, '', ...lines].join('\n')
    }

    /**
     * The composer dock ships sibling pills (activity / usage) styled as plain
     * inline-flex text with a 14px icon, tertiary label colour and no border.
     * These tokens mirror that treatment so the entry reads as one of them.
     */
    const styles = {
      wrap: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
      },
      trigger: {
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '100%',
        padding: '1px 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 'inherit',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      triggerActive: {
        background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      icon: { flex: 'none', width: '14px', height: '14px' },
      label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      sep: {
        color: 'var(--dsw-alias-separator-primary, var(--dsw-alias-label-tertiary, inherit))',
        margin: '0 6px',
      },
      count: { fontVariantNumeric: 'tabular-nums' },
      panel: {
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: '0',
        zIndex: 1100,
        boxSizing: 'border-box',
        width: 'min(460px, calc(100vw - 24px))',
        maxHeight: 'min(70vh, 560px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '14px 16px',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        border: '1px solid var(--dsw-alias-border-l1, transparent)',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        boxShadow: 'var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.18)))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'default',
      },
      panelTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        flexShrink: 0,
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontWeight: 500,
        fontSize: '13px',
      },
      panelRule: {
        flexShrink: 0,
        borderTop: '0.5px solid var(--dsw-alias-border-l2, transparent)',
        marginTop: '8px',
      },
      row: { display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 },
      input: {
        flex: '1',
        minWidth: 0,
        height: '26px',
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l1, transparent)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '12px',
        outline: 'none',
      },
      button: {
        height: '24px',
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        color: 'var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary, inherit))',
      },
      list: {
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        // The list is the only part of the panel that may shrink; every other
        // child keeps its natural height so nothing gets squeezed away.
        flex: '1 1 0%',
        minHeight: 0,
      },
      item: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'transparent',
        border: 'none',
        flexShrink: 0,
      },
      title: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '12px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        flexShrink: 0,
      },
      badge: {
        flex: '0 0 auto',
        padding: '0 5px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '10px',
        lineHeight: '16px',
        whiteSpace: 'nowrap',
      },
      meta: {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      },
      status: {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        flexShrink: 0,
      },
      worklog: {
        maxHeight: 'min(220px, 26vh)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '10px 12px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        border: '1px solid var(--dsw-alias-border-l1, transparent)',
        flexShrink: 0,
      },
      worklogText: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '11px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: '11px', flexShrink: 0 },
    }

    /** Hover and focus affordances the inline styles cannot express. */
    const CSS = `
.codex-history-pill:hover,
.codex-history-pill:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  outline: none;
}
.codex-history-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.codex-history-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover, transparent);
}
.codex-history-input:focus {
  border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l1, transparent));
}
`

    const installCss = () => {
      if (typeof document === 'undefined') return
      const id = 'dsh-codex-history/client.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-codex-history'
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** A small inline history glyph; the dock siblings render 14px line icons. */
    const HistoryIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: styles.icon,
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 4.4V8l2.4 1.5' }),
        h('path', { d: 'M2.7 8a5.3 5.3 0 1 0 1.6-3.8' }),
        h('path', { d: 'M2.2 2.8v2.9h2.9' }),
      )

    function CodexHistoryDock(props) {
      const sessionId = props?.sessionId
      const inputActions = props?.inputActions
      const [open, setOpen] = useState(false)
      const [sessions, setSessions] = useState([])
      const [available, setAvailable] = useState(true)
      const [sessionsDir, setSessionsDir] = useState('')
      const [query, setQuery] = useState('')
      const [since, setSince] = useState('')
      const [until, setUntil] = useState('')
      const [worklog, setWorklog] = useState('')
      const [worklogFor, setWorklogFor] = useState('')
      const [status, setStatus] = useState('')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const [localeRevision, setLocaleRevision] = useState(0)
      const rootRef = useRef(null)

      const load = useCallback(async (keyword, from, to) => {
        setLoading(true)
        setError('')
        try {
          const params = new URLSearchParams()
          params.set('limit', '50')
          if (keyword) params.set('query', keyword)
          if (from) params.set('since', from)
          if (to) params.set('until', to)
          const response = await fetch(apiUrl(`api/codex-history/sessions?${params.toString()}`), { cache: 'no-store' })
          const data = await response.json()
          if (!response.ok || !data?.ok) throw new Error(data?.error || 'request failed')
          setSessions(Array.isArray(data.sessions) ? data.sessions : [])
          setAvailable(data.available !== false)
          setSessionsDir(data.sessionsDir || '')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setSessions([])
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load('', '', '')
      }, [load])

      useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined
        return localeService.subscribe(() => {
          setLocaleRevision((value) => value + 1)
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const node = rootRef.current
          if (node && !node.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const importSession = useCallback(async (id) => {
        setStatus('')
        setError('')
        try {
          const response = await fetch(apiUrl('api/codex-history/import'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, targetSessionId: sessionId }),
          })
          const data = await response.json()
          if (!response.ok || !data?.ok) throw new Error(data?.error || 'import failed')
          setStatus(t('imported'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId])

      const fillDraft = useCallback(async (id) => {
        setStatus('')
        setError('')
        try {
          const response = await fetch(apiUrl(`api/codex-history/session?id=${encodeURIComponent(id)}`), { cache: 'no-store' })
          const data = await response.json()
          if (!response.ok || !data?.ok) throw new Error(data?.error || 'request failed')
          const text = buildDraft(data.session)
          if (!inputActions || typeof inputActions.setDraft !== 'function') throw new Error('composer is not ready')
          inputActions.setDraft(text)
          if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft()
          setStatus(t('copied'))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [inputActions])

      const loadWorklog = useCallback(async (id) => {
        setStatus('')
        setError('')
        try {
          const response = await fetch(apiUrl(`api/codex-history/worklog?id=${encodeURIComponent(id)}`), { cache: 'no-store' })
          const data = await response.json()
          if (!response.ok || !data?.ok) throw new Error(data?.error || 'request failed')
          setWorklog(String(data.text ?? ''))
          setWorklogFor(id)
        } catch (failure) {
          setWorklog('')
          setWorklogFor('')
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const items = useMemo(() => sessions, [sessions])

      const trigger = h(
        'button',
        {
          type: 'button',
          className: 'codex-history-pill',
          title: t('heading'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          style: open ? { ...styles.trigger, ...styles.triggerActive } : styles.trigger,
          onClick: () => setOpen((value) => !value),
        },
        HistoryIcon(),
        h('span', { style: styles.label }, t('button')),
        sessions.length > 0 ? h('span', { style: styles.sep }, '·') : null,
        sessions.length > 0 ? h('span', { style: styles.count }, String(sessions.length)) : null,
      )

      const panel = open
        ? h(
            'div',
            {
              style: styles.panel,
              className: 'codex-history-panel',
              role: 'dialog',
              'aria-label': t('heading'),
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { style: styles.panelTitle },
              HistoryIcon(),
              h('span', null, t('heading')),
              h('span', { style: { flex: '1' } }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'codex-history-ghost',
                  style: styles.button,
                  onClick: () => setOpen(false),
                },
                t('close'),
              ),
            ),
            h('div', { style: styles.panelRule }),
            h(
              'div',
              { style: styles.row },
              h('input', {
                className: 'codex-history-input',
                style: styles.input,
                value: query,
                placeholder: t('search'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void load(query, since, until)
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'codex-history-ghost',
                  style: styles.button,
                  onClick: () => void load(query, since, until),
                },
                t('refresh'),
              ),
            ),
            h(
              'div',
              { style: styles.row },
              h('input', {
                className: 'codex-history-input',
                style: { ...styles.input, flex: '0 1 130px' },
                type: 'date',
                value: since,
                title: t('since'),
                onChange: (event) => setSince(event.target.value),
              }),
              h('input', {
                className: 'codex-history-input',
                style: { ...styles.input, flex: '0 1 130px' },
                type: 'date',
                value: until,
                title: t('until'),
                onChange: (event) => setUntil(event.target.value),
              }),
            ),
            h(
              'div',
              { style: styles.meta },
              sessionsDir ? `${t('dir')}: ${sessionsDir}` : '',
            ),
            h(
              'div',
              { style: styles.list, className: 'codex-history-list' },
              loading && h('div', { style: styles.status }, t('loading')),
              !loading && !available && h('div', { style: styles.error }, t('unavailable')),
              !loading && available && items.length === 0 && h('div', { style: styles.status }, t('empty')),
              items.map((session) =>
                h(
                  'div',
                  { key: session.id, className: 'codex-history-row', style: styles.item },
                  h(
                    'div',
                    { style: styles.titleRow },
                    h('div', { style: styles.title, title: session.title }, session.title || session.id),
                    session.sourceLabel && !session.isLocal
                      ? h('span', { style: styles.badge, title: t('source') }, session.sourceLabel)
                      : null,
                  ),
                  h(
                    'div',
                    { style: styles.meta },
                    `${formatTime(session.updatedAt)} · ${t('messages', { count: session.messageCount ?? 0 })}${session.toolCallCount ? ` · ${t('tools', { count: session.toolCallCount })}` : ''}${session.cwd ? ` · ${session.cwd}` : ''}`,
                  ),
                  h(
                    'div',
                    { style: styles.row },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'codex-history-ghost',
                        style: { ...styles.button, ...styles.primary },
                        onClick: () => void importSession(session.id),
                      },
                      t('import'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'codex-history-ghost',
                        style: styles.button,
                        onClick: () => void fillDraft(session.id),
                      },
                      t('draft'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'codex-history-ghost',
                        style: worklogFor === session.id ? { ...styles.button, ...styles.primary } : styles.button,
                        onClick: () => {
                          if (worklogFor === session.id) {
                            setWorklog('')
                            setWorklogFor('')
                            return
                          }
                          void loadWorklog(session.id)
                        },
                      },
                      t('worklog'),
                    ),
                  ),
                ),
              ),
              worklog
                ? h(
                    'div',
                    { style: styles.worklog },
                    h(
                      'div',
                      { style: styles.row },
                      h('span', { style: styles.meta }, t('worklog')),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'codex-history-ghost',
                          style: styles.button,
                          onClick: () => {
                            setWorklog('')
                            setWorklogFor('')
                          },
                        },
                        t('closeWorklog'),
                      ),
                    ),
                    h('pre', { style: styles.worklogText }, worklog),
                  )
                : null,
              status ? h('div', { style: styles.status }, status) : null,
              error ? h('div', { style: styles.error }, error) : null,
            ),
          )
        : null

      return h('div', { ref: rootRef, style: styles.wrap, 'data-locale-revision': localeRevision }, panel, trigger)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /**
         * The locale service refuses a second registration for the same namespace,
         * so a hot-reloaded bundle would keep rendering the dictionary of its
         * first run. Releasing that first registration through the disposer parked
         * on the global object lets the fresh dictionary take the namespace over.
         */
        const previous = globalThis[DISPOSER_KEY]
        if (typeof previous === 'function') {
          try {
            previous()
          } catch {
            /* the namespace is already gone */
          }
          globalThis[DISPOSER_KEY] = undefined
        }
        try {
          globalThis[DISPOSER_KEY] = ctx.locale.register(NS, DICT)
        } catch {
          /* the namespace is already registered by an earlier apply() */
        }
        t = ctx.locale.bind(NS)
        localeService = ctx.locale
        installCss()
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'codex-history',
              order: 10,
              label: () => t('button'),
            },
            CodexHistoryDock,
          ),
        )
      },
    }
    }
    })
  } catch (error) {
    console.warn('dsh-codex-history: client bundle skipped', error)
  }
}
