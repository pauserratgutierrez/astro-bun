# Design

What the adapter must do for Astro 7 on Bun 1.4, and how. Checked against `astro` 7.4.5, `@astrojs/node` 11.1.9, `@types/bun` 1.4.4, and Bun's source at `bun-v1.4.4`. A line marked **unverified** comes from docs or source and still needs a test.

## Two pieces

| Piece                        | Runs                                                             | Does                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration (`src/index.ts`) | In the Astro CLI, on Node or Bun, during `astro dev` and `build` | Registers the adapter, sets the image endpoint, session default and `build.redirects`, passes its options to the runtime through a Vite virtual module, and writes the static manifest after the build. |
| Runtime (`src/server.ts`)    | On Bun, bundled into `dist/server/entry.mjs`                     | Creates Astro's `App`, starts `Bun.serve`, serves static files, prepares each request for Astro (host, client address, environment), renders, and runs the server's lifecycle.                          |

Everything else Astro does inside `app.render()`: routing, middleware, actions, server islands, cookies, i18n, redirects and rewrites, CSP, sessions, route caching, `src/fetch.ts`. The adapter neither knows nor touches them.

## Astro's contract

### Registration

```ts
setAdapter({
  name: "@pauserratgutierrez/astro-bun",
  entrypointResolution: "auto",
  serverEntrypoint: "@pauserratgutierrez/astro-bun/server.js",
  previewEntrypoint: "@pauserratgutierrez/astro-bun/preview.js",
  adapterFeatures: {
    buildOutput: "server",
    middlewareMode: "classic",
    staticHeaders,
  },
  supportedAstroFeatures: {
    serverOutput: "stable",
    hybridOutput: "stable",
    staticOutput: "stable",
    envGetSecret: "stable",
    sharpImageService: "stable",
    i18nDomains: "experimental",
  },
});
```

- `entrypointResolution: "auto"`: the server entrypoint's top-level code is the server. The `"explicit"` API (`createExports`, `start`, `args`, `exports`) is deprecated.
- Build-time options reach the runtime through `virtual:astro-bun:config`, a Vite plugin registered in `astro:config:setup`, with `resolve.noExternal` for the adapter in the `ssr`, `prerender`, and `astro` environments so its runtime is bundled into `dist/server`.
- Hooks: `astro:config:setup` (config and Vite plugin), `astro:config:done` (`setAdapter`), `astro:build:generated` (`routeToHeaders`, the CSP of prerendered pages), `astro:build:done` (static manifest and precompression).
- No `setPrerenderer`: Astro's default prerenderer suits pages that use no `Bun.*` API, and a custom one turns off `parallelPrerender`.

### Runtime API

| API                                                                                               | Use                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createApp({ streaming })` from `astro/app/entrypoint`                                            | The `App`, with the manifest and `src/fetch.ts` already wired.                                                                                                                                          |
| `setGetEnv((key) => process.env[key])` from `astro/env/setup`                                     | Secrets for `astro:env/server`, before the first render.                                                                                                                                                |
| `app.match(request, true)`                                                                        | The route, prerendered ones included. A prerendered page or endpoint is matched again with `app.match(request)`, so a lower-priority on-demand route can answer; a configured redirect keeps its match. |
| `app.render(request, { addCookieHeader: true, routeData, prerenderedErrorPageFetch, waitUntil })` | The `Response`, which Bun sends as it is.                                                                                                                                                               |
| `App.validateForwardedHost(host, allowedDomains, protocol)`                                       | Validates the `Host` header.                                                                                                                                                                            |
| `app.manifest` (`base`, `trailingSlash`, `buildFormat`, `assetsDir`, `allowedDomains`)            | Static file resolution.                                                                                                                                                                                 |
| `app.getLogger()`, `app.adapterLogger`                                                            | Logs through the destination the app configured.                                                                                                                                                        |

### What Astro leaves to the adapter

1. **The `Host` header.** Astro applies `X-Forwarded-Proto`, `-Host`, and `-Port` itself, and only with `security.allowedDomains`, but it never validates `Host`. Bun builds `request.url` from `Host`. A host outside `allowedDomains` makes the URL `http://localhost:<port>`, as `@astrojs/node` does since 11.1.7 (GHSA-m8p5-r7qv-cx4c).
2. **The client address.** The socket's, from `server.requestIP(request)`; the first `X-Forwarded-For` entry only when `Host` or `X-Forwarded-Host` validated. It is set on `request[Symbol.for("astro.clientAddress")]`, not passed as the `clientAddress` option, so Astro's own forwarded-header logic still applies.
3. **Prerendered 404 and 500 pages,** through `prerenderedErrorPageFetch`. Without it Astro fetches them over HTTP from `http://localhost` with no port.
4. **Static files and prerendered pages.**
5. **The lifecycle:** startup, graceful shutdown, timeouts, body limit, errors.

