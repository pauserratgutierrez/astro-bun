import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request, url }) =>
  Response.json({
    url: url.href,
    method: request.method,
    length: (await request.arrayBuffer()).byteLength,
  });
