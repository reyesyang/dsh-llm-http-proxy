import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Dispatcher } from 'undici'
import * as plugin from '../src/index.ts'
import {
  compileRoutes,
  createRoutedFetch,
  type RouteTarget,
  type RouteTransport,
} from '../src/index.ts'

/** A transport that records the input and dispatcher each routed call carried. */
function fakeTransport(): {
  calls: { input: unknown; init: (RequestInit & { dispatcher?: Dispatcher; duplex?: 'half' }) | undefined }[]
  dispatcher: Dispatcher
  fetch: typeof globalThis.fetch
} {
  const calls: { input: unknown; init: (RequestInit & { dispatcher?: Dispatcher; duplex?: 'half' }) | undefined }[] = []
  const dispatcher = { close: () => Promise.resolve() } as unknown as Dispatcher
  const fetch = ((input: unknown, init?: RequestInit & { dispatcher?: Dispatcher; duplex?: 'half' }) => {
    calls.push({ input, init })
    return Promise.resolve(new Response('ok'))
  }) as unknown as typeof globalThis.fetch
  return { calls, dispatcher, fetch }
}

/** A transport source that hands out one recording transport and remembers each target. */
function fakeTransports(): {
  targets: RouteTarget[]
  transport: ReturnType<typeof fakeTransport>
  for(target: RouteTarget): Promise<RouteTransport>
} {
  const targets: RouteTarget[] = []
  const transport = fakeTransport()
  return {
    targets,
    transport,
    for: (target) => {
      targets.push(target)
      return Promise.resolve(transport)
    },
  }
}

/** A fetch that records the dispatcher each call carried. */
function recordingFetch(): { calls: (Dispatcher | undefined)[]; fetch: typeof globalThis.fetch } {
  const calls: (Dispatcher | undefined)[] = []
  const fetch = ((_input: unknown, init?: RequestInit & { dispatcher?: Dispatcher }) => {
    calls.push(init?.dispatcher)
    return Promise.resolve(new Response('ok'))
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe('createRoutedFetch', () => {
  const routes = compileRoutes({
    'api.example.com': 'http://127.0.0.1:7890',
    'direct.example': 'direct',
  })

  it('sends a matched host through that route’s transport', async () => {
    const transports = fakeTransports()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, transports)
    await routed('https://api.example.com/v1/messages')
    expect(transports.targets).toEqual([{ kind: 'proxy', proxyUrl: 'http://127.0.0.1:7890' }])
    expect(transports.transport.calls).toHaveLength(1)
    expect(transports.transport.calls[0]?.init?.dispatcher).toBe(transports.transport.dispatcher)
    expect(base.calls).toHaveLength(0)
  })

  it('routes a direct target without a proxy URL', async () => {
    const transports = fakeTransports()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, transports)
    await routed(new URL('https://direct.example/v1'))
    expect(transports.targets).toEqual([{ kind: 'direct' }])
  })

  it('delegates an unmatched host unchanged', async () => {
    const transports = fakeTransports()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, transports)
    await routed('https://other.test/v1', { headers: { 'x-test': '1' } })
    expect(transports.targets).toEqual([])
    expect(base.calls).toEqual([undefined])
  })

  it('expands a Request input to a URL and its request fields', async () => {
    const transports = fakeTransports()
    const routed = createRoutedFetch(recordingFetch().fetch, routes, transports)
    const request = new Request('https://api.example.com/v1', {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: 'payload',
    })
    await routed(request)
    expect(transports.targets).toHaveLength(1)
    const call = transports.transport.calls[0]
    // `undici.fetch` cannot parse a Request built by Node's own fetch, so the URL replaces it.
    expect(call?.input).toBe('https://api.example.com/v1')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toEqual(request.headers)
    expect(call?.init?.body).toBe(request.body)
    expect(call?.init?.duplex).toBe('half')
  })

  it('lets an explicit init override the Request fields', async () => {
    const transports = fakeTransports()
    const routed = createRoutedFetch(recordingFetch().fetch, routes, transports)
    await routed(new Request('https://api.example.com/v1', { method: 'POST', body: 'payload' }), {
      method: 'PUT',
    })
    expect(transports.transport.calls[0]?.init?.method).toBe('PUT')
  })

  it('delegates an input it cannot parse', async () => {
    const transports = fakeTransports()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, transports)
    await routed('not-a-url')
    expect(transports.targets).toEqual([])
    expect(base.calls).toEqual([undefined])
  })
})

describe('apply', () => {
  let context: Context | undefined
  const original = globalThis.fetch

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    globalThis.fetch = original
  })

  it('installs a wrapper over globalThis.fetch and restores it on disposal', async () => {
    context = new Context()
    const fiber = context.plugin(plugin, {
      routes: { 'api.example.com': 'http://127.0.0.1:7890' },
    })
    await fiber
    expect(globalThis.fetch).not.toBe(original)
    await fiber.dispose()
    expect(globalThis.fetch).toBe(original)
  })

  it('installs nothing for an empty route table', async () => {
    context = new Context()
    const fiber = context.plugin(plugin, { routes: {} })
    await fiber
    expect(globalThis.fetch).toBe(original)
  })

  it('refuses an invalid configured target at load', async () => {
    context = new Context()
    await expect(context.plugin(plugin, { routes: { 'example.com': 'socks4://127.0.0.1:1080' } }))
      .rejects.toThrow(/unsupported socks4:\/\/ scheme/)
  })
})