## Architecture

### Layout

```
src/
  index.ts          integration: setAdapter, config, Vite plugin, build hooks
  build/static.ts   astro:build:done: static manifest and precompression (node:zlib)
  server.ts         server entrypoint: createApp, Bun.serve, signals; exports handler and routes
  static.ts         runtime: the manifest into Bun.serve routes
  request.ts        host validation, client address
  preview.ts        astro preview: runs `bun entry.mjs` when the CLI runs on Node
  options.ts        public options and their defaults
test/
  unit/             bun test
  fixtures/         small Astro projects, built with the Astro CLI on Node
```

Build-time code uses `node:*` only, so `astro build` works on Node and on Bun. Runtime code runs only on Bun and uses `Bun.*` freely.

### Build: static manifest and precompression

After prerendering, `astro:build:done`:

1. Lists `dist/client`, leaving out dotfiles except `/.well-known/`.
2. Records each file's type, size, content hash (its strong ETag), cache policy (`public, max-age=31536000, immutable` under `/<assetsDir>/`, `no-cache` elsewhere), and its `routeToHeaders` headers when `staticHeaders` is on.
3. Compresses text files of 512 bytes or more once, at the highest levels (Brotli 11, zstd 19 when `node:zlib` has it, gzip 9), and keeps a variant only when it saves at least 10%. Variants are written beside the file (`.br`, `.zst`, `.gz`), where a CDN or reverse proxy can use them too.
4. Writes the manifest into `dist/server`, with public paths already resolved for `base`, `trailingSlash`, and `build.format`, so the runtime decides nothing.

### Runtime: static files

At startup the manifest becomes `Bun.serve`'s `routes`:

| File                           | Served as                                                                     | Why                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Small binary (png, woff2, ico) | A static `new Response(bytes, { headers })`                                   | Buffered once; Bun answers with no allocation per request, its own ETag, 304, and HEAD. |
| Text with compressed variants  | A handler that picks the smallest variant the client accepts                  | `Vary: Accept-Encoding`, one ETag per encoding, 304, HEAD; all in memory.               |
| Over the memory budget         | A handler returning `new Response(Bun.file(path), { headers })` with our ETag | Bun handles Range and uses `sendfile` on Linux plain TCP for files of 1 MiB or more.    |
| Prerendered page               | As text, plus the redirect `trailingSlash` asks for on the other form         | What Astro generated.                                                                   |
| Anything else                  | `fetch`, the fallback: Astro                                                  | On-demand rendering.                                                                    |

No static request makes a filesystem call or decodes a path: Bun matches the route natively, and only paths in the manifest exist. Bun 1.4's `{ dir }` routes are not used: they cannot set response headers (no `immutable`), and their index and trailing-slash rules do not follow Astro's `trailingSlash`.

**Unverified:** route keys for percent-encoded (non-ASCII) paths, which otherwise move to a `Map` looked up in `fetch`; what a method other than GET or HEAD gets on a static route.

### Runtime: a request Astro renders

