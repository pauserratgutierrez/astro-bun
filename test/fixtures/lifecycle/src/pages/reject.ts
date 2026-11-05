import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  // A promise nothing handles.
  void Promise.reject(new Error("rejected on purpose"));
  return new Response("answered");
};
