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
 * Node's built-in `fetch` accepts the non-standard `dispatcher` request option (measured on
 * 22.19.0, 24.16.0, and 26.12.0), so the wrapped request keeps Node's own `fetch`, `Response`, and
 * streams; only the transport differs. `undici` supplies the dispatchers themselves.
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

/** The dispatcher a matched route selected, as {@link createRoutedFetch} needs it. */
export interface RouteDispatcherSource {
  /**
   * Return the dispatcher for one route target, creating it on first use.
   * @param target - the matched route's target.
   * @returns the dispatcher to send this request with.
   */
  for(target: RouteTarget): Promise<Dispatcher>
}

/**
 * Wrap `fetch` so a routed host reaches its own transport and every other request is delegated
 * untouched.
 *
 * @param base - the `fetch` to delegate unmatched requests to; the process-wide policy lives there.
 * @param routes - validated routes in configuration order; the first match wins.
 * @param dispatchers - dispatcher source for matched targets.
 * @returns a `fetch` with the same call and return type as {@link base}.
 */
export function createRoutedFetch(
  base: typeof globalThis.fetch,
  routes: readonly ProxyRoute[],
  dispatchers: RouteDispatcherSource,
): typeof globalThis.fetch {
  const routed: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const route = url === undefined ? undefined : routeFor(routes, url)
    if (route === undefined) return base(input, init)
    const dispatcher = await dispatchers.for(route.target)
    // A provider-scoped route selects its own transport; the process-wide dispatcher cannot
    // answer per origin.
    // proxy-exempt: provider-scoped dispatcher selection.
    const routedInit: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher }
    return base(input, routedInit)
  }
  return routed
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
  const dispatchers = new RouteDispatchers()
  const base = globalThis.fetch
  const routed = createRoutedFetch(base, routes, dispatchers)
  globalThis.fetch = routed
  ctx.logger.info('llm-http-proxy: routing %d host pattern(s) for model requests', routes.length)
  ctx.effect(() => async () => {
    if (globalThis.fetch === routed) globalThis.fetch = base
    await dispatchers.close()
  })
}

/** Dispatchers created by this plugin, one per distinct target, closed with the plugin. */
class RouteDispatchers implements RouteDispatcherSource {
  private undici: Promise<typeof import('undici')> | undefined
  private readonly pending = new Map<string, Promise<Dispatcher>>()

  /** @param target - the matched route's target. */
  for(target: RouteTarget): Promise<Dispatcher> {
    const key = target.kind === 'direct' ? 'direct' : target.proxyUrl
    let dispatcher = this.pending.get(key)
    if (dispatcher === undefined) {
      dispatcher = this.create(target)
      this.pending.set(key, dispatcher)
    }
    return dispatcher
  }

  /** Close every dispatcher this plugin created, waiting for in-flight requests to finish. */
  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.pending.values())
    this.pending.clear()
    await Promise.all(settled.map(async (result) => {
      if (result.status === 'rejected') return
      await result.value.close()
    }))
  }

  /**
   * Build the dispatcher for one target.
   * @param target - the matched route's target.
   * @returns the dispatcher to route this target's requests.
   */
  private async create(target: RouteTarget): Promise<Dispatcher> {
    this.undici ??= import('undici')
    const { Agent, ProxyAgent } = await this.undici
    // The route table is this plugin's transport decision: it cannot be expressed by the
    // process-wide policy.
    // proxy-exempt: provider-scoped dispatcher construction.
    return target.kind === 'direct' ? new Agent() : new ProxyAgent({ uri: target.proxyUrl })
  }
}
