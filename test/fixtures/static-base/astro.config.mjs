import { defineConfig } from "astro/config";
import bun from "../../../dist/index.js";

export default defineConfig({
  output: "server",
  base: "/docs",
  trailingSlash: "always",
  // Every static file is read from disk.
  adapter: bun({ staticMemoryBudget: 0 }),
});
