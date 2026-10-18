/**
 * Provider-scoped proxy routes: one host pattern to one target.
 *
 * Pattern matching follows the documented `NO_PROXY` vocabulary so one mental model covers both: an
 * entry matches its host and every subdomain under it, a leading `.` or `*.` means the same suffix
 * rule, an optional `:port` narrows the entry, and `*` matches every host. A pattern that cannot be
 * satisfied is refused at load instead of being skipped, because a silently dropped route proxies
 * exactly the traffic the user tried to route elsewhere.
 *
 * @module dsh-llm-http-proxy/routes
 */

/** Where a matched route sends its request. */
export type RouteTarget =
  | { readonly kind: 'proxy'; readonly proxyUrl: string }
  | { readonly kind: 'direct' }

/** One validated route entry. */
export interface ProxyRoute {
  /** The host pattern exactly as configuration wrote it, for diagnostics. */
  readonly pattern: string
  /** The target every request matching {@link pattern} uses. */
  readonly target: RouteTarget
}

/** Proxy URL schemes this plugin can route through. */
const SUPPORTED_PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/** The configuration value selecting a direct connection instead of a proxy. */
const DIRECT_TARGET = 'direct'

/**
 * Validate the configured route table.
 *
 * @param raw - the configured map of host pattern to `direct` or an HTTP(S) proxy URL.
 * @returns one validated route per entry, in configuration order.
 * @throws when a pattern is blank or a target is neither `direct` nor a usable proxy URL.
 */
export function compileRoutes(raw: Readonly<Record<string, string>>): ProxyRoute[] {
  return Object.entries(raw).map(([rawPattern, rawTarget]) => {
    const pattern = rawPattern.trim().toLowerCase()
    if (pattern === '') throw new Error('llm-http-proxy: route patterns must not be empty')
    const value = rawTarget.trim()
    if (value.toLowerCase() === DIRECT_TARGET) {
      return { pattern, target: { kind: 'direct' } }
    }
    const parsed = URL.parse(value)
    if (parsed === null) {
      throw new Error(`llm-http-proxy: route "${rawPattern}" is neither "direct" nor a valid URL`)
    }
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(
        `llm-http-proxy: route "${rawPattern}" uses the unsupported ${parsed.protocol}// scheme;`
        + ' use an http:// or https:// proxy URL',
      )
    }
    return { pattern, target: { kind: 'proxy', proxyUrl: value } }
  })
}

/**
 * Resolve the target for one request URL.
 *
 * @param routes - validated routes in configuration order; the first match wins.
 * @param url - the request URL.
 * @returns the matching route, or `undefined` when the request keeps the process-wide policy.
 */
export function routeFor(routes: readonly ProxyRoute[], url: URL): ProxyRoute | undefined {
  const host = normalizeHost(url.hostname)
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  return routes.find(route => matches(route.pattern, host, port))
}

/**
 * Lowercase one host and drop the brackets around an IPv6 literal and the trailing dot of an FQDN,
 * so a bypass entry may be written in either spelling.
 *
 * @param hostname - a URL's hostname or a route pattern's host part.
 * @returns the comparable host.
 */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

/**
 * Split one pattern into host and optional port. A bare IPv6 literal carries several colons and no
 * port, so only a single-colon entry splits; a bracketed literal takes its port from after the
 * bracket.
 *
 * @param entry - one pattern with any leading `.` or `*.` already removed.
 * @returns the entry's host and, when it carries one, its port.
 */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

/**
 * Whether one pattern matches a request host and port.
 *
 * @param pattern - a normalized route pattern.
 * @param host - the normalized request host.
 * @param port - the request's effective port.
 * @returns true when the pattern selects this host.
 */
function matches(pattern: string, host: string, port: string): boolean {
  if (pattern === '*') return true
  const { host: patternHost, port: patternPort } = splitHostPort(pattern.replace(/^\*?\./, ''))
  if (patternHost === '') return false
  if (patternPort !== undefined && patternPort !== port) return false
  return host === patternHost || host.endsWith(`.${patternHost}`)
}
