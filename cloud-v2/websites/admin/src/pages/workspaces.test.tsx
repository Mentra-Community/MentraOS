import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  capabilitiesForRole,
  type MemberView,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@mentra/workspace-contract";
import { createWorkspaceApi, WorkspaceSettingsPanel, workspaceKeys } from "@mentra/workspace-ui";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ApiError } from "../lib/api";
import {
  ORGANIZATION_WORKSPACES_KEY,
  parseMentraUserId,
  recoverWorkspaceOwnership,
  RecoverOwnershipForm,
  STORE_DELETE_NOTICE,
  WorkspacesPage,
} from "./workspaces";

// Synthetic data only. The query cache is seeded, so a server render never reaches the network.
const api = createWorkspaceApi({ basePath: "/api/workspaces" });
const ACME = "ws_acme";
const INVITE_TOKEN = "SYNTHETICINVITETOKEN0000000000000000000000000";

const acme: WorkspaceDetail = {
  workspaceId: ACME,
  name: "Acme Robotics",
  status: "active",
  authorizationRevision: 4,
  membership: { membershipId: "wm_self", role: "admin" },
  capabilities: [...capabilitiesForRole("admin")],
};
const globex: WorkspaceDetail = { ...acme, workspaceId: "ws_globex", name: "Globex" };

const members: MemberView[] = [
  { membershipId: "wm_1", mentraUserId: "u_1", email: "olivia@acme.test", name: "Olivia Owner", role: "owner", startedAt: "2026-09-01T10:00:00.000Z", pending: false },
];

const everyone: WorkspaceSummary[] = [
  { workspaceId: "ws_acme", name: "Acme Robotics", status: "active", authorizationRevision: 4 },
  { workspaceId: "ws_orphan", name: "Orphaned Lab", status: "active", authorizationRevision: 9 },
  { workspaceId: "ws_gone", name: "Closed Down", status: "deleted", authorizationRevision: 2 },
];

interface Seed {
  list?: WorkspaceDetail[];
  /** Workspaces the viewer can open without being in their list (an Organization Admin opening any). */
  details?: WorkspaceDetail[];
  members?: MemberView[];
  everyone?: { items: WorkspaceSummary[]; next: string | null };
  preview?: { workspaceName: string; email: string; role: "member" | "developer" | "admin" | "owner" };
}

function render(ui: ReactElement, seed: Seed = {}): string {
  const client = new QueryClient();
  if (seed.list) client.setQueryData(workspaceKeys.list(api), seed.list);
  for (const workspace of [...(seed.list ?? []), ...(seed.details ?? [])]) {
    client.setQueryData(workspaceKeys.detail(api, workspace.workspaceId), workspace);
  }
  if (seed.members) client.setQueryData(workspaceKeys.members(api, ACME), seed.members);
  if (seed.everyone) client.setQueryData(ORGANIZATION_WORKSPACES_KEY, { pages: [seed.everyone], pageParams: [undefined] });
  if (seed.preview) client.setQueryData(workspaceKeys.invitationPreview(api, INVITE_TOKEN), seed.preview);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

const page = (props: Partial<Parameters<typeof WorkspacesPage>[0]> = {}) => (
  <WorkspacesPage initialWorkspaceId={null} canAdminister={false} inviteToken={null} onInviteSpent={() => {}} {...props} />
);

/** Every `role="tab"` button: its label and whether it is selected. */
function tabs(markup: string): Array<[string, boolean]> {
  return [...markup.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)<\/button>/g)].map(match => [
    match[2]!,
    match[1] === "true",
  ]);
}

