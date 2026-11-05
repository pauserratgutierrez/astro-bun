import type { APIRoute } from "astro";

export const GET: APIRoute = ({ cookies }) => {
  cookies.set("first", "1", { path: "/" });
  cookies.set("second", "2", { path: "/" });
  return new Response("ok");
};
