# dsh-llm-proxy

Provider-scoped outbound proxy for model requests.

DSH resolves **one** outbound proxy policy per process from `HTTP_PROXY` / `HTTPS_PROXY` /
`ALL_PROXY` and installs it as undici's global dispatcher. That cannot express a deployment with
several model endpoints that need different egress — an overseas provider behind a local proxy, an
internal gateway that must stay direct. This plugin adds the missing per-provider choice without
touching the process policy: the plugin page configures a proxy per LLM provider, and a model call
whose provider has an entry is sent with that provider's dispatcher. Every other request reaches the
original `fetch` unchanged and keeps the process-wide policy. A host-pattern table remains available
as a fallback for requests made outside a model call.

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
plugin_manager(action="install_bundle", target="dsh-llm-proxy")
```

`install_bundle` adds the dependency, selects the bundle, and applies its patch layer. To develop
against a local checkout, pass the checkout's absolute path instead; DSH records it as a `link:`
dependency:

```
plugin_manager(action="install_bundle", target="/absolute/path/to/dsh-llm-proxy")
```

A linked checkout supplies its own `dependencies` and `peerDependencies`. Rebuilding and restarting
DSH are required after changing its code; configuration changes apply through HMR.

Enable or disable the installed bundle and its row from the plugin page, or with
`plugin_manager(action="set_bundle", target="dsh-llm-proxy", enabled=false)` and
`plugin_manager(action="set_plugin", target="llm-proxy", enabled=false)`.

## Configuration

### From the plugin page

Open **Plugins → dsh-llm-proxy**. The detail page carries the configuration card:

1. Pick a provider from the dropdown of providers composed in this deployment.
2. Pick **HTTP** or **SOCKS5** as the proxy transport.
3. Enter the proxy address as `host:port` (credentials are allowed:
   `user:pass@host:port`), without an `http://` or `socks5://` prefix.
4. **Add**. To change an entry, **Remove** it and add it again with the new transport or address.

Configured providers are listed with an **on/off switch**, an **Edit** action, and a **Remove**
action. **Edit** turns the row into inline transport and address controls with **Save** / **Cancel**
(`Enter` saves, `Escape` cancels); the provider id and the switch state are kept. Switching an entry
off keeps its transport and address in configuration but stops proxying that provider, so it falls
back to the process-wide policy; switch it back on to resume without retyping the address. A provider
without an entry (or with its switch off) is not proxied by this plugin: its request keeps DSH's
process-wide policy, which is a direct connection unless `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`
is set. That default is what "no proxy" means here; the plugin never forces a direct connection over
the process policy.

The page writes the row's `providers` mapping through DSH's settings service into the active
profile's `cordis.patch.yml`. `providers` is a volatile field, so a saved change reaches the running
plugin without a reload. The same mapping can be written by hand:

```yaml
- id: llm-proxy
  name: 'dsh-llm-proxy'
  config:
    providers:
      # A provider reached through the local SOCKS5 proxy.
      opendesign:
        type: socks5
        address: 127.0.0.1:1081
      # Another provider through an HTTP proxy, currently paused by its switch.
      opencode:
        type: http
        address: 127.0.0.1:8080
        enabled: false
```

At request time the plugin learns the provider from DSH's `llm/stream` waterfall and sends that
model call through the provider's proxy. Requests made outside a model call — model discovery, for
example — have no provider in scope and keep the process-wide policy.

A malformed provider entry fails the plugin load instead of being skipped: a silently dropped entry
sends exactly the traffic the user tried to route elsewhere. An invalid value written later (for
example by editing the patch by hand) is logged and ignored per request rather than failing every
call.

### Host patterns (legacy)

The `routes` table still works as a fallback for requests outside a model call. It is consulted
after `providers`; the bundle ships it empty. Override the row in the profile's
`cordis.patch.yml` — the profile layer wins over the bundle's default:

