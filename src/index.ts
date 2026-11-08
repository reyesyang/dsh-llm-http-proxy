/**
 * Provider-scoped outbound proxy routing for model requests.
 *
 * The harness has one outbound proxy policy per process, resolved at launch from the environment
 * and installed as undici's global dispatcher. That covers every request but cannot say "this
 * provider goes through this proxy while that one connects directly" — the shape a deployment with
 * several model endpoints needs. This plugin adds that selection without touching the policy: it
 * wraps `globalThis.fetch`, and a request whose host matches a configured route is sent with a
 * dispatcher chosen for that route. Everything else reaches the original `fetch` unchanged and
 * keeps the process-wide policy.
 *
 * The plugin page configures this per provider: each entry names a registered LLM provider and one
 * HTTP or SOCKS5 proxy. At request time the `llm/stream` waterfall supplies the provider that owns
 * the call, and the wrapped `fetch` sends that call through the provider's proxy; a provider without
 * an entry (the default) keeps the process-wide policy. A legacy route table still works and is
 * consulted after the provider table, so hosts reached outside a model call — model discovery, for
 * example — keep their configured egress.
 *
 * A route target is either `direct` — which overrides a process-wide proxy for that host — or an
 * `http://`/`https://` proxy URL. Routes are host patterns, not provider names: the LLM registry
 * exposes provider ids and display names but no endpoint, so the configured provider `baseURL` is
 * what names the host here.
 *
 * A `dispatcher` is only understood by the `fetch` from the same undici copy that built it: Node's
 * built-in `fetch` embeds its own undici and rejects a dispatcher from the npm package with
 * `UND_ERR_INVALID_ARG`, which the OpenAI SDK reports as a connection error. A matched request is
 * therefore sent by `undici`'s own `fetch` alongside its dispatcher, while an unmatched request
 * still reaches the original `fetch` unchanged.
 *
 * ```yaml
 * - id: llm-http-proxy
 *   name: 'dsh-llm-http-proxy'
 *   config:
 *     # Written by the plugin page; a provider without an entry connects directly.
 *     providers:
 *       opendesign:
 *         type: socks5
 *         address: 127.0.0.1:1081
 *       opencode:
 *         type: http
 *         address: 127.0.0.1:8080
 *     # Optional host-pattern fallback, kept for calls outside a model request.
 *     routes:
 *       kimi.com: http://127.0.0.1:8080
 * ```
 *
 * @module dsh-llm-http-proxy
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Dispatcher } from 'undici'
import { compileProviderProxies } from './providers.ts'
import type { ProviderProxyTable } from './providers.ts'
import { compileRoutes, routeFor } from './routes.ts'
import type { ProxyRoute, RouteTarget } from './routes.ts'

export { compileProviderProxies } from './providers.ts'
export type { ProviderProxySetting, ProviderProxyTable, ProxyTransport } from './providers.ts'
export { compileRoutes, routeFor } from './routes.ts'
export type { ProxyRoute, RouteTarget } from './routes.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-http-proxy'

/** This plugin depends on no service: it rewrites the transport every caller reaches. */
export const inject: string[] = []

/** Handler-side provider config: the loader supplies a volatile reference; a plain object is accepted too. */
export type ProviderProxyConfig = Volatile<ProviderProxyTable> | ProviderProxyTable

/** Plugin config. */
export interface Config {
  /**
   * Provider id to its proxy, edited from the plugin page. Volatile so a saved
   * value takes effect without reloading the plugin row. A provider without an
   * entry is not proxied by this plugin and keeps the process-wide policy.
   */
  readonly providers?: ProviderProxyConfig
  /**
   * Host pattern to `direct` or an HTTP(S) proxy URL, matched against each request's host the way
   * `NO_PROXY` matches entries. First match wins; an unmatched host keeps the process-wide policy.
   * Consulted after {@link providers}, for requests outside a model call.
   */
  readonly routes?: Record<string, string>
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  providers: z.dict(z.object({
    type: z.union(['http', 'socks5'] as const).default('http'),
    address: z.string().default(''),
    enabled: z.boolean().default(true),
  })).default({}).volatile(),
  routes: z.dict(z.string()).default({}),
}) as unknown as z<Config>

