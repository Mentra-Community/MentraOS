import { afterEach, describe, expect, mock, test } from "bun:test";
import { createRelease, startLogin } from "./api";
import type { CliConfig } from "./config";

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

describe("startLogin", () => {
  test("discovers the public WorkOS client id from the selected Core", async () => {
    const config: CliConfig = {
      coreUrl: "https://core.example.test",
      consoleUrl: "https://console.example.test",
      workosClientId: "",
      workosApiBaseUrl: "https://api.workos.test",
    };
    const requests: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).endsWith("/api/console/auth/cli-config")) {
        return Response.json({ workosClientId: "client_public_123" });
      }
      return Response.json({
        device_code: "device",
        user_code: "USER-CODE",
        verification_uri: "https://login.example.test/device",
        verification_uri_complete: "https://login.example.test/device?code=USER-CODE",
        expires_in: 600,
        interval: 5,
      });
    }) as unknown as typeof fetch;

    await startLogin(config);

    expect(requests).toEqual([
      "https://core.example.test/api/console/auth/cli-config",
      "https://api.workos.test/user_management/authorize/device",
    ]);
    expect(config.workosClientId).toBe("client_public_123");
  });
});
