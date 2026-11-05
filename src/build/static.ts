// Runs in the Astro CLI, on Node or Bun: node:* only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  COMPRESSED_DIR,
  type Encoding,
  hashOf,
  listFiles,
  STATIC_MANIFEST,
  type StaticFile,
  type StaticManifest,
  SUFFIX,
} from "../static-files.js";

// Text formats that compress well; images, woff2, and video are compressed already.
const COMPRESSIBLE =
  /\.(?:html?|css|[cm]?js|json|map|svg|xml|txt|md|csv|webmanifest|wasm|ttf|otf|eot)$/i;
// Below this a compressed copy saves less than a packet.
const MIN_SIZE = 512;
// A copy is kept only when it is at most this share of the file.
const MAX_RATIO = 0.9;
// Files compressed at once; zlib runs each on libuv's thread pool.
const CONCURRENCY = 8;

const brotli = promisify(zlib.brotliCompress);
const zstd = promisify(zlib.zstdCompress);
const gzip = promisify(zlib.gzip);

// Each at its highest level: a file is compressed once, at build time.
const COMPRESS: Record<Encoding, (data: Buffer) => Promise<Buffer>> = {
  br: (data) =>
    brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]:
          zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  zstd: (data) =>
    zstd(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }),
  gzip: (data) => gzip(data, { level: zlib.constants.Z_BEST_COMPRESSION }),
};

export interface StaticBuild {
  client: URL;
  server: URL;
  /** `build.assets`: the directory of hashed files. */
  assets: string;
  precompress: boolean;
}

/** Hashes the client files, compresses the text ones into the server directory, and writes the manifest the server reads at startup. */
export async function writeStaticManifest(
  build: StaticBuild,
): Promise<StaticManifest> {
  const client = fileURLToPath(build.client);
  const server = fileURLToPath(build.server);
  const paths = await listFiles(client);
  const files: StaticFile[] = [];
  let next = 0;
  const work = async () => {
    while (next < paths.length) {
      const index = next++;
      const path = paths[index]!;
      const data = await readFile(join(client, path));
      files[index] = {
        path,
        size: data.length,
        hash: hashOf(data),
        immutable: path.startsWith(`${build.assets}/`),
        encodings: build.precompress
          ? await compress(data, path, join(server, COMPRESSED_DIR, path))
          : {},
      };
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  const manifest: StaticManifest = { files };
  await writeFile(join(server, STATIC_MANIFEST), JSON.stringify(manifest));
  return manifest;
}

/** Writes each encoding worth keeping beside `target`, and returns their sizes. */
async function compress(
  data: Buffer,
  path: string,
  target: string,
): Promise<Partial<Record<Encoding, number>>> {
  if (data.length < MIN_SIZE || !COMPRESSIBLE.test(path)) return {};
  const kept: Partial<Record<Encoding, number>> = {};
  await Promise.all(
    (Object.keys(COMPRESS) as Encoding[]).map(async (encoding) => {
      const compressed = await COMPRESS[encoding](data);
      if (compressed.length > data.length * MAX_RATIO) return;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target + SUFFIX[encoding], compressed);
      kept[encoding] = compressed.length;
    }),
  );
  return kept;
}
