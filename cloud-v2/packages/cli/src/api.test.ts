import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CredentialView } from "@mentra/workspace-contract";
import {
  createRelease,
  createWorkspace,
  createWorkspaceCredential,
  getConsoleSession,
  getPublishingProfile,
  listWorkspaceCredentials,
  resolveWorkspaceId,
  revokeWorkspaceCredential,
  setPackagePrefix,
  startLogin,
  WorkspaceSelectionRequiredError,
  type CliWorkspace,
} from "./api";
import type { CliConfig } from "./config";

const credentials = {
  token: "token",
  workosUserId: "user",
  email: "developer@example.com",
  storeUrl: "https://store.example.test",
  storedAt: new Date(0).toISOString(),
};

// `mock.restore()` only reverts spies; it leaves a plain `globalThis.fetch = ...`
// assignment in place, so without this the mocked fetch below escapes into every
// test file that happens to run after this one in the same process.
const realFetch = globalThis.fetch;
afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
});

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
    expect(requestUrl).toBe("https://store.example.test/api/console/apps/com.example.app/releases");
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
  test("discovers the public WorkOS client id from the selected Store", async () => {
    const config: CliConfig = {
          storeUrl: "https://store.example.test",
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
      "https://store.example.test/api/console/auth/cli-config",
      "https://api.workos.test/user_management/authorize/device",
    ]);
    expect(config.workosClientId).toBe("client_public_123");
  });
});

function workspaceSummary(workspaceId: string, name: string): CliWorkspace {
  return {
    organizationId: "org_core",
    workspaceId,
    name,
    status: "active",
    authorizationRevision: 1,
    membership: { membershipId: `mem_${workspaceId}`, role: "owner" },
    capabilities: [],
  };
}

const credentialView: CredentialView = {
  credentialId: "cred_1",
  prefix: "msk",
  name: "CI",
  display: "msk_test_…abcd",
  workspaceId: "ws_1",
  scopes: ["miniapps.publish"],
  packageNames: [],
  createdByEmail: "developer@example.com",
  issuedByService: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
};

describe("workspace selection", () => {
  test("sends the active workspace header and never the retired developer-org header", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ workspaceId: "ws_selected", packagePrefix: "com.acme", packagePrefixStatus: "verified" });
    }) as unknown as typeof fetch;

    await getPublishingProfile({ ...credentials, workspaceId: "ws_selected" });
    await getPublishingProfile(credentials);

    expect(requests[0]?.url).toBe("https://store.example.test/api/console/publishing-profile");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer token",
      "x-mentra-workspace-id": "ws_selected",
    });
    expect(requests[0]?.init?.headers).not.toHaveProperty("x-mentra-developer-org-id");
    expect(requests[1]?.init?.headers).not.toHaveProperty("x-mentra-workspace-id");
  });

  test("reads the session as the user, their workspaces and the active workspace", async () => {
    const session = {
      user: { id: "user_1", email: "developer@example.com" },
      workspaces: [workspaceSummary("ws_1", "Acme")],
      activeWorkspaceId: "ws_1",
    };
    let requestUrl = "";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestUrl = String(url);
      return Response.json(session);
    }) as unknown as typeof fetch;

    expect(await getConsoleSession(credentials)).toEqual(session);
    expect(requestUrl).toBe("https://store.example.test/api/console/auth/me");
  });

  test("creates a workspace without sending a stale selection", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(workspaceSummary("ws_new", "New Team"), { status: 201 });
    }) as unknown as typeof fetch;

    const created = await createWorkspace({ ...credentials, workspaceId: "ws_stale" }, "New Team");

    expect(created.workspaceId).toBe("ws_new");
    expect(requests[0]?.url).toBe("https://store.example.test/api/console/workspaces");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ name: "New Team" });
    expect(requests[0]?.init?.headers).not.toHaveProperty("x-mentra-workspace-id");
  });

  test("sets the package prefix for the workspace named by the credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ workspaceId: "ws_new", packagePrefix: "com.neworg", packagePrefixStatus: "unverified" });
    }) as unknown as typeof fetch;

    const profile = await setPackagePrefix({ ...credentials, workspaceId: "ws_new" }, "com.neworg");

    expect(profile.packagePrefixStatus).toBe("unverified");
    expect(requests[0]?.url).toBe("https://store.example.test/api/console/publishing-profile");
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ packagePrefix: "com.neworg" });
    expect(requests[0]?.init?.headers).toMatchObject({ "x-mentra-workspace-id": "ws_new" });
  });
});

