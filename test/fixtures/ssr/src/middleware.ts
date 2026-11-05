import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  (context.locals as Record<string, unknown>).middleware = true;
  const response = await next();
  response.headers.set("X-Middleware", "ran");
  return response;
});
