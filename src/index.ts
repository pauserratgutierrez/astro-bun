import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroConfig, AstroIntegration } from "astro";
import { sessionDrivers } from "astro/config";
import type runtimeConfig from "virtual:astro-bun:config";
import type { Plugin } from "vite";
import { writeStaticManifest } from "./build/static.js";

export interface Options {
  /**
   * Whether the build writes Brotli, zstd, and gzip copies of text files, at their highest levels, for the server to send to the clients that accept them.
   * @default true
   */
  precompress?: boolean;
  /**
   * Bytes of static files, compressed copies included, the server keeps in memory, smallest files first. The rest is read from disk on each request.
   * @default 64 MiB
   */
  staticMemoryBudget?: number;
  /**
   * Seconds a connection may go without a byte either way before Bun closes it, from 0 (never) to 255. Bun's own default, 10, also resets a render slower than that to its first byte. Event streams are exempt.
   * @default 60
   */
  idleTimeout?: number;
  /**
   * The largest request body, in bytes: past it Bun answers 413 before the app runs.
   * @default Bun's, 128 MiB
   */
  maxRequestBodySize?: number;
  /**
   * Milliseconds a shutdown waits for the responses in flight before it closes their connections.
   * @default 8000
   */
  shutdownTimeout?: number;
  /**
   * Whether a page is sent as it renders. Off, each page is sent whole.
   * @default true
   */
  streaming?: boolean;
  /**
   * Whether the server loads every page's module at startup, so no page waits for it on its first request.
   * @default true
   */
  preload?: boolean;
}

/** Where sessions are kept when the config names no driver: relative, so the server resolves it in its working directory, not on the build machine. */
const SESSIONS_DIR = "node_modules/.astro/sessions";

const NAME = "@pauserratgutierrez/astro-bun";
const CONFIG_ID = "virtual:astro-bun:config";
const RESOLVED_CONFIG_ID = `\0${CONFIG_ID}`;
// The Vite environments that bundle server code, the adapter's runtime among it.
const SERVER_ENVIRONMENTS = new Set(["ssr", "prerender", "astro"]);

export default function bun(options: Options = {}): AstroIntegration {
  let config: AstroConfig;
  return {
    name: NAME,
    hooks: {
      "astro:config:setup": ({ config: initial, command, updateConfig }) => {
        const { session } = initial;
        updateConfig({
          // Sessions work with no driver configured, on files, as with Astro's Node adapter; `session: false` keeps them off.
          ...(session !== false && !session?.driver
            ? {
                session: {
                  ...session,
                  driver: sessionDrivers.fsLite({ base: SESSIONS_DIR }),
                },
              }
            : {}),
          // A redirect stays a route the server answers, not an HTML file with a meta refresh.
          build: { redirects: false },
          // The endpoint that reads local images from disk, not the generic one that fetches them from the server itself.
          image: {
            endpoint: {
              route: initial.image.endpoint.route ?? "_image",
              entrypoint:
                initial.image.endpoint.entrypoint ??
                (command === "dev"
                  ? "astro/assets/endpoint/dev"
                  : "astro/assets/endpoint/node"),
            },
          },
          vite: { plugins: [configPlugin(() => runtime(config, options))] },
          // Astro puts the adapter first, and an integration added here last: its build:done sees the files every other integration writes then.
          integrations: [
            staticFiles(() => config, options.precompress ?? true),
          ],
        });
      },
      "astro:config:done": ({ config: resolved, setAdapter }) => {
        config = resolved;
        setAdapter({
          name: NAME,
          entrypointResolution: "auto",
          serverEntrypoint: new URL("./server.js", import.meta.url),
          adapterFeatures: { buildOutput: "server", middlewareMode: "classic" },
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            envGetSecret: "stable",
            sharpImageService: "stable",
          },
        });
      },
    },
  };
}

/** Lists, hashes, and compresses the client files once the build has written them all. */
function staticFiles(
  config: () => AstroConfig,
  precompress: boolean,
): AstroIntegration {
  return {
    name: `${NAME}/static-files`,
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const { files } = await writeStaticManifest({
          client: dir,
          server: config().build.server,
          assets: config().build.assets,
          precompress,
        });
        const copies = files.reduce(
          (sum, file) => sum + Object.keys(file.encodings).length,
          0,
        );
        logger.info(`${files.length} files, ${copies} compressed copies`);
      },
    },
  };
}

/** The values the server reads, resolved when the build loads them: by then every integration has set the config. */
function runtime(config: AstroConfig, options: Options): typeof runtimeConfig {
  return {
    client: `${relative(fileURLToPath(config.build.server), fileURLToPath(config.build.client)).replaceAll("\\", "/")}/`,
    host: config.server.host,
    port: config.server.port,
    idleTimeout: options.idleTimeout ?? 60,
    maxRequestBodySize: options.maxRequestBodySize,
    shutdownTimeout: options.shutdownTimeout ?? 8000,
    staticMemoryBudget: options.staticMemoryBudget ?? 64 * 1024 * 1024,
    preload: options.preload ?? true,
    streaming: options.streaming ?? true,
  };
}

/** Serves `virtual:astro-bun:config`, and keeps the adapter in the server bundle so that import resolves. */
function configPlugin(read: () => typeof runtimeConfig): Plugin {
  return {
    name: CONFIG_ID,
    configEnvironment(name) {
      if (SERVER_ENVIRONMENTS.has(name))
        return { resolve: { noExternal: [NAME] } };
    },
    resolveId: {
      filter: { id: new RegExp(`^${CONFIG_ID}$`) },
      handler: () => RESOLVED_CONFIG_ID,
    },
    load: {
      filter: { id: new RegExp(`^${RESOLVED_CONFIG_ID}$`) },
      handler: () => `export default ${JSON.stringify(read())};`,
    },
  };
}
