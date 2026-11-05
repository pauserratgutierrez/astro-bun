import type { APIRoute } from "astro";

export const GET: APIRoute = () =>
  new Response(String((globalThis as { aborted?: number }).aborted ?? 0));
