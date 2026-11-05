# Development

## Toolchain

- Bun 1.4.4: the install, the formatter (`bun fmt`), the typecheck, the tests, and the servers the tests start.
- Node, in a version Astro supports (CI uses 26.13.0): the tests build each fixture with the Astro CLI on Node, as an app builds.

Behavior that depends on the operating system (signals, `reusePort`, `sendfile`) is tested on Linux, as CI runs.

## Commands

| Task              | Command           |
| ----------------- | ----------------- |
| Install           | `bun install`     |
| Format            | `bun fmt`         |
| Check the format  | `bun fmt --check` |
| Typecheck         | `bun run check`   |
| Build the package | `bun run build`   |
| Test              | `bun run test`    |

`bun run test` builds the package first: each fixture imports the adapter from `dist/`.

Without Bun on the machine, the install, the formatter, the typecheck, and the package build run in Bun's image, which has no Node for the tests:

```sh
docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim sh -c "bun install && bun fmt --check && bun run check"
```

In Git Bash on Windows, prefix it with `MSYS_NO_PATHCONV=1`, so MSYS does not rewrite `/work`.

## Tests

- `test/fixtures/<name>/` is an Astro project whose config imports the adapter from `dist/`.
- `test/helpers.ts` builds a fixture, starts its server on Bun, and sends raw requests for headers `fetch` refuses.
- A test starts its server on port 0 and reads the port it got from the server's first line, so it never collides with another server on the machine.