/**
 * Read the provider table from either the loader's volatile reference or a plain object.
 *
 * @param config - validated plugin config.
 * @returns the current provider table.
 */
function providerTableOf(config: Config): ProviderProxyTable {
  const value = config.providers
  if (value === undefined) return {}
  const reference = value as Volatile<ProviderProxyTable>
  return typeof reference.get === 'function' ? reference.get() : value as ProviderProxyTable
}

/**
 * The transport a matched route selected.
 *
 * `fetch` and `dispatcher` must come from the same undici package: a dispatcher built by one undici
 * copy is rejected by the `fetch` of another, including Node's built-in one.
 */
export interface RouteTransport {
  /** Sends this target's requests with {@link dispatcher}. */
  readonly fetch: typeof globalThis.fetch
  /** Selects this target's egress. */
  readonly dispatcher: Dispatcher
}

/** The transports behind matched routes, as {@link createRoutedFetch} needs them. */
export interface RouteTransportSource {
  /**
   * Return the transport for one route target, creating it on first use.
   * @param target - the matched route's target.
   * @returns the transport to send this request with.
   */
  for(target: RouteTarget): Promise<RouteTransport>
}

/**
 * Wrap `fetch` so a routed host reaches its own transport and every other request is delegated
 * untouched.
 *
 * @param base - the `fetch` to delegate unmatched requests to; the process-wide policy lives there.
 * @param routes - validated routes in configuration order; the first match wins.
 * @param transports - transport source for matched targets.
 * @returns a `fetch` with the same call and return type as {@link base}.
 */
export function createRoutedFetch(
  base: typeof globalThis.fetch,
  routes: readonly ProxyRoute[],
  transports: RouteTransportSource,
): typeof globalThis.fetch {
  const routed: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const route = url === undefined ? undefined : routeFor(routes, url)
    if (route === undefined) return base(input, init)
    const transport = await transports.for(route.target)
    // A provider-scoped route selects its own transport; the process-wide dispatcher cannot
    // answer per origin.
    // proxy-exempt: provider-scoped dispatcher selection.
    const [routedInput, routedInit] = routedRequest(input, init, transport.dispatcher)
    return transport.fetch(routedInput, routedInit)
  }
  return routed
}

/** Returns the proxy URL a model call's provider should use, or `undefined` to leave the call alone. */
export type ProviderProxySource = (provider: string) => string | undefined

/**
 * Wrap `fetch` so a model call travels through its provider's configured proxy.
 *
 * The provider is read from the ambient model-call scope that {@link runWithProvider} establishes
 * around each `llm/stream` call. Without one — any request the harness makes outside a model call —
 * the call reaches {@link base} unchanged, so the default is no provider proxy.
 *
 * @param base - the `fetch` to delegate requests whose provider has no proxy to.
 * @param proxyFor - the proxy URL configured for one provider id.
 * @param providerOf - the provider owning the current model call, when one is in scope.
 * @param transports - transport source for the selected proxy URL.
 * @returns a `fetch` with the same call and return type as {@link base}.
 */
export function createProviderFetch(
  base: typeof globalThis.fetch,
  proxyFor: ProviderProxySource,
  providerOf: () => string | undefined,
  transports: RouteTransportSource,
): typeof globalThis.fetch {
  const routed: typeof globalThis.fetch = async (input, init) => {
    const provider = providerOf()
    if (provider === undefined) return base(input, init)
    const proxyUrl = proxyFor(provider)
    if (proxyUrl === undefined) return base(input, init)
    const transport = await transports.for({ kind: 'proxy', proxyUrl })
    const [routedInput, routedInit] = routedRequest(input, init, transport.dispatcher)
    return transport.fetch(routedInput, routedInit)
  }
  return routed
}

/**
 * Run one model-call stream inside the provider's async scope.
 *
 * Every step of the stream — including the `fetch` an adapter issues while the iterator advances —
 * runs inside `AsyncLocalStorage.run`, so the request knows which provider asked for it. The
 * wrapper runs per `next()` call rather than once around the iterable, because a consumer may
 * interleave calls from several providers.
 *
 * @param scope - the store carrying the current provider id.
 * @param provider - the provider owning this stream.
 * @param stream - the downstream stream to iterate.
 * @returns the same chunks, with the provider in scope during each iterator step.
 */
