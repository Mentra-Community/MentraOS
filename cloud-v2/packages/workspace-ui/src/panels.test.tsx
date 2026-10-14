import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemberView } from "@mentra/workspace-contract";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkspaceApi } from "./api";
import { WorkspaceApiError } from "./errors";
import {
  acceptErrorMessage,
  InvitationAcceptCard,
  InvitationAcceptView,
  isInvitationForOtherAccount,
  type InvitationLoad,
} from "./components/invitation-accept-view";
import { WorkspaceAuditPanel } from "./components/audit-panel";
import {
  InviteDialogBody,
  InvitationsScreen,
  PendingInvitationsScreen,
  WorkspaceInvitationsPanel,
  WorkspaceInviteDialog,
  WorkspacePendingInvitationsPanel,
} from "./components/invitations-panel";
import { CreateWorkspaceDialog, CreateWorkspaceForm } from "./components/create-workspace";
import { ROLE_DESCRIPTIONS } from "./roles";
import { QueryGate } from "./components/common";
import { WorkspaceMembersPanel } from "./components/members-panel";
import { WorkspacePicker } from "./components/workspace-picker";
import { deleteRefusalToShow, DeleteSection, LeaveSection, WorkspaceSettingsPanel } from "./components/settings-panel";
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
  START,
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
    expect(listed).toContain("olivia@acme.test");
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
      "dana@acme.test": ["member", "developer"],
      "max@acme.test": ["member", "developer"],
    });
    // Admins and owners are not theirs to change or remove, and neither is their own row.
    expect(labelsStartingWith(markup, "Remove ")).toEqual([
      "Remove dana@acme.test",
      "Remove max@acme.test",
    ]);
    expect(markup).toContain("olivia@acme.test");
    expect(markup).toContain("adam@acme.test");
  });

  test("an owner sees all four roles on every row but their own", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    const selects = selectOptions(markup, "Role");
    expect(Object.keys(selects).sort()).toEqual(
      ["adam@acme.test", "dana@acme.test", "max@acme.test", "olivia@acme.test"].sort(),
    );
    for (const options of Object.values(selects)) expect(options).toEqual(ALL_ROLES);
    expect(labelsStartingWith(markup, "Remove ")).toEqual([
      "Remove olivia@acme.test",
      "Remove adam@acme.test",
      "Remove dana@acme.test",
      "Remove max@acme.test",
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

  test("the viewer's own row has no role selector: another owner or an organization admin changes it", () => {
    const { api } = offlineApi();
    for (const role of ["owner", "admin"] as const) {
      const detail = detailFor(role);
      const markup = renderSeeded(
        api,
        { detail, members: membersFor(detail) },
        <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
      );
      expect(selectOptions(markup, "Role")).not.toHaveProperty("sam@acme.test");
      expect(markup).toContain("sam@acme.test");
    }
  });

  test("with showUserIds each member's Mentra user id is shown with a copy button", () => {
    const { api } = offlineApi();
    const detail = organizationAdminDetail();
    const shown = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} showUserIds />,
    );
    expect(shown).toContain(">u_1<");
    expect(labelsStartingWith(shown, "Copy the Mentra user id of ")).toEqual([
      "Copy the Mentra user id of olivia@acme.test",
      "Copy the Mentra user id of adam@acme.test",
      "Copy the Mentra user id of dana@acme.test",
      "Copy the Mentra user id of max@acme.test",
    ]);

    // Without it (the Developer Console, any viewer who is not an Organization Admin) ids stay hidden.
    const hidden = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(hidden).not.toContain(">u_1<");
    expect(labelsStartingWith(hidden, "Copy the Mentra user id")).toEqual([]);
  });

  test("a member imported from the Store who has not signed in yet is marked, and has no user id to copy", () => {
    const { api } = offlineApi();
    const detail = organizationAdminDetail();
    const members: MemberView[] = [
      ...membersFor(detail),
      { membershipId: "wm_pending", mentraUserId: null, email: "pat@acme.test", role: "developer", startedAt: START, pending: true },
      { membershipId: "wm_pending_owner", mentraUserId: null, email: null, role: "owner", startedAt: START, pending: true },
    ];
    const markup = renderSeeded(
      api,
      { detail, members },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} showUserIds />,
    );
    expect(markup.split(">Pending first sign-in<").length - 1).toBe(2);
    expect(markup).toContain("pat@acme.test");
    // Without an email the row still names something, never a blank or "null".
    expect(markup).toContain(">Imported member<");
    expect(markup).not.toContain(">null<");
    // Only signed-in members have a Mentra user id to copy.
    expect(labelsStartingWith(markup, "Copy the Mentra user id of ")).toHaveLength(OTHER_MEMBERS.length);
    // A pending member is still managed like anyone else.
    expect(labelsStartingWith(markup, "Remove ")).toContain("Remove pat@acme.test");

    const signedIn = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(signedIn).not.toContain("Pending first sign-in");
  });

  test("marks the viewer's own row", () => {
    const { api } = offlineApi();
    const detail = detailFor("admin");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).toContain(">You<");
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

  test("the public panel passes only api and workspaceId on: a smuggled test-only prop never shows a link", () => {
    const { api } = offlineApi();
    // The screen's `initialLink` is for tests; a caller that sneaks it past the types must not reach it.
    const smuggled = {
      api,
      workspaceId: WORKSPACE_ID,
      initialLink: { email: "leak@acme.test", role: "member", inviteUrl: "https://example.test/join#leaked" },
    };
    const markup = renderSeeded(
      api,
      { detail: detailFor("admin"), invitations: INVITATIONS },
      <WorkspaceInvitationsPanel {...(smuggled as { api: typeof api; workspaceId: string })} />,
    );
    expect(markup).not.toContain("https://example.test/join#leaked");
    expect(markup).not.toContain("leak@acme.test");
    expect(markup).not.toContain("Invitation sent to");
    expect(markup).toContain("newbie@acme.test");
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
    expect(members).toContain("dana@acme.test");

    const audit = await failed(
      <WorkspaceAuditPanel api={api} workspaceId={WORKSPACE_ID} />,
      { detail: admin, audit: { items: AUDIT_EVENTS, next: null } },
      ["detail", "audit"],
    );
    expect(audit).toContain(">dana@acme.test</strong> from");

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

  test("the delete warning is the host's: shown only when it passes one", () => {
    const { api } = offlineApi();
    const notice = "Miniapps stay published in the Mentra Miniapp Store.";
    const withNotice = renderSeeded(
      api,
      { detail: detailFor("owner") },
      <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} deleteNotice={notice} />,
    );
    expect(withNotice).toContain(notice);
    expect(withNotice).toContain('role="note"');
    const without = render(detailFor("owner"));
    expect(without).not.toContain('role="note"');
    expect(without).not.toContain("miniapps");
  });

  test("an organization admin who is not a member can delete but has nothing to leave", () => {
    const markup = render(organizationAdminDetail());
    expect(markup).toContain("Delete workspace");
    expect(markup).not.toContain("Leave workspace");
  });

  test("the only owner cannot leave: Leave is disabled and says why", () => {
    const { api } = offlineApi();
    const owner = detailFor("owner");
    const onlyOwner = renderSeeded(
      api,
      { detail: owner, members: membersFor(owner).filter((member) => member.membershipId === "wm_self" || member.role !== "owner") },
      <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(onlyOwner).toContain("You&#x27;re the only owner, so you can&#x27;t leave. Make someone else an owner first.");
    expect(onlyOwner).toMatch(/<button[^>]*aria-label="Leave workspace"[^>]*aria-describedby="[^"]+"[^>]*disabled=""/);
    // With another owner, Leave is offered.
    const twoOwners = renderSeeded(api, { detail: owner, members: membersFor(owner) }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
    expect(twoOwners).not.toContain("only owner");
    expect(twoOwners).not.toMatch(/<button[^>]*aria-label="Leave workspace"[^>]*disabled=""/);
    // A member is never the only owner.
    expect(render(detailFor("member"))).not.toMatch(/<button[^>]*aria-label="Leave workspace"[^>]*disabled=""/);
  });

  test("a refused leave or delete says why next to its own button, not at the bottom of the card", () => {
    const lastOwner = new WorkspaceApiError(409, "last_owner", "a workspace must keep at least one owner");
    const leave = renderToStaticMarkup(
      <LeaveSection workspaceName={WORKSPACE_NAME} onlyOwner={false} busy={false} error={lastOwner} onConfirm={() => {}} />,
    );
    expect(leave).toMatch(/<section aria-label="Leave workspace"[\s\S]*Leave workspace<\/button>[\s\S]*role="alert"[^>]*>A workspace must keep at least one owner<\/p>[\s\S]*<\/section>$/);
    const deleted = renderToStaticMarkup(
      <DeleteSection workspaceName={WORKSPACE_NAME} busy={false} error={new WorkspaceApiError(403, "forbidden", "forbidden")} onDelete={() => {}} />,
    );
    expect(deleted).toMatch(/Delete workspace<\/button><\/form><p role="alert"[^>]*>You do not have permission to do that.<\/p><\/section>$/);
  });

  test("a workspace a service holds says why it cannot be deleted, where the delete is, and offers no delete", () => {
    const { api } = offlineApi();
    const held = { ...detailFor("owner"), deletionHolds: [{ service: "store", reason: "owns_miniapps", count: 3 }] };
    const markup = renderSeeded(
      api,
      { detail: held },
      <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} deleteNotice="Host notice about deleting." />,
    );
    const section = /<section aria-label="Delete workspace"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(section).toContain(
      "This workspace still owns 3 published miniapps. Delete them in the Developer Console first.",
    );
    // The reason names the confirmation field and the button, both disabled; the host's notice about what
    // deleting does waits until deleting is possible.
    const reasonId = /<p id="([^"]+)"[^>]*>This workspace still owns/.exec(section)?.[1];
    expect(reasonId).toBeTruthy();
    expect(section).toMatch(new RegExp(`<input[^>]*aria-describedby="${reasonId}"[^>]*disabled=""`));
    expect(section).toMatch(new RegExp(`<button[^>]*aria-describedby="${reasonId}"[^>]*disabled=""[^>]*>Delete workspace</button>`));
    expect(section).not.toContain("Host notice about deleting.");
    // Once the miniapps are gone, the person checks again here rather than reloading the page.
    expect(section).toMatch(/<button[^>]*>Check again<\/button>/);

    // An organization admin sees the same: holds bind everyone.
    const admin = renderSeeded(
      api,
      { detail: { ...organizationAdminDetail(), deletionHolds: held.deletionHolds } },
      <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(admin).toContain("This workspace still owns 3 published miniapps.");

    // Without holds (or from a server that predates them) nothing is said and the form works as before.
    for (const detail of [{ ...detailFor("owner"), deletionHolds: [] }, detailFor("owner")]) {
      const free = renderSeeded(api, { detail }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
      expect(free).not.toContain("still owns");
      expect(free).not.toContain("Check again");
      expect(free).not.toMatch(/<input[^>]*aria-labelledby="[^"]+"[^>]*disabled=""/);
    }
  });

  test("a delete refused because a service holds the workspace says why in words", () => {
    const refused = new WorkspaceApiError(409, "workspace_has_holds", "workspace_has_holds", [
      { service: "store", reason: "owns_miniapps", count: 1 },
    ]);
    const markup = renderToStaticMarkup(
      <DeleteSection workspaceName={WORKSPACE_NAME} busy={false} error={refused} onDelete={() => {}} />,
    );
    expect(markup).toContain(
      'role="alert"',
    );
    expect(markup).toContain("This workspace still owns 1 published miniapp. Delete it in the Developer Console first.");
  });

  test("a refusal for holds stops showing once a later look-up of the workspace has replaced it", () => {
    const held = new WorkspaceApiError(409, "workspace_has_holds", "held", [{ service: "store", reason: "owns_miniapps", count: 1 }]);
    const submittedAt = 1_000;
    // While the workspace is held, the note says it; the refusal would only repeat it.
    expect(deleteRefusalToShow(held, { held: true, submittedAt, detailUpdatedAt: 2_000 })).toBeNull();
    // Looked up again after the refusal (Check again, focus) and no longer held: the refusal is stale.
    expect(deleteRefusalToShow(held, { held: false, submittedAt, detailUpdatedAt: 2_000 })).toBeNull();
    // Not looked up since (the refetch failed): the refusal is the only word on why.
    expect(deleteRefusalToShow(held, { held: false, submittedAt, detailUpdatedAt: 500 })).toBe(held);
    // Every other refusal stays until the next attempt.
    const forbidden = new WorkspaceApiError(403, "forbidden", "forbidden");
    expect(deleteRefusalToShow(forbidden, { held: false, submittedAt, detailUpdatedAt: 2_000 })).toBe(forbidden);
    expect(deleteRefusalToShow(null, { held: false, submittedAt: 0, detailUpdatedAt: 0 })).toBeNull();
  });

  test("every field has an accessible name: the name field and the delete confirmation", () => {
    const markup = render(detailFor("owner"));
    for (const input of markup.match(/<input[^>]*>/g) ?? []) {
      const id = /id="([^"]+)"/.exec(input)?.[1];
      expect(id).toBeTruthy();
      expect(markup).toContain(`for="${id}"`);
    }
    const confirm = /<input[^>]*aria-labelledby="([^"]+)"[^>]*>/.exec(markup);
    expect(confirm).not.toBeNull();
    expect(markup).toMatch(new RegExp(`<label[^>]*id="${confirm![1]}"[^>]*>.*to confirm</span></label>`));
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
    // Each event is a sentence about what happened, with who did it beside it.
    expect(markup).toContain("Changed <strong");
    expect(markup).toContain(">dana@acme.test</strong> from <strong");
    expect(markup).toContain(">Developer</strong>");
    expect(markup).toContain("Created the key <strong");
    expect(markup).toContain(">CI publisher</strong> (com.acme.scanner)");
    expect(markup).toContain("by olivia@acme.test");
    expect(markup).toContain("by Store service, for dana@acme.test");
    // The raw record stays one click away, closed.
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Show details");
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
    expect(developer).not.toContain("dana@acme.test");
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
  const preview = {
    invitationId: "winv_1",
    workspaceId: WORKSPACE_ID,
    workspaceName: WORKSPACE_NAME,
    email: "newbie@acme.test",
    role: "developer" as const,
    invitedByEmail: "olivia@acme.test",
    expiresAt: "2026-10-26T01:25:48.000Z",
  };

  const card = (
    load: InvitationLoad,
    acceptError: unknown = null,
    extra: Partial<Parameters<typeof InvitationAcceptCard>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <InvitationAcceptCard
        load={load}
        onRetry={() => {}}
        onAccept={() => {}}
        accepting={false}
        acceptError={acceptError}
        {...extra}
      />,
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
    for (const error of [
      new WorkspaceApiError(404, "invitation_not_found", "invitation not found"),
      new WorkspaceApiError(410, "invitation_expired", "this invitation has expired"),
    ]) {
      const markup = card({ status: "error", error });
      expect(markup).toContain("This invitation is no longer valid");
      expect(markup).not.toContain("Accept invitation");
    }
    // A 404 that is not Core saying so (a proxy's error page) says nothing about the invitation.
    const proxy = card({ status: "error", error: new WorkspaceApiError(404, "http_404", "Not Found") });
    expect(proxy).not.toContain("no longer valid");
    expect(proxy).toContain("Try again");
  });

  test("says who sent it, and to whom", () => {
    const signedIn = card({ status: "ready", preview }, null, { viewerEmail: "Newbie@Acme.test" });
    expect(signedIn).toContain(">olivia@acme.test</strong> invited you to join <strong");
    expect(signedIn).toContain("as Developer.");
    expect(signedIn).toContain("Sent to newbie@acme.test");
    expect(signedIn).toContain("Accept invitation");
    // No inviter recorded (the system sent it).
    expect(card({ status: "ready", preview: { ...preview, invitedByEmail: null } })).toContain("You have been invited to join");
  });

  test("an invitation for another account says so up front and offers Switch account instead of Accept", () => {
    expect(isInvitationForOtherAccount(preview, "sam@acme.test")).toBe(true);
    expect(isInvitationForOtherAccount(preview, " NEWBIE@acme.test ")).toBe(false);
    expect(isInvitationForOtherAccount(preview, null)).toBe(false);
    expect(isInvitationForOtherAccount({ email: "" }, "sam@acme.test")).toBe(false);

    const markup = card({ status: "ready", preview }, null, {
      viewerEmail: "sam@acme.test",
      onSwitchAccount: () => {},
      onDismiss: () => {},
    });
    expect(markup).toContain("This invitation is for <strong");
    expect(markup).toContain(">newbie@acme.test</strong>. You&#x27;re signed in as <strong");
    expect(markup).toContain(">sam@acme.test</strong>.");
    expect(markup).toContain(">olivia@acme.test</strong> invited <strong");
    expect(markup).toContain(">Switch account<");
    expect(markup).toContain(">Dismiss<");
    expect(markup).not.toContain("Accept invitation");
    // Without a way to switch, it still never offers an Accept the server would refuse.
    const noSwitch = card({ status: "ready", preview }, null, { viewerEmail: "sam@acme.test" });
    expect(noSwitch).not.toContain("Accept invitation");
    expect(noSwitch).toContain("Sign in with that account to accept it.");
  });

  test("asks a signed-out visitor to sign in, and lets them retry once they have", () => {
    const markup = card({ status: "error", error: new WorkspaceApiError(401, "unauthorized", "unauthorized") });
    expect(markup).toContain("Sign in to view this invitation.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Accept invitation");
  });

  test("an accept refused by the server says why, plainly", () => {
    const markup = card(
      { status: "ready", preview },
      new WorkspaceApiError(403, "email_mismatch", "sign in with the verified email address this invitation was sent to"),
    );
    expect(markup).toContain("This invitation is for newbie@acme.test. To accept it, sign in with that address and make sure it");
    expect(acceptErrorMessage(new WorkspaceApiError(410, "invitation_expired", "x"), "a@b.test")).toStartWith(
      "This invitation is no longer valid.",
    );
    expect(acceptErrorMessage(new WorkspaceApiError(409, "already_member", "x"), "a@b.test")).toBe("You're already in this workspace.");
    expect(acceptErrorMessage(new WorkspaceApiError(500, "server_error", "server_error"), "a@b.test")).toBe(
      "The server ran into a problem. Try again.",
    );
  });
});

