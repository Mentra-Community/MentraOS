import { expect, test } from "bun:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { bufferedRangeResponse } from "../../../packages/core/src/services/storage/byte-range";
import { S3StorageProvider } from "../../../packages/core/src/services/storage/providers/s3-storage.provider";
import { startAdminServer } from "./index";

test("the real admin proxy preserves authenticated media range lengths and exact bytes", async () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => index % 251);
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.headers.get("cookie") !== "test-session=allowed") return new Response(null, { status: 401 });
    const range = req.headers.get("range");
    const match = range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
      "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
    } });
  } });
  const server = startAdminServer({ hostname: "127.0.0.1", port: 0, coreUrl: upstream.url.href });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/test-runs/example/assets/video`;
  try {
    expect((await fetch(url)).status).toBe(401);
    for (const [start, end] of [[0, 1], [123, 65536], [bytes.length - 300000, bytes.length - 1]]) {
      const response = await fetch(url, { headers: { cookie: "test-session=allowed", range: `bytes=${start}-${end}` } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    const head = await fetch(url, { method: "HEAD", headers: { cookie: "test-session=allowed", range: "bytes=0-1" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("2");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const full = await fetch(url, { headers: { cookie: "test-session=allowed" } });
    expect(full.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    upstream.stop(true);
  }
});

test("the real admin proxy relays authenticated incident artifact ranges with exact lengths", async () => {
  // Upstream uses Core's real buffered range responder behind a session check.
  const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (req.headers.get("cookie") !== "test-session=allowed") return new Response(null, { status: 401 });
    return bufferedRangeResponse(req, bytes, new Headers({ "content-type": "video/mp4", etag: '"synthetic"',
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" }));
  } });
  const server = startAdminServer({ hostname: "127.0.0.1", port: 0, coreUrl: upstream.url.href });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/reports/rep_example/artifacts/art_example`;
  const cookie = "test-session=allowed";
  try {
    expect((await fetch(url, { headers: { range: "bytes=0-1" } })).status).toBe(401);
    for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=-4096", bytes.length - 4096, bytes.length - 1],
      ["bytes=1000-", 1000, bytes.length - 1]] as const) {
      const response = await fetch(url, { headers: { cookie, range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, max-age=300");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    const head = await fetch(url, { method: "HEAD", headers: { cookie, range: "bytes=0-1" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("2");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const unsatisfiable = await fetch(url, { headers: { cookie, range: `bytes=${bytes.length}-` } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    await unsatisfiable.arrayBuffer();
    const full = await fetch(url, { headers: { cookie } });
    expect(full.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    upstream.stop(true);
  }
});

test("the streaming proxy preserves POST bodies, redirects and separate sign-in cookies", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    expect(req.method).toBe("POST");
    expect(await req.text()).toBe("test sign-in body");
    const headers = new Headers({ location: "/signed-in" });
    headers.append("set-cookie", "first=one; HttpOnly");
    headers.append("set-cookie", "second=two; HttpOnly");
    return new Response(null, { status: 303, headers });
  } });
  const server = startAdminServer({ hostname: "127.0.0.1", port: 0, coreUrl: upstream.url.href });
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/callback`, {
      method: "POST", body: "test sign-in body", redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/signed-in");
    expect(response.headers.getSetCookie()).toEqual(["first=one; HttpOnly", "second=two; HttpOnly"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    upstream.stop(true);
  }
});

test("the real S3 provider and Bun Core relay retain exact range lengths through the admin listener", async () => {
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 251);
  const objectServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const match = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(null, { status: 400 });
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
      "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
    } });
  } });
  const storage = new S3StorageProvider({ endpoint: objectServer.url.href, bucket: "test", accessKeyId: "test", secretAccessKey: "test", region: "us-east-1" });
  const core = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.headers.get("cookie") !== "test-session=allowed") return new Response(null, { status: 401 });
    const match = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!match) return new Response(null, { status: 400 });
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(await storage.streamObject("video", { start, end }), { status: 206, headers: {
      "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "Content-Type": "video/mp4", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes",
    } });
  } });
  const server = startAdminServer({ hostname: "127.0.0.1", port: 0, coreUrl: core.url.href });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/test-runs/example/assets/video`;
  try {
    expect((await fetch(url)).status).toBe(401);
    for (const [start, end] of [[0, 1], [100000, 399999], [bytes.length - 300000, bytes.length - 1]]) {
      const response = await fetch(url, { headers: { cookie: "test-session=allowed", range: `bytes=${start}-${end}` } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    core.stop(true);
    objectServer.stop(true);
  }
});

test("range length restoration rejects malformed, encoded and unrelated responses", async () => {
  const cases = [
    { range: "bytes 0-1/2", path: "/api/admin/test-runs/example/assets/video", expected: "2" },
    { range: "bytes 2-1/3" }, { range: "bytes 0-2/2" }, { range: "bytes -1-1/2" },
    { range: "bytes 0-1/*" }, { range: "bytes 0-1/9007199254740992" }, { range: "bytes 0-1/2,3-4/5" },
    { range: "bytes 0-1/2", encoding: "x-test-encoding" },
    { range: "bytes 0-1/2", path: "/api/other/video" },
    { range: "bytes 0-1/2", path: "/api/admin/reports/rep_example/artifacts/art_example", expected: "2" },
    { range: "bytes 0-1/2", path: "/api/admin/reports/rep_example" },
    { range: "bytes 0-1/2", path: "/api/admin/reports/rep_example/artifacts/art_example/extra" },
    { range: "bytes 0-1/2", status: 200 },
  ];
  for (const entry of cases) {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      const headers = new Headers({ "Content-Range": entry.range });
      if (entry.encoding) headers.set("Content-Encoding", entry.encoding);
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new Uint8Array([1]));
        await new Promise(resolve => setTimeout(resolve, 10));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      } }), {
        status: entry.status ?? 206, headers,
      });
    } });
    const server = startAdminServer({ hostname: "127.0.0.1", port: 0, coreUrl: upstream.url.href });
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${entry.path ?? "/api/admin/test-runs/example/assets/video"}`);
      expect(response.headers.get("content-length")).toBe(entry.expected ?? null);
      expect((await response.arrayBuffer()).byteLength).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      upstream.stop(true);
    }
  }
});
