import {expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import {CORE_ORDINARY_BODY_BYTES, createCoreStop, serveCore} from "./http-server";

test("Core listener answers a handler that takes more than ten seconds", async () => {
  const api = new Hono();
  api.post("/slow", async c => {
    await Bun.sleep(11_000);
    return c.json({done: true});
  });
  const listener = spyOn(Bun, "serve");
  const server = serveCore(api.fetch, 0), options = listener.mock.calls[0]![0];
  listener.mockRestore();
  const started = performance.now();
  try {
    expect(options.idleTimeout).toBe(60);
    const response = await fetch(`http://127.0.0.1:${server.port}/slow`, {method: "POST", signal: AbortSignal.timeout(20_000)});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({done: true});
    expect(performance.now() - started).toBeGreaterThanOrEqual(11_000);
  } finally {await server.stop(true);}
}, 20_000);

test("Core shutdown drains an admitted publication before disconnecting Mongo, once across repeated signals", async () => {
  let enter!: () => void, finish!: () => void, disconnected = false, disconnects = 0;
  const entered = new Promise<void>(resolve => enter = resolve);
  const finished = new Promise<void>(resolve => finish = resolve);
  const server = serveCore(async () => {
    enter();
    await finished;
    expect(disconnected).toBe(false);
    return new Response("published");
  }, 0);
  const stop = createCoreStop(server, async () => {disconnected = true; disconnects++;});
  const publication = fetch(`http://127.0.0.1:${server.port}/publication`);
  await entered;
  const first = stop(), second = stop();
  try {
    expect(first).toBe(second);
    await Bun.sleep(20);
    expect(disconnected).toBe(false);
    finish();
    expect(await (await publication).text()).toBe("published");
    await first;
    expect(disconnects).toBe(1);
  } finally {finish(); await server.stop(true);}
});

test("ordinary handlers retain the body ceiling with known and streamed lengths", async () => {
  let handled = 0;
  const api = new Hono();
  api.onError((_error, c) => c.json({error: "nested_handler_error"}, 503));
  api.all("*", async c => {
    handled++;
    const input = await c.req.json();
    return c.json({accepted: true, input, header: c.req.header("x-forward-check")});
  });
  const server = serveCore(api.fetch, 0);
  const textBytes = CORE_ORDINARY_BODY_BYTES + 1;
  const prefix = new TextEncoder().encode('{"text":"'), suffix = new TextEncoder().encode('"}');
  function body() {
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    let remaining = textBytes, started = false;
    return new ReadableStream<Uint8Array>({pull(controller) {
      if (!started) {started = true; controller.enqueue(prefix); return;}
      if (!remaining) {controller.enqueue(suffix); controller.close(); return;}
      const bytes = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= bytes.length; controller.enqueue(bytes);
    }});
  }
  try {
    for (const [method, path, withLength] of [
      ["POST", "/api/account/oauth/complete", true],
      ["POST", "/api/account/oauth/complete", false],
    ] as const) {
      const headers: Record<string, string> = {"content-type": "application/json"};
      if (withLength) headers["content-length"] = String(textBytes + prefix.length + suffix.length);
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {method, headers, body: body()});
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({error: "body_too_large"});
      expect(handled).toBe(0);
    }
    const small = await fetch(`http://127.0.0.1:${server.port}/api/account/oauth/complete`,
      {method: "POST", headers: {"content-type": "application/json", "x-forward-check": "retained"},
        body: new ReadableStream({start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({text: "valid"}))); controller.close();
        }})});
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({accepted: true, input: {text: "valid"}, header: "retained"});
    expect(handled).toBe(1);
  } finally {await server.stop(true);}
}, 15000);
