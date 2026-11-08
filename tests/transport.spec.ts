import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import * as plugin from '../src/index.ts'

interface Running {
  readonly server: net.Server
  readonly url: string
}

/** Listen on an ephemeral loopback port and report the base URL. */
function listen(server: net.Server): Promise<Running> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** Close a server and wait for its sockets, matching the transport's own disposal order. */
function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}

/** An origin that echoes the method and body it received. */
function targetServer(): http.Server {
  return http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ method: req.method, body, contentType: req.headers['content-type'] }))
  })
}

/** A forwarding HTTP proxy that counts the requests it received. */
function proxyServer(onRequest: () => void): http.Server {
  return http.createServer((req, res) => {
    onRequest()
    let destination: URL
    try {
      destination = new URL(req.url ?? '')
    } catch (_absoluteFormExpected) {
      res.statusCode = 400
      res.end()
      return
    }
    const upstream = http.request(destination, { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => {
      res.statusCode = 502
      res.end()
    })
    req.pipe(upstream)
  })
}

/**
 * A minimal SOCKS5 CONNECT server (RFC 1928, no authentication) that records the address type and
 * host name each tunnel asked for.
 *
 * The recorded address type is what separates `socks5` from `socks5h` in `curl` terms: a `DOMAIN`
 * request leaves resolution to the proxy, an `IPV4` request resolves locally before connecting.
 */
function socks5Server(onConnect: (addressType: number, host: string) => void): net.Server {
  return net.createServer((client) => {
    let stage: 'greeting' | 'request' | 'tunnelling' = 'greeting'
    let buffered = Buffer.alloc(0)

    const tunnel = (addressType: number, host: string, port: number, leftover: Buffer): void => {
      onConnect(addressType, host)
      const upstream = net.connect(port, host, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        if (leftover.length > 0) upstream.write(leftover)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    }

    const pump = (): void => {
      // Once the tunnel is open the bytes are the tunnelled protocol's, not another SOCKS5
      // handshake: the client keeps the connection for the request it opened it for.
      if (stage === 'tunnelling') return
      if (stage === 'greeting') {
        if (buffered.length < 2) return
        const methods = buffered[1] ?? 0
        if (buffered.length < 2 + methods) return
        buffered = buffered.subarray(2 + methods)
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (buffered.length < 5) return
      const addressType = buffered[3] ?? 0
      let host: string
      let offset: number
      if (addressType === 0x01) {
        if (buffered.length < 10) return
        host = [...buffered.subarray(4, 8)].join('.')
        offset = 8
      } else if (addressType === 0x03) {
        const length = buffered[4] ?? 0
        if (buffered.length < 5 + length + 2) return
        host = buffered.subarray(5, 5 + length).toString('utf8')
        offset = 5 + length
      } else {
        client.destroy()
        return
      }
      if (buffered.length < offset + 2) return
      const port = buffered.readUInt16BE(offset)
      const leftover = buffered.subarray(offset + 2)
      stage = 'tunnelling'
      buffered = Buffer.alloc(0)
      tunnel(addressType, host, port, leftover)
    }

    client.on('data', (chunk) => {
      if (stage === 'tunnelling') return
      buffered = Buffer.concat([buffered, chunk])
      pump()
    })
    client.on('error', () => {})
  })
}

describe('routed transport', () => {
  let context: Context | undefined
  const servers: net.Server[] = []
  let proxyHits = 0
  let configuredHits = 0
  const tunnels: { addressType: number; host: string }[] = []

  afterEach(async () => {
    // Disposing closes the plugin's agents first; only then can the servers' keep-alive sockets go.
    await context?.fiber.dispose()
    context = undefined
    await Promise.all(servers.splice(0).map(close))
    proxyHits = 0
    configuredHits = 0
    tunnels.length = 0
  })

  /** Start an origin and a proxy, and return a route from the origin to the proxy. */
  async function startPair(): Promise<{ target: Running; routes: Record<string, string> }> {
    const target = await listen(targetServer())
    const proxy = await listen(proxyServer(() => { proxyHits += 1 }))
    servers.push(target.server, proxy.server)
    const port = new URL(target.url).port
    return { target, routes: { [`127.0.0.1:${port}`]: proxy.url } }
  }

  it('sends a matched request through the proxy with undici’s own fetch', async () => {
    const { target, routes } = await startPair()
    context = new Context()
    await context.plugin(plugin, { routes })

    const response = await globalThis.fetch(`${target.url}/v1/messages`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ method: 'GET', body: '' })
    expect(proxyHits).toBe(1)
  })

  it('expands a Request built by Node’s fetch before routing it', async () => {
    const { target, routes } = await startPair()
    context = new Context()
    await context.plugin(plugin, { routes })

    const request = new Request(`${target.url}/v1/messages`, { method: 'POST', body: 'payload' })
    const response = await globalThis.fetch(request)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ method: 'POST', body: 'payload' })
    expect(proxyHits).toBe(1)
  })

  it('rebuilds a FormData upload on undici’s own web classes', async () => {
    const { target, routes } = await startPair()
    context = new Context()
    await context.plugin(plugin, { routes })

    const form = new FormData()
    form.set('expires_after[anchor]', 'created_at')
    form.set('file', new Blob(['abc'], { type: 'image/png' }), 'x.png')
    const response = await globalThis.fetch(`${target.url}/files`, { method: 'POST', body: form })

    expect(response.status).toBe(200)
    const payload = await response.json() as { method: string; body: string; contentType: string }
    expect(payload.method).toBe('POST')
    expect(payload.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(payload.body).toContain('name="expires_after[anchor]"\r\n\r\ncreated_at')
    expect(payload.body).toContain('name="file"; filename="x.png"')
    expect(payload.body).toContain('Content-Type: image/png')
    expect(payload.body).toContain('abc')
    expect(proxyHits).toBe(1)
  })

  it('sends a direct route around the process-wide proxy', async () => {
    const target = await listen(targetServer())
    servers.push(target.server)
    const port = new URL(target.url).port

    const previous = getGlobalDispatcher()
    // Port 9 is never listening: reaching for it would fail the test rather than pass it.
    const processProxy = new ProxyAgent({ uri: 'http://127.0.0.1:9' })
    setGlobalDispatcher(processProxy)
    try {
      context = new Context()
      await context.plugin(plugin, { routes: { [`127.0.0.1:${port}`]: 'direct' } })

      const response = await globalThis.fetch(`${target.url}/direct`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ method: 'GET', body: '' })
      expect(proxyHits).toBe(0)
    } finally {
      setGlobalDispatcher(previous)
      await processProxy.close()
    }
  })

  it('sends a matched request through a SOCKS5 proxy', async () => {
    const target = await listen(targetServer())
    const socks = await listen(socks5Server((addressType, host) => { tunnels.push({ addressType, host }) }))
    servers.push(target.server, socks.server)
    const port = new URL(target.url).port
    // The route names localhost, not 127.0.0.1: only a host name can arrive as a SOCKS5 DOMAIN
    // request, which is the address type that leaves resolution to the proxy.
    context = new Context()
    await context.plugin(plugin, { routes: { [`localhost:${port}`]: `socks5://${new URL(socks.url).host}` } })

    const response = await globalThis.fetch(`http://localhost:${port}/v1/messages`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ method: 'GET', body: '' })
    // 0x03 is DOMAIN: the proxy resolved the host, as `socks5h` asks of curl.
    expect(tunnels).toEqual([{ addressType: 0x03, host: 'localhost' }])
  })

  it('treats a socks5h alias as the same SOCKS5 transport', async () => {
    const target = await listen(targetServer())
    const socks = await listen(socks5Server((addressType, host) => { tunnels.push({ addressType, host }) }))
    servers.push(target.server, socks.server)
    const port = new URL(target.url).port
    context = new Context()
    await context.plugin(plugin, { routes: { [`localhost:${port}`]: `socks5h://${new URL(socks.url).host}` } })

    const response = await globalThis.fetch(`http://localhost:${port}/alias`)

    expect(response.status).toBe(200)
    expect(tunnels).toEqual([{ addressType: 0x03, host: 'localhost' }])
  })

  /**
   * Drive one model call through the plugin's `llm/stream` listener.
   *
   * The listener is registered by `apply`; this helper dispatches the same shape the LLM service
   * uses, so the `fetch` inside the callback sees the provider in scope.
   */
  async function modelCall(provider: string, url: string): Promise<Response> {
    const waterfall = context!.waterfall as unknown as (
      thisArg: Context,
      name: string,
      options: { provider: string },
      next: () => AsyncIterable<Response>,
    ) => AsyncIterable<Response>
    const stream = waterfall.call(context!, context!, 'llm/stream', { provider }, () => (async function* () {
      yield await globalThis.fetch(url)
    })())
    const chunks: Response[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks[0]!
  }

  it('sends a provider-routed model request through its HTTP proxy', async () => {
    const target = await listen(targetServer())
    const proxy = await listen(proxyServer(() => { proxyHits += 1 }))
    servers.push(target.server, proxy.server)
    context = new Context()
    await context.plugin(plugin, {
      providers: { 'open-design': { type: 'http', address: new URL(proxy.url).host } },
    })

    const response = await modelCall('open-design', `${target.url}/v1/messages`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ method: 'GET', body: '' })
    expect(proxyHits).toBe(1)
  })

  it('sends a provider-routed model request through a SOCKS5 proxy', async () => {
    const target = await listen(targetServer())
    const socks = await listen(socks5Server((addressType, host) => { tunnels.push({ addressType, host }) }))
    servers.push(target.server, socks.server)
    const port = new URL(target.url).port
    context = new Context()
    await context.plugin(plugin, {
      providers: { 'open-design': { type: 'socks5', address: new URL(socks.url).host } },
    })

    const response = await modelCall('open-design', `http://localhost:${port}/v1/messages`)

    expect(response.status).toBe(200)
    expect(tunnels).toEqual([{ addressType: 0x03, host: 'localhost' }])
  })

  it('leaves a provider without an entry on the process-wide policy', async () => {
    const target = await listen(targetServer())
    const proxy = await listen(proxyServer(() => { proxyHits += 1 }))
    servers.push(target.server, proxy.server)

    const previous = getGlobalDispatcher()
    const processProxy = new ProxyAgent({ uri: proxy.url })
    setGlobalDispatcher(processProxy)
    try {
      context = new Context()
      await context.plugin(plugin, { providers: {} })

      const response = await modelCall('plain', `${target.url}/v1/messages`)

      expect(response.status).toBe(200)
      expect(proxyHits).toBe(1)
    } finally {
      setGlobalDispatcher(previous)
      await processProxy.close()
    }
  })

  it('leaves a disabled provider entry on the process-wide policy', async () => {
    const target = await listen(targetServer())
    const processProxy = await listen(proxyServer(() => { proxyHits += 1 }))
    const configuredProxy = await listen(proxyServer(() => { configuredHits += 1 }))
    servers.push(target.server, processProxy.server, configuredProxy.server)

    const previous = getGlobalDispatcher()
    const processAgent = new ProxyAgent({ uri: processProxy.url })
    setGlobalDispatcher(processAgent)
    try {
      context = new Context()
      await context.plugin(plugin, {
        providers: { live: { type: 'http', address: new URL(configuredProxy.url).host, enabled: false } },
      })

      const response = await modelCall('live', `${target.url}/v1/messages`)

      expect(response.status).toBe(200)
      expect(configuredHits).toBe(0)
      expect(proxyHits).toBe(1)
    } finally {
      setGlobalDispatcher(previous)
      await processAgent.close()
    }
  })
})
