import {expect, spyOn, test} from "bun:test";
import {Hono} from "hono";
import {CORE_ORDINARY_BODY_BYTES, createCoreStop, serveCore} from "./http-server";
import {createFrameworkResultsApi} from "./api/internal/framework-results.api";
import {FrameworkResultService} from "./services/framework-result.service";
import {RoutineSourceBundleService} from './services/routine-source-bundle.service';
import {createRoutineDefinitionsApi} from './api/internal/routine-definitions.api';
import {ROUTINE_BUNDLE_BODY_BYTES} from './types/framework-version.types';

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

test("Core listener streams recordings above 128 MiB while retaining the JSON limit", async () => {
  const size = 129 * 1024 * 1024;
  const token = "synthetic-listener-host-" + "x".repeat(32);
  let uploaded = 0, hostSeen = "", assetSeen = "";
  const assetId = "recording/" + "a".repeat(490);
  class Service extends FrameworkResultService {
    override async upload(_request: string, _asset: string, host: string, body: ReadableStream<Uint8Array> | null): Promise<any> {
      hostSeen = host; assetSeen = _asset;
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
    const response = await fetch(`http://127.0.0.1:${server.port}/api/internal/framework-results/request/assets/${encodeURIComponent(assetId)}`, {method: "PUT",
      headers: {authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(size)}, body});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded: true, size});
    expect(uploaded).toBe(size); expect(hostSeen).toBe("mini"); expect(assetSeen).toBe(assetId);
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

test('Core listener admits authenticated routine archives above ordinary limit and enforces their 256 MiB cap', async () => {
  const token = 'synthetic-bundle-host-' + 'x'.repeat(32), digest = 'a'.repeat(64)
  let handled = 0, uploaded = 0
  const publish = spyOn(RoutineSourceBundleService.prototype, 'publish').mockImplementation(async (_digest, _metadata, body) => {
    handled++
    uploaded = 0
    for await (const bytes of body!) uploaded += bytes.byteLength
    return {repository: 'Mentra-Community/Mentra-Automated-Testing', commit: 'b'.repeat(40), minimumRoutineApiVersion: 1,
      bundle: {url: `https://core.example/bundles/${digest}`, sha256: digest, size: uploaded}}
  })
  const api = new Hono()
  api.route('/api/internal/routine-definitions', createRoutineDefinitionsApi(undefined, () => JSON.stringify({mini: token})))
  const server = serveCore(api.fetch, 0)
  const stream = (size: number) => {
    const chunk = new Uint8Array(1024 * 1024)
    let remaining = size
    return new ReadableStream<Uint8Array>({pull(controller) {
      if (!remaining) {controller.close(); return}
      const bytes = chunk.subarray(0, Math.min(remaining, chunk.length))
      remaining -= bytes.length; controller.enqueue(bytes)
    }})
  }
  try {
    for (const withLength of [true, false]) {
      const size = CORE_ORDINARY_BODY_BYTES + 1
      const metadata = {commit: 'b'.repeat(40), routineId: 'fixture', minimumRoutineApiVersion: 1, definitionSha256: 'c'.repeat(64), size}
      const url = `http://127.0.0.1:${server.port}/api/internal/routine-definitions/bundles/${digest}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`
      const headers: Record<string, string> = {authorization: `Bearer ${token}`, 'content-type': 'application/gzip', 'x-forwarded-proto': 'https'}
      if (withLength) headers['content-length'] = String(size)
      const response = await fetch(url, {method: 'POST', headers, body: stream(size)})
      expect(response.status).toBe(200)
      expect((await response.json()).bundle.size).toBe(size)
      expect(uploaded).toBe(size)
      if (withLength) headers['content-length'] = String(ROUTINE_BUNDLE_BODY_BYTES + 1)
      const oversized = await fetch(url, {method: 'POST', headers, body: stream(ROUTINE_BUNDLE_BODY_BYTES + 1)})
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toEqual({error: 'body_too_large'})
    }
    expect(handled).toBe(2)
  } finally {publish.mockRestore(); await server.stop(true)}
}, 15000)

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
