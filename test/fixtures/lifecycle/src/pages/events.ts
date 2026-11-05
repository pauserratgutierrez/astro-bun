import type { APIRoute } from "astro";
import { paused } from "../lib/paused.ts";

export const GET: APIRoute = () =>
  new Response(paused(6000, "data: first\n\n", "data: second\n\n"), {
    headers: { "Content-Type": "text/event-stream" },
  });
