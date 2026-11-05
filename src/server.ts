// The server entrypoint: Astro bundles it into dist/server/entry.mjs, whose top-level code starts the server.
// ASTRO_BUN_AUTOSTART=disabled leaves the start to an app that imports `handler` into its own Bun.serve.
import type { Server } from "bun";
import { createApp } from "astro/app/entrypoint";
import { setGetEnv } from "astro/env/setup";
import config from "virtual:astro-bun:config";
import { forAstro } from "./request.js";

setGetEnv((key) => process.env[key]);

const app = createApp({ streaming: config.streaming });
// The destination the app configured (a JSON logger, for one), resolved before the first line.
await app.getLogger();
const logger = app.adapterLogger;
const domains = app.getAllowedDomains() ?? [];
// This module's own URL: the entry file in the server directory.
const client = new URL(config.client, import.meta.url);

/** Background work a render hands over, such as a cache provider's write: a shutdown waits for it. */
const pending = new Set<Promise<unknown>>();

function waitUntil(promise: Promise<unknown>): void {
  pending.add(promise);
  promise.then(
    () => pending.delete(promise),
    (error) => {
      pending.delete(promise);
      logger.error(`Background work failed\n${describe(error)}`);
    },
  );
}

const ERROR_PAGE = /\/(404|500)(?:\.html|\/index\.html)$/;

/** A prerendered 404 or 500 page, read from the client directory: Astro would otherwise fetch it over HTTP from the server itself. */
async function prerenderedErrorPage(url: string): Promise<Response> {
  const status = ERROR_PAGE.exec(new URL(url).pathname)?.[1];
  for (const name of status === undefined
    ? []
    : [`${status}.html`, `${status}/index.html`]) {
    const file = Bun.file(new URL(name, client));
    if (await file.exists())
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
  }
  return new Response(null, { status: 404 });
}

/** Renders a request with Astro. */
export async function handler(
  request: Request,
  server: Server<unknown>,
): Promise<Response> {
  const astroRequest = forAstro(request, server, domains);
  try {
    let routeData = app.match(astroRequest, true);
    // A prerendered page or endpoint has its file; a lower-priority on-demand route may still answer this path. A configured redirect keeps its match.
    if (
      routeData?.prerender &&
      (routeData.type === "page" || routeData.type === "endpoint")
    )
      routeData = app.match(astroRequest);
    const response = await app.render(astroRequest, {
      addCookieHeader: true,
      routeData,
      prerenderedErrorPageFetch: prerenderedErrorPage,
      waitUntil,
    });
    // An event stream may stay quiet longer than the idle timeout.
    if (response.headers.get("content-type")?.startsWith("text/event-stream"))
      server.timeout(request, 0);
    return response;
  } catch (error) {
    // A client that left is not an error.
    if (!request.signal.aborted)
      logger.error(`Could not render ${astroRequest.url}\n${describe(error)}`);
    return internalError();
  }
}

function internalError(): Response {
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function describe(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

if (process.env.ASTRO_BUN_AUTOSTART !== "disabled") start();

function start(): void {
  const port =
    process.env.PORT === undefined ? config.port : Number(process.env.PORT);
  const hostname =
    process.env.HOST ??
    (config.host === true
      ? "0.0.0.0"
      : config.host === false
        ? "localhost"
        : config.host);
  let server: Server<unknown>;
  try {
    server = Bun.serve({
      port,
      hostname,
      // Bun's development mode answers errors with a page that shows source code.
      development: false,
      // A second server on the same port fails instead of sharing it.
      reusePort: false,
      idleTimeout: config.idleTimeout,
      ...(config.maxRequestBodySize === undefined
        ? {}
        : { maxRequestBodySize: config.maxRequestBodySize }),
      fetch: handler,
      error(error) {
        logger.error(describe(error));
        return internalError();
      },
    });
  } catch (error) {
    logger.error(`Could not listen on ${hostname}:${port}\n${describe(error)}`);
    process.exit(1);
  }
  logger.info(`Server listening on ${server.url}`);

  // A rejection nothing handled is logged, not fatal: one bad promise does not take every request down.
  process.on("unhandledRejection", (reason) =>
    logger.error(`Unhandled rejection\n${describe(reason)}`),
  );

  let stopping = false;
  const stop = async () => {
    // A second signal: stop waiting.
    if (stopping) process.exit(1);
    stopping = true;
    const deadline = Date.now() + config.shutdownTimeout;
    const force = setTimeout(
      () => void server.stop(true),
      config.shutdownTimeout,
    );
    // Closes idle connections at once and resolves when the responses in flight are done.
    await server.stop();
    clearTimeout(force);
    await Promise.race([
      Promise.allSettled(pending),
      Bun.sleep(Math.max(0, deadline - Date.now())),
    ]);
    app.logger.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
