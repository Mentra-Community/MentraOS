import { afterEach, describe, expect, mock, test } from "bun:test";
import { createRelease } from "./api";

const credentials = {
  token: "token",
  workosUserId: "user",
  email: "developer@example.com",
  coreUrl: "https://core.example.test",
  storedAt: new Date(0).toISOString(),
};

afterEach(() => mock.restore());

describe("createRelease", () => {
  test("uploads the bundle as multipart instead of base64 JSON", async () => {
    let request: RequestInit | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ release: { id: "rel_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await createRelease(credentials, {
      packageName: "com.example.app",
      version: "1.0.0",
      manifest: { packageName: "com.example.app", version: "1.0.0", name: "Example" },
      bundle: new Uint8Array([0x50, 0x4b]),
      fileName: "bundle.zip",
      signedBundle: {
        signingKeyId: "key_1",
        signature: "signature",
        payload: {
          packageName: "com.example.app",
          version: "1.0.0",
          bundleSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          createdAt: new Date(0).toISOString(),
        },
      },
    });

    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("bundle")).toBeInstanceOf(File);
    expect(request?.headers).not.toHaveProperty("content-type");
  });
});