describe("pending invitations panel", () => {
  const render = (role: "owner" | "admin" | "developer", invitations = INVITATIONS) => {
    const { api } = offlineApi();
    return renderSeeded(
      api,
      { detail: detailFor(role), invitations },
      <WorkspacePendingInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
  };

  test("lists pending invitations with Resend and Revoke where the viewer could have sent them", () => {
    const owner = render("owner");
    expect(owner).toContain("Pending invitations");
    expect(labelsStartingWith(owner, "Resend invitation")).toEqual([
      "Resend invitation to newbie@acme.test",
      "Resend invitation to boss@acme.test",
    ]);
    expect(labelsStartingWith(owner, "Revoke invitation")).toEqual([
      "Revoke invitation for newbie@acme.test",
      "Revoke invitation for boss@acme.test",
    ]);
    const admin = render("admin");
    expect(labelsStartingWith(admin, "Resend invitation")).toEqual(["Resend invitation to newbie@acme.test"]);
    expect(admin).toContain("boss@acme.test");
    // The invite form lives in the dialog, not here.
    expect(owner).not.toContain("<form");
  });

  test("renders nothing for a viewer who cannot manage members, or when nothing is pending", () => {
    expect(render("developer")).toBe("");
    expect(render("owner", [])).toBe("");
  });

  test("a resent invitation shows its new link and says the earlier one stopped working", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("admin"), invitations: INVITATIONS },
      <PendingInvitationsScreen
        api={api}
        workspaceId={WORKSPACE_ID}
        initialLink={{ email: "newbie@acme.test", role: "member", inviteUrl: "https://example.test/join#new", resent: true }}
      />,
    );
    expect(markup).toContain("https://example.test/join#new");
    expect(markup).toContain("The earlier link no longer works.");
  });
});

