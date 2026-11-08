/**
 * Provider-scoped proxy settings: one LLM provider id to one proxy endpoint.
 *
 * The plugin page stores a provider's proxy as a transport kind plus the
 * `host:port` the person typed, so the page can render two independent
 * controls. The transport is a fixed choice — HTTP CONNECT tunnelling or a
 * SOCKS5 handshake — and the address stays a plain endpoint without a scheme;
 * this module turns the pair into the proxy URL undici dispatches on.
 *
 * @module dsh-llm-http-proxy/providers
 */

/** The transports the plugin page offers. */
export type ProxyTransport = 'http' | 'socks5'

/** One provider's proxy as the plugin page stores it. */
export interface ProviderProxySetting {
  /** Tunnelling protocol used to reach {@link address}. */
  readonly type: ProxyTransport
  /** Proxy endpoint without a scheme: `host:port`, optionally `user:pass@host:port`. */
  readonly address: string
  /**
   * Whether the entry is active. The plugin page's switch flips this instead of deleting the
   * address, so a paused proxy can be resumed without retyping it. Absent means enabled, which
   * keeps configuration written before the switch existed working.
   */
  readonly enabled?: boolean
}

/** Provider id to its configured proxy, in configuration order. */
export type ProviderProxyTable = Readonly<Record<string, ProviderProxySetting>>

/**
 * Compile the provider table into proxy URLs.
 *
 * The table is edited by the plugin page and persisted as configuration, so a
 * value can arrive malformed from a hand-written patch too. Every entry is
 * validated here: a silently skipped provider would send that provider's
 * traffic around the proxy the person configured.
 *
 * @param raw - provider id to its transport and address.
 * @returns each provider's proxy URL, keyed by provider id.
 * @throws when a provider id is blank or an address is missing, carries a scheme, or is not URL-shaped.
 */
export function compileProviderProxies(raw: ProviderProxyTable): Map<string, string> {
  const compiled = new Map<string, string>()
  for (const [rawProvider, setting] of Object.entries(raw)) {
    // The switch pauses an entry without discarding its address; a paused provider is not proxied.
    if (setting.enabled === false) continue
    const provider = rawProvider.trim()
    if (provider === '') throw new Error('llm-http-proxy: provider ids must not be empty')
    const address = setting.address.trim()
    if (address === '') {
      throw new Error(`llm-http-proxy: provider "${rawProvider}" has an empty proxy address`)
    }
    if (address.includes('://')) {
      throw new Error(
        `llm-http-proxy: provider "${rawProvider}" proxy address must be host:port without a scheme`,
      )
    }
    const proxyUrl = `${setting.type === 'socks5' ? 'socks5' : 'http'}://${address}`
    const parsed = URL.parse(proxyUrl)
    if (parsed === null || parsed.hostname === '') {
      throw new Error(`llm-http-proxy: provider "${rawProvider}" has an invalid proxy address "${address}"`)
    }
    compiled.set(provider, proxyUrl)
  }
  return compiled
}
