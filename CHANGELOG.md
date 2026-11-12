# Changelog

## 0.2.1

- `astro preview` fails, exiting 1, when its server cannot listen, for one because another server holds the port; it used to take that other server for its own and exit 0. The server now says when it listens, instead of the preview probing the port.

## 0.2.0

- Requires Astro 7.4.11 or later.
- `security.allowedDomains` matches `Host` and the forwarded headers as Astro 7.4.11 and its Node adapter do: each entry matches protocol, host, and port together. `X-Forwarded-Proto` counts only when an entry allows it for the host in use, `X-Forwarded-Host` without `X-Forwarded-Proto` is matched with the server's protocol, `port: "443"` matches an https host without a port, and a host that is not a plain `hostname[:port]` (percent-encoded, for one) moves the request to localhost.
- A page that fails after it started streaming is logged once through the configured logger (withastro/astro#18625, fixed in Astro). The adapter needed no change; a test now covers it.

## 0.1.1

The code of 0.1.0, published from CI through npm's trusted publishing, so the package now carries provenance. Releases follow a pushed version tag, which sets the version.

## 0.1.0

First release: an Astro 7 adapter that serves on-demand pages with Bun's `Bun.serve`, and the static files beside them from memory.

- Every Astro feature runs inside Astro's `app.render()`: routing, middleware, actions, server islands, sessions, i18n, `src/fetch.ts`.
- Static files are hashed at build time, and text files get Brotli, zstd, and gzip copies; the server sends the smallest copy a client accepts, with ETags and 304s, `immutable` caching for hashed files, and prerendered pages at their clean URLs (`base`, `trailingSlash`, `build.format`). Files other integrations write after the build are listed and compressed too.
- The request URL is kept only for a `Host` listed in `security.allowedDomains`, and `X-Forwarded-For` trusted only behind one. No request path reaches the filesystem, and Bun's development error page is always off.
- `SIGTERM` lets the responses in flight finish, also as a container's PID 1. Event streams outlive the idle timeout, oversized bodies get 413, and a port in use exits 1.
- `astro preview` runs the build on Bun even when the Astro CLI runs on Node, and an app's own `Bun.serve` can compose the adapter's routes and handler with routes and WebSockets of its own.
- No runtime dependencies. Requires Astro 7.4 and Bun 1.4.4 or later.
