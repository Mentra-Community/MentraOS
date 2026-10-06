import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkspaceApi } from "./api";
import { WorkspaceApiError } from "./errors";
import { InvitationAcceptCard, InvitationAcceptView, type InvitationLoad } from "./components/invitation-accept-view";
import { WorkspaceAuditPanel } from "./components/audit-panel";
import { InvitationsScreen, WorkspaceInvitationsPanel } from "./components/invitations-panel";
import { QueryGate } from "./components/common";
import { WorkspaceMembersPanel } from "./components/members-panel";
import { WorkspacePicker } from "./components/workspace-picker";
import { WorkspaceSettingsPanel } from "./components/settings-panel";
import { invitationPreviewQuery } from "./queries";
import {
  AUDIT_EVENTS,
  INVITATIONS,
  labelsStartingWith,
  membersFor,
  offlineApi,
  OTHER_MEMBERS,
  organizationAdminDetail,
  detailFor,
  renderAfterFailedRefetch,
  renderSeeded,
  selectOptions,
  WORKSPACE_ID,
  WORKSPACE_NAME,
} from "./test-fixtures";

const ALL_ROLES = ["member", "developer", "admin", "owner"];

describe("members panel: role controls follow the viewer's role", () => {
  test("a developer sees no role controls", () => {
    const { api, requests } = offlineApi();
    // A developer cannot read the member list at all, so nothing about the members renders.
    const detail = detailFor("developer");
    const restricted = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(restricted).toContain("Only workspace admins can see the member list.");
    expect(restricted).not.toContain("<select");
    expect(restricted).not.toContain("Remove");
    expect(restricted).not.toContain("olivia@acme.test");

    // Even if the member list were readable to them, no transition is theirs to make.
    const readable = detailFor("developer", ["workspace.members.read"]);
    const listed = renderSeeded(
      api,
      { detail: readable, members: membersFor(readable) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(listed).toContain("Olivia Owner");
    expect(listed).not.toContain("<select");
    expect(listed).not.toContain(">Remove<");
    expect(requests).toEqual([]);
  });

  test("an admin sees member and developer options only, and only on rows they may change", () => {
    const { api } = offlineApi();
    const detail = detailFor("admin");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(selectOptions(markup, "Role")).toEqual({
      "Dana Developer": ["member", "developer"],
      "Max Member": ["member", "developer"],
      "pending@acme.test": ["member", "developer"],
    });
    // Admins and owners are not theirs to change or remove, and neither is their own row.
    expect(labelsStartingWith(markup, "Remove ")).toEqual([
      "Remove Dana Developer",
      "Remove Max Member",
      "Remove pending@acme.test",
    ]);
    expect(markup).toContain("Olivia Owner");
    expect(markup).toContain("Adam Admin");
  });

  test("an owner sees all four roles on every row", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    const selects = selectOptions(markup, "Role");
    expect(Object.keys(selects).sort()).toEqual(
      ["Adam Admin", "Dana Developer", "Max Member", "Olivia Owner", "Sam Self", "pending@acme.test"].sort(),
    );
    for (const options of Object.values(selects)) expect(options).toEqual(ALL_ROLES);
    expect(labelsStartingWith(markup, "Remove ")).toEqual([
      "Remove Olivia Owner",
      "Remove Adam Admin",
      "Remove Dana Developer",
      "Remove Max Member",
      "Remove pending@acme.test",
    ]);
  });

  test("an organization admin with no membership acts as an owner", () => {
    const { api } = offlineApi();
    const detail = organizationAdminDetail();
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    for (const options of Object.values(selectOptions(markup, "Role"))) expect(options).toEqual(ALL_ROLES);
    expect(Object.keys(selectOptions(markup, "Role"))).toHaveLength(OTHER_MEMBERS.length);
    expect(markup).not.toContain(">You<");
  });

  test("an organization admin who is also a member uses the capabilities they were granted, not their member role", () => {
    const { api } = offlineApi();
    const detail = { ...organizationAdminDetail(), membership: { membershipId: "wm_self", role: "developer" as const } };
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    for (const options of Object.values(selectOptions(markup, "Role"))) expect(options).toEqual(ALL_ROLES);
  });

  test("marks the viewer's own row and pending members", () => {
    const { api } = offlineApi();
    const detail = detailFor("admin");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain(">You<");
    expect(markup).toContain("Pending first sign-in");
  });

  test("destructive actions start unconfirmed: removal needs a second, explicit step", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).not.toContain("Confirm remove");
  });

  test("shows a loading state, not an empty list, until the workspace has loaded", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(api, {}, <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />);
    expect(markup).toContain("Loading");
    expect(markup).not.toContain("No members");
  });
});

