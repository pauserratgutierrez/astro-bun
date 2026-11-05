# Agent standards

This repository is an Astro adapter for Bun, published to npm as `@pauserratgutierrez/astro-bun`. What it must do and why: [docs/design.md](./docs/design.md). Running the checks and tests: [docs/development.md](./docs/development.md).

## Hard stops

- Never trust the `Host` header unless it matches `security.allowedDomains`; otherwise the request URL is `localhost:<port>`, as in Astro's Node adapter.
- Never serve a file that is not in the static manifest the build writes. No path from a request reaches the filesystem.
- Never run `Bun.serve` with `development` on, and never send a stack trace or an internal path to a client.
- Build-time code (`src/index.ts` and what it imports) runs in the Astro CLI on Node or Bun: `node:*` and Astro APIs only, never `Bun.*`. Runtime code runs only on Bun.
- Use Astro's public API: `astro/app/entrypoint`, `astro/env/setup`, the `App` methods, the integration hooks. An internal one is feature-detected, has a fallback, and is listed in [docs/design.md](./docs/design.md#astro-internals-used).
- No runtime dependencies. A development dependency needs the user's approval.
- Never commit, push, tag, or publish to npm unless the user asks.
- Never edit another repository. An app used to try the adapter is copied, and only the copy changes.

## Evidence before changes

- Verify against the pinned `astro` in `node_modules` (its `dist/` and types), `@types/bun`, and the docs of the pinned versions, never from memory.
- Before handling an edge case, read how Astro's Node adapter (`@astrojs/node`) handles it, and its changelog: its fixes are the list of what breaks in production.
- Prove a behavior with a fixture under `test/` before relying on it, on Linux when it depends on the OS (signals, `reusePort`, `sendfile`).

## Change discipline

- Touch only files the change needs. No drive-by refactors, renames, or formatting.
- Prefer the smallest change that keeps behavior. A cleanup never changes outputs, headers, or status codes.
- Prefer the form that is both less code and faster; never add code for a gain you cannot measure.
- No per-request work that can run once at build time or at startup.
- Fix the cause, not the symptom: no workarounds, retries, or special cases that hide a bug.
- Use Bun, Web, and Astro primitives directly. No wrapper that only forwards, renames, or re-exports.
- Leave no dead code: delete what you introduce and what your change orphans (imports, exports, helpers, types, options, docs).
- A behavior change updates [README.md](./README.md) and [docs/](./docs/) in the same change.
- Every package in `package.json` is an exact version, never `^` or `~` (`bun add -E`), except the `astro` peer range.
- Markdown names: `README.md` is a folder's page and `AGENTS.md` this file; every other page is lowercase kebab-case in `docs/`. A link uses its target's exact case: Linux and GitHub are case-sensitive, and Windows hides a wrong one.
- Do not wrap prose, comments, or YAML at a column width.
