import type { APIRoute } from "astro";
import { paused } from "../lib/paused.ts";

// The same pause as /events, in a body that is not an event stream.
export const GET: APIRoute = () =>
  new Response(paused(6000, "first\n", "second\n"), {
    headers: { "Content-Type": "text/plain" },
  });
