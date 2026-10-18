import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Dispatcher } from 'undici'
import * as plugin from '../src/index.ts'
import { compileRoutes, createRoutedFetch, type RouteTarget } from '../src/index.ts'

/** Records the target each routed request asked for. */
function fakeDispatchers(): {
  targets: RouteTarget[]
  for(target: RouteTarget): Promise<Dispatcher>
} {
  const targets: RouteTarget[] = []
  return {
    targets,
    for: (target) => {
      targets.push(target)
      return Promise.resolve({ close: () => Promise.resolve() } as unknown as Dispatcher)
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

  it('sends a matched host with that route’s dispatcher', async () => {
    const dispatchers = fakeDispatchers()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, dispatchers)
    await routed('https://api.example.com/v1/messages')
    expect(dispatchers.targets).toEqual([{ kind: 'proxy', proxyUrl: 'http://127.0.0.1:7890' }])
    expect(base.calls).toHaveLength(1)
    expect(base.calls[0]).toBeDefined()
  })

  it('routes a direct target without a proxy URL', async () => {
    const dispatchers = fakeDispatchers()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, dispatchers)
    await routed(new URL('https://direct.example/v1'))
    expect(dispatchers.targets).toEqual([{ kind: 'direct' }])
  })

  it('delegates an unmatched host unchanged', async () => {
    const dispatchers = fakeDispatchers()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, dispatchers)
    await routed('https://other.test/v1', { headers: { 'x-test': '1' } })
    expect(dispatchers.targets).toEqual([])
    expect(base.calls[0]).toBeUndefined()
  })

  it('reads the URL of a Request input', async () => {
    const dispatchers = fakeDispatchers()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, dispatchers)
    await routed(new Request('https://api.example.com/v1'))
    expect(dispatchers.targets).toHaveLength(1)
  })

  it('delegates an input it cannot parse', async () => {
    const dispatchers = fakeDispatchers()
    const base = recordingFetch()
    const routed = createRoutedFetch(base.fetch, routes, dispatchers)
    await routed('not-a-url')
    expect(dispatchers.targets).toEqual([])
    expect(base.calls).toHaveLength(1)
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
    await expect(context.plugin(plugin, { routes: { 'example.com': 'socks5://127.0.0.1:1080' } }))
      .rejects.toThrow(/unsupported socks5:\/\/ scheme/)
  })
})
