import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrganizationWorkspaceListItem, WorkspaceSummary } from "@mentra/workspace-contract";
import { workspaceKeys } from "@mentra/workspace-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import {
  adminWorkspaceApi,
  hasNoOwner,
  manageWorkspaceUrl,
  ORGANIZATION_WORKSPACES_KEY,
  WorkspaceSearchForm,
  workspacesKey,
  workspacesPath,
  WorkspacesPage,
} from "./workspaces";

// Synthetic data only. The query cache is seeded, so a server render never reaches the network.
const everyone: WorkspaceSummary[] = [
  { workspaceId: "ws_acme", name: "Acme Robotics", status: "active", authorizationRevision: 4 },
  { workspaceId: "ws_orphan", name: "Orphaned Lab", status: "active", authorizationRevision: 9 },
  { workspaceId: "ws_gone", name: "Closed Down", status: "deleted", authorizationRevision: 2 },
];
const PORTAL = "https://portal.test";

function render(ui: ReactElement, seed: { everyone?: WorkspaceSummary[] } = {}): string {
  const client = new QueryClient();
  if (seed.everyone) client.setQueryData(ORGANIZATION_WORKSPACES_KEY, { pages: [{ items: seed.everyone, next: null }], pageParams: [undefined] });
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  } finally {
    client.clear();
  }
}

describe("the Workspaces page", () => {
  test("lists every workspace with one action, Manage workspace, which opens it in Mentra Portal", () => {
    const markup = render(<WorkspacesPage portalUrl={PORTAL} />, { everyone });
    expect(markup).toContain("All workspaces");
    expect(markup).toContain("Acme Robotics");
    expect(markup).toContain('aria-label="Manage workspace Acme Robotics"');
    expect(markup).toContain('href="https://portal.test/?workspace=ws_acme"');
    expect(manageWorkspaceUrl(PORTAL, "ws/odd id")).toBe("https://portal.test/?workspace=ws%2Fodd%20id");
    // What is done to one workspace is in Mentra Portal now: nothing of it is left here.
    for (const gone of ["Open Acme", "Recover ownership", "Grant licenses", "Reset licenses", 'role="tab"', "End grant"]) expect(markup).not.toContain(gone);
  });

  test("a deleted workspace is marked and offers nothing", () => {
    const markup = render(<WorkspacesPage portalUrl={PORTAL} />, { everyone });
    expect(markup).toContain("Deleted");
    expect(markup).not.toContain('aria-label="Manage workspace Closed Down"');
  });

  test("with no Mentra Portal address from Core, rows have no action and the page says why", () => {
    const markup = render(<WorkspacesPage portalUrl={null} />, { everyone });
    expect(markup).not.toContain("Manage workspace");
    expect(markup).toContain("This Core has no Mentra Portal address");
    expect(render(<WorkspacesPage portalUrl={PORTAL} />, { everyone })).not.toContain("no Mentra Portal address");
  });

  test("offers a new workspace", () => {
    expect(render(<WorkspacesPage portalUrl={PORTAL} />, { everyone })).toMatch(/<button[^>]*>New workspace<\/button>/);
  });

  test("its source no longer carries the workspace screens or the support tools that moved to Mentra Portal", () => {
    const source = readFileSync(join(import.meta.dir, "workspaces.tsx"), "utf8");
    for (const gone of ["WorkspaceMembersPanel", "WorkspaceCredentialsPanel", "WorkspaceAuditPanel", "WorkspaceSettingsPanel", "license-grants", "/owners", "workspace-license-resets"]) {
      expect(source).not.toContain(gone);
    }
  });

  test("marks an active workspace that has no owner, and only where Core counted none", () => {
    const counted: OrganizationWorkspaceListItem[] = [
      { ...everyone[0]!, owners: 2 },
      { ...everyone[1]!, owners: 0 },
      { ...everyone[2]!, owners: 0 },
    ];
    expect(counted.map(hasNoOwner)).toEqual([false, true, false]);
    // A Core that sends no count says nothing either way.
    expect(everyone.map(hasNoOwner)).toEqual([false, false, false]);
    const markup = render(<WorkspacesPage portalUrl={PORTAL} />, { everyone: counted });
    expect(markup.match(/>No owner</g)).toHaveLength(1);
    expect(markup.indexOf("Orphaned Lab")).toBeLessThan(markup.indexOf(">No owner<"));
    expect(markup.indexOf(">No owner<")).toBeLessThan(markup.indexOf("Closed Down"));
    expect(render(<WorkspacesPage portalUrl={PORTAL} />, { everyone })).not.toContain("No owner");
  });

  test("searches by name, and by member and invitation emails when the box is ticked", () => {
    expect(workspacesPath({ query: "", emails: true })).toBe("/api/admin/organization/workspaces?limit=50");
    expect(workspacesPath({ query: "  North wind ", emails: false })).toBe("/api/admin/organization/workspaces?limit=50&query=North+wind");
    expect(workspacesPath({ query: "sam@northwind.test", emails: true }, "ws_last")).toBe(
      "/api/admin/organization/workspaces?limit=50&query=sam%40northwind.test&emails=true&before=ws_last",
    );
    // The unsearched list keeps the key the rest of the page invalidates; a search sits beneath it.
    expect(workspacesKey({ query: " ", emails: true })).toBe(ORGANIZATION_WORKSPACES_KEY);
    expect(workspacesKey({ query: "north", emails: true })).toEqual([...ORGANIZATION_WORKSPACES_KEY, "north", true]);
    const form = renderToStaticMarkup(<WorkspaceSearchForm search={{ query: "", emails: false }} onSearch={() => {}} />);
    expect(form).toContain("Search workspaces");
    expect(form).toContain("Also search member and invitation emails");
    expect(form).not.toContain("Clear");
    const page = render(<WorkspacesPage portalUrl={PORTAL} />, { everyone });
    expect(page).toContain('role="search"');
  });

  test("a list still loading says so", () => {
    expect(render(<WorkspacesPage portalUrl={PORTAL} />)).toContain("Loading workspaces");
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