export function runWithProvider<T>(
  scope: AsyncLocalStorage<string>,
  provider: string,
  stream: AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]()
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => scope.run(provider, () => iterator.next()),
        return: (value?: T) => scope.run(
          provider,
          () => iterator.return?.(value) ?? Promise.resolve({ done: true, value } as IteratorResult<T>),
        ),
        throw: (error?: unknown) => scope.run(
          provider,
          () => iterator.throw?.(error) ?? Promise.reject(error),
        ),
      }
    },
  }
}

/** A routed `fetch` call's init, carrying the non-standard undici dispatcher. */
type RoutedInit = RequestInit & { dispatcher: Dispatcher; duplex?: 'half' }

/**
 * Convert one `fetch` call into the arguments a route's transport accepts.
 *
 * A request object is expanded first: `undici.fetch` does not recognise a `Request` built by
 * another copy of undici (including Node's built-in one) and would parse it as a relative URL. Its
 * `init` still wins over the request's own fields, as `fetch(input, init)` specifies.
 *
 * @param input - the first argument of the caller's `fetch` call.
 * @param init - the second argument of the caller's `fetch` call.
 * @param dispatcher - the dispatcher selected for the matched route.
 * @returns the input and init to hand the route's `fetch`.
 */
function routedRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  dispatcher: Dispatcher,
): [Parameters<typeof globalThis.fetch>[0], RoutedInit] {
  if (!isRequest(input)) return [input, { ...init, dispatcher }]
  const fromRequest: RoutedInit = {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
    redirect: input.redirect,
    credentials: input.credentials,
    cache: input.cache,
    integrity: input.integrity,
    keepalive: input.keepalive,
    mode: input.mode,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    ...input.body === null ? {} : { body: input.body, duplex: 'half' as const },
    dispatcher,
  }
  return [input.url, { ...fromRequest, ...init, dispatcher }]
}

/**
 * Whether a `fetch` input is a request object rather than a URL string or `URL`.
 *
 * A brand check would miss a `Request` from another undici copy, which is exactly the input this
 * conversion exists for, so the shape is measured instead.
 *
 * @param input - the first argument of a `fetch` call.
 * @returns true when {@link input} carries request fields to copy.
 */
function isRequest(
  input: Parameters<typeof globalThis.fetch>[0],
): input is Request {
  return typeof input === 'object' && input !== null
    && 'url' in input && typeof input.url === 'string'
    && 'method' in input && typeof input.method === 'string'
    && 'headers' in input
}

/**
 * Read the URL a `fetch` call targets, leaving the request alone when the input is not absolute.
 *
 * @param input - the first argument of a `fetch` call.
 * @returns the absolute request URL, or `undefined` when it cannot be parsed here.
 */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): URL | undefined {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    return new URL(input.url)
  } catch (_notAnAbsoluteUrl) {
    return undefined
  }
}

/**
 * Install the provider-aware routing wrapper over `globalThis.fetch` for one composition lifetime.
 *
 * The wrapper is installed even with an empty provider table: the plugin page may add a provider
 * later, and `providers` is volatile, so the saved value must take effect without reloading the
 * row. With nothing configured every request reaches the original `fetch` unchanged.
 *
 * An invalid provider entry fails the row at load, matching the route table's policy.
 *
 * @param ctx - plugin lifetime owning the wrapper's disposal.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const routes = compileRoutes(config.routes ?? {})
  // A malformed entry is refused at load rather than silently skipped: skipping would send that
  // provider's traffic around the proxy the person configured.
  compileProviderProxies(providerTableOf(config))
  const providers = new ProviderProxies(() => providerTableOf(config), (message) => { ctx.logger.warn(message) })
  const transports = new RouteTransports()
  const base = globalThis.fetch
  const scope = new AsyncLocalStorage<string>()
  const hostRouted = createRoutedFetch(base, routes, transports)
  const routed = createProviderFetch(
    hostRouted,
    provider => providers.proxyFor(provider),
    () => scope.getStore(),
    transports,
  )
  globalThis.fetch = routed
  const offStream = listenLlmStream(ctx, (options, next) => runWithProvider(scope, options.provider, next()))
  ctx.logger.info(
    'llm-http-proxy: %d provider proxy setting(s), %d host pattern(s) for model requests',
    Object.keys(providerTableOf(config)).length,
    routes.length,
  )
  ctx.effect(() => async () => {
    offStream()
    if (globalThis.fetch === routed) globalThis.fetch = base
    await transports.close()
  })
}

/** The `llm/stream` waterfall listener this bundle registers. */
type LlmStreamListener = (
  options: { readonly provider: string },
  next: () => AsyncIterable<unknown>,
) => AsyncIterable<unknown>

