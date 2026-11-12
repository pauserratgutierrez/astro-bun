import { defineConfig, envField } from "astro/config";
import bun from "../../../dist/index.js";

export default defineConfig({
  output: "server",
  adapter: bun(),
  security: {
    allowedDomains: [
      { hostname: "app.example", protocol: "https" },
      { hostname: "port.example", protocol: "https", port: "443" },
      { hostname: "plain.example", protocol: "http" },
    ],
  },
  env: {
    schema: {
      FIXTURE_SECRET: envField.string({
        context: "server",
        access: "secret",
        optional: true,
      }),
    },
  },
});