```
fetch(request, server)
  host valid for allowedDomains (with the validated X-Forwarded-Proto)?
    yes: the request as it is, no new Request
    no:  new Request(`http://localhost:${port}${pathAndQuery}`, request)
  request[Symbol.for("astro.clientAddress")] = forwarded client when the host validated, else server.requestIP(request)
  route = app.match(request, true); a prerendered page or endpoint is matched again with app.match(request)
  response = await app.render(request, { addCookieHeader: true, routeData: route, prerenderedErrorPageFetch, waitUntil })
  a text/event-stream response: server.timeout(request, 0)
  return response
```

An error is a plain-text 500, logged through `adapterLogger`; a client that already left (`request.signal.aborted`) is not logged as one. The `error` handler of `Bun.serve` never returns a stack.

### Startup and shutdown

- Startup: `setGetEnv`, `createApp`, load the static routes, preload every page module (`app.manifest.pageMap`, when present), `await app.getLogger()`, `Bun.serve`, then the listening line. A port in use is a clear error and exit code 1.
- Shutdown on `SIGTERM` or `SIGINT`: `await server.stop()`, which since Bun 1.4 closes idle keep-alive connections and waits for responses in flight; `server.stop(true)` after the deadline (8 s by default, under Docker's 10 s); then the pending `waitUntil` promises, also bounded; then the logger closes and the process exits 0. A second signal exits at once.

### Composition

`dist/server/entry.mjs` exports `handler(request, server)`, `routes`, and `options`. With `ASTRO_BUN_AUTOSTART=disabled` it starts nothing, so an app can run its own `Bun.serve` (WebSockets through `server.upgrade`, its own routes) and hand the rest to Astro.

### Preview

The Astro CLI imports `previewEntrypoint` in its own process, usually Node. The preview module starts `bun dist/server/entry.mjs` as a child process with `HOST` and `PORT`, waits until it listens, and returns `{ host, port, closed(), stop() }`.

### Development

`astro dev` is Vite and does not involve the adapter. It runs on Node by default; code that calls `Bun.*` needs `bun --bun astro dev`, which Astro does not officially support. Running dev-time server code inside Bun while the CLI stays on Node would need a custom Vite environment built on Astro internals and a Vite API still in its release-candidate phase: not planned.

## Decisions and edge cases

| Topic                | Decision                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server               | `Bun.serve`, never `node:http`.                                                                                                                                                                                                     |
| `development`        | Always set to `false`; otherwise Bun's error page shows source code to visitors.                                                                                                                                                    |
| `reusePort`          | Always set, `false` by default, so a second instance on the port fails. Bun's source suggests `development: false` turns it on implicitly (**unverified**).                                                                         |
| `idleTimeout`        | Bun resets a connection after 10 s without bytes, before the first byte and mid-stream. Default 60 s; event streams get `server.timeout(request, 0)`. Keep it above a reverse proxy's keep-alive: Bun sends no `Keep-Alive` header. |
| Body size            | `maxRequestBodySize`: Bun answers 413 before JavaScript runs. Default 128 MiB, Bun's. Actions and server islands have their own limits in Astro.                                                                                    |
| Host                 | As `@astrojs/node` 11.1.7+, without a new `Request` when the host is valid. A malformed host or port never crashes the process (GHSA-qh8j-hqjv-7m4x).                                                                               |
| Client address       | The socket's; `X-Forwarded-For` only when the host validated, as in the Node adapter.                                                                                                                                               |
| Cache headers        | `immutable` only on 2xx answers under `/_astro/`; never cache headers on a 412 (GHSA-c57f-mm3j-27q9).                                                                                                                               |
| Trailing slash       | Redirects computed at build time; backslashes and `//` never become an open redirect (GHSA-r557-wffq-wvrc); the query string is kept.                                                                                               |
| Error pages          | `prerenderedErrorPageFetch` from the in-memory routes: no I/O, no SSRF.                                                                                                                                                             |
| Client disconnects   | `request.signal` reaches Astro (the same `Request`, or a copy with its signal); not logged as errors; no leaked listeners or file descriptors.                                                                                      |
| Unhandled rejections | Logged through `adapterLogger`. No `AsyncLocalStorage` per request: on Bun its store does not reach that listener (oven-sh/bun#44650), and it costs every request.                                                                  |
| Page preload         | Removes each page's cold start, and avoids Bun losing an `AsyncLocalStorage` store while a dynamic `import()` evaluates (oven-sh/bun#32693).                                                                                        |
| `waitUntil`          | Implemented, so Astro's route cache providers can write off the response path; drained on shutdown.                                                                                                                                 |
| Sessions             | With `session` enabled and no driver: `fsLite` in a relative directory resolved at runtime, not the build machine's absolute path. `session: false` changes nothing.                                                                |
| Images               | `image.endpoint` is `astro/assets/endpoint/node` in production (reads files; works on Bun) and `astro/assets/endpoint/dev` in development; `build.redirects: false`, as the Node adapter sets.                                      |
| Environment          | `setGetEnv((key) => process.env[key])`. Bun loads `.env*` from the working directory on its own: production runs `bun --no-env-file`.                                                                                               |
| Paths                | The client directory is resolved from the entry file; no absolute path from the build machine in the bundle; tested on Windows too.                                                                                                 |
| HTTP/2 and HTTP/3    | Experimental in Bun 1.4: left to the reverse proxy.                                                                                                                                                                                 |
| Dynamic compression  | Off by default. With `compress: true`, `CompressionStream` (zstd or Brotli at a low level) on HTML and JSON answers without `Content-Encoding`. **Unverified:** that it does not hold back streamed chunks.                         |

## Astro features

| Feature                                                                                                                                                                                                                                               | Adapter code | How                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| On-demand pages and endpoints, middleware, actions, server islands, redirects and rewrites, cookies, i18n by prefix, view transitions, content collections, `src/fetch.ts`, the in-memory route cache, CSP headers on rendered pages, fonts, prefetch | None         | `app.render`                                       |
| Static and hybrid output (`prerender`)                                                                                                                                                                                                                | Yes          | Static routes; the two-step match                  |
| `astro:env` secrets                                                                                                                                                                                                                                   | One line     | `setGetEnv`                                        |
| `Astro.clientAddress`                                                                                                                                                                                                                                 | Yes          | `requestIP`, or `X-Forwarded-For` after validation |
| `security.allowedDomains`, `X-Forwarded-*`, `security.checkOrigin`                                                                                                                                                                                    | Yes          | `Host` validation; Astro does the rest             |
| Prerendered 404 and 500                                                                                                                                                                                                                               | Yes          | `prerenderedErrorPageFetch`                        |
| Sessions                                                                                                                                                                                                                                              | Config       | Default driver                                     |
| `/_image` and Sharp                                                                                                                                                                                                                                   | Config       | The Node image endpoint                            |
| CSP of static pages (`staticHeaders`)                                                                                                                                                                                                                 | Yes          | `routeToHeaders` into the manifest                 |
| i18n domains                                                                                                                                                                                                                                          | Yes          | The validated host; experimental, as in Node       |
| `waitUntil` (cache providers)                                                                                                                                                                                                                         | Yes          | Tracked promises, drained on shutdown              |
| `base`, `trailingSlash`, `build.format`                                                                                                                                                                                                               | Yes          | Resolved at build time                             |
| `astro preview`                                                                                                                                                                                                                                       | Yes          | A Bun child process                                |

## Options

```ts
bun({
  // network: option, then environment (PORT, HOST), then astro.config (server.port, server.host)
  port?: number;
  host?: string | boolean;
  unix?: string;
  reusePort?: boolean; // false
  idleTimeout?: number; // 60 (seconds)
  maxRequestBodySize?: number; // 128 MiB
  // static files
  precompress?: boolean | { brotli?: boolean; zstd?: boolean; gzip?: boolean }; // true
  staticMemoryBudget?: number; // bytes kept in memory; larger files are read with Bun.file
  staticHeaders?: boolean; // CSP of prerendered pages
  // runtime
  streaming?: boolean; // true
  compress?: boolean; // false: dynamic compression of HTML and JSON
  preload?: boolean; // true: load every page module at startup
  shutdownTimeout?: number; // 8000 (ms)
});
```

TLS through `SERVER_CERT_PATH` and `SERVER_KEY_PATH`, as in the Node adapter. `ASTRO_BUN_AUTOSTART=disabled` for composition. An option is added only when a real case needs it.

## Astro internals used

| Internal               | Use          | Without it                                    |
| ---------------------- | ------------ | --------------------------------------------- |
| `app.manifest.pageMap` | Page preload | No preload: pages load on their first request |

## Tests

- Unit (`bun test`): encoding negotiation (q-values, smallest variant), ETag, 304 and HEAD, `trailingSlash` × `build.format` × `base`, the `Host` validation and client address matrix.
- Fixtures: each built with the Astro CLI on Node, started on Bun, exercised with `fetch`. Server and hybrid output; `trailingSlash` `never`, `always`, `ignore`; `build.format` `directory`, `file`, `preserve`; `base` `/` and `/docs`; i18n; actions (form and RPC); middleware; several `Set-Cookie`; configured redirects; rewrites; server islands; streaming with a slow component; an event stream silent for over 10 s; 413; a client leaving mid-stream (no crash, no leak, `server.pendingRequests` back to 0); prerendered and rendered 404 and 500; CSP with `staticHeaders`; `fsLite` sessions; `/_image` with Sharp; `astro:env` secrets; non-ASCII file names and `logo@2x.png`; traversal attempts (`/..%2F..`, `\`, `//`); a spoofed `Host` and a malformed port; Range; `SIGTERM` during a slow request (it completes); a port in use.
- Conformance: the relevant cases of `withastro/astro`'s `packages/integrations/node/test` (MIT), ported.
- CI: the pinned `astro` and `astro@latest`, Bun 1.4.4 and the latest Bun; a weekly run against the latest releases so a breaking upstream release shows here first.

## Roadmap

| Phase           | Scope                                                                                                                                                 | Done when                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Rendering    | `setAdapter`, the virtual config module, `createApp`, `Bun.serve` with `fetch` to `app.render`, `setGetEnv`, `development: false`                     | A real app's pages, actions, and middleware run |
| 2. Static files | Manifest and precompression, in-memory routes, negotiation, 304 and HEAD, prerendered pages, `trailingSlash`, `base`, `build.format`, error pages     | The fixture matrix passes                       |
| 3. Hardening    | Host and client address, timeouts and event streams, 413, disconnects, graceful shutdown, port in use, logger, preload, `waitUntil`, sessions, images | The ported Node adapter cases pass              |
| 4. Release      | `preview.ts`, composition exports, docs, publishing from CI with provenance                                                                           | `astro preview` works with the CLI on Node      |
| 5. Measure      | A real app on Bun against the same app on Node, at the same CPU and memory limits                                                                     | Throughput, p95 latency, and memory compared    |

Later, on demand: Bun-native session drivers (`bun:sqlite`, `Bun.redis`) with no dependency, trusted proxies by CIDR, an image service on `Bun.Image`, several processes with `reusePort`.

## References

- Adapter API: https://docs.astro.build/en/reference/adapter-reference/
- Upgrading: https://docs.astro.build/en/guides/upgrade-to/v6/, https://docs.astro.build/en/guides/upgrade-to/v7/
- `@astrojs/node` changelog: https://github.com/withastro/astro/blob/main/packages/integrations/node/CHANGELOG.md
- `Bun.serve`: https://bun.com/docs/runtime/http/server, https://bun.com/docs/runtime/http/routing, https://bun.com/docs/runtime/streams
- Bun 1.4: https://bun.com/blog/bun-v1.4
- Bun's types: https://github.com/oven-sh/bun/blob/bun-v1.4.4/packages/bun-types/serve.d.ts