describe("invite dialog", () => {
  test("asks for an email and a role, and explains the role", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("admin") },
      <InviteDialogBody api={api} workspaceId={WORKSPACE_ID} onClose={() => {}} />,
    );
    expect(markup).toContain("Email address");
    expect(markup).toContain('aria-label="Invitation role"');
    expect(markup).toContain(ROLE_DESCRIPTIONS.member);
    expect(markup).toContain("Send invitation");
    expect(markup).toContain("Cancel");
  });

  test("after sending it shows the link once, with Copy and Done", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("admin") },
      <InviteDialogBody
        api={api}
        workspaceId={WORKSPACE_ID}
        onClose={() => {}}
        initialLink={{ email: "friend@acme.test", role: "developer", inviteUrl: "https://example.test/join#one-time" }}
      />,
    );
    expect(markup).toContain("Invitation sent");
    expect(markup).toContain("https://example.test/join#one-time");
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Done");
    expect(markup).not.toContain("<form");
  });

  test("a developer cannot invite", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(
      api,
      { detail: detailFor("developer") },
      <InviteDialogBody api={api} workspaceId={WORKSPACE_ID} onClose={() => {}} />,
    );
    expect(markup).toContain("Only workspace admins can invite people.");
    expect(markup).not.toContain("<form");
  });

  test("the dialog renders its content only while open", () => {
    const { api } = offlineApi();
    const seed = { detail: detailFor("owner") };
    const closed = renderSeeded(
      api,
      seed,
      <WorkspaceInviteDialog api={api} workspaceId={WORKSPACE_ID} open={false} onClose={() => {}} />,
    );
    expect(closed).toContain("<dialog");
    expect(closed).not.toContain("Email address");
    const open = renderSeeded(
      api,
      seed,
      <WorkspaceInviteDialog api={api} workspaceId={WORKSPACE_ID} open onClose={() => {}} />,
    );
    expect(open).toContain(`Invite people to ${WORKSPACE_NAME}`);
    expect(open).toContain("Email address");
  });
});

