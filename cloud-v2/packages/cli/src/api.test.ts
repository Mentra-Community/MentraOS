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
    let requestUrl: string | URL | Request | undefined;
    let request: RequestInit | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = url;
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
    expect(requestUrl).toBe("https://core.example.test/api/console/apps/com.example.app/releases");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ accept: "application/json", authorization: "Bearer token" });
    expect(form.get("bundle")).toBeInstanceOf(File);
    expect(form.get("packageName")).toBe("com.example.app");
    expect(form.get("version")).toBe("1.0.0");
    expect(form.get("fileName")).toBe("bundle.zip");
    expect(JSON.parse(String(form.get("manifest")))).toMatchObject({
      packageName: "com.example.app",
      version: "1.0.0",
    });
    expect(JSON.parse(String(form.get("signedBundle")))).toMatchObject({ signingKeyId: "key_1" });
    expect(request?.headers).not.toHaveProperty("content-type");
  });
});
