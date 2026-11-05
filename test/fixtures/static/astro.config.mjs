import { writeFile } from "node:fs/promises";
import { defineConfig } from "astro/config";
import bun from "../../../dist/index.js";

export default defineConfig({
  output: "server",
  adapter: bun(),
  redirects: { "/old": "/about" },
  integrations: [
    {
      // As a sitemap or a search index does: a file written once the build is done.
      name: "late-file",
      hooks: {
        "astro:build:done": ({ dir }) =>
          writeFile(
            new URL("late.txt", dir),
            "Written by another integration once the build was done.\n".repeat(
              20,
            ),
          ),
      },
    },
  ],
});