```yaml
- id: llm-proxy
  name: 'dsh-llm-proxy'
  config:
    routes:
      # Overseas providers through the local proxy.
      opencode.ai: http://127.0.0.1:8080
      kimi.com: http://127.0.0.1:8080
      # An internal gateway that must bypass a process-wide proxy.
      internal.example.com: direct
```

Keys are host patterns matched against each request's host with the documented `NO_PROXY`
vocabulary: an entry matches its host and every subdomain under it, a leading `.` or `*.` means the
same suffix rule, an optional `:port` narrows the entry, and `*` matches every host. First match
wins, so an explicit host entry must come before a `*` fallback. Values are `direct` (bypass any
process-wide proxy) or an `http://`, `https://`, or `socks5://` proxy URL.

To send everything else through a proxy while keeping named hosts direct, put the wildcard last:

```yaml
    routes:
      internal.example.com: direct
      '*': http://127.0.0.1:8080
```

Routes name hosts, not provider ids: the LLM registry exposes provider ids and display names but no
endpoint, so write the host of the provider's configured `baseURL`. For `https://api.example.com/v1`
that is `api.example.com` (or `example.com` to cover the whole domain).

A malformed pattern or proxy URL fails the plugin load instead of being skipped: a silently dropped
route proxies exactly the traffic the user tried to route elsewhere.

A `socks5://` entry tunnels through a SOCKS5 proxy using undici's `Socks5ProxyAgent`, which is
marked experimental and emits one `ExperimentalWarning` per process when first built. The host name
is sent to the proxy rather than resolved locally, so `socks5h://` and `socks://` are accepted as
aliases and resolve to the same transport. SOCKS4 has no equivalent and is refused.

```yaml
    routes:
      amr-link.example.com: socks5://127.0.0.1:1081
```

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

The browser half is `src/client.js`, hand-written in the `window.__ModuleLoader__.load` form and
exported as `./client`; it is shipped as source and needs no build step. The Host bundle is the
built `lib/`, so rebuild and restart DSH after changing the Host half. A linked checkout serves the
changed files directly, but DSH must still be restarted to load a fresh Host module generation.

## Publish

The package is published to the public npm registry. `install_bundle` resolves it by name, so the
registry entry is what DSH profiles consume.

```bash
npm login                     # npmjs.com account with publish rights
npm publish                   # a release version: it tags `latest`
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
`npm dist-tag add dsh-llm-proxy@1.1.0-rc.1 latest`.

## Limits

- The wrapper covers `globalThis.fetch`, which is what the shipped model adapters reach. A library
  that calls `undici.fetch` directly keeps the process-wide policy.
- Provider routing rides DSH's `llm/stream` waterfall. A request the harness makes outside that
  waterfall — model discovery, for example — has no provider in scope and keeps its host route or
  the process-wide policy.
- A routed request is carried by this package's `fetch`, so its `Response`, headers, and body
  streams come from undici rather than Node's built-in implementations. They are spec-compliant and
  stream-compatible; only a strict `instanceof Response` against the global constructor would see the
  difference. A `FormData` body is likewise rebuilt on undici's class, which preserves multipart
  fields and file metadata.
- The route's `fetch` and dispatcher come from the same `undici` package, so routing does not depend
  on which undici copy a given Node release embeds. Unmatched requests keep using Node's built-in
  `fetch` and its process-wide policy.
- Proxy URLs may carry credentials. Nothing here prints a provider's proxy URL; diagnostics name the
  provider or route pattern only.
- The plugin page writes through DSH's settings service, so it needs a profile that composes
  `settings` and `config-editor` (the standard Web composition does). Without them the page reports
  that configuration is unavailable; `cordis.patch.yml` still configures the plugin.
- A TLS-intercepting proxy still needs `NODE_EXTRA_CA_CERTS`, which is read once at process start.
- `@deepseek-ai/cordis` is a `peerDependency`: the plugin must use the harness's Cordis instance,
  not a second copy bundled with it.
