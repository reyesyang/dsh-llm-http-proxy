/**
 * Browser half of dsh-llm-http-proxy.
 *
 * The bundle's detail page renders this card through `plugins.bundle.config`:
 * one row per configured LLM provider, plus a form that adds or replaces a
 * provider's proxy. Values live in the harness settings service under the
 * plugin row's entry id, so a save lands in the active profile's patch and the
 * Host's volatile `providers` reference updates without a reload.
 *
 * The available providers come from the harness LLM Remote service, so the
 * dropdown follows the providers composed in this deployment. When that
 * catalogue is unavailable the form falls back to a provider id text input.
 *
 * @module dsh-llm-http-proxy/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-http-proxy',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Client locale namespace owned by this plugin. */
    const NS = 'llmHttpProxy'
    /** Bundle package name: the key `plugins.bundle.config` dispatches. */
    const PACKAGE = 'dsh-llm-http-proxy'
    /** Profile entry id this bundle inserts; the settings namespace of its config. */
    const ENTRY = 'llm-http-proxy'

    const en = {
      title: 'Outbound proxy',
      empty: 'No provider is configured.',
      provider: 'Provider',
      providerPlaceholder: 'Select a provider',
      providerIdPlaceholder: 'Provider id',
      transport: 'Proxy type',
      address: 'Proxy address',
      addressPlaceholder: '127.0.0.1:8080',
      add: 'Add',
      replace: 'Replace',
      remove: 'Remove',
      loading: 'Loading configuration…',
      unavailable: 'This configuration is not available yet.',
      invalidAddress: 'Enter host:port without a http:// or socks5:// prefix.',
      missingProvider: 'Select a provider.',
      saveFailed: 'The configuration was not saved.',
      saved: 'Saved.',
      configured: 'Configured providers',
      catalogueMissing: 'The provider list is unavailable; enter a provider id instead.',
      catalogueEmpty: 'The LLM service reports no available provider; enter a provider id instead.',
      catalogueFailed: 'Could not load the provider list: {detail}',
      toggleProvider: 'Enable or disable this proxy',
      edit: 'Edit',
      save: 'Save',
      cancel: 'Cancel',
    }

    const zh = {
      title: '出站代理',
      empty: '尚未配置任何 provider。',
      provider: 'Provider',
      providerPlaceholder: '选择 provider',
      providerIdPlaceholder: 'Provider id',
      transport: '代理类型',
      address: '代理地址',
      addressPlaceholder: '127.0.0.1:8080',
      add: '添加',
      replace: '替换',
      remove: '删除',
      loading: '正在读取配置…',
      unavailable: '配置尚未就绪。',
      invalidAddress: '请填写 host:port，不要包含 http:// 或 socks5:// 前缀。',
      missingProvider: '请选择 provider。',
      saveFailed: '配置保存失败。',
      saved: '已保存。',
      configured: '已配置的 provider',
      catalogueMissing: '无法读取 provider 列表，请直接填写 provider id。',
      catalogueEmpty: 'LLM 服务没有返回可用的 provider，请直接填写 provider id。',
      catalogueFailed: '无法读取 provider 列表：{detail}',
      toggleProvider: '启用或停用此代理',
      edit: '编辑',
      save: '保存',
      cancel: '取消',
    }

    const css = `
.llm-http-proxy-config { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.llm-http-proxy-title { margin: 0; font-size: 14px; font-weight: 600; }
.llm-http-proxy-intro { margin: 0; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.llm-http-proxy-list { display: flex; flex-direction: column; gap: 8px; }
.llm-http-proxy-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.llm-http-proxy-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.llm-http-proxy-tag { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.llm-http-proxy-address { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.llm-http-proxy-spacer { flex: 1; }
.llm-http-proxy-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; padding: 12px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; }
.llm-http-proxy-field { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.llm-http-proxy-field > span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.llm-http-proxy-input, .llm-http-proxy-select { padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; max-width: 240px; }
.llm-http-proxy-input:focus, .llm-http-proxy-select:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.llm-http-proxy-button { padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; }
.llm-http-proxy-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.llm-http-proxy-button:disabled { opacity: 0.5; cursor: default; }
.llm-http-proxy-button--primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.llm-http-proxy-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.llm-http-proxy-note { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.llm-http-proxy-empty { color: var(--dsw-alias-label-secondary); }
.llm-http-proxy-row[data-disabled='true'] .llm-http-proxy-name,
.llm-http-proxy-row[data-disabled='true'] .llm-http-proxy-address { opacity: 0.5; }
.llm-http-proxy-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.llm-http-proxy-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.llm-http-proxy-switch:disabled { cursor: default; opacity: 0.5; }
.llm-http-proxy-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.llm-http-proxy-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }
.llm-http-proxy-switch[aria-checked='true'] .llm-http-proxy-switch-thumb { background: var(--dsw-alias-label-primary-foreground); transform: translateX(16px); }
.llm-http-proxy-row[data-editing='true'] .llm-http-proxy-input,
.llm-http-proxy-row[data-editing='true'] .llm-http-proxy-select { max-width: 170px; }
`

    /** Split a settings snapshot into the provider table the card renders. */
    function providerTable(snapshot) {
      const value = snapshot && snapshot.value
      const providers = value && typeof value === 'object' ? value.providers : undefined
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return {}
      return providers
    }

    /** Whether an address is a plausible scheme-less proxy endpoint. */
    function validAddress(address) {
      return address.length > 0 && !address.includes('://') && !/\s/.test(address)
    }

    /** The card registered at `plugins.bundle.config` for this bundle. */
    function ConfigCard(props) {
      const { form, ctx } = props
      const subscribe = React.useCallback(callback => form.subscribe(callback), [form])
      const getSnapshot = React.useCallback(() => form.getSnapshot(), [form])
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
      // Re-render when the active language changes so the card's copy follows the app.
      React.useSyncExternalStore(
        React.useCallback(callback => ctx.locale.subscribe(callback), []),
        React.useCallback(() => ctx.locale.getSnapshot(), []),
      )
      const t = ctx.locale.bind(NS)
      const [known, setKnown] = React.useState([])
      const [catalogue, setCatalogue] = React.useState({ state: 'loading', detail: '' })
      const [providerId, setProviderId] = React.useState('')
      const [transport, setTransport] = React.useState('http')
      const [address, setAddress] = React.useState('')
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [editing, setEditing] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const remote = ctx.remote
          const namespace = remote && remote.llm
          if (!namespace || typeof namespace.listProviders !== 'function') {
            if (alive) {
              setKnown([])
              setCatalogue({ state: 'missing', detail: '' })
            }
            return
          }
          try {
            const result = await namespace.listProviders()
            if (!alive) return
            if (!result || result.ok !== true) {
              setKnown([])
              setCatalogue({
                state: 'failed',
                detail: result && result.error ? `${result.error.code}: ${result.error.message}` : 'no result',
              })
              return
            }
            const value = result.value
            if (!Array.isArray(value)) {
              setKnown([])
              setCatalogue({ state: 'failed', detail: `unexpected value: ${JSON.stringify(value)?.slice(0, 120) ?? String(value)}` })
              return
            }
            setKnown(value)
            setCatalogue({ state: value.length > 0 ? 'ready' : 'empty', detail: `count ${value.length}` })
          } catch (error) {
            if (alive) {
              setKnown([])
              setCatalogue({ state: 'failed', detail: error && error.message ? error.message : String(error) })
            }
          }
        }
        const offs = []
        void load()
        try {
          offs.push(ctx.on('connection/reset', () => { void load() }))
          offs.push(ctx.remote.$on('llm/adapters-updated', () => { void load() }))
        } catch (_unavailable) {
          // A deployment without forwarded events keeps the first load only.
        }
        return () => {
          alive = false
          for (const off of offs) off()
        }
      }, [])

      const providers = providerTable(snapshot)
      const configured = Object.entries(providers)
      const knownNames = new Map(known.map(provider => [provider.id, provider.name]))
      const configuredProviders = new Set(configured.map(([id]) => id))
      const selectable = known.filter(provider => !configuredProviders.has(provider.id))
      const effectiveOptions = selectable.length > 0 ? selectable : known

      const submit = async () => {
        setNotice(false)
        const id = providerId.trim()
        if (id === '') {
          setError(t('missingProvider'))
          return
        }
        if (!validAddress(address.trim())) {
          setError(t('invalidAddress'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const accepted = await form.mutate([
            { op: 'set', path: ['providers', id, 'type'], value: transport },
            { op: 'set', path: ['providers', id, 'address'], value: address.trim() },
          ])
          if (!accepted) setError(t('saveFailed'))
          else {
            setNotice(true)
            setAddress('')
            setProviderId('')
          }
        } catch (_failure) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const saveEdit = async () => {
        const entry = editing
        if (entry === null) return
        const address = entry.address.trim()
        if (!validAddress(address)) {
          setError(t('invalidAddress'))
          return
        }
        setNotice(false)
        setBusy(true)
        setError(null)
        try {
          const accepted = await form.mutate([
            { op: 'set', path: ['providers', entry.id, 'type'], value: entry.type },
            { op: 'set', path: ['providers', entry.id, 'address'], value: address },
          ])
          if (!accepted) setError(t('saveFailed'))
          else {
            setNotice(true)
            setEditing(null)
          }
        } catch (_failure) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const toggle = async (id, enabled) => {
        setNotice(false)
        setBusy(true)
        setError(null)
        try {
          const accepted = await form.mutate([{ op: 'set', path: ['providers', id, 'enabled'], value: enabled }])
          if (!accepted) setError(t('saveFailed'))
        } catch (_failure) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      const remove = async (id) => {
        setNotice(false)
        setBusy(true)
        setError(null)
        try {
          const accepted = await form.mutate([{ op: 'unset', path: ['providers', id] }])
          if (!accepted) setError(t('saveFailed'))
        } catch (_failure) {
          setError(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      if (snapshot.status === 'loading') {
        return h('div', { className: 'llm-http-proxy-config' }, h('style', null, css), h('p', { className: 'llm-http-proxy-intro' }, t('loading')))
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'llm-http-proxy-config' }, h('style', null, css), h('p', { className: 'llm-http-proxy-intro' }, t('unavailable')))
      }

      const rows = configured.length === 0
        ? [h('p', { key: 'empty', className: 'llm-http-proxy-empty' }, t('empty'))]
        : configured.map(([id, setting]) => {
          const enabled = !setting || setting.enabled !== false
          if (editing !== null && editing.id === id) {
            return h('div', { key: id, className: 'llm-http-proxy-row', 'data-editing': 'true' },
              h('span', { className: 'llm-http-proxy-name' }, knownNames.get(id) ?? id),
              h('select', {
                className: 'llm-http-proxy-select',
                value: editing.type,
                disabled: busy,
                'aria-label': t('transport'),
                onChange: event => { setEditing({ id, type: event.target.value, address: editing.address }) },
              },
              h('option', { value: 'http' }, 'HTTP'),
              h('option', { value: 'socks5' }, 'SOCKS5')),
              h('input', {
                className: 'llm-http-proxy-input',
                value: editing.address,
                disabled: busy,
                'aria-label': t('address'),
                placeholder: t('addressPlaceholder'),
                onChange: event => { setEditing({ id, type: editing.type, address: event.target.value }) },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void saveEdit()
                  else if (event.key === 'Escape') setEditing(null)
                },
              }),
              h('span', { className: 'llm-http-proxy-spacer' }),
              h('button', {
                type: 'button',
                className: 'llm-http-proxy-button llm-http-proxy-button--primary',
                disabled: busy || !snapshot.writable,
                onClick: () => { void saveEdit() },
              }, t('save')),
              h('button', {
                type: 'button',
                className: 'llm-http-proxy-button',
                disabled: busy,
                onClick: () => { setEditing(null) },
              }, t('cancel')),
            )
          }
          return h('div', { key: id, className: 'llm-http-proxy-row', 'data-disabled': enabled ? undefined : 'true' },
            h('span', { className: 'llm-http-proxy-name' }, knownNames.get(id) ?? id),
            h('span', { className: 'llm-http-proxy-tag' }, setting && setting.type === 'socks5' ? 'SOCKS5' : 'HTTP'),
            h('span', { className: 'llm-http-proxy-address' }, setting && typeof setting.address === 'string' ? setting.address : ''),
            h('span', { className: 'llm-http-proxy-spacer' }),
            h('button', {
              type: 'button',
              className: 'llm-http-proxy-button',
              disabled: busy || !snapshot.writable,
              onClick: () => {
                setNotice(false)
                setError(null)
                setEditing({
                  id,
                  type: setting && setting.type === 'socks5' ? 'socks5' : 'http',
                  address: setting && typeof setting.address === 'string' ? setting.address : '',
                })
              },
            }, t('edit')),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': enabled,
              'aria-label': t('toggleProvider'),
              title: t('toggleProvider'),
              className: 'llm-http-proxy-switch',
              disabled: busy || !snapshot.writable,
              onClick: () => { void toggle(id, !enabled) },
            }, h('span', { className: 'llm-http-proxy-switch-thumb' })),
            h('button', {
              type: 'button',
              className: 'llm-http-proxy-button',
              disabled: busy || !snapshot.writable,
              onClick: () => { void remove(id) },
            }, t('remove')),
          )
        })

      const catalogueNote = catalogue.state === 'ready' || catalogue.state === 'loading'
        ? null
        : catalogue.state === 'missing'
          ? t('catalogueMissing')
          : catalogue.state === 'empty'
            ? t('catalogueEmpty')
            : t('catalogueFailed', { detail: catalogue.detail })

      const providerControl = effectiveOptions.length > 0
        ? h('select', {
          className: 'llm-http-proxy-select',
          value: providerId,
          onChange: event => { setProviderId(event.target.value) },
        }, [
          h('option', { key: '', value: '' }, t('providerPlaceholder')),
          ...effectiveOptions.map(provider => h('option', { key: provider.id, value: provider.id }, provider.name)),
        ])
        : h('input', {
          className: 'llm-http-proxy-input',
          value: providerId,
          placeholder: catalogue.state === 'ready' ? t('providerPlaceholder') : t('providerIdPlaceholder'),
          onChange: event => { setProviderId(event.target.value) },
        })

      return h('div', { className: 'llm-http-proxy-config' },
        h('style', null, css),
        h('h3', { className: 'llm-http-proxy-title' }, t('title')),
        h('div', { className: 'llm-http-proxy-list' }, rows),
        h('div', { className: 'llm-http-proxy-form' },
          h('label', { className: 'llm-http-proxy-field' },
            h('span', null, t('provider')),
            providerControl,
          ),
          h('label', { className: 'llm-http-proxy-field' },
            h('span', null, t('transport')),
            h('select', {
              className: 'llm-http-proxy-select',
              value: transport,
              onChange: event => { setTransport(event.target.value) },
            },
            h('option', { value: 'http' }, 'HTTP'),
            h('option', { value: 'socks5' }, 'SOCKS5')),
          ),
          h('label', { className: 'llm-http-proxy-field' },
            h('span', null, t('address')),
            h('input', {
              className: 'llm-http-proxy-input',
              value: address,
              placeholder: t('addressPlaceholder'),
              onChange: event => { setAddress(event.target.value) },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void submit()
              },
            }),
          ),
          h('button', {
            type: 'button',
            className: 'llm-http-proxy-button llm-http-proxy-button--primary',
            disabled: busy || !snapshot.writable,
            onClick: () => { void submit() },
          }, providerId !== '' && configuredProviders.has(providerId) ? t('replace') : t('add')),
        ),
        error === null ? null : h('p', { className: 'llm-http-proxy-error' }, error),
        catalogueNote === null ? null : h('p', { className: 'llm-http-proxy-error' }, catalogueNote),
        notice ? h('p', { className: 'llm-http-proxy-note' }, t('saved')) : null,
      )
    }

    return {
      // `remote.llm` keeps this plugin parked until the LLM namespace is mounted, so the card never
      // renders with a provider dropdown it cannot fill.
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.llm'],
      apply(ctx) {
        // The card is registered as the bundle's own configuration on its detail page.
        const t = ctx.locale.bind(NS)
        const form = ctx.configForms.get(ENTRY)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'llm-http-proxy: locale')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: NS,
          label: () => t('title'),
        }, (props) => {
          // The bundle page renders this entry without the row-level `form` prop, so the card owns
          // the settings form; the page's own ConfigPageForm is only supplied to row configs.
          return h(ConfigCard, { ...props, form, ctx })
        })), 'llm-http-proxy: configuration card')
      },
    }
  },
})
