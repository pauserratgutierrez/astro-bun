import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import type { StaticManifest } from "../src/static-files.js";
import { build, raw, start, type Running } from "./helpers.js";

let site: Running;
let based: Running;
let fileFormat: Running;
let root: string;
let manifest: StaticManifest;

beforeAll(async () => {
  const roots = await Promise.all([
    build("static"),
    build("static-base"),
    build("static-file"),
  ]);
  root = roots[0];
  manifest = await Bun.file(
    join(root, "dist/server/static-manifest.json"),
  ).json();
  // As a deploy step that copies a file into the build would.
  await Bun.write(
    join(root, "dist/client/post-build.txt"),
    "Copied in after the build.\n",
  );
  [site, based, fileFormat] = await Promise.all([
    start(roots[0]),
    start(roots[1]),
    start(roots[2]),
  ]);
}, 180_000);

afterAll(() =>
  Promise.all([site, based, fileFormat].map((server) => server.stop())),
);

/** A request whose answer is read as sent: no redirect followed, no body decompressed. */
const get = (
  server: Running,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) =>
  fetch(server.origin + path, {
    method,
    headers,
    redirect: "manual",
    decompress: false,
  });

// A response's bytes sit on a plain ArrayBuffer; Bun's decompressors are typed for exactly that.
const DECODE = {
  br: (bytes: Uint8Array) => new Uint8Array(brotliDecompressSync(bytes)),
  zstd: (bytes: Uint8Array) =>
    Bun.zstdDecompressSync(bytes as Uint8Array<ArrayBuffer>),
  gzip: (bytes: Uint8Array) => Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>),
};

