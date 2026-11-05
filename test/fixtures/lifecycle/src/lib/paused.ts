/** A body that sends one line, stays quiet for `ms`, then sends another. */
export function paused(
  ms: number,
  first: string,
  second: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(first));
      await new Promise((resolve) => setTimeout(resolve, ms));
      controller.enqueue(encoder.encode(second));
      controller.close();
    },
  });
}
