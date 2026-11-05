import type { APIRoute } from "astro";
import { FIXTURE_SECRET } from "astro:env/server";

export const GET: APIRoute = ({ url, clientAddress, locals }) =>
  Response.json({
    url: url.href,
    clientAddress,
    secret: FIXTURE_SECRET ?? null,
    middleware: (locals as Record<string, unknown>).middleware === true,
  });