describe("invitations panel", () => {
  test("an owner can invite any role; an admin only members and developers", () => {
    const { api } = offlineApi();
    const roles = (role: "owner" | "admin") =>
      [
        ...renderSeeded(
          api,
          { detail: detailFor(role), invitations: INVITATIONS },
          <WorkspaceInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />,
        ).matchAll(/<select[^>]*aria-label="Invitation role"[^>]*>([\s\S]*?)<\/select>/g),
      ].flatMap((select) => [...select[1]!.matchAll(/<option value="([^"]+)"/g)].map((o) => o[1]));
    expect(roles("owner")).toEqual(ALL_ROLES);
    expect(roles("admin")).toEqual(["member", "developer"]);
  });

  test("revoke is offered only for invitations the viewer could have sent", () => {
    const { api } = offlineApi();
    const seed = (role: "owner" | "admin") =>
      renderSeeded(
        api,
        { detail: detailFor(role), invitations: INVITATIONS },
        <WorkspaceInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />,
      );
    expect(labelsStartingWith(seed("admin"), "Revoke invitation")).toEqual(["Revoke invitation for newbie@acme.test"]);
    expect(labelsStartingWith(seed("owner"), "Revoke invitation")).toEqual([
      "Revoke invitation for newbie@acme.test",
      "Revoke invitation for boss@acme.test",
    ]);
  });

  test("a developer sees no invitation controls", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("developer"), invitations: INVITATIONS },
      <WorkspaceInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain("Only workspace admins can manage invitations.");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("newbie@acme.test");
  });
});

describe("a failed background refetch keeps what was already loaded", () => {
  test("the invitation link stays on screen, with the invitations that were loaded", async () => {
    const { api } = offlineApi();
    const markup = await renderAfterFailedRefetch(
      api,
      { detail: detailFor("admin"), invitations: INVITATIONS },
      <InvitationsScreen
        api={api}
        workspaceId={WORKSPACE_ID}
        initialLink={{ email: "friend@acme.test", role: "member", inviteUrl: "https://example.test/join#one-time" }}
      />,
      ["detail", "invitations"],
    );
    expect(markup).toContain("https://example.test/join#one-time");
    expect(markup).toContain("newbie@acme.test");
    expect(markup).not.toContain("Try again");
  });

  test("the invitation link shows even before anything has loaded", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      {},
      <InvitationsScreen
        api={api}
        workspaceId={WORKSPACE_ID}
        initialLink={{ email: "friend@acme.test", role: "member", inviteUrl: "https://example.test/join#one-time" }}
      />,
    );
    expect(markup).toContain("Loading");
    expect(markup).toContain("https://example.test/join#one-time");
  });

  test("every panel keeps its content instead of swapping it for an error", async () => {
    const { api } = offlineApi();
    const admin = detailFor("admin");
    const failed = (ui: ReactElement, seed: Parameters<typeof renderSeeded>[1], failing: Parameters<typeof renderAfterFailedRefetch>[3]) =>
      renderAfterFailedRefetch(api, seed, ui, failing);

    const members = await failed(
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
      { detail: admin, members: membersFor(admin) },
      ["detail", "members"],
    );
    expect(members).toContain("Dana Developer");

    const audit = await failed(
      <WorkspaceAuditPanel api={api} workspaceId={WORKSPACE_ID} />,
      { detail: admin, audit: { items: AUDIT_EVENTS, next: null } },
      ["detail", "audit"],
    );
    expect(audit).toContain("Role changed");

    const settings = await failed(
      <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />,
      { detail: detailFor("owner") },
      ["detail"],
    );
    expect(settings).toContain("Save name");

    const picker = await failed(
      <WorkspacePicker api={api} value={WORKSPACE_ID} onChange={() => {}} />,
      { list: [detailFor("owner")] },
      ["list"],
    );
    expect(picker).toContain(WORKSPACE_NAME);

    for (const markup of [members, audit, settings, picker]) expect(markup).not.toContain("Try again");
  });
});

