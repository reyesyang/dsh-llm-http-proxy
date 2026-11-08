import { describe, expect, it } from 'vitest'
import { compileProviderProxies } from '../src/providers.ts'

describe('compileProviderProxies', () => {
  it('turns an HTTP transport and address into a proxy URL', () => {
    expect(compileProviderProxies({
      opencode: { type: 'http', address: '127.0.0.1:7890' },
    })).toEqual(new Map([['opencode', 'http://127.0.0.1:7890']]))
  })

  it('turns a SOCKS5 transport and address into a proxy URL', () => {
    expect(compileProviderProxies({
      opendesign: { type: 'socks5', address: '127.0.0.1:7891' },
    })).toEqual(new Map([['opendesign', 'socks5://127.0.0.1:7891']]))
  })

  it('keeps proxy credentials and surrounding whitespace out of the address', () => {
    expect(compileProviderProxies({
      secured: { type: 'http', address: ' alice:s3cret@10.0.0.1:8080 ' },
    })).toEqual(new Map([['secured', 'http://alice:s3cret@10.0.0.1:8080']]))
  })

  it('omits a disabled entry so the provider keeps the process-wide policy', () => {
    expect(compileProviderProxies({
      paused: { type: 'http', address: '127.0.0.1:7890', enabled: false },
      live: { type: 'socks5', address: '127.0.0.1:7891' },
    })).toEqual(new Map([['live', 'socks5://127.0.0.1:7891']]))
  })

  it('keeps every provider in configuration order', () => {
    const compiled = compileProviderProxies({
      first: { type: 'http', address: '127.0.0.1:1' },
      second: { type: 'socks5', address: '127.0.0.1:2' },
    })
    expect([...compiled.keys()]).toEqual(['first', 'second'])
  })

  it.each([
    ['an empty provider id', { ' ': { type: 'http' as const, address: '127.0.0.1:7890' } }, /provider ids must not be empty/],
    ['an empty address', { live: { type: 'http' as const, address: '  ' } }, /empty proxy address/],
    ['an address carrying a scheme', { live: { type: 'http' as const, address: 'http://127.0.0.1:7890' } }, /without a scheme/],
    ['an address without a host', { live: { type: 'socks5' as const, address: ':1080' } }, /invalid proxy address/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => compileProviderProxies(raw)).toThrow(message)
  })
})
