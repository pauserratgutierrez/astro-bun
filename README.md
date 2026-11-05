# astro-bun

An [Astro](https://astro.build) adapter that serves on-demand rendered pages with [Bun](https://bun.com)'s native HTTP server, `Bun.serve`.

> **Status:** in development, not published yet. What it does and how is in [docs/design.md](./docs/design.md).

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

## Goals

- `Bun.serve` directly, with no `node:http` layer: Astro and Bun both speak `Request` and `Response`.
- Every Astro feature from the start. Routing, middleware, actions, server islands, sessions, and the rest run inside Astro's `app.render()`; the adapter covers only what Astro hands to it: static files, the client address, host validation, the environment, error pages, and the server's lifecycle.
- Static files listed and precompressed (Brotli, zstd, gzip) at build time and served from memory: no filesystem access per request, and no path outside the build's list can be served.
- Secure defaults that match Astro's Node adapter: the host validated against `security.allowedDomains`, prerendered error pages read locally, Bun's development mode always off.
- A production lifecycle: graceful shutdown on `SIGTERM`, timeouts that suit streaming, a request body limit.
- `astro dev` and `astro build` stay on Node, which Astro supports; only the production server runs on Bun.
- No runtime dependencies.

## Requirements

- Astro 7.4 or later within 7.x.
- Bun 1.4.4 or later, to run the server.
- The Node version Astro requires, for `astro dev` and `astro build`.

## Development

[docs/development.md](./docs/development.md). Security reports: [.github/SECURITY.md](./.github/SECURITY.md).

## License

[MIT](./LICENSE)
