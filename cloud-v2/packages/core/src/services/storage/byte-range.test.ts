import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ByteRangeError, bufferedRangeResponse, parseSingleByteRange } from "./byte-range";

describe("single byte range parsing", () => {
  test("accepts initial, bounded, open-ended and suffix ranges clamped to the payload", () => {
    expect(parseSingleByteRange(null, 20)).toBeUndefined();
    expect(parseSingleByteRange("bytes=0-1", 20)).toEqual({ start: 0, end: 1 });
    expect(parseSingleByteRange("bytes=4-999", 20)).toEqual({ start: 4, end: 19 });
    expect(parseSingleByteRange("bytes=5-", 20)).toEqual({ start: 5, end: 19 });
    expect(parseSingleByteRange("bytes=-3", 20)).toEqual({ start: 17, end: 19 });
    expect(parseSingleByteRange("bytes=-999", 20)).toEqual({ start: 0, end: 19 });
  });

  test("rejects multipart, reversed, unsafe, empty, malformed and out-of-bounds ranges", () => {
    for (const value of ["bytes=1-2,3-4", "bytes=8-2", "bytes=-0", "bytes=-", "bytes=99999999999999999-",
      "items=0-1", "bytes=0-1 ", "bytes=20-", "bytes=20-25"]) {
      expect(() => parseSingleByteRange(value, 20)).toThrow(ByteRangeError);
    }
    expect(() => parseSingleByteRange("bytes=0-0", 0)).toThrow(ByteRangeError);
  });
});

describe("buffered range responses over a real HTTP socket", () => {
  // Genuine synthetic silent H264 MP4 followed by deterministic padding, so a
  // tail range spans more than the socket's first chunk.
  const fixture = readFile(new URL("../../../../../tests/fixtures/synthetic-silent-h264-64x64-10f.mp4", import.meta.url));
  const etag = '"synthetic-sha256"';
  const security = {
    "content-type": "video/mp4",
    "content-disposition": 'inline; filename="recording.mp4"',
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=300",
  };

  async function withServer(run: (url: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>) {
    const bytes = new Uint8Array(Buffer.concat([await fixture, Buffer.alloc(1024 * 1024, 0x6d)]));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: request => bufferedRangeResponse(request, bytes, new Headers({ ...security, etag })) });
    try { await run(new URL("/artifact", server.url).href, bytes); } finally { await server.stop(true); }
  }

  function expectSecurityHeaders(response: Response) {
    for (const [name, value] of Object.entries(security)) expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBe(etag);
  }

  test("serves the initial probe, tail, suffix, bounded and open-ended ranges with exact bytes and lengths", async () => {
    await withServer(async (url, bytes) => {
      const size = bytes.byteLength;
      for (const [range, start, end] of [
        ["bytes=0-1", 0, 1],
        ["bytes=-8192", size - 8192, size - 1],
        ["bytes=123-65536", 123, 65536],
        [`bytes=${size - 10}-`, size - 10, size - 1],
        [`bytes=0-${size + 100}`, 0, size - 1],
      ] as const) {
        const response = await fetch(url, { headers: { range } });
        expect(response.status).toBe(206);
        expect(response.headers.get("content-length")).toBe(String(end - start + 1));
        expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${size}`);
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expectSecurityHeaders(response);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
      }
      // Bytes 4-7 of the genuine fixture are its `ftyp` box type.
      const probe = await fetch(url, { headers: { range: "bytes=4-7" } });
      expect(await probe.text()).toBe("ftyp");
    });
  });

  test("serves the full payload and HEAD responses with exact lengths", async () => {
    await withServer(async (url, bytes) => {
      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(full.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(full.headers.get("content-range")).toBeNull();
      expectSecurityHeaders(full);
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

      const headRange = await fetch(url, { method: "HEAD", headers: { range: "bytes=0-1" } });
      expect(headRange.status).toBe(206);
      expect(headRange.headers.get("content-length")).toBe("2");
      expect(headRange.headers.get("content-range")).toBe(`bytes 0-1/${bytes.byteLength}`);
      expect((await headRange.arrayBuffer()).byteLength).toBe(0);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    });
  });

  test("If-Range serves the range only for the current strong ETag", async () => {
    await withServer(async (url, bytes) => {
      const current = await fetch(url, { headers: { range: "bytes=0-1", "if-range": etag } });
      expect(current.status).toBe(206);
      expect(new Uint8Array(await current.arrayBuffer())).toEqual(bytes.subarray(0, 2));

      for (const ifRange of ['"old"', `W/${etag}`, "Mon, 21 Sep 2026 00:00:00 GMT"]) {
        const changed = await fetch(url, { headers: { range: "bytes=0-1", "if-range": ifRange } });
        expect(changed.status).toBe(200);
        expect(changed.headers.get("content-range")).toBeNull();
        expect(changed.headers.get("content-length")).toBe(String(bytes.byteLength));
        expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bytes);
      }
    });
  });

  test("payload views keep their own offset and length, including shared-buffer input", async () => {
    // Stored payloads can be views into a larger buffer (e.g. pooled Node
    // Buffers) or, generically, not backed by an ArrayBuffer at all.
    const payload = Uint8Array.from({ length: 4096 }, (_, index) => index % 253);
    const pooled = new Uint8Array(new ArrayBuffer(payload.length + 300));
    pooled.fill(0xee);
    pooled.set(payload, 100);
    const shared = new Uint8Array(new SharedArrayBuffer(payload.length));
    shared.set(payload);
    for (const input of [pooled.subarray(100, 100 + payload.length), shared]) {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
        fetch: request => bufferedRangeResponse(request, input, new Headers({ "content-type": "video/mp4", etag })) });
      try {
        const url = new URL("/artifact", server.url);
        const full = await fetch(url);
        expect(full.headers.get("content-length")).toBe(String(payload.length));
        expect(new Uint8Array(await full.arrayBuffer())).toEqual(payload);
        const tail = await fetch(url, { headers: { range: "bytes=-10" } });
        expect(tail.headers.get("content-range")).toBe(`bytes ${payload.length - 10}-${payload.length - 1}/${payload.length}`);
        expect(new Uint8Array(await tail.arrayBuffer())).toEqual(payload.subarray(-10));
        const middle = await fetch(url, { headers: { range: "bytes=1000-1999" } });
        expect(middle.headers.get("content-length")).toBe("1000");
        expect(new Uint8Array(await middle.arrayBuffer())).toEqual(payload.subarray(1000, 2000));
      } finally { await server.stop(true); }
    }
  });

  test("invalid, multiple and out-of-bounds ranges get 416 with the payload size and the same security headers", async () => {
    await withServer(async (url, bytes) => {
      for (const range of ["bytes=0-1,4-5", `bytes=${bytes.byteLength}-`, "bytes=9-3", "bytes=-0", "items=0-1"]) {
        const response = await fetch(url, { headers: { range } });
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);
        expectSecurityHeaders(response);
        expect((await response.arrayBuffer()).byteLength).toBe(0);
      }
    });
  });
});
