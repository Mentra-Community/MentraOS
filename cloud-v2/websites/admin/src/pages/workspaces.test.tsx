import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@mentra/workspace-contract";
import { WorkspaceSettingsPanel, workspaceKeys } from "@mentra/workspace-ui";
import { capabilitiesForRole, type WorkspaceDetail } from "@mentra/workspace-contract";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ApiError } from "../lib/api";
import {
  adminWorkspaceApi,
  ORGANIZATION_WORKSPACES_KEY,
  parseOwnerTarget,
  recoverWorkspaceOwnership,
  RecoverOwnershipForm,
  STORE_DELETE_NOTICE,
  WorkspacesPage,
} from "./workspaces";

// Synthetic data only. The query cache is seeded, so a server render never reaches the network.
const everyone: WorkspaceSummary[] = [
  { workspaceId: "ws_acme", name: "Acme Robotics", status: "active", authorizationRevision: 4 },
  { workspaceId: "ws_orphan", name: "Orphaned Lab", status: "active", authorizationRevision: 9 },
  { workspaceId: "ws_gone", name: "Closed Down", status: "deleted", authorizationRevision: 2 },
];

function render(ui: ReactElement, seed: { everyone?: WorkspaceSummary[]; details?: WorkspaceDetail[] } = {}): string {
  const client = new QueryClient();
  if (seed.everyone) client.setQueryData(ORGANIZATION_WORKSPACES_KEY, { pages: [{ items: seed.everyone, next: null }], pageParams: [undefined] });
  for (const detail of seed.details ?? []) client.setQueryData(workspaceKeys.detail(adminWorkspaceApi, detail.workspaceId), detail);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

describe("the Workspaces page", () => {
  test("lists every workspace with Open and Recover ownership, and asks to open one", () => {
    const markup = render(<WorkspacesPage />, { everyone });
    expect(markup).toContain("All workspaces");
    expect(markup).toContain("Acme Robotics");
    expect(markup).toContain('aria-label="Open Acme Robotics"');
    expect(markup).toContain('aria-label="Recover ownership of Orphaned Lab"');
    expect(markup).toContain("Open a workspace to manage");
    expect(markup).not.toContain('role="tab"');
  });

  test("a deleted workspace is marked and cannot be opened or recovered", () => {
    const markup = render(<WorkspacesPage />, { everyone });
    expect(markup).toContain("Deleted");
    expect(markup).not.toContain('aria-label="Open Closed Down"');
    expect(markup).not.toContain('aria-label="Recover ownership of Closed Down"');
  });

  test("a list still loading says so", () => {
    expect(render(<WorkspacesPage />)).toContain("Loading workspaces");
  });

  test("states that a workspace that owns miniapps in the Mentra Miniapp Store can't be deleted", () => {
    const owner: WorkspaceDetail = {
      ...everyone[0]!,
      membership: null,
      capabilities: [...capabilitiesForRole("owner")],
      deletionHolds: [],
    };
    const markup = render(
      <WorkspaceSettingsPanel api={adminWorkspaceApi} workspaceId="ws_acme" deleteNotice={STORE_DELETE_NOTICE} />,
      { details: [owner] },
    );
    expect(markup).toContain(
      "A workspace that owns miniapps in the Mentra Miniapp Store can&#x27;t be deleted. Delete its miniapps first.",
    );
    // Nothing is left behind any more, so there is no word of miniapps staying in the Store.
    expect(markup).not.toContain("stay there");
    expect(markup).not.toContain("Store operator");
  });

  test("a workspace that still owns miniapps says so where the delete is, and cannot be deleted from here", () => {
    const held: WorkspaceDetail = {
      ...everyone[0]!,
      membership: null,
      capabilities: [...capabilitiesForRole("owner")],
      organizationAdmin: true,
      deletionHolds: [{ service: "store", reason: "owns_miniapps", count: 3 }],
    };
    const markup = render(
      <WorkspaceSettingsPanel api={adminWorkspaceApi} workspaceId="ws_acme" deleteNotice={STORE_DELETE_NOTICE} />,
      { details: [held] },
    );
    const section = /<section aria-label="Delete workspace"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(section).toContain("This workspace still owns 3 miniapps. Delete them in the Developer Console first.");
    expect(section).toMatch(/<button[^>]*disabled=""[^>]*>Delete workspace<\/button>/);
    expect(section).not.toContain(STORE_DELETE_NOTICE);
  });
});

describe("recover ownership", () => {
  test("names a person by email or by Mentra user id, and refuses blank", () => {
    expect(parseOwnerTarget("")).toEqual({ ok: false, message: "Enter an email address or a Mentra user id." });
    expect(parseOwnerTarget("  sam@acme.test ")).toEqual({ ok: true, target: { email: "sam@acme.test" } });
    expect(parseOwnerTarget(" mu_123 ")).toEqual({ ok: true, target: { mentraUserId: "mu_123" } });
  });

  test("the form asks for the person and the workspace it is for, and shows why the last attempt failed", () => {
    const markup = renderToStaticMarkup(
      <RecoverOwnershipForm workspaceName="Orphaned Lab" pending={false} error={null} onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(markup).toContain("Account email or Mentra user id");
    expect(markup).toContain("Orphaned Lab");
    expect(markup).not.toContain('role="alert"');
    const failed = renderToStaticMarkup(
      <RecoverOwnershipForm workspaceName="Orphaned Lab" pending error="No Mentra account matches that email or user id." onSubmit={() => {}} onCancel={() => {}} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Make owner/);
  });

  test("posts the person to the admin portal's organization route for that workspace", async () => {
    const summary = { ...everyone[1]!, authorizationRevision: 10 };
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(summary)) as unknown as typeof fetch);
    try {
      expect(await recoverWorkspaceOwnership("ws_orphan", { email: "sam@acme.test" })).toEqual(summary);
      const [url, init] = spy.mock.calls[0]!;
      expect(url).toBe("/api/admin/organization/workspaces/ws_orphan/owners");
      expect(init).toMatchObject({ method: "POST" });
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: "sam@acme.test" });
      await recoverWorkspaceOwnership("ws/odd id", { mentraUserId: "mu_1" });
      expect(spy.mock.calls[1]![0]).toBe("/api/admin/organization/workspaces/ws%2Fodd%20id/owners");
    } finally {
      spy.mockRestore();
    }
  });

  test("an unknown person reads as a sentence; any other failure keeps the server's own words", async () => {
    const unknown = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "user_not_found" }, { status: 404 }));
    try {
      const error = await recoverWorkspaceOwnership("ws_orphan", { mentraUserId: "nobody" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as Error).message).toBe("No Mentra account matches that email or user id.");
    } finally {
      unknown.mockRestore();
    }
    const other = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "workspace_not_found", error_description: "workspace not found" }, { status: 404 }),
    );
    try {
      const error = await recoverWorkspaceOwnership("ws_gone", { mentraUserId: "mu_1" }).catch((caught: unknown) => caught);
      expect((error as Error).message).toBe("workspace not found");
    } finally {
      other.mockRestore();
    }
  });
});

describe("the All workspaces list stays current", () => {
  test("it is invalidated by the invalidation every workspace rename, delete and leave performs", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(ORGANIZATION_WORKSPACES_KEY, { pages: [{ items: everyone, next: null }], pageParams: [undefined] });
      void client.invalidateQueries({ queryKey: workspaceKeys.list(adminWorkspaceApi) });
      expect(client.getQueryState(ORGANIZATION_WORKSPACES_KEY)?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  test("its key stays inside the admin portal's cache scope", () => {
    expect(ORGANIZATION_WORKSPACES_KEY.slice(0, 3)).toEqual(["workspace-ui", "/api/admin/workspaces", "list"]);
  });
});
