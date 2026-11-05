declare module "virtual:astro-bun:config" {
  /** What the integration hands the server at build time. */
  const config: {
    /** The client directory, relative to the server directory, with a trailing slash. */
    client: string;
    /** `server.host` from the Astro config: a name, `true` for every interface, `false` for localhost. */
    host: string | boolean;
    /** `server.port` from the Astro config. */
    port: number;
    idleTimeout: number;
    /** Absent for Bun's default. */
    maxRequestBodySize?: number;
    shutdownTimeout: number;
    streaming: boolean;
  };
  export default config;
}