/**
 * Subscribe to DSH's `llm/stream` waterfall without a compile-time dependency on the harness LLM
 * package: that package owns the event declaration, while this bundle must build on its own.
 *
 * @param ctx - plugin lifetime owning the listener.
 * @param listener - the waterfall listener wrapping one model call.
 * @returns the disposer removing the listener.
 */
function listenLlmStream(ctx: Context, listener: LlmStreamListener): () => void {
  const on = ctx.on as unknown as (name: string, listener: LlmStreamListener) => () => boolean
  return on('llm/stream', listener)
}

/** The provider table's compiled proxy URLs, recompiled when a volatile save replaces the table. */
class ProviderProxies {
  private compiled: { source: ProviderProxyTable; urls: Map<string, string> } | undefined

  /**
   * @param read - the live provider table behind the volatile config reference.
   * @param warn - diagnostic sink for a table that no longer compiles.
   */
  constructor(
    private readonly read: () => ProviderProxyTable,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * The proxy URL for one provider.
   *
   * A table written outside the plugin page can turn malformed after load; each entry is compiled on
   * its own so one bad provider cannot take the others' proxies with it. The request keeps the
   * process-wide policy for that provider and the diagnostic names it.
   *
   * @param provider - the provider owning the current model call.
   * @returns the configured proxy URL, or `undefined` when the provider has no usable entry.
   */
  proxyFor(provider: string): string | undefined {
    const source = this.read()
    if (this.compiled?.source !== source) {
      this.compiled = { source, urls: this.compile(source) }
    }
    return this.compiled.urls.get(provider)
  }

  /** Compile every entry of one table, keeping the valid ones and warning about the rest. */
  private compile(source: ProviderProxyTable): Map<string, string> {
    const urls = new Map<string, string>()
    for (const [provider, setting] of Object.entries(source)) {
      try {
        const proxyUrl = compileProviderProxies({ [provider]: setting }).get(provider)
        if (proxyUrl !== undefined) urls.set(provider, proxyUrl)
      } catch (error) {
        this.warn(`llm-http-proxy: ignoring provider "${provider}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return urls
  }
}

/** Transports created by this plugin, one per distinct target, closed with the plugin. */
class RouteTransports implements RouteTransportSource {
  private undici: Promise<typeof import('undici')> | undefined
  private readonly pending = new Map<string, Promise<RouteTransport>>()

  /** @param target - the matched route's target. */
  for(target: RouteTarget): Promise<RouteTransport> {
    const key = target.kind === 'direct' ? 'direct' : target.proxyUrl
    let transport = this.pending.get(key)
    if (transport === undefined) {
      transport = this.create(target)
      this.pending.set(key, transport)
    }
    return transport
  }

  /** Close every dispatcher this plugin created, waiting for in-flight requests to finish. */
  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.pending.values())
    this.pending.clear()
    await Promise.all(settled.map(async (result) => {
      if (result.status === 'rejected') return
      await result.value.dispatcher.close()
    }))
  }

  /**
   * Build the transport for one target.
   *
   * The pair matters: Node's built-in `fetch` only accepts a dispatcher from the undici copy it
   * embeds, so a `ProxyAgent` from this package must be sent by this package's `fetch`. Passing it
   * to `globalThis.fetch` fails with `UND_ERR_INVALID_ARG` (`invalid onRequestStart method`).
   *
   * @param target - the matched route's target.
   * @returns the transport that routes this target's requests.
   */
  private async create(target: RouteTarget): Promise<RouteTransport> {
    this.undici ??= import('undici')
    const undici = await this.undici
    // The route table is this plugin's transport decision: it cannot be expressed by the
    // process-wide policy.
    // proxy-exempt: provider-scoped dispatcher construction.
    const dispatcher = target.kind === 'direct'
      ? new undici.Agent()
      : createProxyDispatcher(undici, target.proxyUrl)
    return { fetch: undiciFetch(undici), dispatcher }
  }
}

/**
 * Build the dispatcher one proxy URL asks for.
 *
 * `compileRoutes` has already refused every scheme but these, so the scheme only decides between
 * HTTP CONNECT tunnelling and a SOCKS5 handshake. undici's SOCKS5 dispatcher emits a one-time
 * `ExperimentalWarning` when built, and sends the host name to the proxy rather than resolving it
 * locally — the behaviour `socks5h` names in `curl`.
 *
 * @param undici - the module building the dispatcher.
 * @param proxyUrl - a validated `http:`, `https:`, or `socks5:` proxy URL.
 * @returns the dispatcher sending this route's requests.
 */
function createProxyDispatcher(undici: typeof import('undici'), proxyUrl: string): Dispatcher {
  // The scheme was validated when the route table was compiled.
  // proxy-exempt: provider-scoped dispatcher construction.
  return new URL(proxyUrl).protocol === 'socks5:'
    ? new undici.Socks5ProxyAgent(proxyUrl)
    : new undici.ProxyAgent({ uri: proxyUrl })
}

/**
 * Build the `fetch` one route sends with: this package's undici, with form bodies rebuilt on that
 * same copy.
 *
 * @param undici - the module that built the route's dispatcher.
 * @returns a `fetch` bound to that module.
 */
function undiciFetch(undici: typeof import('undici')): typeof globalThis.fetch {
  const fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const body = await adaptBody(init?.body, undici.FormData as unknown as FormDataConstructor)
    const routed = body === init?.body ? init : { ...init, body }
    return await undici.fetch(input as never, routed as never) as unknown as Response
  }
  return fetch as typeof globalThis.fetch
}

/** The constructor shape {@link adaptBody} needs; the DOM and undici classes differ nominally. */
interface FormDataConstructor {
  new (): {
    append(name: string, value: string | Blob, filename?: string): void
  }
}

/** A body carrying form entries, whichever copy of the web classes built it. */
function isFormData(body: unknown): body is FormData {
  return typeof body === 'object' && body !== null
    && Object.prototype.toString.call(body) === '[object FormData]'
    && typeof (body as FormData).entries === 'function'
}

/**
 * Rebuild a `FormData` body on the undici copy that will send it.
 *
 * `FormData` is the one request body class each copy implements itself, so undici does not recognise
 * a `FormData` built by Node's built-in fetch and would send the string `[object FormData]` instead.
 * Rebuilding the entries on this package's class keeps multipart uploads — including a file name and
 * media type — intact. A body that copy already owns passes through untouched.
 *
 * @param body - the request body as the caller supplied it.
 * @param FormDataClass - the undici copy's `FormData` constructor.
 * @returns the body to send, rebuilt when it came from another copy.
 */
async function adaptBody(
  body: BodyInit | null | undefined,
  FormDataClass: FormDataConstructor,
): Promise<BodyInit | null | undefined> {
  if (!isFormData(body) || body.constructor === FormDataClass) return body
  const converted = new FormDataClass()
  for (const [name, entry] of body) {
    if (typeof entry === 'string') {
      converted.append(name, entry)
      continue
    }
    const value = entry as unknown as { arrayBuffer(): Promise<ArrayBuffer>; type: string; name?: string }
    // A blob this runtime's classes built is accepted as-is; one from another copy is recopied.
    const blob: Blob = value instanceof Blob
      ? value
      : new Blob([await value.arrayBuffer()], { type: value.type })
    converted.append(name, blob, typeof value.name === 'string' ? value.name : undefined)
  }
  return converted as unknown as BodyInit
}
