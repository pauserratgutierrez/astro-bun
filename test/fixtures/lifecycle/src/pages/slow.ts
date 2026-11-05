import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ url }) => {
  const ms = Number(url.searchParams.get("ms"));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return new Response(`done after ${ms} ms`);
};
