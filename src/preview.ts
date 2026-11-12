// `astro preview` imports this module into the Astro CLI's process, on Node or Bun: node:* only. It runs the built server on Bun beside it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CreatePreviewServer } from "astro";

// How long the server may take to listen.
const STARTUP_TIMEOUT = 30_000;

const createPreviewServer: CreatePreviewServer = async ({
  serverEntrypoint,
  host,
  port,
  root,
}) => {
  // As Astro's Node adapter: a host the CLI did not name (`--host` alone) is every interface.
  const hostname = process.env.HOST ?? host ?? "0.0.0.0";
  const child = spawn(
    process.versions.bun === undefined ? "bun" : process.execPath,
    [
      fileURLToPath(new URL("./preview-child.js", import.meta.url)),
      fileURLToPath(serverEntrypoint),
    ],
    {
      cwd: fileURLToPath(root),
      env: { ...process.env, HOST: hostname, PORT: String(port) },
      // The server ends when its stdin does, and says on fd 3 that it listens.
      stdio: ["pipe", "inherit", "inherit", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  // The first of these settles it; the others then do nothing.
  await new Promise<void>((resolve, reject) => {
    child.stdio[3]!.once("data", () => resolve());
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new Error(
              "astro preview runs the built server on Bun, which is not installed or not on PATH: https://bun.com",
            )
          : error,
      ),
    );
    child.once("exit", (code) =>
      reject(
        new Error(`The server exited with code ${code} before it listened`),
      ),
    );
    setTimeout(
      () =>
        reject(
          new Error(
            `The server did not listen on ${hostname}:${port} within ${STARTUP_TIMEOUT / 1000} s`,
          ),
        ),
      STARTUP_TIMEOUT,
    ).unref();
  }).catch((error) => {
    child.kill();
    throw error;
  });
  return {
    host: hostname,
    port,
    closed: () => closed,
    async stop() {
      child.kill();
      await closed;
    },
  };
};

export default createPreviewServer;
