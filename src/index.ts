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
 *     routes:
 *       opencode.ai: http://127.0.0.1:7890
 *       kimi.com: http://127.0.0.1:7890
 * ```
 *
 * @module dsh-llm-http-proxy
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Dispatcher } from 'undici'
import { compileRoutes, routeFor } from './routes.ts'
import type { ProxyRoute, RouteTarget } from './routes.ts'

export { compileRoutes, routeFor } from './routes.ts'
export type { ProxyRoute, RouteTarget } from './routes.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-http-proxy'

/** This plugin depends on no service: it rewrites the transport every caller reaches. */
export const inject: string[] = []

/** Plugin config. */
export interface Config {
  /**
   * Host pattern to `direct` or an HTTP(S) proxy URL, matched against each request's host the way
   * `NO_PROXY` matches entries. First match wins; an unmatched host keeps the process-wide policy.
   */
  readonly routes: Record<string, string>
}

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  routes: z.dict(z.string()).default({}),
}) as unknown as z<Config>

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
 * Install the routing wrapper over `globalThis.fetch` for one composition lifetime.
 *
 * An empty route table installs nothing: the plugin then has no effect at all rather than wrapping
 * `fetch` to choose the same global dispatcher for every call.
 *
 * @param ctx - plugin lifetime owning the wrapper's disposal.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const routes = compileRoutes(config.routes ?? {})
  if (routes.length === 0) return
  const transports = new RouteTransports()
  const base = globalThis.fetch
  const routed = createRoutedFetch(base, routes, transports)
  globalThis.fetch = routed
  ctx.logger.info('llm-http-proxy: routing %d host pattern(s) for model requests', routes.length)
  ctx.effect(() => async () => {
    if (globalThis.fetch === routed) globalThis.fetch = base
    await transports.close()
  })
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
      : new undici.ProxyAgent({ uri: target.proxyUrl })
    return { fetch: undiciFetch(undici), dispatcher }
  }
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
