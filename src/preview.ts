// `astro preview` imports this module into the Astro CLI's process, on Node or Bun: node:* only. It runs the built server on Bun beside it.
import { spawn } from "node:child_process";
import { connect } from "node:net";
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
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `The server did not listen on ${hostname}:${port} within ${STARTUP_TIMEOUT / 1000} s`,
          ),
        ),
      STARTUP_TIMEOUT,
    );
    child.once("error", (error: NodeJS.ErrnoException) =>
      settle(
        error.code === "ENOENT"
          ? new Error(
              "astro preview runs the built server on Bun, which is not installed or not on PATH: https://bun.com",
            )
          : error,
      ),
    );
    child.once("exit", (code) =>
      settle(
        new Error(`The server exited with code ${code} before it listened`),
      ),
    );
    // Ready once a connection opens: the server's own startup line says so in whatever format the app logs.
    const address =
      hostname === "0.0.0.0"
        ? "127.0.0.1"
        : hostname === "::"
          ? "::1"
          : hostname;
    const probe = () => {
      if (settled) return;
      const socket = connect(port, address);
      socket.once("connect", () => {
        socket.destroy();
        settle();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(probe, 50);
      });
    };
    probe();
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