describe("workspaces page", () => {
  test("shows the picker, the five tabs and the members of the opening workspace", () => {
    const markup = render(page({ initialWorkspaceId: ACME }), { list: [acme, globex], members });
    expect(markup).toContain('aria-label="Workspace"');
    expect(markup).toContain(">Acme Robotics</option>");
    expect(markup).toContain(">Globex</option>");
    expect(tabs(markup)).toEqual([
      ["Members", true],
      ["Invitations", false],
      ["Keys", false],
      ["Settings", false],
      ["Audit", false],
    ]);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("olivia@acme.test");
    expect(markup).not.toContain("All workspaces");
  });

  test("names the open workspace above the tabs, even one the viewer is not a member of", () => {
    const orphan: WorkspaceDetail = { ...acme, workspaceId: "ws_orphan", name: "Orphaned Lab", membership: null };
    const markup = render(page({ initialWorkspaceId: "ws_orphan", canAdminister: true }), {
      list: [],
      details: [orphan],
      everyone: { items: [], next: null },
    });
    const heading = markup.indexOf("Orphaned Lab");
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(markup.indexOf('role="tablist"'));
    expect(markup).toContain("ws_orphan");
  });

  test("an Organization Admin sees members' Mentra user ids, which Recover ownership asks for; others do not", () => {
    const seed = { list: [acme], members, everyone: { items: everyone, next: null } };
    expect(render(page({ initialWorkspaceId: ACME, canAdminister: true }), seed)).toContain(">u_1<");
    expect(render(page({ initialWorkspaceId: ACME }), seed)).not.toContain(">u_1<");
  });

  test("offers creating a workspace", () => {
    expect(render(page({ initialWorkspaceId: ACME }), { list: [acme] })).toContain("New workspace");
  });

  test("without a workspace chosen it asks for one and shows no tabs", () => {
    const markup = render(page({ canAdminister: true }), { list: [] });
    expect(tabs(markup)).toEqual([]);
    expect(markup).toContain("Pick a workspace");
  });

  test("an Organization Admin also gets the paged list of every workspace, with Recover ownership", () => {
    const markup = render(page({ canAdminister: true }), { list: [], everyone: { items: everyone, next: "ws_gone" } });
    expect(markup).toContain("All workspaces");
    for (const name of ["Acme Robotics", "Orphaned Lab", "Closed Down"]) expect(markup).toContain(name);
    expect(markup).toContain('aria-label="Recover ownership of Orphaned Lab"');
    expect(markup).toContain('aria-label="Open Orphaned Lab"');
    expect(markup).toContain("Load more");
  });

  test("a deleted workspace is marked and cannot be opened or recovered", () => {
    const markup = render(page({ canAdminister: true }), { list: [], everyone: { items: everyone, next: null } });
    expect(markup).toContain("Deleted");
    expect(markup).not.toContain('aria-label="Recover ownership of Closed Down"');
    expect(markup).not.toContain('aria-label="Open Closed Down"');
    expect(markup).not.toContain("Load more");
  });

  test("someone who cannot administer the organization never sees the list", () => {
    const markup = render(page({ initialWorkspaceId: ACME }), { list: [acme], everyone: { items: everyone, next: null } });
    expect(markup).not.toContain("All workspaces");
    expect(markup).not.toContain("Recover ownership");
    expect(markup).not.toContain("Orphaned Lab");
  });

  test("an invitation link renders the accept view, without printing the token", () => {
    const preview = { workspaceName: "Initech", email: "sam@acme.test", role: "developer" } as const;
    const markup = render(page({ inviteToken: INVITE_TOKEN }), { list: [], preview });
    expect(markup).toContain("Join Initech");
    expect(markup).toContain("Accept invitation");
    expect(markup).not.toContain(INVITE_TOKEN);
  });

  test("an invitation that is still loading says so, and no invitation means no accept view", () => {
    expect(render(page({ inviteToken: INVITE_TOKEN }), { list: [] })).toContain("Invitation");
    expect(render(page(), { list: [] })).not.toContain("Accept invitation");
  });
});

describe("deleting a workspace", () => {
  test("warns that the Mentra Miniapp Store keeps the workspace's miniapps until an operator reassigns them", () => {
    const owner: WorkspaceDetail = {
      ...acme,
      membership: { membershipId: "wm_self", role: "owner" },
      capabilities: [...capabilitiesForRole("owner")],
    };
    const markup = render(<WorkspaceSettingsPanel api={api} workspaceId={ACME} deleteNotice={STORE_DELETE_NOTICE} />, {
      list: [owner],
    });
    expect(markup).toContain("Delete workspace");
    expect(markup).toContain("Miniapps this workspace publishes in the Mentra Miniapp Store stay published.");
    expect(markup).toContain("until a Store operator assigns them to another workspace");
  });
});

