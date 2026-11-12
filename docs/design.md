# Design

What the adapter must do for Astro 7 on Bun 1.4, and how. Checked against `astro` 7.4.11, `@astrojs/node` 11.1.12, `@types/bun` 1.4.4, and Bun's source at `bun-v1.4.4`. A line marked **unverified** comes from docs or source and still needs a test.

## Two pieces

| Piece                        | Runs                                                             | Does                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration (`src/index.ts`) | In the Astro CLI, on Node or Bun, during `astro dev` and `build` | Registers the adapter, sets the image endpoint, session default and `build.redirects`, passes its options to the runtime through a Vite virtual module, and appends the integration that hashes and compresses the client files after the build. |
| Runtime (`src/server.ts`)    | On Bun, bundled into `dist/server/entry.mjs`                     | Creates Astro's `App`, starts `Bun.serve`, serves static files, prepares each request for Astro (host, client address, environment), renders, and runs the server's lifecycle.                                                                   |

Everything else Astro does inside `app.render()`: routing, middleware, actions, server islands, cookies, i18n, redirects and rewrites, CSP, sessions, route caching, `src/fetch.ts`. The adapter neither knows nor touches them.

## Astro's contract

### Registration

```ts
setAdapter({
  name: "@pauserratgutierrez/astro-bun",
  entrypointResolution: "auto",
  serverEntrypoint: new URL("./server.js", import.meta.url),
  previewEntrypoint: fileURLToPath(new URL("./preview.js", import.meta.url)),
  adapterFeatures: { buildOutput: "server", middlewareMode: "classic" },
  supportedAstroFeatures: {
    serverOutput: "stable",
    hybridOutput: "stable",
    staticOutput: "stable",
    envGetSecret: "stable",
    sharpImageService: "stable",
  },
});
```

- `entrypointResolution: "auto"`: the server entrypoint's top-level code is the server. The `"explicit"` API (`createExports`, `start`, `args`, `exports`) is deprecated.
- Both entrypoints are given by location next to the integration's own file, so they resolve the same from `node_modules` and from a checkout. `previewEntrypoint` is a path: Astro resolves it with `require.resolve`, which takes no file URL.
- Build-time options reach the runtime through `virtual:astro-bun:config`, a Vite plugin registered in `astro:config:setup`, with `resolve.noExternal` for the adapter in the `ssr`, `prerender`, and `astro` environments so its runtime is bundled into `dist/server`.
- Hooks: `astro:config:setup` (config, Vite plugin, and the static-files integration appended), `astro:config:done` (`setAdapter`); the appended integration's `astro:build:done` (manifest and compressed copies, once every other integration wrote its files).
- No `setPrerenderer`: Astro's default prerenderer suits pages that use no `Bun.*` API, and a custom one turns off `parallelPrerender`.

### Runtime API

| API                                                                                                              | Use                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createApp({ streaming })` from `astro/app/entrypoint`                                                           | The `App`, with the manifest and `src/fetch.ts` already wired.                                                                                                                                          |
| `setGetEnv((key) => process.env[key])` from `astro/env/setup`                                                    | Secrets for `astro:env/server`, before the first render.                                                                                                                                                |
| `app.match(request, true)`                                                                                       | The route, prerendered ones included. A prerendered page or endpoint is matched again with `app.match(request)`, so a lower-priority on-demand route can answer; a configured redirect keeps its match. |
| `app.render(request, { addCookieHeader: true, clientAddress, routeData, prerenderedErrorPageFetch, waitUntil })` | The `Response`, which Bun sends as it is.                                                                                                                                                               |
| `app.manifest` (`base`, `trailingSlash`, `buildFormat`, `assetsDir`, `allowedDomains`)                           | Static file resolution.                                                                                                                                                                                 |
| `app.getLogger()`, `app.adapterLogger`                                                                           | Logs through the destination the app configured.                                                                                                                                                        |

### What Astro leaves to the adapter

1. **The `Host` header.** Astro applies `X-Forwarded-Proto`, `-Host`, and `-Port` itself, and only with `security.allowedDomains`, but it never validates `Host`. Bun builds `request.url` from `Host`. A host outside `allowedDomains` makes the URL `http://localhost:<port>`, as `@astrojs/node` does since 11.1.7 (GHSA-m8p5-r7qv-cx4c). The match follows Astro's rules since 7.4.11 (withastro/astro#18641), the ones `createRequestFromNodeRequest` applies: `validateHost` and `validateForwardedHeaders`, which Astro does not export, are ported in `src/request.ts`. `BaseApp.validateForwardedHost`, the public one, keeps the older rules.
2. **The client address.** The socket's, from `server.requestIP(request)`; the first `X-Forwarded-For` entry only when `Host` or `X-Forwarded-Host` validated. It is passed as `app.render()`'s `clientAddress` option, whose default reads the same value from a symbol on the request.
3. **Prerendered 404 and 500 pages,** through `prerenderedErrorPageFetch`. Without it Astro fetches them over HTTP from `http://localhost` with no port.
4. **Static files and prerendered pages.**
5. **The lifecycle:** startup, graceful shutdown, timeouts, body limit, errors.

