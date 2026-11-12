// The built server as `astro preview` runs it, on Bun: `bun preview-child.js <entry.mjs>`.
// The preview's process holds this one's stdin: when it goes away, however it ends, the pipe closes and the server ends with it.
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
// The entry's top-level code ends once Bun.serve listens, or exits the process when it cannot.
await import(pathToFileURL(process.argv[2]!).href);
// The preview reads this on the pipe it opened as fd 3.
writeSync(3, "listening\n");