describe("QueryGate", () => {
  const retry = () => {};
  const gate = (result: { data: string | undefined; isError: boolean; error: unknown }) =>
    renderToStaticMarkup(
      <QueryGate result={{ ...result, refetch: retry }}>{(data) => <p>loaded: {data}</p>}</QueryGate>,
    );

  test("shows data whenever there is any, even when the last refetch failed", () => {
    expect(gate({ data: "old", isError: true, error: new WorkspaceApiError(0, "network_error", "offline") })).toContain("loaded: old");
    expect(gate({ data: "fresh", isError: false, error: null })).toContain("loaded: fresh");
  });

  test("with no data, loading shows Loading and a failure shows the error with a retry", () => {
    expect(gate({ data: undefined, isError: false, error: null })).toContain("Loading");
    const failed = gate({ data: undefined, isError: true, error: new WorkspaceApiError(502, "http_502", "Bad Gateway") });
    expect(failed).toContain("Bad Gateway");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("loaded:");
  });
});

describe("settings panel", () => {
  const render = (detail: ReturnType<typeof detailFor>) => {
    const { api } = offlineApi();
    return renderSeeded(api, { detail }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
  };

  test("a developer can only leave: no rename and no delete", () => {
    const markup = render(detailFor("developer"));
    expect(markup).toContain(WORKSPACE_NAME);
    expect(markup).toContain("Leave workspace");
    expect(markup).not.toContain("Save name");
    expect(markup).not.toContain("Delete workspace");
  });

  test("an admin can rename but not delete", () => {
    const markup = render(detailFor("admin"));
    expect(markup).toContain("Save name");
    expect(markup).not.toContain("Delete workspace");
  });

  test("an owner can delete only after typing the workspace name", () => {
    const markup = render(detailFor("owner"));
    expect(markup).toContain("Save name");
    expect(markup).toContain("Delete workspace");
    expect(markup).toContain(WORKSPACE_NAME);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Delete workspace<\/button>/);
  });

  test("an organization admin who is not a member can delete but has nothing to leave", () => {
    const markup = render(organizationAdminDetail());
    expect(markup).toContain("Delete workspace");
    expect(markup).not.toContain("Leave workspace");
  });
});

describe("audit panel", () => {
  test("an admin sees readable events, who did them, and a way to load more", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("admin"), audit: { items: AUDIT_EVENTS, next: "evt_1" } },
      <WorkspaceAuditPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain("Role changed");
    expect(markup).toContain("Credential created");
    expect(markup).toContain("olivia@acme.test");
    expect(markup).toContain("Store service");
    expect(markup).toContain("role: member → developer");
    expect(markup).toContain("Load more");
  });

  test("no Load more on the last page, and nothing at all for a developer", () => {
    const { api } = offlineApi();
    const last = renderSeeded(
      api,
      { detail: detailFor("admin"), audit: { items: AUDIT_EVENTS, next: null } },
      <WorkspaceAuditPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(last).not.toContain("Load more");
    const developer = renderSeeded(
      api,
      { detail: detailFor("developer"), audit: { items: AUDIT_EVENTS, next: null } },
      <WorkspaceAuditPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(developer).toContain("Only workspace admins can see the audit log.");
    expect(developer).not.toContain("Role changed");
  });
});

