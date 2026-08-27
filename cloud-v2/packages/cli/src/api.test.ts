import { afterEach, describe, expect, mock, test } from "bun:test";
import { createRelease, getOrg, startLogin, upsertOrg } from "./api";
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
      releaseTrack: "beta",
      manifest: { packageName: "com.example.app", version: "1.0.0", name: "Example" },
      bundle: new Uint8Array([0x50, 0x4b]),
      fileName: "bundle.zip",
    });

    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(requestUrl).toBe("https://core.example.test/api/console/apps/com.example.app/releases");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({ accept: "application/json", authorization: "Bearer token" });
    expect(form.get("bundle")).toBeInstanceOf(File);
    expect(form.get("packageName")).toBe("com.example.app");
    expect(form.get("version")).toBe("1.0.0");
    expect(form.get("releaseTrack")).toBe("beta");
    expect(form.get("fileName")).toBe("bundle.zip");
    expect(JSON.parse(String(form.get("manifest")))).toMatchObject({
      packageName: "com.example.app",
      version: "1.0.0",
    });
    expect(form.has("signedBundle")).toBe(false);
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

describe("developer organization selection", () => {
  test("sends the selected developer org and can explicitly create another one", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({
        org: {
          id: "dorg_new",
          ownerUserId: "user",
          workosOrgId: "org_workos_1",
          name: "New Org",
          packagePrefix: "com.neworg",
          packagePrefixStatus: "unverified",
          createdAt: null,
          updatedAt: null,
        },
      });
    }) as unknown as typeof fetch;
    const selectedCredentials = {
      ...credentials,
      organizationId: "org_workos_1",
      developerOrgId: "dorg_selected",
    };

    await getOrg(selectedCredentials);
    await upsertOrg(selectedCredentials, {
      displayName: "New Org",
      packagePrefix: "com.neworg",
      createNew: true,
    });

    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer token",
      "x-mentra-developer-org-id": "dorg_selected",
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      displayName: "New Org",
      packagePrefix: "com.neworg",
      createNew: true,
    });
  });
});
