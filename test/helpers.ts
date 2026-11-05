import { connect } from "node:net";
import { fileURLToPath } from "node:url";

export const astro = fileURLToPath(
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

export interface Launched {
  /** Everything the server wrote so far, stdout and stderr. */
  log(): string;
  /** Sends the process a signal. */
  signal(name: NodeJS.Signals): void;
  /** Its exit code, once it exits. */
  exited: Promise<number>;
}

export interface Running extends Launched {
  /** The server's origin, `http://127.0.0.1:<port>`. */
  origin: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Runs a built fixture's server on Bun, in the fixture's directory, on a port the system picks unless `env` names one.
 * With `script`, Bun runs that file and passes it the entry's path, as an app with its own `Bun.serve` would load it.
 */
export function launch(
  root: string,
  env: Record<string, string> = {},
  script?: string,
): Launched {
  const entry = `${root}dist/server/entry.mjs`;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      ...(script ? [script, entry] : [entry]),
    ],
    {
      cwd: root,
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
  return {
    log: () => log,
    signal: (name) => child.kill(name),
    exited: child.exited,
  };
}

/** Starts a built fixture's server and waits until it listens. */
export async function start(
  root: string,
  env: Record<string, string> = {},
  script?: string,
): Promise<Running> {
  const launched = launch(root, env, script);
  let exited = false;
  void launched.exited.then(() => (exited = true));
  const deadline = Date.now() + 15_000;
  let port: number | undefined;
  while (port === undefined) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(
      launched.log(),
    );
    if (match) port = Number(match[1]);
    else if (exited || Date.now() > deadline)
      throw new Error(`the server did not start\n${launched.log()}`);
    else await Bun.sleep(25);
  }
  return {
    ...launched,
    origin: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      launched.signal("SIGTERM");
      await launched.exited;
    },
  };
}

/** Waits until `ready` holds, or fails after `ms`. */
export async function until(
  ready: () => boolean | Promise<boolean>,
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
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
