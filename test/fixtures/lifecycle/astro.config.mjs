import { defineConfig } from "astro/config";
import bun from "../../../dist/index.js";

export default defineConfig({
  output: "server",
  // Bun counts idle time in 4-second steps: 2 cuts a connection quiet for 4 s.
  adapter: bun({
    idleTimeout: 2,
    maxRequestBodySize: 1024,
    shutdownTimeout: 1500,
  }),
});
