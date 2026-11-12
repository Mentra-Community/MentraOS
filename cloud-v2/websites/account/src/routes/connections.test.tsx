import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CONNECTIONS_SIGN_IN_PATH, createConnectionsApi, type Connection, type ConnectionsApi, type ConnectionsResult, type RevokeResult } from "../lib/connections-api";
import { isSignInReturn, loadConnections, revokeConnection } from "../lib/connections-flow";
import { ConnectionsView, grantedText } from "./connections";

const NOTES: Connection = { clientId: "mwc_notes", name: "Notes", scopes: ["openid", "email"], grantedAt: "2026-11-11T19:00:00.000Z" };
const PAPERWORK: Connection = { clientId: "mwc_paperwork", name: "Paperwork", scopes: ["openid"], grantedAt: null };

function fakeApi(overrides: { list?: ConnectionsResult; revoke?: RevokeResult } = {}) {
  const api = {
    list: mock(async (): Promise<ConnectionsResult> => overrides.list ?? { kind: "ok", connections: [NOTES, PAPERWORK] }),
    revoke: mock(async (_clientId: string): Promise<RevokeResult> => overrides.revoke ?? { kind: "ok" }),
  };
  const typed: ConnectionsApi = api;
  void typed;
  return api;
}

function respond(status: number, body: unknown) {
  return mock(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("Connected apps", () => {
  test("lists each site with what it can see and when it was allowed, and a Revoke button", () => {
    const html = renderToStaticMarkup(<ConnectionsView connections={[NOTES, PAPERWORK]} notice="none" busy={null} onRevoke={() => undefined} />);
    expect(html).toContain("Notes");
    expect(html).toContain("Read basic information");
    expect(html).not.toContain(" · ");
    expect(html).toContain("Allowed Nov 11, 2026");
    expect(html).toContain('aria-label="Revoke Notes"');
    expect(html).toContain('aria-label="Revoke Paperwork"');
    expect(html).not.toContain("disabled");
  });

  test("says so when nothing is connected", () => {
    const html = renderToStaticMarkup(<ConnectionsView connections={[]} notice="none" busy={null} onRevoke={() => undefined} />);
    expect(html).toContain("No sites are connected to your Mentra account.");
    expect(html).not.toContain("Revoke</button>");
  });

  test("every button waits while one site is being revoked, and a failure is said", () => {
    const html = renderToStaticMarkup(<ConnectionsView connections={[NOTES, PAPERWORK]} notice="revoke-failed" busy="mwc_notes" onRevoke={() => undefined} />);
    expect(html).toContain("Revoking…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("That site could not be revoked. Try again.");
  });

  test("a site's name is text, never markup", () => {
    const html = renderToStaticMarkup(
      <ConnectionsView connections={[{ ...NOTES, name: "<script>alert(1)</script>" }]} notice="none" busy={null} onRevoke={() => undefined} />,
    );
    expect(html).not.toContain("<script>");
  });

  test("the grant date is shown only when it is one", () => {
    expect(grantedText("2026-01-02T23:59:59.000Z")).toBe("Allowed Jan 2, 2026");
    expect(grantedText(null)).toBe("");
    expect(grantedText("yesterday")).toBe("");
  });
});

describe("the Connected apps flow", () => {
  test("a signed-in person sees their list", async () => {
    const navigate = mock((_url: string) => undefined);
    expect(await loadConnections({ api: fakeApi(), navigate }, false)).toEqual({ kind: "list", connections: [NOTES, PAPERWORK], notice: "none" });
    expect(navigate).not.toHaveBeenCalled();
  });

  test("without a session the browser goes through sign-in once, and never round again", async () => {
    const navigate = mock((_url: string) => undefined);
    const api = fakeApi({ list: { kind: "signed-out" } });
    expect(await loadConnections({ api, navigate }, false)).toEqual({ kind: "redirecting" });
    expect(navigate.mock.calls).toEqual([[CONNECTIONS_SIGN_IN_PATH]]);
    // Back from sign-in and still signed out: stop and say so.
    expect(await loadConnections({ api, navigate }, true)).toEqual({ kind: "sign-in-failed" });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("the return from sign-in is recognised by its query", () => {
    expect(isSignInReturn("?code=abc&state=s&iss=https%3A%2F%2Faccount.example")).toBe(true);
    expect(isSignInReturn("?error=access_denied")).toBe(true);
    expect(isSignInReturn("")).toBe(false);
    expect(isSignInReturn("?utm=x")).toBe(false);
  });

  test("revoking removes the site from the list; a failure keeps it and says so", async () => {
    const navigate = mock((_url: string) => undefined);
    const api = fakeApi();
    expect(await revokeConnection({ api, navigate }, [NOTES, PAPERWORK], "mwc_notes")).toEqual({ kind: "list", connections: [PAPERWORK], notice: "none" });
    expect(api.revoke.mock.calls).toEqual([["mwc_notes"]]);
    expect(await revokeConnection({ api: fakeApi({ revoke: { kind: "error" } }), navigate }, [NOTES], "mwc_notes")).toEqual({ kind: "list", connections: [NOTES], notice: "revoke-failed" });
    expect(await revokeConnection({ api: fakeApi({ revoke: { kind: "rate-limited" } }), navigate }, [NOTES], "mwc_notes")).toEqual({ kind: "list", connections: [NOTES], notice: "rate-limited" });
    expect(await revokeConnection({ api: fakeApi({ revoke: { kind: "signed-out" } }), navigate }, [NOTES], "mwc_notes")).toEqual({ kind: "redirecting" });
    expect(navigate.mock.calls).toEqual([[CONNECTIONS_SIGN_IN_PATH]]);
  });
});

describe("the Connected apps calls", () => {
  test("list: same-origin, uncached, and only well-formed entries", async () => {
    const fetchImpl = respond(200, { connections: [NOTES, { clientId: 7 }, PAPERWORK, null] });
    expect(await createConnectionsApi(fetchImpl).list()).toEqual({ kind: "ok", connections: [NOTES, PAPERWORK] });
    expect(fetchImpl.mock.calls[0]).toEqual(["/oidc/connections", { credentials: "same-origin", cache: "no-store" }]);
    expect(await createConnectionsApi(respond(401, { error: "sign_in_required" })).list()).toEqual({ kind: "signed-out" });
    expect(await createConnectionsApi(respond(503, {})).list()).toEqual({ kind: "error" });
    expect(await createConnectionsApi(respond(200, { connections: "none" })).list()).toEqual({ kind: "error" });
    const offline = mock(async () => {
      throw new TypeError("offline");
    });
    expect(await createConnectionsApi(offline).list()).toEqual({ kind: "error" });
  });

  test("revoke posts the client and reads the answer", async () => {
    const fetchImpl = respond(200, { revoked: true });
    expect(await createConnectionsApi(fetchImpl).revoke("mwc_notes")).toEqual({ kind: "ok" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/oidc/connections/revoke");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ clientId: "mwc_notes" }) });
    expect(await createConnectionsApi(respond(401, {})).revoke("mwc_notes")).toEqual({ kind: "signed-out" });
    expect(await createConnectionsApi(respond(429, {})).revoke("mwc_notes")).toEqual({ kind: "rate-limited" });
    expect(await createConnectionsApi(respond(403, {})).revoke("mwc_notes")).toEqual({ kind: "error" });
  });
});
