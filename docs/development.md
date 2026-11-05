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

Releases follow scraply and sluice: pushing a version tag publishes it. `package.json` keeps `0.0.0` in git, and [release.yml](../.github/workflows/release.yml) takes the version from the tag (`v0.2.0` publishes 0.2.0) once the checks and tests pass on Linux, then publishes through npm's trusted publishing, with provenance and no token stored. A version already on npm is left as it is, so a tag can be pushed again.

1. Add the version's entry to [CHANGELOG.md](../CHANGELOG.md), with anything that changes behavior for an app called out: in the pull request that makes the change, or in one of its own.
2. Once it is merged, tag `main`: `git tag v0.2.0 && git push origin v0.2.0`.

npm lets a package trust a workflow only once the package exists, so 0.1.0 was published by hand, once:

1. `npm login` as the package's owner.
2. `npm publish --access public --provenance=false`, with `package.json` at 0.1.0: `prepublishOnly` builds the package first, and provenance is signed only in CI.
3. On npmjs.com, the package's **Settings**, **Trusted Publisher**: GitHub Actions, `pauserratgutierrez` / `astro-bun`, workflow `release.yml`, **Allow npm publish**. The connection names the workflow's file, so renaming it means setting this up again.
4. **Publishing access**: two-factor authentication, with no tokens that bypass it.

## Tests

- `test/fixtures/<name>/` is an Astro project whose config imports the adapter from `dist/`.
- `test/helpers.ts` builds a fixture, runs its server on Bun in the fixture's directory, signals it, and sends raw requests for headers `fetch` refuses.
- A test starts its server on port 0 and reads the port it got from the server's first line, so it never collides with another server on the machine.
- Bun counts idle time in 4-second steps: a fixture with `idleTimeout: 2` cuts a connection quiet for 4 s, so its slow endpoints pause 6 s.
