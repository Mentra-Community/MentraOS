import {expect, test} from "bun:test";
import {Hono} from "hono";
import {TestRunError} from "../../services/test-result-error";
import {frameworkBodyLimit, frameworkJson} from "./framework-json";

test("framework JSON rejects oversized fixed-length and streamed requests as 413", async () => {
  const app = new Hono();
  app.onError((error, c) => error instanceof TestRunError ? c.json({error: error.message}, error.status) : c.json({}, 503));
  app.post("/", frameworkBodyLimit(16), async c => c.json(await frameworkJson(c)));
  expect((await app.request("/", {method: "POST", body: '{"ok":true}'})).status).toBe(200);
  const bytes = new TextEncoder().encode(JSON.stringify({text: "x".repeat(50)}));
  expect((await app.request("/", {method: "POST", headers: {"content-length": String(bytes.length)}, body: bytes})).status).toBe(413);
  const stream = new ReadableStream({start(controller) {controller.enqueue(bytes); controller.close();}});
  expect((await app.request(new Request("http://localhost/", {method: "POST", body: stream}))).status).toBe(413);
  expect((await app.request("/", {method: "POST", body: "bad"})).status).toBe(400);
});
