import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ session }) => {
  const visits = ((await session?.get("visits")) ?? 0) + 1;
  session?.set("visits", visits);
  return new Response(String(visits));
};
