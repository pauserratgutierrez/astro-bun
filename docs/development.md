# Development

## Toolchain

Bun 1.4.4 runs everything in this repository: the install, the formatter (`bun fmt`), the typecheck, and the tests. Install it on the machine, or run the same commands in its image, `oven/bun:1.4.4-slim`.

Behavior that depends on the operating system (signals, `reusePort`, `sendfile`) is tested on Linux: in the image when the machine runs Windows or macOS.

## Commands

| Task              | On the machine    | In the image                                                                      |
| ----------------- | ----------------- | --------------------------------------------------------------------------------- |
| Install           | `bun install`     | `docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim bun install`        |
| Format            | `bun fmt`         | `docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim bun fmt`            |
| Check the format  | `bun fmt --check` | `docker run --rm -v "$PWD:/work:ro" -w /work oven/bun:1.4.4-slim bun fmt --check` |
| Typecheck         | `bun run check`   | `docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim bun run check`      |
| Test              | `bun test`        | `docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim bun test`           |
| Build the package | `bun run build`   | `docker run --rm -v "$PWD:/work" -w /work oven/bun:1.4.4-slim bun run build`      |

In Git Bash on Windows, prefix a `docker` command with `MSYS_NO_PATHCONV=1`, so MSYS does not rewrite `/work`.

## Ports

A test starts its server on port 0 and reads the port it got, so a test never collides with another server on the machine.
