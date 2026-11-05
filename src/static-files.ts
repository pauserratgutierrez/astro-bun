// What the build and the server share about the client files. The build runs on Node or Bun: node:* only.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AstroConfig } from "astro";

/** The file the build writes into the server directory, read by the server at startup. */
export const STATIC_MANIFEST = "static-manifest.json";

/** The directory, inside the server directory, that holds the compressed copies of the client files. */
export const COMPRESSED_DIR = "compressed";

export type Encoding = "br" | "zstd" | "gzip";

/** The file name suffix of each encoding's copy. */
export const SUFFIX: Record<Encoding, string> = {
  br: ".br",
  zstd: ".zst",
  gzip: ".gz",
};

export interface StaticFile {
  /** Its path in the client directory, with `/` separators. */
  path: string;
  size: number;
  /** A hash of its bytes, the base of its ETags. */
  hash: string;
  /** Under the hashed assets directory: cached for a year. */
  immutable: boolean;
  /** The size of each compressed copy kept. */
  encodings: Partial<Record<Encoding, number>>;
}

export interface StaticManifest {
  files: StaticFile[];
}

/** A URL path, decoded and with the base, answered by a file (its index in the list) or by a redirect. */
export type StaticRoute =
  { url: string; file: number } | { url: string; redirect: string };

export function hashOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("base64url").slice(0, 16);
}

/** The client files by their path there, with `/` separators. Dotfiles are left out, except under `.well-known/`. */
export async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    .filter(
      (path) =>
        !path
          .split("/")
          .some(
            (segment, i) =>
              segment.startsWith(".") &&
              !(i === 0 && segment === ".well-known"),
          ),
    )
    .sort();
}

/**
 * The URL paths the files answer: each file at its own path, and each page also at its clean URL, with the other form of its trailing slash redirected (or answered too, for `ignore`), as `trailingSlash` and `build.format` say.
 * A file's own path wins over a page's clean URL, and both over a redirect.
 */
export function routesFor(
  paths: readonly string[],
  base: string,
  trailingSlash: AstroConfig["trailingSlash"],
  format: AstroConfig["build"]["format"],
): StaticRoute[] {
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  const routes = new Map<string, StaticRoute>();
  const add = (route: StaticRoute) => {
    if (!routes.has(route.url)) routes.set(route.url, route);
  };
  paths.forEach((path, file) => add({ url: `${prefix}/${path}`, file }));
  paths.forEach((path, file) => {
    // The page's URL without a trailing slash: `/about` for about/index.html, or for about.html in the file and preserve formats.
    let page: string;
    if (path === "index.html" || path.endsWith("/index.html"))
      page = `${prefix}/${path.slice(0, -"/index.html".length)}`.replace(
        /\/$/,
        "",
      );
    else if (format !== "directory" && path.endsWith(".html"))
      page = `${prefix}/${path.slice(0, -".html".length)}`;
    else return;
    if (page === "") return add({ url: "/", file });
    const slashed = `${page}/`;
    if (trailingSlash === "always") {
      add({ url: slashed, file });
      add({ url: page, redirect: slashed });
    } else if (trailingSlash === "never") {
      add({ url: page, file });
      add({ url: slashed, redirect: page });
    } else {
      add({ url: page, file });
      add({ url: slashed, file });
    }
  });
  return [...routes.values()];
}
