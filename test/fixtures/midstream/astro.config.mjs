import { defineConfig, logHandlers } from "astro/config";
import bun from "../../../dist/index.js";
export default defineConfig({
  output: "server",
  adapter: bun(),
  logger: logHandlers.json(),
});