## Architecture

### Layout

```
src/
  index.ts          integration: setAdapter, config, Vite plugin; appends the static-files integration
  static-files.ts   shared by build and server: manifest shape, file listing, hash, routes from base/trailingSlash/format
  build/static.ts   build: hashes and compresses the client files, writes the manifest (node:zlib)
  server.ts         server entrypoint: createApp, Bun.serve, signals; exports handler and routes
  static.ts         server: the client files into Bun.serve routes
  request.ts        host validation, client address
  preview.ts        astro preview, in the CLI's process: runs the server on Bun beside it
  preview-child.ts  the server as preview runs it, ending when the CLI does
test/
  *.test.ts         bun test, unit and fixture suites
  fixtures/         small Astro projects, built with the Astro CLI on Node
```

Build-time code uses `node:*` only, so `astro build` works on Node and on Bun. Runtime code runs only on Bun and uses `Bun.*` freely.

### Build: hashes and compressed copies

Astro puts the adapter first among the integrations, so its own `astro:build:done` runs before the others write their files (a sitemap, a search index, icons). The adapter therefore appends a second integration, `@pauserratgutierrez/astro-bun/static-files`, during `astro:config:setup`; Astro runs integrations added there last. Its `astro:build:done`:

1. Lists `dist/client`, leaving out dotfiles except `/.well-known/`.
2. Records each file's size, content hash (the base of its ETags), and whether it is under `build.assets` (cached for a year).
3. Compresses text files of 512 bytes or more once, at the highest levels (Brotli 11, zstd 19, gzip 9: Node has zstd since 22.15, below Astro's minimum), and keeps a copy only when it saves at least 10%. Copies go to `dist/server/compressed/`, so the client directory keeps only what the build put there.
4. Writes `dist/server/static-manifest.json`.

### Runtime: static files

At startup the server lists `dist/client` again: the files on disk are the ones served. The manifest gives their hashes and compressed copies; a file it does not list (copied in after the build) is hashed then and sent uncompressed, and the startup logs how many. Each file's URLs come from `base`, `trailingSlash`, and `build.format` in the app's manifest: its own path, a page's clean URL, and a redirect (301, query kept) from the other form of the trailing slash. Then:

| File                                       | Served as                                                                  | Why                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| In memory, no compressed copy (png, woff2) | A static `{ GET: new Response(blob, { headers }) }` route                  | Buffered once; Bun answers it, its 304 (our ETag), and HEAD with no JavaScript. Other methods go on to Astro. |
| In memory, with compressed copies          | A `{ GET: handler }` route that picks the smallest copy the client accepts | `Vary: Accept-Encoding`, one ETag per encoding, 304; HEAD from GET.                                           |
| Over the memory budget                     | The same handler with `Bun.file(path)` bodies, each made once at startup   | Bun handles Range on the file itself and uses `sendfile` on Linux plain TCP for files of 1 MiB or more.       |
| A redirect from `trailingSlash`            | A `{ GET: handler }` route                                                 |                                                                                                               |
| Anything else                              | `fetch`, the fallback                                                      | First a lookup of the decoded path among the files, then Astro.                                               |

Measured on Bun 1.4.4: a route key matches the request's raw path, so `/caf%C3%A9.txt` misses `/caf%c3%a9.txt` and `/logo@2x.png` misses `/logo%402x.png`. Keys are encoded as browsers send paths, and `fetch` looks up any other spelling, decoded, in a map of the files. A key with a segment that starts with `:` is a parameter that answers every path of its length, and `*` is a wildcard, so a file with such a name is answered from the map only. A static route answers every method, so a file is always a `{ GET }` route. No static request makes a filesystem call except for files over the budget, and only listed paths exist. Bun 1.4's `{ dir }` routes are not used: they cannot set response headers (no `immutable`), and their index and trailing-slash rules do not follow Astro's `trailingSlash`.

A file in memory is a `Blob`: `new Response()` shares a Blob, but copies a `Uint8Array` on each call. Each `Accept-Encoding` value is parsed once, and up to 64 are kept. Measured in one process on Bun 1.4.4, against 0.2.0: a 100 KB file sent uncompressed went from 21 µs to 2 µs per request, its smallest compressed copy from 4.0 to 2.3 µs, and a 304 from 3.8 to 3.0 µs.

### Runtime: a request Astro renders

```
fetch(request, server)
  host valid for allowedDomains (with the validated X-Forwarded-Proto)?
    yes: the request as it is, no new Request
    no:  new Request(`http://localhost:${port}${pathAndQuery}`, request)
  clientAddress = forwarded client when the host validated, else server.requestIP(request)
  route = app.match(request, true); a prerendered page or endpoint is matched again with app.match(request)
  response = await app.render(request, { addCookieHeader: true, clientAddress, routeData: route, prerenderedErrorPageFetch, waitUntil })
  a text/event-stream response: server.timeout(request, 0)
  return response
```

An error is a plain-text 500, logged through `adapterLogger`; a client that already left (`request.signal.aborted`) is not logged as one. The `error` handler of `Bun.serve` never returns a stack.

### Startup and shutdown

- Startup: `setGetEnv`, `createApp`, load the static routes, preload every page module (`app.manifest.pageMap`, when present), `await app.getLogger()`, `Bun.serve`, then the listening line. A port in use is a clear error and exit code 1.
- Shutdown on `SIGTERM` or `SIGINT`: `await server.stop()`, which since Bun 1.4 closes idle keep-alive connections and waits for responses in flight; `server.stop(true)` after the deadline (8 s by default, under Docker's 10 s); then the pending `waitUntil` promises, also bounded; then the logger closes and the process exits 0. A second signal exits at once.

### Composition

`dist/server/entry.mjs` exports `handler(request, server)` and `routes`. With `ASTRO_BUN_AUTOSTART=disabled` it starts nothing, so an app can run its own `Bun.serve` (WebSockets through `server.upgrade`, its own routes) and hand the rest to Astro.

### Preview

The Astro CLI imports `previewEntrypoint` in its own process, usually Node. The preview module runs `bun preview-child.js dist/server/entry.mjs` in the project's directory with `HOST` and `PORT` (Bun loads its `.env` files, as for local work), and returns `{ host, port, closed(), stop() }` once the child writes a line on fd 3, a pipe the preview opens for it. The child writes it when the entry module has run, which is when `Bun.serve` listens; a server that cannot listen exits first, so `astro preview` fails with exit code 1 instead of reporting whatever else holds the port (tested). The CLI holds the child's stdin: when the CLI ends, however it ends (on Windows a kill runs no handler), the pipe closes and `preview-child.js` exits, so no server outlives it. A missing Bun is a clear error.

### Development

`astro dev` is Vite and does not involve the adapter. It runs on Node by default; code that calls `Bun.*` needs `bun --bun astro dev`, which Astro does not officially support. Running dev-time server code inside Bun while the CLI stays on Node would need a custom Vite environment built on Astro internals and a Vite API still in its release-candidate phase: not planned.

## Decisions and edge cases

| Topic                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server               | `Bun.serve`, never `node:http`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `development`        | Always `false`; otherwise Bun's error page shows source code to visitors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `reusePort`          | Always `false`, set explicitly: a second server on a port in use exits 1 and says why (tested).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `idleTimeout`        | Bun resets a connection after 10 s without bytes, before the first byte and mid-stream, counting in 4-second steps (measured on Bun 1.4.4: `idleTimeout: 2` cut at 4.0 s). Default 60 s; event streams get `server.timeout(request, 0)`. Keep it above a reverse proxy's keep-alive: Bun sends no `Keep-Alive` header.                                                                                                                                                                                                                                                                                                                                                                                        |
| Body size            | `maxRequestBodySize`: Bun answers 413 before JavaScript runs, whether the body has a `Content-Length` or comes chunked. Default 128 MiB, Bun's. Actions and server islands have their own limits in Astro.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Host                 | As `@astrojs/node` 11.1.7+, without a new `Request` when the host is valid. Only a plain `hostname[:port]` matches; anything else (with `/`, `\`, `@`, `%`, or none) or a malformed port moves the request to localhost instead of failing it (GHSA-qh8j-hqjv-7m4x). Since Astro 7.4.11 an entry matches protocol, host, and port together: `X-Forwarded-Proto` counts only when an entry allows it for the host in use, `X-Forwarded-Host` without it is matched with the server's protocol, and `port: "443"` matches an https host without a port. Compared with `@astrojs/node` 11.1.12 over 31 header combinations (wildcards, ports, mixed protocols): the same `Astro.url` and client address in each. |
| Client address       | The socket's; `X-Forwarded-For` only when `Host` or `X-Forwarded-Host` validated, as in the Node adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cache headers        | `public, max-age=31536000, immutable` on files under `build.assets`, `no-cache` on the rest, revalidated by ETag. Static files do not handle `If-Match`, so none answers 412.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Trailing slash       | Each page's URLs are computed at startup from `base`, `trailingSlash`, and `build.format`; a redirect goes to a path from the file listing, so it never leaves the site (GHSA-r557-wffq-wvrc), and keeps the query string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Error pages          | `prerenderedErrorPageFetch` from the static files: no I/O for files in memory, no SSRF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Client disconnects   | `request.signal` aborts when the client leaves (the same `Request`, or a copy with its signal), and it is not logged as an error (tested).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Mid-stream failures  | A page that fails after its first bytes ends the connection unfinished, so no client or cache keeps it as whole. Since Astro 7.4.9 the renderer logs the error once, through the configured logger, for every adapter (withastro/astro#18625, fixed by #18688); a client that already left is not logged. The adapter adds nothing: the body goes to Bun untouched, since reading `response.body` cost a streamed page 16% of its throughput, and a wrapper that logs the failure 45–53%, measured on Bun 1.4.4. Tested with the JSON logger: one `error` record per failure.                                                                                                                                 |
| Unhandled rejections | Logged through `adapterLogger`. No `AsyncLocalStorage` per request: on Bun its store does not reach that listener (oven-sh/bun#44650), and it costs every request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Page preload         | `preload` (on by default) loads every module of `app.manifest.pageMap` before the server listens; one that fails is logged and its page fails on request, as it would have. Removes each page's cold start, and avoids Bun losing an `AsyncLocalStorage` store while a dynamic `import()` evaluates (oven-sh/bun#32693).                                                                                                                                                                                                                                                                                                                                                                                      |
| `waitUntil`          | Passed to `app.render`, so a route cache provider can write off the response path; the pending work is awaited on shutdown, within `shutdownTimeout`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sessions             | With `session` enabled and no driver: `fsLite` at `node_modules/.astro/sessions`, a relative path the driver resolves in the server's working directory (Astro's Node adapter writes the build machine's absolute path into the bundle). A read-only container needs a driver of its own. `session: false` changes nothing.                                                                                                                                                                                                                                                                                                                                                                                   |
| Images               | `image.endpoint` is `astro/assets/endpoint/node` in production (reads files; works on Bun) and `astro/assets/endpoint/dev` in development; `build.redirects: false`, as the Node adapter sets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Environment          | `setGetEnv((key) => process.env[key])`. Bun loads `.env*` from the working directory on its own: production runs `bun --no-env-file`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Paths                | The client directory is resolved from the entry file; no absolute path from the build machine in the bundle; tested on Windows and Linux.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PID 1                | The server handles `SIGTERM` itself, so it drains as a container's first process with no init: `docker stop` took 587 ms and exited 0 (measured).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| HTTP/2 and HTTP/3    | Experimental in Bun 1.4: left to the reverse proxy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
| `waitUntil` (cache providers)                                                                                                                                                                                                                         | Yes          | Tracked promises, awaited on shutdown              |
| `base`, `trailingSlash`, `build.format`                                                                                                                                                                                                               | Yes          | Routes computed at startup                         |
| `astro preview`                                                                                                                                                                                                                                       | Yes          | A Bun child process                                |

## Options

```ts
bun({
  idleTimeout?: number; // 60 (seconds)
  maxRequestBodySize?: number; // Bun's, 128 MiB
  shutdownTimeout?: number; // 8000 (ms)
  streaming?: boolean; // true
  preload?: boolean; // true: load every page module at startup
  precompress?: boolean; // true: Brotli, zstd, and gzip copies of text files at build time
  staticMemoryBudget?: number; // 64 MiB: bytes of static files kept in memory, smallest first
});
```

The address comes from `HOST` and `PORT`, else Astro's `server.host` and `server.port`. `ASTRO_BUN_AUTOSTART=disabled` for composition. An option is added only when a real case needs it.

## Astro internals used

| Internal               | Use          | Without it                                    |
| ---------------------- | ------------ | --------------------------------------------- |
| `app.manifest.pageMap` | Page preload | No preload: pages load on their first request |

## Tests

- Unit: the route matrix (`trailingSlash` × `build.format` × `base`), route keys, encoding negotiation (q-values, smallest copy), ETag matching.
- Fixtures, each built with the Astro CLI on Node and served on Bun:
  - `ssr`: rendering through middleware, secrets, request bodies (also once moved to localhost), several `Set-Cookie`, a 500 that shows nothing internal, the prerendered 404, the `Host` and client-address matrix over raw requests (protocol, host, and port matched together), an image through Sharp.
  - `midstream`: a page failing after it started streaming ends unfinished and is logged once as a JSON `error` record; the server keeps answering.
  - `static`, `static-base`, `static-file`: encodings, 304 and HEAD on hashed files; names with `@`, accents, spaces, and `%`; `.well-known` and dotfiles; traversal attempts over raw TCP; POST to a static path; config redirects; `base` with `trailingSlash: "always"` from disk with Range; `build.format: "file"` with `trailingSlash: "never"`; a file another integration writes at build:done; a file copied in after the build.
  - `lifecycle`: event streams past the idle timeout, 413, client aborts, unhandled rejections, default sessions, preload, a port in use; on Linux and macOS, `SIGTERM` draining, `shutdownTimeout`, and a second signal.
  - `compose`: an app's own `Bun.serve` with the static routes, Astro's handler, its own route, and a WebSocket; `astro preview` with the CLI on Node, its server ending with the CLI, and a preview whose port another server holds exiting 1.
- `bun run test:linux` runs the suite on Linux from any OS; CI runs it on Ubuntu.

## Not yet

- Publishing: the first release, from CI with provenance.
- Measuring a real app on Bun against Node at the same CPU and memory limits: throughput, p95 latency, memory.
- `staticHeaders`: the CSP header of prerendered pages (`astro:build:generated`'s `routeToHeaders`). Pages rendered on demand get theirs from Astro.
- i18n domains: not declared, so Astro reports them unsupported.
- Compressing on-demand responses; TLS, unix sockets, and several processes with `reusePort`; trusted proxies by CIDR; Bun-native session drivers (`bun:sqlite`, `Bun.redis`); an image service on `Bun.Image`.
- Conformance cases ported from `@astrojs/node`'s tests, and a weekly CI run against the latest Astro and Bun.

## References

- Adapter API: https://docs.astro.build/en/reference/adapter-reference/
- Upgrading: https://docs.astro.build/en/guides/upgrade-to/v6/, https://docs.astro.build/en/guides/upgrade-to/v7/
- `@astrojs/node` changelog: https://github.com/withastro/astro/blob/main/packages/integrations/node/CHANGELOG.md
- `Bun.serve`: https://bun.com/docs/runtime/http/server, https://bun.com/docs/runtime/http/routing, https://bun.com/docs/runtime/streams
- Bun 1.4: https://bun.com/blog/bun-v1.4
- Bun's types: https://github.com/oven-sh/bun/blob/bun-v1.4.4/packages/bun-types/serve.d.ts
