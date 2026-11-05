import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build, raw, start, type Running } from "./helpers.js";

let server: Running;

beforeAll(async () => {
  server = await start(await build("ssr"), {
    FIXTURE_SECRET: "from-the-environment",
  });
}, 120_000);

afterAll(() => server.stop());

interface Info {
  url: string;
  clientAddress: string;
  secret: string | null;
  middleware: boolean;
}

const info = async (headers: Record<string, string> = {}): Promise<Info> =>
  (await fetch(`${server.origin}/info`, { headers })).json() as Promise<Info>;

describe("rendering", () => {
  test("streams a page through the middleware", async () => {
    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("x-middleware")).toBe("ran");
    const html = await response.text();
    expect(html).toContain("Rendered on Bun");
    expect(html).toContain("streamed part");
  });

  test("gives endpoints the middleware's locals and the runtime's secrets", async () => {
    const body = await info();
    expect(body.middleware).toBe(true);
    expect(body.secret).toBe("from-the-environment");
  });

  test("passes the request body through", async () => {
    const body = new Uint8Array(1_000_000).fill(7);
    const response = await fetch(`${server.origin}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    expect(await response.json()).toMatchObject({
      method: "POST",
      length: body.byteLength,
    });
  });

  test("sends each cookie in its own Set-Cookie header", async () => {
    const response = await fetch(`${server.origin}/cookies`);
    expect(response.headers.getSetCookie()).toEqual([
      "first=1; Path=/",
      "second=2; Path=/",
    ]);
  });

  test("answers a thrown error with a 500 that shows nothing internal", async () => {
    const response = await fetch(`${server.origin}/throw`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("boom");
    expect(body).not.toContain("/internal/secret/path");
    expect(body).not.toMatch(/\bat \S+:\d+/);
  });

  test("transforms an image with Sharp through the image endpoint", async () => {
    const html = await (await fetch(`${server.origin}/image`)).text();
    const src = /<img[^>]+src="([^"]+)"/
      .exec(html)?.[1]
      ?.replaceAll("&#38;", "&")
      .replaceAll("&amp;", "&");
    expect(src).toStartWith("/_image?");
    const response = await fetch(`${server.origin}${src}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    // The PNG came back as WebP: Sharp ran on Bun.
    const bytes = await response.bytes();
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...bytes.subarray(start, end));
    expect([ascii(0, 4), ascii(8, 12)]).toEqual(["RIFF", "WEBP"]);
  });

  test("answers an unknown path with the prerendered 404 page", async () => {
    const response = await fetch(`${server.origin}/nowhere`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Prerendered not-found page");
  });
});

describe("host and client address", () => {
  test("keeps the URL of an allowed host, with the forwarded protocol", async () => {
    const body = await info({
      Host: "app.example",
      "X-Forwarded-Proto": "https",
    });
    expect(body.url).toBe("https://app.example/info");
  });

  test("puts any other host on localhost at the server's port", async () => {
    expect((await info()).url).toBe(`http://localhost:${server.port}/info`);
    expect((await info({ Host: "evil.example" })).url).toBe(
      `http://localhost:${server.port}/info`,
    );
  });

  test("puts a host Bun cannot build a URL from on localhost, keeping the path and query", async () => {
    for (const host of [
      "evil.example/x",
      "user@app.example",
      "app.example\\x",
      "app.example:99999",
      "a:1:2",
    ]) {
      const answer = await raw(
        server.port,
        `GET /info?q=1 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
      expect(answer.status, host).toBe(200);
      expect((JSON.parse(answer.body) as Info).url, host).toBe(
        `http://localhost:${server.port}/info?q=1`,
      );
    }
    const noHost = await raw(server.port, "GET /info HTTP/1.0\r\n\r\n");
    expect((JSON.parse(noHost.body) as Info).url).toBe(
      `http://localhost:${server.port}/info`,
    );
  });

  test("passes the body through when the request moves to localhost", async () => {
    const response = await fetch(`${server.origin}/echo`, {
      method: "POST",
      headers: {
        Host: "evil.example",
        "Content-Type": "application/octet-stream",
      },
      body: "12345",
    });
    expect(await response.json()).toMatchObject({
      url: `http://localhost:${server.port}/echo`,
      length: 5,
    });
  });

  test("reads the client from X-Forwarded-For only behind an allowed host", async () => {
    const forwarded = {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "203.0.113.7, 10.0.0.1",
    };
    expect(
      (await info({ Host: "app.example", ...forwarded })).clientAddress,
    ).toBe("203.0.113.7");
    expect(
      (await info({ Host: "evil.example", ...forwarded })).clientAddress,
    ).toBe("127.0.0.1");
    expect((await info()).clientAddress).toBe("127.0.0.1");
  });

  test("matches the allowed domain's protocol: plain http does not match an https domain", async () => {
    const body = await info({
      Host: "app.example",
      "X-Forwarded-For": "203.0.113.7",
    });
    expect(body.url).toBe(`http://localhost:${server.port}/info`);
    expect(body.clientAddress).toBe("127.0.0.1");
  });

  test("trusts an allowed X-Forwarded-Host for the client address", async () => {
    const body = await info({
      "X-Forwarded-Host": "app.example",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "198.51.100.9",
    });
    expect(body.clientAddress).toBe("198.51.100.9");
    expect(body.url).toBe("https://app.example/info");
  });
});
