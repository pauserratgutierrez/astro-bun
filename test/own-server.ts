// An app's own Bun.serve around the adapter's build: `bun own-server.ts <entry.mjs>`. Static routes and Astro's handler beside its own route and a WebSocket.
import { pathToFileURL } from "node:url";

process.env.ASTRO_BUN_AUTOSTART = "disabled";
const { handler, routes } = await import(pathToFileURL(process.argv[2]!).href);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
  routes: { ...routes, "/own": new Response("own route") },
  fetch(request, server) {
    if (new URL(request.url).pathname === "/socket" && server.upgrade(request))
      return;
    return handler(request, server);
  },
  websocket: {
    message(socket, message) {
      socket.send(`echo ${message}`);
    },
  },
});
console.log(`own server listening on http://127.0.0.1:${server.port}`);
