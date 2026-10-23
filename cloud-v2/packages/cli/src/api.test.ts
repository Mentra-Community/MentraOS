import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CredentialView } from "@mentra/workspace-contract";
import {
  createRelease,
  createWorkspace,
  createWorkspaceCredential,
  ensureOidcClient,
  getConsoleSession,
  getPublishingProfile,
  listWorkspaceCredentials,
  refreshLoginToken,
  resolveWorkspaceId,
  revokeLogin,
  revokeWorkspaceCredential,
  SessionExpiredError,
  setPackagePrefix,
  WorkspaceSelectionRequiredError,
  type CliWorkspace,
} from "./api";
import type { CliCredentials } from "./credentials";
import { loopbackLogin } from "./loopback-login";
import { startFakeOidcIssuer, type FakeOidcIssuer } from "./testing/fake-oidc-issuer";
import { expectLoopbackPortsFree, freeLoopbackPorts } from "./testing/loopback";

const credentials = {
  token: "token",
  storeUrl: "https://store.example.test",
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

/** A Store or Core answering only its CLI sign-in settings, recording what it was asked. */
function signInSettingsServer(path: string, answer: () => Response) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      return url.pathname === path ? answer() : new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

describe("ensureOidcClient", () => {
  let idp: FakeOidcIssuer;
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  async function issuer() {
    idp = await startFakeOidcIssuer({ publicClientId: "mentra-cli" });
    stops.push(() => idp.stop());
    return idp;
  }

  test("uses MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID when both are set, without asking the Store", async () => {
    await issuer();
    const store = signInSettingsServer("/api/console/auth/cli-config", () => Response.json({ issuer: "unused", clientId: "unused" }));
    stops.push(store.stop);
    const config = await ensureOidcClient({
      oidcIssuer: idp.issuer,
      cliClientId: "mentra-cli",
      target: { kind: "store", url: store.url },
    });
    expect(config.serverMetadata().issuer).toBe(idp.issuer);
    expect(config.clientMetadata()).toMatchObject({ client_id: "mentra-cli", id_token_signed_response_alg: "EdDSA" });
    expect(store.requests).toEqual([]);
  });

  test("asks the Store's /api/console/auth/cli-config otherwise", async () => {
    await issuer();
    const store = signInSettingsServer("/api/console/auth/cli-config", () =>
      Response.json({ issuer: idp.issuer, clientId: "mentra-cli" }),
    );
    stops.push(store.stop);
    const config = await ensureOidcClient({ oidcIssuer: "", cliClientId: "", target: { kind: "store", url: store.url } });
    expect(config.serverMetadata().revocation_endpoint).toBe(`${idp.issuer}/revoke`);
    expect(config.clientMetadata().client_id).toBe("mentra-cli");
    expect(store.requests).toEqual(["/api/console/auth/cli-config"]);
  });

  test("Core mode resolves the issuer from Core's /api/cli/config", async () => {
    await issuer();
    const core = signInSettingsServer("/api/cli/config", () => Response.json({ issuer: idp.issuer, clientId: "mentra-cli" }));
    stops.push(core.stop);
    const config = await ensureOidcClient({ target: { kind: "core", url: core.url } });
    expect(config.serverMetadata().issuer).toBe(idp.issuer);
    expect(core.requests).toEqual(["/api/cli/config"]);
  });

  test("a Core without CLI sign-in says so", async () => {
    const core = signInSettingsServer("/api/cli/config", () =>
      Response.json({ error: "not_configured", error_description: "off" }, { status: 404 }),
    );
    stops.push(core.stop);
    await expect(ensureOidcClient({ target: { kind: "core", url: core.url } })).rejects.toThrow(
      `This Core at ${core.url} does not offer CLI sign-in.`,
    );
  });

  test("only one of the two variables is refused", async () => {
    await expect(ensureOidcClient({ oidcIssuer: "https://account.example.test", cliClientId: "" })).rejects.toThrow(
      "Set both MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID, or neither.",
    );
  });

  test("a plain-HTTP issuer off this machine is refused before any request", async () => {
    const store = signInSettingsServer("/api/console/auth/cli-config", () =>
      Response.json({ issuer: "http://account.example.test", clientId: "mentra-cli" }),
    );
    stops.push(store.stop);
    await expect(ensureOidcClient({ target: { kind: "store", url: store.url } })).rejects.toThrow("must be an HTTPS URL");
  });
});

describe("refresh and revocation", () => {
  let idp: FakeOidcIssuer;
  let freePorts: number[] = [];
  beforeEach(async () => {
    freePorts = await freeLoopbackPorts();
  });
  afterEach(async () => {
    idp?.stop();
    await expectLoopbackPortsFree(freePorts);
  });

  async function signedIn(): Promise<CliCredentials> {
    idp = await startFakeOidcIssuer({ publicClientId: "mentra-cli" });
    const config = await ensureOidcClient({ oidcIssuer: idp.issuer, cliClientId: "mentra-cli" });
    let browser: Promise<unknown> | undefined;
    const result = await loopbackLogin(config, {
      openBrowser: async (url) => {
        browser = idp.approveInBrowser(url, { sub: "mu_1", email: "ada@example.com" });
        return true;
      },
      print: () => {},
    });
    await browser;
    return {
      token: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: new Date(result.expiresAt).toISOString(),
      mentraUserId: result.subject,
      email: result.email,
      issuer: idp.issuer,
      clientId: "mentra-cli",
      storeUrl: "https://store.example.test",
      storedAt: new Date().toISOString(),
    };
  }

  test("refresh rotates the refresh token", async () => {
    const login = await signedIn();
    const refreshed = await refreshLoginToken(login);
    expect(refreshed.token).not.toBe(login.token);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    expect(refreshed).toMatchObject({ mentraUserId: "mu_1", email: "ada@example.com", storeUrl: login.storeUrl });
    expect(idp.refreshTokenActive(login.refreshToken)).toBe(false);
    expect(idp.refreshTokenActive(refreshed.refreshToken)).toBe(true);
    expect(idp.accessTokenOwner(refreshed.token)).toMatchObject({ sub: "mu_1" });
  });

  test("reusing a spent refresh token is a session expiry and ends the grant", async () => {
    const login = await signedIn();
    const refreshed = await refreshLoginToken(login);
    const error = await refreshLoginToken(login).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).toBe("Session expired. Run `mentra login`.");
    expect(idp.refreshTokenActive(refreshed.refreshToken)).toBe(false);
  });

  test("revokeLogin revokes the refresh token at the revocation endpoint, which then fails (L09)", async () => {
    const login = await signedIn();
    expect(await revokeLogin(login)).toEqual({ confirmed: true });
    expect(idp.revocations).toEqual([{ token: login.refreshToken, hint: "refresh_token", clientId: "mentra-cli" }]);
    await expect(refreshLoginToken(login)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  test("revokeLogin ends only this login", async () => {
    const first = await signedIn();
    const idpForBoth = idp;
    const config = await ensureOidcClient({ oidcIssuer: idp.issuer, cliClientId: "mentra-cli" });
    let browser: Promise<unknown> | undefined;
    const second = await loopbackLogin(config, {
      openBrowser: async (url) => {
        browser = idpForBoth.approveInBrowser(url, { sub: "mu_1" });
        return true;
      },
      print: () => {},
    });
    await browser;
    expect(await revokeLogin(first)).toEqual({ confirmed: true });
    expect(idp.refreshTokenActive(second.refreshToken)).toBe(true);
  });

  test("revokeLogin is not confirmed when the revocation endpoint fails", async () => {
    const login = await signedIn();
    idp.failRevocation = true;
    expect(await revokeLogin(login)).toEqual({ confirmed: false });
    expect(idp.refreshTokenActive(login.refreshToken)).toBe(true);
  });

  test("revokeLogin is not confirmed when the sign-in server cannot be reached", async () => {
    const login = await signedIn();
    idp.stop();
    expect(await revokeLogin(login)).toEqual({ confirmed: false });
  });
});

function workspaceSummary(workspaceId: string, name: string): CliWorkspace {
  return {
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

  test("a 409 says the account must be brought down to one workspace and lists the ids it is in", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) =>
      String(url).endsWith("/api/console/auth/me")
        ? Response.json(sessionWithTwoWorkspaces)
        : Response.json({ error: "workspace_selection_required" }, { status: 409 }),
    ) as unknown as typeof fetch;

    const error = await getPublishingProfile(credentials).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkspaceSelectionRequiredError);
    const message = (error as Error).message;
    expect(message).toContain("more than one workspace");
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
    expect((error as Error).message).toContain("more than one workspace");
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
