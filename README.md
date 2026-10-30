# dsh-llm-http-proxy

Provider-scoped outbound proxy routes for model requests.

DSH resolves **one** outbound proxy policy per process from `HTTP_PROXY` / `HTTPS_PROXY` /
`ALL_PROXY` and installs it as undici's global dispatcher. That cannot express a deployment with
several model endpoints that need different egress — an overseas provider behind a local proxy, an
internal gateway that must stay direct. This plugin adds the missing per-provider choice without
touching the process policy: it wraps `globalThis.fetch` and sends a request whose host matches a
configured route with a dispatcher chosen for that route. Unmatched requests reach the original
`fetch` unchanged and keep the process-wide policy.

A matched request travels on `undici`'s own `fetch`, not Node's built-in one. A dispatcher is only
valid for the `fetch` from the same undici copy: Node's built-in `fetch` embeds its own undici and
rejects a `ProxyAgent` from the npm package with `UND_ERR_INVALID_ARG: invalid onRequestStart
method`, which the OpenAI SDK reports as `Connection error. This may be caused by passing an undici
dispatcher...`. Pairing the two inside this plugin keeps that error out of the deployment. Request
bodies built by the runtime's web classes are rebuilt on undici's matching classes, so a multipart
`FormData` upload keeps its fields, file name, and media type.

## Install

This package is a DSH bundle: its `package.json` declares `dsh.bundle.patch`, so a profile installs
and enables it as a unit rather than by hand-editing the profile patch.

Install it into the profile that should use it:

```
plugin_manager(action="install_bundle", target="dsh-llm-http-proxy")
```

`install_bundle` adds the dependency, selects the bundle, and applies its patch layer. To develop
against a local checkout, pass the checkout's absolute path instead; DSH records it as a `link:`
dependency:

```
plugin_manager(action="install_bundle", target="/absolute/path/to/dsh-llm-http-proxy")
```

A linked checkout supplies its own `dependencies` and `peerDependencies`. Rebuilding and restarting
DSH are required after changing its code; configuration changes apply through HMR.

Enable or disable the installed bundle and its row from the plugin page, or with
`plugin_manager(action="set_bundle", target="dsh-llm-http-proxy", enabled=false)` and
`plugin_manager(action="set_plugin", target="llm-http-proxy", enabled=false)`.

## Configuration

The bundle ships an empty route table, so installing it changes no traffic. Override the row in the
profile's `cordis.patch.yml` — the profile layer wins over the bundle's default:

```yaml
- id: llm-http-proxy
  name: 'dsh-llm-http-proxy'
  config:
    routes:
      # Overseas providers through the local proxy.
      opencode.ai: http://127.0.0.1:7890
      kimi.com: http://127.0.0.1:7890
      # An internal gateway that must bypass a process-wide proxy.
      internal.example.com: direct
```

Keys are host patterns matched against each request's host with the documented `NO_PROXY`
vocabulary: an entry matches its host and every subdomain under it, a leading `.` or `*.` means the
same suffix rule, an optional `:port` narrows the entry, and `*` matches every host. First match
wins, so an explicit host entry must come before a `*` fallback. Values are `direct` (bypass any
process-wide proxy) or an `http://` / `https://` proxy URL.

To send everything else through a proxy while keeping named hosts direct, put the wildcard last:

```yaml
    routes:
      internal.example.com: direct
      '*': http://127.0.0.1:7890
```

Routes name hosts, not provider ids: the LLM registry exposes provider ids and display names but no
endpoint, so write the host of the provider's configured `baseURL`. For `https://api.example.com/v1`
that is `api.example.com` (or `example.com` to cover the whole domain).

A malformed pattern or proxy URL fails the plugin load instead of being skipped: a silently dropped
route proxies exactly the traffic the user tried to route elsewhere. A SOCKS proxy URL is refused;
point the entry at the proxy application's HTTP port instead.

## Build

Published artifacts are built; `src/` stays in the checkout for tsx-based source runs.

```bash
pnpm install
pnpm run build     # lib/index.js + lib/types/**/*.d.ts
pnpm run typecheck
pnpm run test
```

DSH installations that load built packages resolve `main`/`exports` from `lib/`. A source checkout
running `tsx` may also import `./src/*` through the `./src/*` export, which is why `src/` ships in the
tarball: `install_bundle` on a published version must still resolve that entry.

## Publish

The package is published to the public npm registry. `install_bundle` resolves it by name, so the
registry entry is what DSH profiles consume.

```bash
npm login                     # npmjs.com account with publish rights
npm publish                   # 1.0.1 is a release version: it tags `latest`
```

`prepack` runs the build, so the tarball always carries fresh `lib/` output; `prepublishOnly` runs
typecheck and tests. `publishConfig.registry` pins the publish target to `registry.npmjs.org` even
when the local npm config points at a mirror, and `access: public` is explicit because a scoped
name would otherwise default to restricted.

Check the tarball before publishing:

```bash
npm publish --dry-run
npx publint .
```

A prerelease version (for example `1.1.0-rc.1`) needs an explicit dist-tag — `npm publish --tag next` —
because npm refuses to guess `latest` for one. Move `latest` to a prerelease only deliberately:
`npm dist-tag add dsh-llm-http-proxy@1.1.0-rc.1 latest`.

## Limits

- The wrapper covers `globalThis.fetch`, which is what the shipped model adapters reach. A library
  that calls `undici.fetch` directly keeps the process-wide policy.
- A matched request is carried by this package's `fetch`, so its `Response`, headers, and body
  streams come from undici rather than Node's built-in implementations. They are spec-compliant and
  stream-compatible; only a strict `instanceof Response` against the global constructor would see the
  difference. A `FormData` body is likewise rebuilt on undici's class, which preserves multipart
  fields and file metadata.
- The route's `fetch` and dispatcher come from the same `undici` package, so routing does not depend
  on which undici copy a given Node release embeds. Unmatched requests keep using Node's built-in
  `fetch` and its process-wide policy.
- Proxy URLs may carry credentials. Nothing here prints a proxy URL; diagnostics name the route
  pattern and the target kind only.
- A TLS-intercepting proxy still needs `NODE_EXTRA_CA_CERTS`, which is read once at process start.
- `@deepseek-ai/cordis` is a `peerDependency`: the plugin must use the harness's Cordis instance,
  not a second copy bundled with it.
