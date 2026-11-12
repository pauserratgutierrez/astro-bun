import { afterAll, beforeAll, expect, test } from "bun:test";
import { build, start, until, type Running } from "./helpers.js";

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

test("a page that fails mid-stream is logged once, as one error record of the configured logger", async () => {
  const records = () =>
    server
      .log()
      .split("\n")
      .filter((line) =>
        line.includes("upstream failed after the head was sent"),
      );
  const before = records().length;
  await fetch(`${server.origin}/`).then((response) =>
    response.text().catch(() => {}),
  );
  await until(() => records().length > before);
  // A request after it, so a second report would have arrived.
  await fetch(`${server.origin}/missing`);
  const added = records().slice(before);
  expect(added).toHaveLength(1);
  expect(JSON.parse(added[0]!)).toMatchObject({ level: "error" });
});

test("the server keeps answering after a page failed mid-stream", async () => {
  await fetch(`${server.origin}/`).then((response) =>
    response.text().catch(() => {}),
  );
  const response = await fetch(`${server.origin}/missing`);
  expect(response.status).toBe(404);
});
