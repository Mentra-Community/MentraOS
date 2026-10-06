import { describe, expect, spyOn, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { createWorkspaceApi } from "./api";
import {
  createCredentialAndReveal,
  CredentialsScreen,
  expiryFromDateInput,
  parsePackageNames,
  secretReducer,
  WorkspaceCredentialsPanel,
  type SecretState,
} from "./components/credentials-panel";
import { workspaceMutationOptions } from "./queries";
import {
  CREDENTIALS,
  detailFor,
  offlineApi,
  organizationAdminDetail,
  renderAfterFailedRefetch,
  renderSeeded,
  TOKEN,
  WORKSPACE_ID,
} from "./test-fixtures";

/** The credentials screen as a developer sees it, with the one-time dialog in the given state. */
const screen = (secret: SecretState) => {
  const { api } = offlineApi();
  return renderSeeded(
    api,
    { detail: detailFor("developer"), credentials: CREDENTIALS },
    <CredentialsScreen api={api} workspaceId={WORKSPACE_ID} initialSecret={secret} />,
  );
};

describe("credentials panel: the token is shown once", () => {
  test("the creation dialog shows the token with a copy button and says it will not be shown again", () => {
    const markup = screen({ status: "shown", name: "CI publisher", token: TOKEN });
    expect(markup).toContain(TOKEN);
    expect(markup).toMatch(/role="dialog"/);
    expect(markup).toContain("Copy credential");
    expect(markup).toContain("cannot be shown again");
    expect(markup).toContain(">Done<");
  });

  test("after the dialog closes the token is nowhere in the panel, though the credential is still listed", () => {
    const closed = secretReducer({ status: "shown", name: "CI publisher", token: TOKEN }, { type: "dismissed" });
    const markup = screen(closed);
    expect(markup).not.toContain(TOKEN);
    expect(markup).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).toContain("msk_prod_…abcd");
    expect(markup).toContain("CI publisher");
  });

  test("the secret state forgets the token entirely when dismissed", () => {
    const shown = secretReducer({ status: "hidden" }, { type: "created", name: "CI publisher", token: TOKEN });
    expect(shown).toEqual({ status: "shown", name: "CI publisher", token: TOKEN });
    const hidden = secretReducer(shown, { type: "dismissed" });
    expect(hidden).toEqual({ status: "hidden" });
    expect(JSON.stringify(hidden)).not.toContain(TOKEN);
  });

  test("a rendered panel, including its listing, never contains a token", () => {
    const { api, requests } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("developer"), credentials: CREDENTIALS },
      <WorkspaceCredentialsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).not.toMatch(/msk_[a-z0-9]+_[0-9A-Z]{26}\./);
    expect(markup).toContain("msk_prod_…abcd");
    expect(requests).toEqual([]);
  });

  test("creating a credential hands the token to the dialog and keeps it out of the query and mutation caches", async () => {
    const client = new QueryClient();
    const api = createWorkspaceApi({ basePath: "/api/workspaces" });
    const created = { ...CREDENTIALS[0]!, credentialId: "cred_new", name: "Fresh key" };
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return Response.json({ credential: created, token: TOKEN }, { status: 201 });
    }) as unknown as typeof fetch);
    const revealed: Array<{ name: string; token: string }> = [];
    try {
      const observer = new MutationObserver(
        client,
        workspaceMutationOptions(client, api, WORKSPACE_ID, (input: { name: string }) =>
          createCredentialAndReveal(api, WORKSPACE_ID, input, (secret) => revealed.push(secret)),
        ),
      );
      const result = await observer.mutate({ name: "Fresh key" });
      expect(result).toEqual(created);
      expect(revealed).toEqual([{ name: "Fresh key", token: TOKEN }]);
      const retained = JSON.stringify([
        client.getMutationCache().getAll().map((mutation) => mutation.state),
        client.getQueryCache().getAll().map((query) => query.state),
      ]);
      expect(retained).not.toContain(TOKEN);
    } finally {
      fetched.mockRestore();
      client.clear();
    }
  });
});

