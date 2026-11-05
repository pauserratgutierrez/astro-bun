import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { astro, build, type Running, start, until } from "./helpers.js";

let root: string;

beforeAll(async () => {
  root = await build("compose");
}, 120_000);

describe("an app's own Bun.serve", () => {
  let own: Running;

  beforeAll(async () => {
    own = await start(
      root,
      {},
      fileURLToPath(new URL("./own-server.ts", import.meta.url)),
    );
  });

  afterAll(() => own.stop());

  test("serves the adapter's static routes and Astro's handler beside its own route and a WebSocket", async () => {
    expect(await (await fetch(`${own.origin}/runtime`)).json()).toEqual({
      bun: true,
    });
    expect(await (await fetch(`${own.origin}/hello.txt`)).text()).toBe(
      "a public file\n",
    );
    expect(await (await fetch(`${own.origin}/own`)).text()).toBe("own route");
    const socket = new WebSocket(`${own.origin.replace("http", "ws")}/socket`);
    const reply = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) =>
        resolve(String(event.data)),
      ),
    );
    socket.addEventListener("open", () => socket.send("hi"));
    expect(await reply).toBe("echo hi");
    socket.close();
  });

  test("ASTRO_BUN_AUTOSTART=disabled leaves the start to the app", () => {
    expect(own.log()).not.toContain("Server listening on");
  });
});

describe("astro preview", () => {
  test("with the Astro CLI on Node, serves the build on Bun, and the server ends with the CLI", async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = free.port!;
    free.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    const cli = Bun.spawn(
      [
        "node",
        astro,
        "preview",
        "--root",
        root,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      {
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const answers = () =>
      fetch(`${origin}/runtime`).then(
        (response) => response.ok,
        () => false,
      );
    try {
      await until(answers, 30_000);
      expect(await (await fetch(`${origin}/runtime`)).json()).toEqual({
        bun: true,
      });
    } finally {
      cli.kill();
      await cli.exited;
    }
    await until(async () => !(await answers()), 5000);
  }, 60_000);
});