describe("recover ownership", () => {
  test("the Mentra user id must not be blank", () => {
    expect(parseMentraUserId("")).toEqual({ ok: false, message: "Enter a Mentra user id." });
    expect(parseMentraUserId("   \n")).toEqual({ ok: false, message: "Enter a Mentra user id." });
  });

  test("the id is trimmed, and otherwise kept exactly", () => {
    expect(parseMentraUserId("  Sam@Acme.test ")).toEqual({ ok: true, mentraUserId: "Sam@Acme.test" });
  });

  test("the form asks for the id and the workspace it is for", () => {
    const markup = renderToStaticMarkup(
      <RecoverOwnershipForm workspaceName="Orphaned Lab" pending={false} error={null} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain("Mentra user id");
    expect(markup).toContain("Orphaned Lab");
    expect(markup).toContain("Make owner");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain('role="alert"');
  });

  test("the form shows why the last attempt failed, and disables itself while sending", () => {
    const failed = renderToStaticMarkup(
      <RecoverOwnershipForm workspaceName="Orphaned Lab" pending={false} error="No Mentra user has that id." onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("No Mentra user has that id.");
    const sending = renderToStaticMarkup(
      <RecoverOwnershipForm workspaceName="Orphaned Lab" pending error={null} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(sending).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Make owner/);
  });

  test("posts the trimmed id to the organization route for that workspace", async () => {
    const summary = { ...everyone[1]!, authorizationRevision: 10 };
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(summary));
    try {
      expect(await recoverWorkspaceOwnership("ws_orphan", "u_new")).toEqual(summary);
      const [url, init] = spy.mock.calls[0]!;
      expect(url).toBe("/api/organization/workspaces/ws_orphan/owners");
      expect(init).toMatchObject({ method: "POST" });
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ mentraUserId: "u_new" });
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown user reads as a sentence, not as a status line", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "user_not_found" }, { status: 404 }));
    try {
      const error = await recoverWorkspaceOwnership("ws_orphan", "nobody").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message).toBe("No Mentra user has that id.");
    } finally {
      spy.mockRestore();
    }
  });

  test("any other failure keeps the server's own words", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "workspace_not_found", error_description: "workspace not found" }, { status: 404 }),
    );
    try {
      const error = await recoverWorkspaceOwnership("ws_gone", "u_new").catch((caught: unknown) => caught);
      expect((error as Error).message).toBe("workspace not found");
    } finally {
      spy.mockRestore();
    }
  });

  test("the workspace id is encoded into the path", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(everyone[0]));
    try {
      await recoverWorkspaceOwnership("ws/odd id", "u_new");
      expect(spy.mock.calls[0]![0]).toBe("/api/organization/workspaces/ws%2Fodd%20id/owners");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the All workspaces list stays current", () => {
  test("it is invalidated by the invalidation every workspace create, rename, delete and leave performs", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(workspaceKeys.list(api), [acme]);
      client.setQueryData(ORGANIZATION_WORKSPACES_KEY, { pages: [{ items: everyone, next: null }], pageParams: [undefined] });
      client.setQueryData(workspaceKeys.detail(api, ACME), acme);
      // What `workspaceMutationOptions` and the picker do on success.
      void client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
      expect(client.getQueryState(ORGANIZATION_WORKSPACES_KEY)?.isInvalidated).toBe(true);
      expect(client.getQueryState(workspaceKeys.list(api))?.isInvalidated).toBe(true);
      // Another workspace's own data is not what the list is about.
      expect(client.getQueryState(workspaceKeys.detail(api, ACME))?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });

  test("its key stays inside this API's cache scope", () => {
    expect(ORGANIZATION_WORKSPACES_KEY.slice(0, 3)).toEqual(["workspace-ui", "/api/workspaces", "list"]);
  });
});
