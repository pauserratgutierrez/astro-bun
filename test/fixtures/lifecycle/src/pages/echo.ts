import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) =>
  new Response(String((await request.arrayBuffer()).byteLength));
