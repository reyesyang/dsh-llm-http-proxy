# dsh-llm-http-proxy

Provider-scoped outbound proxy routes for model requests.

DSH resolves **one** outbound proxy policy per process from `HTTP_PROXY` / `HTTPS_PROXY` /
`ALL_PROXY` and installs it as undici's global dispatcher. That cannot express a deployment with
several model endpoints that need different egress — an overseas provider behind a local proxy, an
internal gateway that must stay direct. This plugin adds the missing per-provider choice without
touching the process policy: it wraps `globalThis.fetch` and sends a request whose host matches a
configured route with a dispatcher chosen for that route. Unmatched requests reach the original
`fetch` unchanged and keep the process-wide policy.

## Configuration

```yaml
- id: llm-http-proxy
  name: 'dsh-llm-http-proxy'
  config:
    routes:
      # Overseas providers through the local proxy.
      opencode.ai: http://127.0.0.1:7890
      kimi.com: http://127.0.0.1:7890
```

Keys are host patterns matched against each request's host with the documented `NO_PROXY`
vocabulary: an entry matches its host and every subdomain under it, a leading `.` or `*.` means the
same suffix rule, an optional `:port` narrows the entry, and `*` matches every host. First match
wins. Values are `direct` (bypass any process-wide proxy) or an `http://` / `https://` proxy URL.

Routes name hosts, not provider ids: the LLM registry exposes provider ids and display names but no
endpoint, so write the host of the provider's configured `baseURL`.

A malformed pattern or proxy URL fails the plugin load instead of being skipped: a silently dropped
route proxies exactly the traffic the user tried to route elsewhere. A SOCKS proxy URL is refused;
point the entry at the proxy application's HTTP port instead.

## Limits

- The wrapper covers `globalThis.fetch`, which is what the shipped model adapters reach. A library
  that calls `undici.fetch` directly keeps the process-wide policy.
- The `dispatcher` request option is a non-standard undici extension. It is measured on Node
  22.19.0, 24.16.0, and 26.12.0; a runtime that drops it would fall back to the process-wide policy
  rather than failing.
- Proxy URLs may carry credentials. Nothing here prints a proxy URL; diagnostics name the route
  pattern and the target kind only.
- A TLS-intercepting proxy still needs `NODE_EXTRA_CA_CERTS`, which is read once at process start.
