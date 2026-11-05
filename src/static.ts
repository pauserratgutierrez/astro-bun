import { join } from "node:path";
import type { AstroConfig } from "astro";
import {
  COMPRESSED_DIR,
  type Encoding,
  hashOf,
  listFiles,
  routesFor,
  STATIC_MANIFEST,
  type StaticFile,
  type StaticManifest,
  SUFFIX,
} from "./static-files.js";

type Serve = (request: Request) => Response;

/** A `Bun.serve` route that answers GET (and HEAD from it) and leaves every other method to `fetch`. */
export type StaticRoute = { GET: Response | Serve };

export interface StaticFiles {
  /** For `Bun.serve`'s `routes`, by each path as a browser writes it. */
  routes: Record<string, StaticRoute>;
  /** The answer for a decoded path the routes did not match as written: another percent-encoding, or a name `routes` cannot hold. */
  find(pathname: string): Serve | undefined;
  /** A prerendered 404 or 500 page, as Astro asks for it: the page alone, unencoded. */
  errorPage(status: "404" | "500"): Response | undefined;
  /** Files on disk the build's manifest did not list, written after it: served, uncompressed. */
  unlisted: number;
}

/** What decides a file's URLs and caching, from the app's manifest. */
export interface Site {
  base: string;
  trailingSlash: AstroConfig["trailingSlash"];
  format: AstroConfig["build"]["format"];
  /** `build.assets`: the directory of hashed files. */
  assets: string;
}

// Hashed build files never change at their URL; any other file is checked against its ETag on each use.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/**
 * Prepares a route for each file in the client directory: the smallest files first into memory, within `budget` bytes counting their compressed copies, the rest from disk.
 * The files on disk are the ones served. The build's manifest gives their hashes and compressed copies; a file it does not list, written by a later integration or after the build, is hashed here and served as it is.
 */
export async function loadStatic(
  clientDir: string,
  serverDir: string,
  budget: number,
  site: Site,
): Promise<StaticFiles> {
  const manifestFile = Bun.file(join(serverDir, STATIC_MANIFEST));
  const manifest: StaticManifest = (await manifestFile.exists())
    ? await manifestFile.json()
    : { files: [] };
  const known = new Map(manifest.files.map((file) => [file.path, file]));
  const paths = await listFiles(clientDir);
  let unlisted = 0;
  const files = await Promise.all(
    paths.map(async (path): Promise<StaticFile> => {
      const file = known.get(path);
      if (file !== undefined) return file;
      unlisted++;
      const data = await Bun.file(join(clientDir, path)).bytes();
      return {
        path,
        size: data.length,
        hash: hashOf(data),
        immutable: path.startsWith(`${site.assets}/`),
        encodings: {},
      };
    }),
  );
  const routes = routesFor(paths, site.base, site.trailingSlash, site.format);
  const weight = (file: StaticFile) =>
    Object.values(file.encodings).reduce((sum, size) => sum + size, file.size);
  const inMemory = new Set<StaticFile>();
  let used = 0;
  for (const file of [...files].sort((a, b) => weight(a) - weight(b))) {
    if (used + weight(file) > budget) break;
    used += weight(file);
    inMemory.add(file);
  }
  const prepared = await Promise.all(
    files.map((file) =>
      prepare(file, clientDir, serverDir, inMemory.has(file)),
    ),
  );
  const byKey: Record<string, StaticRoute> = {};
  const byPath = new Map<string, Serve>();
  for (const route of routes) {
    const serve =
      "file" in route ? prepared[route.file]!.serve : redirect(route.redirect);
    byPath.set(route.url, serve);
    const key = routeKey(route.url);
    if (key !== undefined)
      byKey[key] = {
        GET: "file" in route ? prepared[route.file]!.route : serve,
      };
  }
  const byFile = new Map(files.map((file, i) => [file.path, prepared[i]!]));
  return {
    routes: byKey,
    find(pathname) {
      if (!pathname.includes("%")) return byPath.get(pathname);
      try {
        return byPath.get(decodeURIComponent(pathname));
      } catch {
        return undefined;
      }
    },
    errorPage: (status) =>
      (
        byFile.get(`${status}.html`) ?? byFile.get(`${status}/index.html`)
      )?.plain(),
    unlisted,
  };
}

interface Variant {
  encoding: Encoding | undefined;
  size: number;
  etag: string;
  headers: Record<string, string>;
  body(): Uint8Array | Blob;
}

