import { describe, expect, test } from "bun:test";
import { routesFor } from "../src/static-files.js";
import { choose, etagMatches, routeKey } from "../src/static.js";

const PATHS = ["index.html", "about/index.html", "404.html", "robots.txt"];

describe("routesFor", () => {
  test("directory format, trailing slash ignored: a page answers with and without the slash", () => {
    expect(routesFor(PATHS, "/", "ignore", "directory")).toEqual([
      { url: "/index.html", file: 0 },
      { url: "/about/index.html", file: 1 },
      { url: "/404.html", file: 2 },
      { url: "/robots.txt", file: 3 },
      { url: "/", file: 0 },
      { url: "/about", file: 1 },
      { url: "/about/", file: 1 },
    ]);
  });

  test("trailing slash always: the bare URL redirects to the slashed one", () => {
    const routes = routesFor(PATHS, "/", "always", "directory");
    expect(routes).toContainEqual({ url: "/about/", file: 1 });
    expect(routes).toContainEqual({ url: "/about", redirect: "/about/" });
    expect(routes).toContainEqual({ url: "/", file: 0 });
  });

  test("trailing slash never: the slashed URL redirects to the bare one", () => {
    const routes = routesFor(PATHS, "/", "never", "directory");
    expect(routes).toContainEqual({ url: "/about", file: 1 });
    expect(routes).toContainEqual({ url: "/about/", redirect: "/about" });
    expect(routes.filter((route) => route.url.startsWith("/404"))).toEqual([
      { url: "/404.html", file: 2 },
    ]);
  });

  test("a base prefixes every URL, its root included", () => {
    const routes = routesFor(PATHS, "/docs/", "always", "directory");
    expect(routes).toContainEqual({ url: "/docs/robots.txt", file: 3 });
    expect(routes).toContainEqual({ url: "/docs/", file: 0 });
    expect(routes).toContainEqual({ url: "/docs", redirect: "/docs/" });
    expect(routesFor(PATHS, "/docs", "never", "directory")).toContainEqual({
      url: "/docs/",
      redirect: "/docs",
    });
  });

  test("file format: a page answers without its .html", () => {
    const routes = routesFor(
      ["index.html", "about.html"],
      "/",
      "never",
      "file",
    );
    expect(routes).toContainEqual({ url: "/about.html", file: 1 });
    expect(routes).toContainEqual({ url: "/about", file: 1 });
    expect(routes).toContainEqual({ url: "/about/", redirect: "/about" });
    expect(routes).toContainEqual({ url: "/", file: 0 });
  });

  test("a file's own path wins over a page's clean URL and over a redirect", () => {
    const routes = routesFor(
      ["about", "about/index.html"],
      "/",
      "never",
      "directory",
    );
    expect(routes.filter((route) => route.url === "/about")).toEqual([
      { url: "/about", file: 0 },
    ]);
  });
});

describe("routeKey", () => {
  test("encodes each segment as a browser sends it", () => {
    expect(routeKey("/café.txt")).toBe("/caf%C3%A9.txt");
    expect(routeKey("/logo@2x.png")).toBe("/logo@2x.png");
    expect(routeKey("/space name.txt")).toBe("/space%20name.txt");
    expect(routeKey("/100%.txt")).toBe("/100%25.txt");
    expect(routeKey("/q?.txt")).toBe("/q%3F.txt");
    expect(routeKey("/a:b,c=d;e+f.txt")).toBe("/a:b,c=d;e+f.txt");
  });

  test("leaves out a path Bun would read as a pattern", () => {
    expect(routeKey("/:lead.txt")).toBeUndefined();
    expect(routeKey("/a/:id")).toBeUndefined();
    expect(routeKey("/x*y.txt")).toBeUndefined();
  });
});

describe("choose", () => {
  const variants = [
    { encoding: undefined, size: 1000 },
    { encoding: "br", size: 300 },
    { encoding: "zstd", size: 320 },
    { encoding: "gzip", size: 400 },
  ] as const;
  const pick = (header: string | null) => choose(header, variants).encoding;

  test("the smallest copy the client accepts, else the file", () => {
    expect(pick(null)).toBeUndefined();
    expect(pick("identity")).toBeUndefined();
    expect(pick("gzip, deflate, br, zstd")).toBe("br");
    expect(pick("gzip, zstd")).toBe("zstd");
    expect(pick("GZIP")).toBe("gzip");
  });

  test("q=0 refuses an encoding, and * takes the rest", () => {
    expect(pick("br;q=0, gzip")).toBe("gzip");
    expect(pick("*")).toBe("br");
    expect(pick("*, br;q=0")).toBe("zstd");
    expect(pick("br;q=0.5")).toBe("br");
  });
});

test("etagMatches compares weakly, in a list, and takes *", () => {
  expect(etagMatches('"a"', '"a"')).toBe(true);
  expect(etagMatches('W/"a"', '"a"')).toBe(true);
  expect(etagMatches('"b", "a"', '"a"')).toBe(true);
  expect(etagMatches("*", '"a"')).toBe(true);
  expect(etagMatches('"a-br"', '"a"')).toBe(false);
});