describe("a hashed build file", () => {
  const script = () =>
    manifest.files.find(
      (file) =>
        /^_astro\/.+\.js$/.test(file.path) &&
        Object.keys(file.encodings).length === 3,
    )!;
  const original = () =>
    Bun.file(join(root, "dist/client", script().path)).bytes();

  test("is cached for a year, and sent as it is to a client that takes no encoding", async () => {
    const response = await get(site, `/${script().path}`, {
      "Accept-Encoding": "identity",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("content-type")).toStartWith("text/javascript");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("etag")).toBe(`"${script().hash}"`);
    expect(await response.bytes()).toEqual(await original());
  });

  test("is sent in each encoding a client accepts, the smallest when it accepts several", async () => {
    for (const encoding of ["br", "zstd", "gzip"] as const) {
      const response = await get(site, `/${script().path}`, {
        "Accept-Encoding": encoding,
      });
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("etag")).toBe(
        `"${script().hash}-${encoding}"`,
      );
      expect(DECODE[encoding](await response.bytes())).toEqual(
        await original(),
      );
    }
    const sizes = Object.entries(script().encodings).sort(
      (a, b) => a[1] - b[1],
    );
    const all = await get(site, `/${script().path}`, {
      "Accept-Encoding": "gzip, deflate, br, zstd",
    });
    expect(all.headers.get("content-encoding")).toBe(sizes[0]![0]);
    const refused = await get(site, `/${script().path}`, {
      "Accept-Encoding": "br;q=0, gzip",
    });
    expect(refused.headers.get("content-encoding")).toBe("gzip");
  });

  test("answers 304 to the ETag of the copy it would send, and HEAD with no body", async () => {
    const tag = `"${script().hash}-gzip"`;
    const unchanged = await get(site, `/${script().path}`, {
      "Accept-Encoding": "gzip",
      "If-None-Match": tag,
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    const head = await get(
      site,
      `/${script().path}`,
      { "Accept-Encoding": "gzip" },
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(script().encodings.gzip),
    );
    expect(await head.text()).toBe("");
  });
});

describe("public files", () => {
  test("a small one is a static response that revalidates", async () => {
    const response = await get(site, "/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("User-agent: *\nAllow: /\n");
    const unchanged = await get(site, "/robots.txt", {
      "If-None-Match": response.headers.get("etag")!,
    });
    expect(unchanged.status).toBe(304);
  });

  test("a method other than GET and HEAD goes to Astro", async () => {
    const response = await get(
      site,
      "/robots.txt",
      { "Content-Type": "application/octet-stream" },
      "POST",
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("User-agent");
  });

  test("names with characters a browser encodes, or may encode another way", async () => {
    for (const [path, body] of [
      ["/caf%C3%A9.txt", "cafe with an accent\n"],
      ["/caf%c3%a9.txt", "cafe with an accent\n"],
      ["/space%20name.txt", "a name with a space\n"],
      ["/100%25.txt", "a percent sign in the name\n"],
    ]) {
      const response = await get(site, path!);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(body!);
    }
    for (const path of ["/logo@2x.png", "/logo%402x.png"]) {
      const response = await get(site, path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
    }
  });

  test(".well-known is served and other dotfiles are not", async () => {
    expect((await get(site, "/.well-known/security.txt")).status).toBe(200);
    const hidden = await get(site, "/.hidden");
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("never served");
    expect(manifest.files.some((file) => file.path.includes(".hidden"))).toBe(
      false,
    );
  });

  test("no path reaches a file outside the build's list", async () => {
    for (const path of [
      "/../astro.config.mjs",
      "/..%2F..%2Fastro.config.mjs",
      "/%2e%2e/%2e%2e/astro.config.mjs",
      "/..%5C..%5Castro.config.mjs",
      "/_astro/..%2F..%2Fserver%2Fentry.mjs",
      "/server/entry.mjs",
      "/robots.txt%00.png",
    ]) {
      const answer = await raw(
        site.port,
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
      );
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain("defineConfig");
      expect(answer.body, path).not.toContain("createApp");
    }
  });

  test("text files have their compressed copies written beside the server, not among the client files", () => {
    const notes = manifest.files.find((file) => file.path === "notes.txt")!;
    expect(Object.keys(notes.encodings).sort()).toEqual(["br", "gzip", "zstd"]);
    expect(existsSync(join(root, "dist/server/compressed/notes.txt.br"))).toBe(
      true,
    );
    expect(existsSync(join(root, "dist/client/notes.txt.br"))).toBe(false);
  });
});

describe("files written after Astro's own build", () => {
  test("a file another integration writes when the build is done is listed and compressed", async () => {
    const late = manifest.files.find((file) => file.path === "late.txt")!;
    expect(Object.keys(late.encodings).sort()).toEqual(["br", "gzip", "zstd"]);
    const response = await get(site, "/late.txt", { "Accept-Encoding": "br" });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(
      new TextDecoder().decode(DECODE.br(await response.bytes())),
    ).toStartWith("Written by another integration");
  });

  test("a file copied in after the build is served as it is, and the startup says so", async () => {
    const response = await get(site, "/post-build.txt", {
      "Accept-Encoding": "br",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("Copied in after the build.\n");
    expect(site.log()).toContain("sent uncompressed: 1");
  });
});

describe("pages", () => {
  test("a prerendered page answers with and without its trailing slash", async () => {
    for (const path of ["/about", "/about/"]) {
      const response = await get(site, path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain("Prerendered about page");
    }
  });

  test("an on-demand page still renders", async () => {
    expect(await (await get(site, "/")).text()).toContain("On demand");
  });

  test("a redirect from the config is answered", async () => {
    const response = await get(site, "/old");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/about");
  });

  test("an unknown path gets the prerendered 404 page", async () => {
    const response = await get(site, "/nowhere");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Prerendered not-found page");
  });
});

describe("base, trailingSlash always, and files read from disk", () => {
  test("pages answer under the base with their slash, and the bare URL redirects keeping the query", async () => {
    expect(await (await get(based, "/docs/about/")).text()).toContain(
      "Prerendered about page",
    );
    expect(await (await get(based, "/docs/")).text()).toContain(
      "Prerendered index page",
    );
    const bare = await get(based, "/docs/about?x=1");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe("/docs/about/?x=1");
    expect((await get(based, "/docs")).headers.get("location")).toBe("/docs/");
    expect(await (await get(based, "/about/")).text()).not.toContain(
      "Prerendered about page",
    );
  });

  test("a file on disk is sent compressed, as a range, and answers 304", async () => {
    const original = await Bun.file(join(root, "public/notes.txt")).bytes();
    const brotli = await get(based, "/docs/notes.txt", {
      "Accept-Encoding": "br",
    });
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect(DECODE.br(await brotli.bytes())).toEqual(original);
    const range = await get(based, "/docs/notes.txt", {
      "Accept-Encoding": "br",
      Range: "bytes=0-9",
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-encoding")).toBeNull();
    expect(await range.bytes()).toEqual(original.subarray(0, 10));
    const tag = brotli.headers.get("etag")!;
    expect(
      (
        await get(based, "/docs/notes.txt", {
          "Accept-Encoding": "br",
          "If-None-Match": tag,
        })
      ).status,
    ).toBe(304);
  });

  test("an on-demand page renders under the base", async () => {
    expect(await (await get(based, "/docs/live/")).text()).toContain(
      "Rendered on demand",
    );
  });
});

describe("file format with trailingSlash never", () => {
  test("a page answers without .html, and with it; the slashed URL redirects", async () => {
    expect(await (await get(fileFormat, "/about")).text()).toContain(
      "Prerendered about page",
    );
    expect((await get(fileFormat, "/about.html")).status).toBe(200);
    const slashed = await get(fileFormat, "/about/");
    expect(slashed.status).toBe(301);
    expect(slashed.headers.get("location")).toBe("/about");
    expect(await (await get(fileFormat, "/")).text()).toContain(
      "Prerendered index page",
    );
    expect(await (await get(fileFormat, "/live")).text()).toContain(
      "Rendered on demand",
    );
  });
});
