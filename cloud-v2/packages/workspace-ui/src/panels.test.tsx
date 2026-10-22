import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemberView } from "@mentra/workspace-contract";
import { act, type ReactElement } from "react";
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
import { CreateWorkspaceForm } from "./components/create-workspace";
import { ROLE_DESCRIPTIONS } from "./roles";
import { QueryGate } from "./components/common";
import { WorkspaceMembersPanel } from "./components/members-panel";
import { WorkspaceSettingsPanel } from "./components/settings-panel";
import { byText, cleanup, click, find, findAll, press, render, setupDom, teardownDom } from "./test-dom";
import { invitationPreviewQuery, workspaceKeys } from "./queries";
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
    expect(labelsStartingWith(listed, "More for ")).toEqual([]);
    expect(requests).toEqual([]);
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
    // A pending member is still managed like anyone else: their row has the same menu (Change role, Remove).
    expect(labelsStartingWith(markup, "More for ")).toContain("More for pat@acme.test");
    expect(labelsStartingWith(markup, "More for ")).toContain("More for Imported member");

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

  test("destructive actions start unasked: nothing about removal is drawn until the row's menu is opened and Remove chosen", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).not.toContain("Remove from workspace");
    expect(markup).not.toContain("<dialog");
  });

  test("the list has no native role control and no panel: each row the viewer manages has one menu, and none opens a panel", () => {
    const { api } = offlineApi();
    const detail = detailFor("owner");
    const markup = renderSeeded(
      api,
      { detail, members: membersFor(detail) },
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />,
    );
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("type=\"checkbox\"");
    expect(markup).not.toContain("side-panel");
    expect(labelsStartingWith(markup, "Open ")).toEqual([]);
    // Everyone but the viewer (Sam, the owner).
    expect(labelsStartingWith(markup, "More for ")).toEqual([
      "More for olivia@acme.test",
      "More for adam@acme.test",
      "More for dana@acme.test",
      "More for max@acme.test",
    ]);
  });

  test("shows a loading state, not an empty list, until the workspace has loaded", () => {
    const { api } = offlineApi();
    const markup = renderSeeded(api, {}, <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />);
    expect(markup).toContain("Loading");
    expect(markup).not.toContain("No members");
  });
});

