# Development

## Toolchain

- Bun 1.4.4: the install, the formatter (`bun fmt`), the typecheck, the tests, and the servers the tests start.
- Node, in a version Astro supports (CI uses 26.13.0): the tests build each fixture with the Astro CLI on Node, as an app builds.
- Docker, for the suite on Linux from another OS.

## Commands

| Task                 | Command              |
| -------------------- | -------------------- |
| Install              | `bun install`        |
| Format               | `bun fmt`            |
| Check the format     | `bun fmt --check`    |
| Typecheck            | `bun run check`      |
| Build the package    | `bun run build`      |
| Test                 | `bun run test`       |
| Test on Linux, as CI | `bun run test:linux` |

`bun run test` builds the package first: each fixture imports the adapter from `dist/`.

`bun run test:linux` builds [test/Dockerfile](../test/Dockerfile) (Node's image with Bun's binary, dependencies installed for Linux) and runs the suite in it. Tests of signals skip on Windows, where a kill ends a process without running its handlers; they run on Linux and macOS.

## Releasing

A release is a GitHub release whose tag is `v` and the version in `package.json`, such as `v0.1.0`. Publishing it runs [release.yml](../.github/workflows/release.yml): the checks and tests on Linux, then `npm publish --provenance` through npm's trusted publishing, with no token stored.

1. Raise `version` in `package.json` in a pull request, and merge it.
2. Create the release from `main`, tagged `v<version>`, with its notes.

npm lets a package trust a workflow only once the package exists, so the first version is published by hand, once:

1. `npm login` as the package's owner.
2. `bun run build`, then `npm publish --access public --provenance=false` (provenance is signed only in CI).
3. On npmjs.com, the package's **Settings**, **Trusted publishing**: GitHub Actions, repository `pauserratgutierrez/astro-bun`, workflow `release.yml`.

From then on every version comes from a release.

## Tests

- `test/fixtures/<name>/` is an Astro project whose config imports the adapter from `dist/`.
- `test/helpers.ts` builds a fixture, runs its server on Bun in the fixture's directory, signals it, and sends raw requests for headers `fetch` refuses.
- A test starts its server on port 0 and reads the port it got from the server's first line, so it never collides with another server on the machine.
- Bun counts idle time in 4-second steps: a fixture with `idleTimeout: 2` cuts a connection quiet for 4 s, so its slow endpoints pause 6 s.
