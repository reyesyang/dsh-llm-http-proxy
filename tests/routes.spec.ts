import { describe, expect, it } from 'vitest'
import { compileRoutes, routeFor } from '../src/routes.ts'

describe('compileRoutes', () => {
  it('accepts direct and HTTP(S) proxy targets', () => {
    expect(compileRoutes({
      'example.com': 'direct',
      '.corp.example': 'http://127.0.0.1:7890',
      'secure.example': 'https://proxy.example:8443',
    })).toEqual([
      { pattern: 'example.com', target: { kind: 'direct' } },
      { pattern: '.corp.example', target: { kind: 'proxy', proxyUrl: 'http://127.0.0.1:7890' } },
      { pattern: 'secure.example', target: { kind: 'proxy', proxyUrl: 'https://proxy.example:8443' } },
    ])
  })

  it('accepts a SOCKS5 proxy target', () => {
    expect(compileRoutes({ 'example.com': 'socks5://127.0.0.1:1080' })).toEqual([
      { pattern: 'example.com', target: { kind: 'proxy', proxyUrl: 'socks5://127.0.0.1:1080' } },
    ])
  })

  it.each([
    ['socks', 'socks://127.0.0.1:1080'],
    ['socks5h', 'socks5h://127.0.0.1:1080'],
  ])('rewrites a %s alias to the scheme undici dispatches on', (_label, written) => {
    expect(compileRoutes({ 'example.com': written })).toEqual([
      { pattern: 'example.com', target: { kind: 'proxy', proxyUrl: 'socks5://127.0.0.1:1080' } },
    ])
  })

  it('keeps SOCKS5 credentials and a rewritten scheme together', () => {
    expect(compileRoutes({ 'example.com': 'socks5h://alice:s3cret@10.0.0.1:1080' })).toEqual([
      { pattern: 'example.com', target: { kind: 'proxy', proxyUrl: 'socks5://alice:s3cret@10.0.0.1:1080' } },
    ])
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(compileRoutes({ ' Example.COM ': ' DIRECT ' })).toEqual([
      { pattern: 'example.com', target: { kind: 'direct' } },
    ])
  })

  it('keeps proxy credentials in the resolved URL', () => {
    expect(compileRoutes({ 'example.com': 'http://alice:s3cret@proxy.example:8080' })).toEqual([
      { pattern: 'example.com', target: { kind: 'proxy', proxyUrl: 'http://alice:s3cret@proxy.example:8080' } },
    ])
  })

  it.each([
    ['an empty pattern', { ' ': 'direct' }, /must not be empty/],
    ['an unparseable target', { 'example.com': 'not a url' }, /neither "direct" nor a valid URL/],
    ['a SOCKS4 target', { 'example.com': 'socks4://127.0.0.1:1080' }, /unsupported socks4:\/\/ scheme/],
    ['a plain HTTP target', { 'example.com': 'ftp://example.com' }, /unsupported ftp:\/\/ scheme/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => compileRoutes(raw)).toThrow(message)
  })
})

describe('routeFor', () => {
  const routes = compileRoutes({
    'api.example.com': 'http://127.0.0.1:7890',
    'suffix.example': 'direct',
    '*.dot.example': 'http://127.0.0.1:7891',
    'ported.example:8443': 'direct',
    '*': 'direct',
  })

  it.each([
    ['an exact host', 'https://api.example.com/v1', 'api.example.com'],
    ['a subdomain of a suffix entry', 'https://api.suffix.example/v1', 'suffix.example'],
    ['a wildcard-dot entry', 'https://api.dot.example', '*.dot.example'],
    ['the wildcard entry', 'https://elsewhere.test', '*'],
  ])('matches %s', (_label, href, pattern) => {
    expect(routeFor(routes, new URL(href))?.pattern).toBe(pattern)
  })

  it('honors a port in the pattern', () => {
    expect(routeFor(routes, new URL('https://ported.example:8443/v1'))?.pattern).toBe('ported.example:8443')
    expect(routeFor(routes, new URL('https://ported.example/v1'))?.pattern).toBe('*')
  })

  it('matches case-insensitively and ignores a trailing dot', () => {
    expect(routeFor(routes, new URL('https://API.Example.COM./v1'))?.pattern).toBe('api.example.com')
  })

  it('returns undefined when nothing matches', () => {
    const narrow = compileRoutes({ 'example.com': 'direct' })
    expect(routeFor(narrow, new URL('https://other.test'))).toBeUndefined()
  })

  it('uses the first matching route', () => {
    const ordered = compileRoutes({
      'api.example.com': 'http://127.0.0.1:7890',
      'example.com': 'direct',
    })
    expect(routeFor(ordered, new URL('https://api.example.com'))?.pattern).toBe('api.example.com')
  })

  it('matches an IPv6 literal without brackets', () => {
    const ipv6 = compileRoutes({ '[::1]:8080': 'direct' })
    expect(routeFor(ipv6, new URL('http://[::1]:8080/v1'))?.pattern).toBe('[::1]:8080')
    expect(routeFor(ipv6, new URL('http://[::1]:9090/v1'))).toBeUndefined()
  })
})
