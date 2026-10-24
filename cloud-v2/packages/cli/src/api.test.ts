import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createWorkspace,
  CoreRequestError,
  ensureOidcClient,
  listWorkspaces,
  refreshLoginToken,
  revokeLogin,
  SessionExpiredError,
  type CliWorkspace,
} from "./api";
import type { CliCredentials } from "./credentials";
import { loopbackLogin } from "./loopback-login";
import { startFakeOidcIssuer, type FakeOidcIssuer } from "./testing/fake-oidc-issuer";
import { expectLoopbackPortsFree, freeLoopbackPorts } from "./testing/loopback";

const credentials = {
  token: "token",
  coreUrl: "https://core.example.test",
};

// `mock.restore()` only reverts spies; it leaves a plain `globalThis.fetch = ...`
// assignment in place, so without this the mocked fetch below escapes into every
// test file that happens to run after this one in the same process.
const realFetch = globalThis.fetch;
afterEach(() => {
  mock.restore();
  globalThis.fetch = realFetch;
});

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

  test("uses MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID when both are set, without asking Core", async () => {
    await issuer();
    const core = signInSettingsServer("/api/cli/config", () => Response.json({ issuer: "unused", clientId: "unused" }));
    stops.push(core.stop);
    const config = await ensureOidcClient({ oidcIssuer: idp.issuer, cliClientId: "mentra-cli", coreUrl: core.url });
    expect(config.serverMetadata().issuer).toBe(idp.issuer);
    expect(config.clientMetadata()).toMatchObject({ client_id: "mentra-cli", id_token_signed_response_alg: "EdDSA" });
    expect(core.requests).toEqual([]);
  });

  test("asks Core's /api/cli/config otherwise", async () => {
    await issuer();
    const core = signInSettingsServer("/api/cli/config", () => Response.json({ issuer: idp.issuer, clientId: "mentra-cli" }));
    stops.push(core.stop);
    const config = await ensureOidcClient({ oidcIssuer: "", cliClientId: "", coreUrl: core.url });
    expect(config.serverMetadata().revocation_endpoint).toBe(`${idp.issuer}/revoke`);
    expect(config.clientMetadata().client_id).toBe("mentra-cli");
    expect(core.requests).toEqual(["/api/cli/config"]);
  });

  test("a Core without CLI sign-in says so", async () => {
    const core = signInSettingsServer("/api/cli/config", () =>
      Response.json({ error: "not_configured", error_description: "off" }, { status: 404 }),
    );
    stops.push(core.stop);
    await expect(ensureOidcClient({ coreUrl: core.url })).rejects.toThrow(`The Core at ${core.url} does not offer CLI sign-in.`);
  });

  test("a Core that does not answer with sign-in settings says so", async () => {
    const core = signInSettingsServer("/api/cli/config", () => Response.json({ issuer: "" }));
    stops.push(core.stop);
    await expect(ensureOidcClient({ coreUrl: core.url })).rejects.toThrow(`The Core at ${core.url} did not provide CLI sign-in settings.`);
  });

  test("only one of the two variables is refused", async () => {
    await expect(ensureOidcClient({ oidcIssuer: "https://account.example.test", cliClientId: "" })).rejects.toThrow(
      "Set both MENTRA_CLI_OIDC_ISSUER and MENTRA_CLI_CLIENT_ID, or neither.",
    );
  });

  test("a plain-HTTP issuer off this machine is refused before any request", async () => {
    const core = signInSettingsServer("/api/cli/config", () =>
      Response.json({ issuer: "http://account.example.test", clientId: "mentra-cli" }),
    );
    stops.push(core.stop);
    await expect(ensureOidcClient({ coreUrl: core.url })).rejects.toThrow("must be an HTTPS URL");
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
      coreUrl: "https://core.example.test",
      storedAt: new Date().toISOString(),
    };
  }

  test("refresh rotates the refresh token", async () => {
    const login = await signedIn();
    const refreshed = await refreshLoginToken(login);
    expect(refreshed.token).not.toBe(login.token);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    expect(refreshed).toMatchObject({ mentraUserId: "mu_1", email: "ada@example.com", coreUrl: login.coreUrl });
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

/** Records every request and answers each with `answer`. */
function recordFetch(answer: (url: string, init?: RequestInit) => Response) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return answer(String(url), init);
  }) as unknown as typeof fetch;
  return requests;
}

describe("Core's workspace API", () => {
  test("lists the signed-in person's workspaces with their bearer, and names no workspace in a header", async () => {
    const requests = recordFetch(() => Response.json({ items: [workspaceSummary("ws_1", "Team One")] }));
    expect(await listWorkspaces(credentials)).toEqual([workspaceSummary("ws_1", "Team One")]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://core.example.test/api/workspaces");
    expect(requests[0]?.init?.headers).toEqual({ accept: "application/json", authorization: "Bearer token" });
  });

  test("creates a workspace as JSON", async () => {
    const requests = recordFetch(() => Response.json({ ...workspaceSummary("ws_new", "New Team"), capabilities: [] }, { status: 201 }));
    expect(await createWorkspace(credentials, "New Team")).toMatchObject({ workspaceId: "ws_new", name: "New Team" });
    expect(requests[0]?.url).toBe("https://core.example.test/api/workspaces");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "New Team" }),
      headers: { "content-type": "application/json", authorization: "Bearer token" },
    });
  });

  test("a refusal keeps Core's status, code and explanation", async () => {
    recordFetch(() => Response.json({ error: "workspace_limit", error_description: "You already have a workspace" }, { status: 409 }));
    const error = await createWorkspace(credentials, "Second").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CoreRequestError);
    expect(error).toMatchObject({ status: 409, code: "workspace_limit", message: "You already have a workspace" });
  });

  test("a refused access token is renewed once and the request retried with the new one", async () => {
    const requests = recordFetch((_url, init) =>
      (init?.headers as Record<string, string>).authorization === "Bearer fresh"
        ? Response.json({ items: [] })
        : Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    const refused: string[] = [];
    const session = { ...credentials, renewToken: async (token: string) => (refused.push(token), "fresh") };
    expect(await listWorkspaces(session)).toEqual([]);
    expect(refused).toEqual(["token"]);
    expect(requests.map((request) => (request.init?.headers as Record<string, string>).authorization)).toEqual([
      "Bearer token",
      "Bearer fresh",
    ]);
    // Later requests of the command carry the renewed token.
    expect(session.token).toBe("fresh");
  });

  test("without a renewed token the refusal stands", async () => {
    const requests = recordFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const error = await listWorkspaces({ ...credentials, renewToken: async () => null }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
    expect(requests).toHaveLength(1);
  });
});
