# astro-bun

An [Astro](https://astro.build) adapter that serves on-demand rendered pages with [Bun](https://bun.com)'s native HTTP server, `Bun.serve`, and the static files beside them from memory, precompressed.

> **Status:** not on npm yet; the first release publishes it. How it works: [docs/design.md](./docs/design.md).

## Install

```sh
bun add @pauserratgutierrez/astro-bun
```

```js
// astro.config.mjs
import bun from "@pauserratgutierrez/astro-bun";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  adapter: bun(),
});
```

Build with the Astro CLI as usual, on Node (which Astro supports) or Bun, then run the server on Bun:

```sh
astro build
bun --no-env-file ./dist/server/entry.mjs
```

The server listens on `HOST` and `PORT`, or on Astro's `server.host` and `server.port` (`localhost:4321`). `--no-env-file` keeps Bun from loading the `.env` files of the working directory, which it does on its own. `astro preview` runs the same server on Bun, even when the Astro CLI runs on Node.

## What it does

- **Every Astro feature.** Routing, middleware, actions, server islands, sessions, i18n, redirects, rewrites, cookies, CSP, and `src/fetch.ts` run inside Astro's `app.render()`: the adapter hands it each request and sends back its `Response`, with no `node:http` layer.
- **Static files from memory.** At build time every client file is hashed, and text files get Brotli, zstd, and gzip copies at their highest levels. The server sends the smallest copy each client accepts, with ETags and 304s, `immutable` caching for `/_astro/`, and HEAD; the smallest files are kept in memory (64 MiB by default), the rest read from disk. Prerendered pages answer at their clean URLs, following `base`, `trailingSlash`, and `build.format`. Files other integrations write after the build (a sitemap, a search index, icons) are listed and compressed too.
- **Secure defaults.** The request URL is kept only for a `Host` listed in `security.allowedDomains`, as in Astro's Node adapter; `X-Forwarded-For` is trusted only behind such a host. No request path reaches the filesystem, dotfiles are not served (except `.well-known`), Bun's development error page is always off, and prerendered 404 and 500 pages are read locally.
- **A production lifecycle.** `SIGTERM` lets the responses in flight finish (within `shutdownTimeout`), then exits. Event streams outlive the idle timeout, which defaults to 60 s rather than Bun's 10. Bodies over `maxRequestBodySize` get 413. A port in use exits 1. An unhandled rejection is logged, not fatal. Every page module loads before the server listens.
- **Sessions and images.** Sessions work with no driver configured, on files under the working directory. `astro:assets` transforms images with Sharp on Bun.
- **No runtime dependencies.**

## Options

```js
bun({
  idleTimeout: 60, // seconds without a byte before Bun closes a connection; Bun counts them in 4-second steps
  maxRequestBodySize: 128 * 1024 * 1024, // bytes; larger bodies get 413 before the app runs
  shutdownTimeout: 8000, // milliseconds SIGTERM waits for the responses in flight
  streaming: true, // send pages as they render
  preload: true, // load every page module at startup
  precompress: true, // write Brotli, zstd, and gzip copies of text files at build time
  staticMemoryBudget: 64 * 1024 * 1024, // bytes of static files kept in memory, smallest first
});
```

## Behind a reverse proxy

List the public host so Astro builds its URLs, its CSRF check, and `Astro.clientAddress` from what the proxy forwards:

```js
export default defineConfig({
  security: {
    allowedDomains: [{ hostname: "example.com", protocol: "https" }],
  },
});
```

The proxy sends `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`. Without a match the request URL is `http://localhost:<port>`, and the client address is the socket's.

## In a container

```dockerfile
FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV HOST=0.0.0.0 PORT=4321
USER bun
EXPOSE 4321
CMD ["bun", "--no-env-file", "./dist/server/entry.mjs"]
```

Bun handles `SIGTERM` itself as PID 1. A read-only container needs a session driver of its own if the app uses sessions.

## Your own Bun.serve

With `ASTRO_BUN_AUTOSTART=disabled`, the built entry starts nothing and exports what the server is made of, for an app that adds routes or WebSockets of its own:

```js
process.env.ASTRO_BUN_AUTOSTART = "disabled";
const { handler, routes } = await import("./dist/server/entry.mjs");

Bun.serve({
  routes: { ...routes, "/health": new Response("ok") },
  fetch(request, server) {
    if (new URL(request.url).pathname === "/socket" && server.upgrade(request))
      return;
    return handler(request, server);
  },
  websocket: { message: (socket, message) => socket.send(message) },
});
```

## Why this exists

Astro has no official Bun adapter, and its team has said it does not plan Bun-specific code. Reviewed against Astro 7 and Bun 1.4 in November 2026, none of the adapters the community has published so far is safe to run in production as-is. Their issues fall in three groups.

**Security**

- Path traversal: the request path is decoded and joined to the client directory, so a path with encoded `../` segments reads files outside it.
- The `Host` header trusted as sent. Bun builds `request.url` from it, and Astro derives `Astro.url` and its CSRF origin check from that URL; Astro's own Node adapter only trusts a host listed in `security.allowedDomains`.
- A response cache keyed by path alone that stores answers carrying `Set-Cookie` or `Cache-Control: private`: one user's response, cookies included, served to another.
- Stack traces sent to visitors: Bun's development error page left on, or `error.stack` written into the page as unescaped HTML.
- Prerendered 404 and 500 pages fetched over HTTP from the server itself instead of read locally, the pattern behind Astro's own SSRF advisories.

**Production**

- `SIGTERM` exits without draining: requests in flight are cut on every deploy.
- Bun's 10-second idle timeout left at its default: a render slower than that, or a quiet event stream, is reset mid-response.
- Static files whose name has `@`, `+`, `,`, `=` or `:` (`logo@2x.png`) answered 404.
- The build machine's absolute paths written into the bundle, so a build moved into a container, or made on Windows, cannot find its files.
- Astro's warnings silenced after startup.

**Compatibility**

- Adapters on the deprecated Astro 5 entrypoint API, or calling methods Astro 7 removed: they do not start.
- `astro preview` fails when the Astro CLI runs on Node, its default runtime.
- Build hooks that call Bun-only APIs, which forces the whole Astro CLI to run under Bun, a setup Astro does not support.
- Redirects from the config, and directory indexes of prerendered pages, answered 404.

## Requirements

- Astro 7.4 or later within 7.x.
- Bun 1.4.4 or later, to run the server.
- The Node version Astro requires, for `astro dev` and `astro build`.

## Development

[docs/development.md](./docs/development.md). Security reports: [.github/SECURITY.md](./.github/SECURITY.md).

## License

[MIT](./LICENSE)
