import {expect, test} from "bun:test";
import {serveCore} from "./http-server";
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
  const api = createFrameworkResultsApi(new Service(), () => JSON.stringify({mini: token}));
  const server = serveCore(api.fetch, 0);
  try {
    const chunk = new Uint8Array(1024 * 1024);
    let remaining = size;
    const body = new ReadableStream<Uint8Array>({pull(controller) {
      if (!remaining) {controller.close(); return;}
      const bytes = chunk.subarray(0, Math.min(remaining, chunk.length));
      remaining -= bytes.length; controller.enqueue(bytes);
    }});
    const response = await fetch(`http://127.0.0.1:${server.port}/request/assets/video`, {method: "PUT",
      headers: {authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(size)}, body});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded: true, size});
    expect(uploaded).toBe(size); expect(hostSeen).toBe("mini");
    const jsonResponse = await fetch(`http://127.0.0.1:${server.port}/`, {method: "POST",
      headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
      body: JSON.stringify({text: "x".repeat(1024 * 1024)})});
    expect(jsonResponse.status).toBe(413);
  } finally {await server.stop(true);}
}, 15000);