describe("workspace picker", () => {
  const list = [detailFor("owner"), { ...detailFor("member"), workspaceId: "ws_other", name: "Side Project" }];

  test("lists the caller's workspaces with the current one selected", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { list },
      <WorkspacePicker api={api} value="ws_other" onChange={() => {}} />,
    );
    expect(markup).toContain(WORKSPACE_NAME);
    expect(markup).toMatch(/<option value="ws_other" selected="">Side Project<\/option>/);
    expect(markup).not.toContain("New workspace");
  });

  test("offers creation only when asked to, and says so when there is nothing to pick", () => {
    const { api } = offlineApi();
    const creating = renderSeeded(api, { list }, <WorkspacePicker api={api} value={null} onChange={() => {}} allowCreate />);
    expect(creating).toContain("New workspace");
    expect(creating).toContain("Select a workspace");
    const empty = renderSeeded(api, { list: [] }, <WorkspacePicker api={api} value={null} onChange={() => {}} />);
    expect(empty).toContain("You are not in any workspace yet.");
  });
});

describe("invitation accept view", () => {
  const TOKEN = "invite-token-never-shown";
  const preview = { workspaceName: WORKSPACE_NAME, email: "newbie@acme.test", role: "developer" as const };

  const card = (load: InvitationLoad, acceptError: unknown = null) =>
    renderToStaticMarkup(
      <InvitationAcceptCard load={load} onRetry={() => {}} onAccept={() => {}} accepting={false} acceptError={acceptError} />,
    );

  test("tells the invitee what they are joining, as whom, and never echoes the token", () => {
    const { api } = offlineApi();
    const client = new QueryClient();
    client.setQueryData(invitationPreviewQuery(api, TOKEN).queryKey, preview);
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <InvitationAcceptView api={api} token={TOKEN} onAccepted={() => {}} />
      </QueryClientProvider>,
    );
    client.clear();
    expect(markup).toContain(WORKSPACE_NAME);
    expect(markup).toContain("Developer");
    expect(markup).toContain("newbie@acme.test");
    expect(markup).toContain("Accept invitation");
    expect(markup).not.toContain(TOKEN);
  });

  test("looks the invitation up by POST body, once", async () => {
    const client = new QueryClient();
    const api = createWorkspaceApi({ basePath: "/api/workspaces" });
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(preview)) as unknown as typeof fetch);
    try {
      await client.prefetchQuery(invitationPreviewQuery(api, TOKEN));
      expect(fetched.mock.calls).toHaveLength(1);
      const [url, init] = fetched.mock.calls[0]!;
      expect(url).toBe("/api/workspaces/invitations/peek");
      expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ token: TOKEN }) });
    } finally {
      fetched.mockRestore();
      client.clear();
    }
  });

  test("an unknown, used, revoked or expired invitation is one honest dead end", () => {
    for (const status of [404, 410]) {
      const markup = card({ status: "error", error: new WorkspaceApiError(status, "invitation_not_found", "invitation not found") });
      expect(markup).toContain("This invitation is no longer valid");
      expect(markup).not.toContain("Accept invitation");
    }
  });

  test("asks a signed-out visitor to sign in, and lets them retry once they have", () => {
    const markup = card({ status: "error", error: new WorkspaceApiError(401, "unauthorized", "unauthorized") });
    expect(markup).toContain("Sign in to view this invitation.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Accept invitation");
  });

  test("an accept refused by the server shows the server's reason", () => {
    const markup = card(
      { status: "ready", preview },
      new WorkspaceApiError(403, "email_mismatch", "sign in with the verified email address this invitation was sent to"),
    );
    expect(markup).toContain("Sign in with the verified email address this invitation was sent to");
  });
});