describe("settings panel: general", () => {
  test("shows the workspace ID with a copy button, to everyone in the workspace", () => {
    for (const role of ["member", "owner"] as const) {
      const { api } = offlineApi();
      const markup = renderSeeded(api, { detail: detailFor(role) }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
      expect(markup).toContain("Workspace ID");
      expect(markup).toContain(`>${WORKSPACE_ID}<`);
      expect(markup).toContain('aria-label="Copy the workspace ID"');
    }
  });

  test("leaving and deleting sit in the danger zone", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(api, { detail: detailFor("owner") }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
    const zone = markup.indexOf("Danger zone");
    expect(zone).toBeGreaterThan(markup.indexOf("Workspace ID"));
    expect(markup.indexOf("Leave workspace")).toBeGreaterThan(zone);
    expect(markup.indexOf("Delete workspace")).toBeGreaterThan(zone);
  });
});

describe("creating a workspace", () => {
  test("asks only for a name", () => {
    const { api, requests } = offlineApi();
    const markup = renderSeeded(api, {}, <CreateWorkspaceForm api={api} onCreated={() => {}} onCancel={() => {}} />);
    expect(markup).toContain("Workspace name");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Create workspace<\/button>/);
    expect(markup).toContain("Cancel");
    expect(markup.match(/<input/g)).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  test("the dialog shows the form only while open", () => {
    const { api } = offlineApi();
    expect(renderSeeded(api, {}, <CreateWorkspaceDialog api={api} open={false} onClose={() => {}} onCreated={() => {}} />)).not.toContain(
      "Workspace name",
    );
    const open = renderSeeded(api, {}, <CreateWorkspaceDialog api={api} open onClose={() => {}} onCreated={() => {}} />);
    expect(open).toContain("Create a workspace");
    expect(open).toContain("Workspace name");
  });
});

describe("members panel: count and invitation card dismiss", () => {
  test("the member count shows beside the title once the list has loaded", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(api, { detail, members: membersFor(detail) }, <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />);
    expect(markup).toMatch(/Members<span[^>]*>5<\/span>/);
  });

  test("the invitation card offers Dismiss only when the host passes it", () => {
    const preview = {
      invitationId: "winv_1",
      workspaceId: WORKSPACE_ID,
      workspaceName: WORKSPACE_NAME,
      email: "newbie@acme.test",
      role: "member" as const,
      invitedByEmail: null,
      expiresAt: "2026-10-26T01:25:48.000Z",
    };
    const render = (onDismiss?: () => void) =>
      renderToStaticMarkup(
        <InvitationAcceptCard
          load={{ status: "ready", preview }}
          onRetry={() => {}}
          onAccept={() => {}}
          onDismiss={onDismiss}
          accepting={false}
          acceptError={null}
        />,
      );
    expect(render(() => {})).toContain(">Dismiss<");
    expect(render()).not.toContain(">Dismiss<");
  });
});
