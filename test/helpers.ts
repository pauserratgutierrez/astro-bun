import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const astro = fileURLToPath(
  new URL("../node_modules/astro/bin/astro.mjs", import.meta.url),
);

/** Builds a fixture with the Astro CLI on Node, as an app builds, and returns its directory. */
export async function build(fixture: string): Promise<string> {
  const root = fileURLToPath(
    new URL(`./fixtures/${fixture}/`, import.meta.url),
  );
  const child = Bun.spawn(["node", astro, "build", "--root", root], {
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`astro build of ${fixture} exited ${code}\n${out}\n${err}`);
  return root;
}

export interface Running {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  /** Everything the server wrote so far, stdout and stderr. */
  log(): string;
  stop(): Promise<void>;
}

/** Starts a built fixture's server on Bun, on a port the system picks, and waits until it listens. */
export async function start(
  root: string,
  env: Record<string, string> = {},
): Promise<Running> {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", `${root}dist/server/entry.mjs`],
    {
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let log = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      log += decoder.decode(chunk, { stream: true });
  };
  void drain(child.stdout);
  void drain(child.stderr);
  const deadline = Date.now() + 15_000;
  let port: number | undefined;
  while (port === undefined) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (match) port = Number(match[1]);
    else if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`the server did not start\n${log}`);
    else await Bun.sleep(25);
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    log: () => log,
    async stop() {
      child.kill("SIGTERM");
      await child.exited;
    },
  };
}

/** Sends request bytes as written, for headers `fetch` refuses, and returns the whole answer. */
export function raw(
  port: number,
  request: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(data.slice(9, 12));
      resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
  });
}
