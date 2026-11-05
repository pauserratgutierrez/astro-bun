import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroConfig, AstroIntegration } from "astro";
import type runtimeConfig from "virtual:astro-bun:config";
import type { Plugin } from "vite";

export interface Options {
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
}

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
        updateConfig({
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
            envGetSecret: "stable",
            sharpImageService: "stable",
          },
        });
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