describe("credentials panel: the one-time dialog survives a failed refetch", () => {
  const shown: SecretState = { status: "shown", name: "CI publisher", token: TOKEN };

  test("when the detail and credential list fail a background refetch, the dialog and the list stay", async () => {
    const { api } = offlineApi();
    const markup = await renderAfterFailedRefetch(
      api,
      { detail: detailFor("developer"), credentials: CREDENTIALS },
      <CredentialsScreen api={api} workspaceId={WORKSPACE_ID} initialSecret={shown} />,
      ["detail", "credentials"],
    );
    expect(markup).toContain(TOKEN);
    expect(markup).toMatch(/role="dialog"/);
    expect(markup).toContain("CI publisher");
    expect(markup).not.toContain("Try again");
  });

  test("when there is nothing loaded to show, the dialog still renders next to the error", () => {
    const { api } = offlineApi();
    // No detail at all: the panel is still loading, yet the token (from a creation that just succeeded) is shown.
    const markup = renderSeeded(
      api,
      {},
      <CredentialsScreen api={api} workspaceId={WORKSPACE_ID} initialSecret={shown} />,
    );
    expect(markup).toContain("Loading");
    expect(markup).toContain(TOKEN);
  });
});

describe("credentials panel: who sees what", () => {
  test("a member cannot see or create credentials", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("member"), credentials: CREDENTIALS },
      <WorkspaceCredentialsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain("Credentials are available to developers, admins and owners.");
    expect(markup).not.toContain("CI publisher");
    expect(markup).not.toContain("<form");
  });

  test("only a member who can publish gets the create form; an organization admin outside the workspace gets a note", () => {
    const { api } = offlineApi();
    const render = (detail: ReturnType<typeof detailFor>) =>
      renderSeeded(
        api,
        { detail, credentials: CREDENTIALS },
        <WorkspaceCredentialsPanel api={api} workspaceId={WORKSPACE_ID} />,
      );
    for (const role of ["developer", "admin", "owner"] as const) {
      expect(render(detailFor(role))).toContain("Create credential");
    }
    // Core ties a key to its creator's membership, so an org admin who is not a member cannot create one...
    const outside = render(organizationAdminDetail());
    expect(outside).not.toContain("Create credential");
    expect(outside).not.toContain("<form");
    expect(outside).toContain("Only members of this workspace with the developer role or above can create credentials");
    // ...but still sees and can revoke the workspace's credentials.
    expect(outside).toContain("CI publisher");
    expect(outside).toContain('aria-label="Revoke CI publisher"');
    // The same for an org admin whose own membership is a role that cannot publish.
    const lowerMember = render({ ...organizationAdminDetail(), membership: { membershipId: "wm_self", role: "member" } });
    expect(lowerMember).not.toContain("Create credential");
  });

  test("a developer can create and revoke from the same panel, behind a confirm step", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("developer"), credentials: CREDENTIALS },
      <WorkspaceCredentialsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain("Create credential");
    expect(markup).toContain('aria-label="Revoke CI publisher"');
    expect(markup).not.toContain("Confirm revoke");
    expect(markup).toContain("com.acme.scanner");
  });
});

describe("credential form helpers", () => {
  test("package names split on commas and whitespace, and an empty field means no restriction", () => {
    expect(parsePackageNames(" com.acme.a, com.acme.b\ncom.acme.c  ")).toEqual(["com.acme.a", "com.acme.b", "com.acme.c"]);
    expect(parsePackageNames("com.acme.a,com.acme.a")).toEqual(["com.acme.a"]);
    expect(parsePackageNames("  ")).toBeUndefined();
  });

  test("an expiry date becomes the end of that local day as an ISO string, and blank means never", () => {
    expect(expiryFromDateInput("")).toBeNull();
    const iso = expiryFromDateInput("2027-03-04")!;
    expect(iso).toBe(new Date(2027, 2, 4, 23, 59, 59).toISOString());
    expect(iso).toMatch(/Z$/);
    expect(expiryFromDateInput("not a date")).toBeNull();
  });
});
