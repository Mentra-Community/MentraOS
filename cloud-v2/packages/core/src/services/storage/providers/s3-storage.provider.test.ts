import { expect, spyOn, test } from "bun:test";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { S3StorageProvider } from "./s3-storage.provider";

const options = { bucket: "private-test-bucket", accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key", region: "us-east-1" };

// Raw HTTP keeps Content-Length absent when requested. Bun.serve otherwise
// supplies zero for an empty response, hiding the compressed R2 HEAD behavior.
async function withHeadServer(
  respond: (request: string) => string[],
  run: (endpoint: string) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let request = "";
    socket.on("data", chunk => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.removeAllListeners("data");
      socket.end([...respond(request), "Connection: close", "", ""].join("\r\n"));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("requests identity HEAD metadata instead of treating compressed missing length as zero", async () => {
  const requests: string[] = [];
  await withHeadServer(request => {
    requests.push(request);
    return ["HTTP/1.1 200 OK", "Content-Type: application/json", 'ETag: "test"',
      "Last-Modified: Mon, 21 Sep 2026 00:00:00 GMT",
      /\r\naccept-encoding: identity\r\n/i.test(request) ? "Content-Length: 58992" : "Content-Encoding: gzip"];
  }, async endpoint => {
    // This is the failure seen with real JSON evidence in R2 on Bun 1.3.14.
    const native = new Bun.S3Client({ ...options, endpoint });
    expect((await native.file("source-run.json").stat()).size).toBe(0);
    const provider = new S3StorageProvider({ ...options, endpoint });
    expect(await provider.statObject("source-run.json")).toEqual({ sizeBytes: 58992 });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatch(/^HEAD /);
    expect(requests[1]).toContain("X-Amz-Signature=");
    expect(requests[1]).toContain("X-Amz-Expires=60");
    expect(requests[1]).toMatch(/\r\naccept-encoding: identity\r\n/i);
  });
});

test("does not substitute zero or download objects when HEAD size is missing or invalid", async () => {
  for (const headers of [[], ["Content-Length: -1"], ["Content-Length: 1.5"],
    ["Content-Length: 9007199254740992"], ["Content-Length: 12", "Content-Encoding: gzip"]]) {
    let requests = 0;
    await withHeadServer(request => {
      requests++;
      expect(request).toMatch(/^HEAD /);
      return ["HTTP/1.1 200 OK", ...headers];
    }, async endpoint => {
      await expect(new S3StorageProvider({ ...options, endpoint }).statObject("metadata")).rejects.toThrow();
      expect(requests).toBe(1);
    });
  }
});

test("accepts an explicit zero-byte object size", async () => {
  await withHeadServer(() => ["HTTP/1.1 200 OK", "Content-Length: 0"], async endpoint => {
    expect(await new S3StorageProvider({ ...options, endpoint }).statObject("empty")).toEqual({ sizeBytes: 0 });
  });
});

test("rejects unsuccessful HEAD responses and redirects without following them", async () => {
  for (const status of ["403 Forbidden", "302 Found", "204 No Content"]) {
    let requests = 0;
    await withHeadServer(() => {
      requests++;
      return [`HTTP/1.1 ${status}`, "Content-Length: 12", "Location: /must-not-follow"];
    }, async endpoint => {
      await expect(new S3StorageProvider({ ...options, endpoint }).statObject("metadata")).rejects.toThrow();
      expect(requests).toBe(1);
    });
  }
});

test("does not expose a signed URL when the metadata request fails", async () => {
  const failingFetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    throw new Error(`request failed: ${input}`);
  }, { preconnect: fetch.preconnect });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(failingFetch);
  try {
    const provider = new S3StorageProvider({ ...options, endpoint: "https://storage.example.test" });
    await expect(provider.statObject("private-metadata")).rejects.toThrow("storage object metadata request failed");
    try { await provider.statObject("private-metadata"); } catch (error) {
      expect(String(error)).not.toContain("X-Amz");
      expect(String(error)).not.toContain("private-metadata");
      expect((error as Error).cause).toBeUndefined();
    }
  } finally { fetchMock.mockRestore(); }
});
