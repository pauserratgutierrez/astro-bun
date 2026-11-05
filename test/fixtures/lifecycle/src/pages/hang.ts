import type { APIRoute } from "astro";

const state = globalThis as { aborted?: number };

// Sends one line and never ends; counts the requests whose signal aborted.
export const GET: APIRoute = ({ request }) => {
  request.signal.addEventListener("abort", () => {
    state.aborted = (state.aborted ?? 0) + 1;
  });
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("waiting\n"));
      },
    }),
    { headers: { "Content-Type": "text/plain" } },
  );
};