async function prepare(
  file: StaticFile,
  clientDir: string,
  serverDir: string,
  inMemory: boolean,
) {
  const type = Bun.file(file.path).type;
  const sources: [Encoding | undefined, string, number][] = [
    [undefined, join(clientDir, file.path), file.size],
    ...(Object.entries(file.encodings) as [Encoding, number][]).map(
      ([encoding, size]): [Encoding, string, number] => [
        encoding,
        join(serverDir, COMPRESSED_DIR, file.path + SUFFIX[encoding]),
        size,
      ],
    ),
  ];
  const variants = await Promise.all(
    sources.map(async ([encoding, path, size]): Promise<Variant> => {
      const bytes = inMemory ? await Bun.file(path).bytes() : undefined;
      const etag = `"${file.hash}${encoding === undefined ? "" : `-${encoding}`}"`;
      const headers: Record<string, string> = {
        "Content-Type": type,
        "Cache-Control": file.immutable ? IMMUTABLE : REVALIDATE,
        ETag: etag,
      };
      if (sources.length > 1) headers.Vary = "Accept-Encoding";
      if (encoding !== undefined) headers["Content-Encoding"] = encoding;
      return {
        encoding,
        size,
        etag,
        headers,
        body: bytes === undefined ? () => Bun.file(path) : () => bytes,
      };
    }),
  );
  const identity = variants[0]!;
  const serve: Serve = (request) => {
    // A range is of the file itself, never of a compressed copy.
    const variant = request.headers.has("range")
      ? identity
      : choose(request.headers.get("accept-encoding"), variants);
    const tags = request.headers.get("if-none-match");
    if (tags !== null && etagMatches(tags, variant.etag))
      return new Response(null, { status: 304, headers: variant.headers });
    return new Response(variant.body(), { headers: variant.headers });
  };
  return {
    serve,
    // A file in memory with nothing to choose is a static response: Bun answers it, its 304, and HEAD without running JavaScript.
    route:
      variants.length === 1 && inMemory
        ? new Response(identity.body(), { headers: identity.headers })
        : serve,
    plain: () =>
      new Response(identity.body(), { headers: { "Content-Type": type } }),
  };
}

function redirect(location: string): Serve {
  return (request) => {
    const query = request.url.indexOf("?");
    return new Response(null, {
      status: 301,
      headers: {
        Location: query === -1 ? location : location + request.url.slice(query),
      },
    });
  };
}

/** The variant to send: the smallest compressed copy the client accepts, else the file itself. */
export function choose<
  T extends { encoding: Encoding | undefined; size: number },
>(acceptEncoding: string | null, variants: readonly T[]): T {
  let best = variants[0]!;
  if (acceptEncoding === null || variants.length === 1) return best;
  const accepts = acceptance(acceptEncoding);
  for (const variant of variants)
    if (
      variant.encoding !== undefined &&
      variant.size < best.size &&
      accepts(variant.encoding)
    )
      best = variant;
  return best;
}

/** Whether an Accept-Encoding header takes an encoding: listed (or `*`) with a q-value above 0. */
function acceptance(header: string): (encoding: Encoding) => boolean {
  const weights = new Map<string, number>();
  for (const part of header.toLowerCase().split(",")) {
    const [name = "", ...parameters] = part
      .split(";")
      .map((piece) => piece.trim());
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    weights.set(name, q === undefined ? 1 : Number(q.slice(2)) || 0);
  }
  const any = weights.get("*") ?? 0;
  return (encoding) => (weights.get(encoding) ?? any) > 0;
}

/** Whether If-None-Match names the tag: `*`, or an entry equal to it with any `W/` ignored. */
export function etagMatches(header: string, etag: string): boolean {
  for (const entry of header.split(",")) {
    const tag = entry.trim();
    if (tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag)
      return true;
  }
  return false;
}

/**
 * The `routes` key for a decoded URL path: each segment percent-encoded as a browser sends it. None for a path Bun would read as a pattern: a segment that starts with `:` is a parameter and `*` a wildcard, so that file is answered through `find`.
 */
export function routeKey(url: string): string | undefined {
  const key = url
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /%(?:24|26|2B|2C|3A|3B|3D|40|5B|5D|5E|7C)/g,
        decodeURIComponent,
      ),
    )
    .join("/");
  return key.includes("*") || key.includes("/:") ? undefined : key;
}
