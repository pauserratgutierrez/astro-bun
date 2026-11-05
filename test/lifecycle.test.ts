import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build, launch, type Running, start, until } from "./helpers.js";

// Signals reach a process's handlers on Linux and macOS; on Windows a kill ends the process at once.
const signals = process.platform !== "win32";

let root: string;
let server: Running;

beforeAll(async () => {
  root = await build("lifecycle");
  server = await start(root);
}, 120_000);

afterAll(() => server.stop());

/** The whole body, or `cut` when the connection ends first. */
const read = (url: string) =>
  fetch(url)
    .then((response) => response.text())
    .catch(() => "cut");

describe("timeouts and limits", () => {
  test("an event stream quiet past the idle timeout stays open; any other body is cut", async () => {
    const [events, quiet] = await Promise.all([
      read(`${server.origin}/events`),
      read(`${server.origin}/quiet`),
    ]);
    expect(events).toBe("data: first\n\ndata: second\n\n");
    expect(quiet).toBe("cut");
  }, 15_000);

  test("a body over maxRequestBodySize gets 413 before the app runs", async () => {
    const post = (size: number) =>
      fetch(`${server.origin}/echo`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(size),
      });
    const small = await post(1024);
    expect(await small.text()).toBe("1024");
    expect((await post(1025)).status).toBe(413);
  });
});

describe("requests and errors", () => {
  test("a client that leaves aborts its request's signal, and that is not logged as an error", async () => {
    const before = await (await fetch(`${server.origin}/aborted`)).text();
    const leaving = new AbortController();
    const response = await fetch(`${server.origin}/hang`, {
      signal: leaving.signal,
    });
    await response.body!.getReader().read();
    leaving.abort();
    await until(
      async () =>
        (await (await fetch(`${server.origin}/aborted`)).text()) ===
        String(Number(before) + 1),
    );
    expect(server.log()).not.toContain("Could not render");
  });

  test("an unhandled rejection is logged, and the server keeps answering", async () => {
    expect(await (await fetch(`${server.origin}/reject`)).text()).toBe(
      "answered",
    );
    await until(() => server.log().includes("rejected on purpose"));
    expect(server.log()).toContain("Unhandled rejection");
    expect(await read(`${server.origin}/slow?ms=0`)).toBe("done after 0 ms");
  });

  test("sessions work with no driver configured, kept under the server's working directory", async () => {
    const first = await fetch(`${server.origin}/visits`);
    expect(await first.text()).toBe("1");
    const cookie = first.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const second = await fetch(`${server.origin}/visits`, {
      headers: { Cookie: cookie },
    });
    expect(await second.text()).toBe("2");
    expect(existsSync(join(root, "node_modules/.astro/sessions"))).toBe(true);
  });

  test("page modules load at startup, before the server listens", () => {
    const log = server.log();
    expect(log).toContain("page module loaded");
    expect(log.indexOf("page module loaded")).toBeLessThan(
      log.indexOf("listening on"),
    );
  });
});

describe("startup and shutdown", () => {
  test("a server whose port is taken exits 1 and says why", async () => {
    const second = launch(root, { PORT: String(server.port) });
    expect(await second.exited).toBe(1);
    expect(second.log()).toContain("Could not listen");
  });

  test.skipIf(!signals)(
    "SIGTERM lets a response in flight finish, then exits 0",
    async () => {
      const draining = await start(root);
      const response = read(`${draining.origin}/slow?ms=700`);
      await Bun.sleep(150);
      draining.signal("SIGTERM");
      expect(await response).toBe("done after 700 ms");
      expect(await draining.exited).toBe(0);
    },
  );

  test.skipIf(!signals)(
    "a response slower than shutdownTimeout is cut, and the process still exits",
    async () => {
      const draining = await start(root);
      const response = read(`${draining.origin}/slow?ms=5000`);
      await Bun.sleep(150);
      const signalled = Date.now();
      draining.signal("SIGTERM");
      expect(await response).toBe("cut");
      expect(await draining.exited).toBe(0);
      expect(Date.now() - signalled).toBeLessThan(4000);
    },
    10_000,
  );

  test.skipIf(!signals)("a second signal exits at once, with 1", async () => {
    const draining = await start(root);
    void read(`${draining.origin}/slow?ms=5000`);
    await Bun.sleep(150);
    draining.signal("SIGTERM");
    await Bun.sleep(100);
    draining.signal("SIGTERM");
    expect(await draining.exited).toBe(1);
  });
});
