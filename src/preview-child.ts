// The built server as `astro preview` runs it, on Bun: `bun preview-child.js <entry.mjs>`.
// The preview's process holds this one's stdin: when it goes away, however it ends, the pipe closes and the server ends with it.
import { pathToFileURL } from "node:url";

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
await import(pathToFileURL(process.argv[2]!).href);