describe("workspace credentials through the Store", () => {
  test("lists, creates and revokes under the workspace's credentials route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") return Response.json({ credential: credentialView, token: "msk_secret" }, { status: 201 });
      return Response.json({ items: [credentialView] });
    }) as unknown as typeof fetch;

    expect(await listWorkspaceCredentials(credentials, "ws_1")).toEqual({ items: [credentialView] });
    expect(
      await createWorkspaceCredential(credentials, "ws_1", {
        name: "CI",
        packageNames: ["com.acme.app"],
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toEqual({ credential: credentialView, token: "msk_secret" });
    expect(await revokeWorkspaceCredential(credentials, "ws_1", "cred/1")).toBeUndefined();

    expect(requests.map((request) => [request.init?.method ?? "GET", request.url])).toEqual([
      ["GET", "https://store.example.test/api/console/workspaces/ws_1/credentials"],
      ["POST", "https://store.example.test/api/console/workspaces/ws_1/credentials"],
      ["DELETE", "https://store.example.test/api/console/workspaces/ws_1/credentials/cred%2F1"],
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      name: "CI",
      packageNames: ["com.acme.app"],
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });
});

describe("workspace selection required", () => {
  const sessionWithTwoWorkspaces = {
    user: { id: "user_1", email: "developer@example.com" },
    workspaces: [workspaceSummary("ws_1", "Acme"), workspaceSummary("ws_2", "Beta")],
    activeWorkspaceId: null,
  };

  test("a 409 tells the caller to run `mentra workspace use <id>` and lists the available ids", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) =>
      String(url).endsWith("/api/console/auth/me")
        ? Response.json(sessionWithTwoWorkspaces)
        : Response.json({ error: "workspace_selection_required" }, { status: 409 }),
    ) as unknown as typeof fetch;

    const error = await getPublishingProfile(credentials).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceSelectionRequiredError);
    const message = (error as Error).message;
    expect(message).toContain("Run `mentra workspace use <id>`");
    expect(message).toContain("ws_1");
    expect(message).toContain("Acme");
    expect(message).toContain("ws_2");
    expect(message).toContain("Beta");
  });

  test("a 409 still explains itself when the workspaces cannot be listed", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "workspace_selection_required" }, { status: 409 }),
    ) as unknown as typeof fetch;

    const error = await getPublishingProfile(credentials).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceSelectionRequiredError);
    expect((error as Error).message).toContain("Run `mentra workspace use <id>`");
    expect((error as Error).message).toContain("mentra workspace list");
  });

  test("other errors keep the Store's message", async () => {
    globalThis.fetch = mock(async () => Response.json({ error: "forbidden" }, { status: 403 })) as unknown as typeof fetch;

    await expect(getPublishingProfile(credentials)).rejects.toThrow("forbidden");
  });

  test("resolveWorkspaceId prefers the selection, then the active or only workspace", async () => {
    let session: unknown = sessionWithTwoWorkspaces;
    globalThis.fetch = mock(async () => Response.json(session)) as unknown as typeof fetch;

    expect(await resolveWorkspaceId({ ...credentials, workspaceId: "ws_2" })).toBe("ws_2");

    session = { ...sessionWithTwoWorkspaces, activeWorkspaceId: "ws_1" };
    expect(await resolveWorkspaceId(credentials)).toBe("ws_1");

    session = { ...sessionWithTwoWorkspaces, workspaces: [workspaceSummary("ws_only", "Solo")] };
    expect(await resolveWorkspaceId(credentials)).toBe("ws_only");

    session = sessionWithTwoWorkspaces;
    const several = await resolveWorkspaceId(credentials).catch((caught: unknown) => caught);
    expect(several).toBeInstanceOf(WorkspaceSelectionRequiredError);
    expect((several as Error).message).toContain("ws_2");

    session = { ...sessionWithTwoWorkspaces, workspaces: [] };
    await expect(resolveWorkspaceId(credentials)).rejects.toThrow("mentra workspace create <name>");
  });
});