describe("members panel: the row menu's role controls follow the viewer's role", () => {
  beforeAll(setupDom);
  afterAll(teardownDom);
  afterEach(cleanup);

  /** Mounts the list over a cache that holds `detail` and `members`; no request is made. */
  async function mountMembers(detail: ReturnType<typeof detailFor>, members: MemberView[]) {
    const { api, requests } = offlineApi();
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
    client.setQueryData(workspaceKeys.detail(api, WORKSPACE_ID), detail);
    client.setQueryData(workspaceKeys.members(api, WORKSPACE_ID), members);
    await render(
      <QueryClientProvider client={client}>
        <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />
      </QueryClientProvider>,
    );
    return requests;
  }

  /**
   * What the row's menu for the member labelled `label` offers: the roles it can change to (null: no menu at all) and
   * whether Remove from workspace is there.
   */
  async function offeredFor(label: string): Promise<{ roles: string[] | null; remove: boolean }> {
    const menu = document.querySelector<HTMLButtonElement>(`button[aria-label="More for ${label}"]`);
    if (!menu) return { roles: null, remove: false };
    await click(menu);
    const items = findAll('[role="menuitem"]', document).map((item) => item.textContent!.trim());
    await press(menu, "Escape");
    return {
      roles: items.filter((text) => text.startsWith("Change role to ")).map((text) => text.slice("Change role to ".length)),
      remove: items.includes("Remove from workspace"),
    };
  }

  const LABELS = { self: "sam@acme.test", owner: "olivia@acme.test", admin: "adam@acme.test", developer: "dana@acme.test", member: "max@acme.test" };
  const ROLE_NAMES = ALL_ROLES.map((role) => role[0]!.toUpperCase() + role.slice(1));
  /** Every role but the one held: the menu never offers a no-op. */
  const otherThan = (held: string) => ROLE_NAMES.filter((name) => name !== held);

  test("an admin may change members and developers (to member or developer) and remove them, and nothing else", async () => {
    const detail = detailFor("admin");
    const requests = await mountMembers(detail, membersFor(detail));
    expect(await offeredFor(LABELS.developer)).toEqual({ roles: ["Member"], remove: true });
    expect(await offeredFor(LABELS.member)).toEqual({ roles: ["Developer"], remove: true });
    // Admins and owners are not theirs to change or remove, and neither is their own row.
    expect(await offeredFor(LABELS.owner)).toEqual({ roles: null, remove: false });
    expect(await offeredFor(LABELS.admin)).toEqual({ roles: null, remove: false });
    expect(await offeredFor(LABELS.self)).toEqual({ roles: null, remove: false });
    expect(requests).toEqual([]);
  });

  test("an owner sees every other role and Remove on every row but their own", async () => {
    const detail = detailFor("owner");
    await mountMembers(detail, membersFor(detail));
    expect(await offeredFor(LABELS.owner)).toEqual({ roles: otherThan("Owner"), remove: true });
    expect(await offeredFor(LABELS.admin)).toEqual({ roles: otherThan("Admin"), remove: true });
    expect(await offeredFor(LABELS.developer)).toEqual({ roles: otherThan("Developer"), remove: true });
    expect(await offeredFor(LABELS.member)).toEqual({ roles: otherThan("Member"), remove: true });
    expect(await offeredFor(LABELS.self)).toEqual({ roles: null, remove: false });
  });

  test("an organization admin with no membership acts as an owner on every row", async () => {
    const detail = organizationAdminDetail();
    await mountMembers(detail, membersFor(detail));
    expect(await offeredFor(LABELS.owner)).toEqual({ roles: otherThan("Owner"), remove: true });
    expect(await offeredFor(LABELS.admin)).toEqual({ roles: otherThan("Admin"), remove: true });
    expect(await offeredFor(LABELS.developer)).toEqual({ roles: otherThan("Developer"), remove: true });
    expect(await offeredFor(LABELS.member)).toEqual({ roles: otherThan("Member"), remove: true });
    expect(document.body.textContent).not.toContain("You");
  });

  test("an organization admin who is also a member uses the capabilities they were granted, not their member role", async () => {
    const detail = { ...organizationAdminDetail(), membership: { membershipId: "wm_self", role: "developer" as const } };
    await mountMembers(detail, membersFor(detail));
    expect((await offeredFor(LABELS.owner)).roles).toEqual(otherThan("Owner"));
    expect((await offeredFor(LABELS.admin)).roles).toEqual(otherThan("Admin"));
    expect((await offeredFor(LABELS.developer)).roles).toEqual(otherThan("Developer"));
    expect((await offeredFor(LABELS.member)).roles).toEqual(otherThan("Member"));
    // Their own row is still theirs alone: another owner or an organization admin changes it.
    expect(await offeredFor(LABELS.self)).toEqual({ roles: null, remove: false });
  });

  test("a developer who can read the list has nothing to change or remove", async () => {
    const detail = detailFor("developer", ["workspace.members.read"]);
    await mountMembers(detail, membersFor(detail));
    for (const label of [LABELS.owner, LABELS.admin, LABELS.member]) {
      expect(await offeredFor(label)).toEqual({ roles: null, remove: false });
    }
  });

  test("removal asks first, in a dialog, and the row's menu is the list's only role control", async () => {
    const detail = detailFor("owner");
    const requests = await mountMembers(detail, membersFor(detail));
    expect(document.querySelectorAll("select")).toHaveLength(0);
    await click(find(`button[aria-label="More for ${LABELS.developer}"]`));
    await click(byText("Remove from workspace", '[role="menuitem"]'));
    const dialog = find<HTMLDialogElement>("dialog[open]");
    expect(find("h2", dialog).textContent).toBe("Remove dana@acme.test from this workspace?");
    expect(byText("Remove", "button", dialog)).toBeTruthy();
    expect(byText("Cancel", "button", dialog)).toBeTruthy();
    await act(async () => {});
    expect(document.querySelectorAll("select")).toHaveLength(0);
    // Asking sent nothing.
    expect(requests).toEqual([]);
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

  test("a row's menu is offered only for invitations the viewer could have sent", () => {
    const { api } = offlineApi();
    const seed = (role: "owner" | "admin") =>
      renderSeeded(
        api,
        { detail: detailFor(role), invitations: INVITATIONS },
        <WorkspaceInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />,
      );
    expect(labelsStartingWith(seed("admin"), "More for ")).toEqual(["More for newbie@acme.test"]);
    expect(labelsStartingWith(seed("owner"), "More for ")).toEqual(["More for newbie@acme.test", "More for boss@acme.test"]);
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

    for (const markup of [members, audit, settings]) expect(markup).not.toContain("Try again");
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

  test("an owner can delete, but the workspace's name is asked for only in the dialog the button opens", () => {
    const markup = render(detailFor("owner"));
    expect(markup).toContain("Save name");
    expect(markup).toMatch(/<button[^>]*>Delete workspace<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete workspace<\/button>/);
    // Nothing to type until it asks: the page holds no dialog, and no field for the name.
    expect(markup).not.toContain("to confirm");
    expect(markup).not.toContain("<dialog");
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
      "This workspace still owns 3 miniapps. Delete them in the Developer Console first.",
    );
    // The reason names the button, which is disabled; the host's notice about what deleting does waits until
    // deleting is possible.
    const reasonId = /<p id="([^"]+)"[^>]*>This workspace still owns/.exec(section)?.[1];
    expect(reasonId).toBeTruthy();
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
    expect(admin).toContain("This workspace still owns 3 miniapps.");

    // Without holds (or from a server that predates them) nothing is said and the form works as before.
    for (const detail of [{ ...detailFor("owner"), deletionHolds: [] }, detailFor("owner")]) {
      const free = renderSeeded(api, { detail }, <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
      expect(free).not.toContain("still owns");
      expect(free).not.toContain("Check again");
      expect(free).not.toMatch(/<button[^>]*aria-describedby="[^"]+"[^>]*disabled=""[^>]*>Delete workspace<\/button>/);
    }
  });

  test("every field has an accessible name", () => {
    const markup = render(detailFor("owner"));
    const inputs = markup.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(1);
    for (const input of inputs) {
      const id = /id="([^"]+)"/.exec(input)?.[1];
      expect(id).toBeTruthy();
      expect(markup).toContain(`for="${id}"`);
    }
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

  test("someone already in a workspace is told to leave it first: no Accept, Decline stays, expiry is relative", () => {
    const soon = { ...preview, expiresAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString() };
    const markup = card({ status: "ready", preview: soon }, null, {
      viewerEmail: "newbie@acme.test",
      inWorkspace: { name: "Side Project" },
      leaveAction: <a href="/w/ws_side/settings">Leave Side Project</a>,
      onDecline: () => {},
    });
    expect(markup).toContain("You&#x27;re in <strong");
    expect(markup).toContain(">Side Project</strong>. Leave it to join <strong");
    expect(markup).toContain("Leave Side Project");
    expect(markup).toContain("Decline");
    expect(markup).not.toContain("Accept invitation");
    expect(markup).toContain("Expires in 3 days");
    // Someone else's invitation says that first, and is not asked to leave anything.
    const other = card({ status: "ready", preview }, null, { viewerEmail: "sam@acme.test", inWorkspace: { name: "Side Project" }, onSwitchAccount: () => {} });
    expect(other).toContain("This invitation is for <strong");
    expect(other).not.toContain("Leave it to join");
    // Not in a workspace: plain Accept.
    expect(card({ status: "ready", preview }, null, { viewerEmail: "newbie@acme.test", inWorkspace: null })).toContain("Accept invitation");
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

  test("lists pending invitations with a menu where the viewer could have sent them; Resend and Revoke are in it", () => {
    const owner = render("owner");
    expect(owner).toContain("Pending invitations");
    expect(labelsStartingWith(owner, "More for ")).toEqual(["More for newbie@acme.test", "More for boss@acme.test"]);
    // Nothing destructive is drawn until a row's menu is opened.
    expect(owner).not.toContain("Resend");
    expect(owner).not.toContain("Revoke");
    const admin = render("admin");
    expect(labelsStartingWith(admin, "More for ")).toEqual(["More for newbie@acme.test"]);
    expect(admin).toContain("boss@acme.test");
    // The invite form lives in the dialog, not here.
    expect(owner).not.toContain("<form");
  });

  test("is a table of address, role and when it expires, newest first", () => {
    const now = Date.now();
    const day = 86_400_000;
    const invitations = [
      { invitationId: "inv_old", email: "old@acme.test", role: "member" as const, expiresAt: new Date(now + 2 * day).toISOString(), invitedByMembershipId: null },
      { invitationId: "inv_new", email: "new@acme.test", role: "admin" as const, expiresAt: new Date(now + 6 * day + 3_600_000).toISOString(), invitedByMembershipId: null },
    ];
    const markup = render("owner", invitations);
    for (const heading of ["Email", "Role", "Expires"]) expect(markup).toContain(`>${heading}</th>`);
    expect(markup.indexOf("new@acme.test")).toBeLessThan(markup.indexOf("old@acme.test"));
    expect(markup).toContain("In 6 days");
    expect(markup).toContain("In 2 days");
    expect(markup).not.toContain("Expires Oct");
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
