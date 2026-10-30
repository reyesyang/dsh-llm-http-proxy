import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici'
import * as plugin from '../src/index.ts'

interface Running {
  readonly server: http.Server
  readonly url: string
}

/** Listen on an ephemeral loopback port and report the base URL. */
function listen(server: http.Server): Promise<Running> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

/** Close a server and wait for its sockets, matching the transport's own disposal order. */
function close(server: http.Server): Promise<void> {
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

describe('routed transport', () => {
  let context: Context | undefined
  const servers: http.Server[] = []
  let proxyHits = 0

  afterEach(async () => {
    // Disposing closes the plugin's agents first; only then can the servers' keep-alive sockets go.
    await context?.fiber.dispose()
    context = undefined
    await Promise.all(servers.splice(0).map(close))
    proxyHits = 0
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
})
