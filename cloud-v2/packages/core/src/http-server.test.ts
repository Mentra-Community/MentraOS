import {expect, test} from "bun:test";
import {Hono} from "hono";
import {CORE_ORDINARY_BODY_BYTES, serveCore} from "./http-server";
import {createFrameworkResultsApi} from "./api/internal/framework-results.api";
import {FrameworkResultService} from "./services/framework-result.service";

test("Core listener streams recordings above 128 MiB while retaining the JSON limit", async () => {
  const size = 129 * 1024 * 1024;
  const token = "synthetic-listener-host-" + "x".repeat(32);
  let uploaded = 0, hostSeen = "";
  class Service extends FrameworkResultService {
    override async upload(_request: string, _asset: string, host: string, body: ReadableStream<Uint8Array> | null): Promise<any> {
      hostSeen = host;
      if (!body) throw new Error("Upload body missing");
      for await (const bytes of body) uploaded += bytes.byteLength;
      return {uploaded: true, size: uploaded};
    }
  }
  const api = new Hono();
  api.route("/api/internal/framework-results", createFrameworkResultsApi(new Service(), () => JSON.stringify({mini: token})));
  const server = serveCore(api.fetch, 0);
  try {
    const chunk = new Uint8Array(1024 * 1024);
    let remaining = size;
    const body = new ReadableStream<Uint8Array>({pull(controller) {
      if (!remaining) {controller.close(); return;}
      const bytes = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= bytes.length; controller.enqueue(bytes);
    }});
    const response = await fetch(`http://127.0.0.1:${server.port}/api/internal/framework-results/request/assets/video`, {method: "PUT",
      headers: {authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(size)}, body});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded: true, size});
    expect(uploaded).toBe(size); expect(hostSeen).toBe("mini");
    const jsonResponse = await fetch(`http://127.0.0.1:${server.port}/api/internal/framework-results`, {method: "POST",
      headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
      body: JSON.stringify({text: "x".repeat(1024 * 1024)})});
    expect(jsonResponse.status).toBe(413);
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/internal/framework-results/request/assets/video`,
      {method: "PUT", body: "untrusted", headers: {"content-type": "video/mp4"}});
    expect(unauthorized.status).toBe(401);
    expect(uploaded).toBe(size);
  } finally {await server.stop(true);}
}, 15000);

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
      ["PUT", "/api/internal/framework-results/request/assets/video/extra", false],
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
