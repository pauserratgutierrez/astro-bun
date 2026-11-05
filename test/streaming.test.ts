import { afterAll, beforeAll, expect, test } from "bun:test";
import { build, start, type Running } from "./helpers.js";

let server: Running;

beforeAll(async () => {
  server = await start(await build("midstream"));
}, 120_000);

afterAll(() => server.stop());

test("a page that fails after it started streaming ends the connection unfinished, so no client or cache takes it for whole", async () => {
  const response = await fetch(`${server.origin}/`);
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow();
});

test("the server keeps answering after a page failed mid-stream", async () => {
  await fetch(`${server.origin}/`).then((response) =>
    response.text().catch(() => {}),
  );
  const response = await fetch(`${server.origin}/missing`);
  expect(response.status).toBe(404);
});
