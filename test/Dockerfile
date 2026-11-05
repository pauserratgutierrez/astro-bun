# The test suite on Linux, as CI runs it, from a machine on any OS: Node for the Astro CLI, Bun for the rest. Signals and other Linux behavior are tested here.
#   docker build -f test/Dockerfile -t astro-bun-test . && docker run --rm astro-bun-test
FROM oven/bun:1.4.4-slim AS bun

FROM node:26.13.0-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "run", "test"]
