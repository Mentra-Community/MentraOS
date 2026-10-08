import { describe, expect, spyOn, test } from "bun:test";
import { createWorkspaceApi } from "./api";
import { errorMessage, isWorkspaceChangedError, WORKSPACE_CHANGED_MESSAGE, WorkspaceApiError } from "./errors";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials: string | undefined;
}

/** A fetch that records every request and answers each with the next canned response. */
function recordingFetch(...responses: Array<Response | (() => Response)>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      credentials: init?.credentials,
    });
    const next = responses.shift() ?? Response.json({});
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const noContent = () => new Response(null, { status: 204 });

describe("createWorkspaceApi: routes", () => {
  test("lists the caller's workspaces from GET {base}", async () => {
    const items = [{ workspaceId: "ws_1", name: "Acme" }];
    const rec = recordingFetch(Response.json({ items }));
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    expect(await api.listWorkspaces()).toEqual(items as never);
    expect(rec.calls[0]).toMatchObject({ url: "/api/workspaces", method: "GET", credentials: "same-origin" });
    expect(rec.calls[0]!.headers.accept).toBe("application/json");
    expect(rec.calls[0]!.body).toBeUndefined();
  });

  test("works under the Store proxy base path and ignores a trailing slash", async () => {
    const rec = recordingFetch(Response.json({ items: [] }), Response.json({}));
    const api = createWorkspaceApi({ basePath: "/api/console/workspaces/", fetch: rec.fetch });
    expect(api.basePath).toBe("/api/console/workspaces");
    await api.listWorkspaces();
    await api.getWorkspace("ws_1");
    expect(rec.calls.map((call) => call.url)).toEqual(["/api/console/workspaces", "/api/console/workspaces/ws_1"]);
  });

  test("creates a workspace with POST {base} {name}", async () => {
    const detail = { workspaceId: "ws_9", name: "New" };
    const rec = recordingFetch(Response.json(detail, { status: 201 }));
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    expect(await api.createWorkspace("New")).toEqual(detail as never);
    expect(rec.calls[0]).toMatchObject({ url: "/api/workspaces", method: "POST", body: { name: "New" } });
    expect(rec.calls[0]!.headers["content-type"]).toBe("application/json");
  });

  test("reads, renames and deletes a workspace", async () => {
    const rec = recordingFetch(Response.json({}), Response.json({}), noContent());
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    await api.getWorkspace("ws_1");
    await api.renameWorkspace("ws_1", "Renamed", 4);
    expect(await api.deleteWorkspace("ws_1", "Renamed")).toBeUndefined();
    expect(rec.calls).toMatchObject([
      { url: "/api/workspaces/ws_1", method: "GET" },
      { url: "/api/workspaces/ws_1", method: "PATCH", body: { name: "Renamed", expectedRevision: 4 } },
      { url: "/api/workspaces/ws_1", method: "DELETE", body: { confirmName: "Renamed" } },
    ]);
  });

  test("lists members, changes a role, removes a member and leaves", async () => {
    const rec = recordingFetch(
      Response.json({ items: [{ membershipId: "wm_1" }] }),
      Response.json({ workspaceId: "ws_1", authorizationRevision: 5 }),
      noContent(),
      noContent(),
    );
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    expect(await api.listMembers("ws_1")).toEqual([{ membershipId: "wm_1" }] as never);
    await api.changeMemberRole("ws_1", "wm_1", "developer", 4);
    await api.removeMember("ws_1", "wm_1", 5);
    await api.leaveWorkspace("ws_1");
    expect(rec.calls).toMatchObject([
      { url: "/api/workspaces/ws_1/members", method: "GET" },
      {
        url: "/api/workspaces/ws_1/members/wm_1",
        method: "PATCH",
        body: { role: "developer", expectedRevision: 4 },
      },
      { url: "/api/workspaces/ws_1/members/wm_1", method: "DELETE", body: { expectedRevision: 5 } },
      { url: "/api/workspaces/ws_1/leave", method: "POST" },
    ]);
    expect(rec.calls[3]!.body).toBeUndefined();
  });

  test("lists, creates and revokes invitations", async () => {
    const created = { invitationId: "inv_1", inviteUrl: "https://example.test/join#abc", expiresAt: "2026-10-19T00:00:00.000Z" };
    const rec = recordingFetch(Response.json({ items: [] }), Response.json(created, { status: 201 }), noContent());
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    await api.listInvitations("ws_1");
    expect(await api.createInvitation("ws_1", { email: "new@example.com", role: "member" })).toEqual(created);
    await api.revokeInvitation("ws_1", "inv_1");
    expect(rec.calls).toMatchObject([
      { url: "/api/workspaces/ws_1/invitations", method: "GET" },
      { url: "/api/workspaces/ws_1/invitations", method: "POST", body: { email: "new@example.com", role: "member" } },
      { url: "/api/workspaces/ws_1/invitations/inv_1", method: "DELETE" },
    ]);
  });

  test("peeks and accepts an invitation with POST bodies, never the token in the URL", async () => {
    const preview = { workspaceName: "Acme", email: "new@example.com", role: "developer" };
    const accepted = { workspaceId: "ws_1", membershipId: "wm_2" };
    const rec = recordingFetch(Response.json(preview), Response.json(accepted));
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    expect(await api.peekInvitation("secret-token")).toEqual(preview as never);
    expect(await api.acceptInvitation("secret-token")).toEqual(accepted);
    expect(rec.calls).toMatchObject([
      { url: "/api/workspaces/invitations/peek", method: "POST", body: { token: "secret-token" } },
      { url: "/api/workspaces/invitations/accept", method: "POST", body: { token: "secret-token" } },
    ]);
    for (const call of rec.calls) expect(call.url).not.toContain("secret-token");
  });

  test("lists, creates and revokes credentials", async () => {
    const created = { credential: { credentialId: "cred_1" }, token: "msk_prod_X.secret" };
    const rec = recordingFetch(Response.json({ items: [] }), Response.json(created, { status: 201 }), Response.json(created), noContent());
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    await api.listCredentials("ws_1");
    const expiresAt = new Date("2027-01-01T00:00:00Z").toISOString();
    expect(await api.createCredential("ws_1", { name: "CI", packageNames: ["com.acme.app"], expiresAt })).toEqual(created as never);
    await api.createCredential("ws_1", { name: "Bare" });
    await api.revokeCredential("ws_1", "cred_1");
    expect(rec.calls).toMatchObject([
      { url: "/api/workspaces/ws_1/credentials", method: "GET" },
      {
        url: "/api/workspaces/ws_1/credentials",
        method: "POST",
        body: { name: "CI", packageNames: ["com.acme.app"], expiresAt: "2027-01-01T00:00:00.000Z" },
      },
      { url: "/api/workspaces/ws_1/credentials", method: "POST" },
      { url: "/api/workspaces/ws_1/credentials/cred_1", method: "DELETE" },
    ]);
    // Absent optional fields are left out of the body rather than sent as null.
    expect(rec.calls[2]!.body).toEqual({ name: "Bare" });
  });

  test("pages the audit log with before and limit", async () => {
    const page = { items: [], next: "evt_1" };
    const rec = recordingFetch(Response.json(page), Response.json(page));
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    expect(await api.listAudit("ws_1")).toEqual(page);
    await api.listAudit("ws_1", { before: "evt/2 3", limit: 25 });
    expect(rec.calls.map((call) => call.url)).toEqual([
      "/api/workspaces/ws_1/audit",
      "/api/workspaces/ws_1/audit?before=evt%2F2+3&limit=25",
    ]);
  });

  test("encodes ids so a hostile id cannot change the route", async () => {
    const rec = recordingFetch(Response.json({}), noContent());
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    await api.getWorkspace("ws_1/../members");
    await api.revokeCredential("ws_1", "a/b");
    expect(rec.calls.map((call) => call.url)).toEqual([
      "/api/workspaces/ws_1%2F..%2Fmembers",
      "/api/workspaces/ws_1/credentials/a%2Fb",
    ]);
  });

  test("the credentials mode is same-origin unless the host chooses otherwise", async () => {
    const rec = recordingFetch(Response.json({ items: [] }), Response.json({ items: [] }));
    await createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch }).listWorkspaces();
    await createWorkspaceApi({ basePath: "https://core.example.test/api/workspaces", fetch: rec.fetch, credentials: "include" }).listWorkspaces();
    expect(rec.calls.map((call) => call.credentials)).toEqual(["same-origin", "include"]);
    expect(rec.calls[1]!.url).toBe("https://core.example.test/api/workspaces");
  });

  test("looks up the global fetch at call time and sends the session cookie to the same origin only", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ items: [] })) as unknown as typeof fetch);
    try {
      const api = createWorkspaceApi({ basePath: "/api/workspaces" });
      await api.listWorkspaces();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toBe("/api/workspaces");
      expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createWorkspaceApi: errors", () => {
  test("parses the {error, error_description} body into a typed error", async () => {
    const rec = recordingFetch(
      Response.json({ error: "forbidden", error_description: "a developer cannot change a member to admin" }, { status: 403 }),
    );
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    const error = await api.changeMemberRole("ws_1", "wm_1", "admin", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "a developer cannot change a member to admin",
    });
  });

  test("falls back to the code, then the status, when the body has no description", async () => {
    const rec = recordingFetch(
      Response.json({ error: "unauthorized" }, { status: 401 }),
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    const unauthorized = await api.listWorkspaces().catch((e: unknown) => e);
    expect(unauthorized).toMatchObject({ status: 401, code: "unauthorized", message: "unauthorized" });
    const gateway = await api.listWorkspaces().catch((e: unknown) => e);
    expect(gateway).toMatchObject({ status: 502, code: "http_502", message: "Bad Gateway" });
  });

  test("a 409 membership_changed is recognized and shows the review-and-retry message", async () => {
    const rec = recordingFetch(
      Response.json({ error: "membership_changed", error_description: "membership_changed" }, { status: 409 }),
      Response.json({ error: "last_owner", error_description: "a workspace must keep at least one owner" }, { status: 409 }),
    );
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    const changed = await api.removeMember("ws_1", "wm_1", 3).catch((e: unknown) => e);
    expect(isWorkspaceChangedError(changed)).toBe(true);
    expect(errorMessage(changed)).toBe(WORKSPACE_CHANGED_MESSAGE);
    expect(WORKSPACE_CHANGED_MESSAGE).toBe("This workspace changed. Review and try again.");

    // Another 409 is a different failure and keeps the server's own explanation.
    const lastOwner = await api.removeMember("ws_1", "wm_2", 3).catch((e: unknown) => e);
    expect(isWorkspaceChangedError(lastOwner)).toBe(false);
    expect(errorMessage(lastOwner)).toBe("A workspace must keep at least one owner");
  });

  test("a Store refusal to delete a workspace that publishes miniapps asks to move or delete them", async () => {
    const rec = recordingFetch(Response.json({ error: "workspace_has_miniapps", count: 2 }, { status: 409 }));
    const api = createWorkspaceApi({ basePath: "/api/console/workspaces", fetch: rec.fetch });
    const refused = await api.deleteWorkspace("ws_1", "Acme").catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "workspace_has_miniapps" });
    expect(isWorkspaceChangedError(refused)).toBe(false);
    expect(errorMessage(refused)).toBe("Move or delete this workspace's miniapps before deleting it.");
  });

  test("a network failure becomes a status-0 error", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: failing });
    const error = await api.listWorkspaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
    expect(errorMessage(error)).toContain("Could not reach the server");
  });

  test("a successful response that is not JSON is an error, not undefined data", async () => {
    const rec = recordingFetch(new Response("<html></html>", { status: 200 }));
    const api = createWorkspaceApi({ basePath: "/api/workspaces", fetch: rec.fetch });
    const error = await api.listWorkspaces().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200, code: "invalid_response" });
  });

  test("codes the server sends without a description get readable messages", () => {
    expect(errorMessage(new WorkspaceApiError(401, "unauthorized", "unauthorized"))).toBe(
      "Your session has expired. Sign in again.",
    );
    expect(errorMessage(new WorkspaceApiError(403, "forbidden", "forbidden"))).toBe(
      "You do not have permission to do that.",
    );
    expect(errorMessage(new WorkspaceApiError(404, "workspace_not_found", "workspace_not_found"))).toBe(
      "This workspace no longer exists or you no longer have access to it.",
    );
    expect(errorMessage(new WorkspaceApiError(400, "invalid_request", "name must be 1-64 characters"))).toBe(
      "Name must be 1-64 characters",
    );
    expect(errorMessage(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
