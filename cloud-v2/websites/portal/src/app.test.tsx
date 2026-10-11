import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  capabilitiesForRole,
  type MemberView,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@mentra/workspace-contract";
import {
  invitationPreviewQuery,
  workspaceDetailQuery,
  WorkspaceApiError,
  workspaceKeys,
  type WorkspaceListItem,
} from "@mentra/workspace-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate, PortalRoutes } from "./App";
import { WorkspaceSwitcher } from "./components/workspace-switcher";
import type { PortalMe } from "./lib/api";
import { creationNotice, PortalProvider, portalWorkspaceApi, type PortalSession, type WorkspaceCreation } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import { isNoAccess, roleLabel, visibleSections, workspaceNav } from "./pages/workspace";

// Synthetic data only. The query cache is seeded, so a server render never reaches the network.
const api = portalWorkspaceApi;
const ACME = "ws_acme";
const NORTHWIND = "ws_northwind";
const TOKEN = "invite-token-never-rendered";

function detail(workspaceId: string, name: string, role: WorkspaceRole, member = true): WorkspaceDetail {
  return {
    workspaceId,
    name,
    status: "active",
    authorizationRevision: 3,
    membership: member ? { membershipId: `wm_${workspaceId}`, role } : null,
    capabilities: [...capabilitiesForRole(role)],
  };
}

function listItem(workspaceId: string, name: string, role: WorkspaceRole): WorkspaceListItem {
  return { ...detail(workspaceId, name, role), membership: { membershipId: `wm_${workspaceId}`, role } };
}

const MEMBERS: MemberView[] = [
  { membershipId: `wm_${ACME}`, mentraUserId: "u_self", email: "sam@acme.test", role: "owner", startedAt: "2026-09-01T10:00:00.000Z" },
  { membershipId: "wm_2", mentraUserId: "u_2", email: "priya@acme.test", role: "admin", startedAt: "2026-09-02T10:00:00.000Z" },
];

const ME: PortalMe = {
  authenticated: true,
  user: { id: "u_self", email: "sam@acme.test" },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: true,
  org: null,
};

function session(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    userEmail: "sam@acme.test",
    creation: { allowed: true, reason: null },
    inviteToken: null,
    forgetInvite() {},
    signOut() {},
    signingOut: false,
    ...overrides,
  };
}

interface Seed {
  list?: WorkspaceListItem[];
  details?: WorkspaceDetail[];
  members?: MemberView[];
  preview?: { workspaceName: string; email: string; role: WorkspaceRole };
}

function seeded(seed: Seed, client = new QueryClient()): QueryClient {
  if (seed.list) client.setQueryData(workspaceKeys.list(api), seed.list);
  for (const item of seed.details ?? []) client.setQueryData(workspaceKeys.detail(api, item.workspaceId), item);
  if (seed.members) client.setQueryData(workspaceKeys.members(api, ACME), seed.members);
  client.setQueryData(workspaceKeys.invitations(api, ACME), []);
  if (seed.preview) client.setQueryData(invitationPreviewQuery(api, TOKEN).queryKey, seed.preview);
  return client;
}

function render(path: string, seed: Seed, portal: Partial<PortalSession> = {}, client = seeded(seed)): string {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PortalProvider value={session(portal)}>
          <PortalRoutes route={parseRoute(path)} me={ME} />
        </PortalProvider>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const TWO_WORKSPACES: Seed = {
  list: [listItem(ACME, "Acme Field Team", "owner"), listItem(NORTHWIND, "Northwind Pilot", "developer")],
  details: [detail(ACME, "Acme Field Team", "owner"), detail(NORTHWIND, "Northwind Pilot", "developer")],
  members: MEMBERS,
};

const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map(match => match[1]!);

describe("the sidebar follows the viewer's role", () => {
  const caps = (role: WorkspaceRole) => ({ capabilities: [...capabilitiesForRole(role)] });

  test("members and developers get Settings only; admins and owners add Members and the Audit log", () => {
    expect(visibleSections(caps("member"))).toEqual(["settings"]);
    expect(visibleSections(caps("developer"))).toEqual(["settings"]);
    expect(visibleSections(caps("admin"))).toEqual(["members", "settings", "audit"]);
    expect(visibleSections(caps("owner"))).toEqual(["members", "settings", "audit"]);
    expect(visibleSections(undefined)).toEqual(["settings"]);
  });

  test("the Fleet group exists for later but has no items, so it renders nothing", () => {
    const nav = workspaceNav(ACME, visibleSections(caps("owner")));
    expect(nav.map(group => group.key)).toEqual(["workspace", "fleet"]);
    expect(nav.find(group => group.key === "fleet")?.items).toEqual([]);
    const markup = render(`/w/${ACME}/members`, TWO_WORKSPACES);
    expect(markup).not.toContain(">Fleet<");
  });

  test("an Organization Admin who is not a member shows as such", () => {
    expect(roleLabel(detail(ACME, "Acme", "owner", false))).toBe("Organization Admin");
    expect(roleLabel(detail(ACME, "Acme", "admin"))).toBe("Admin");
  });
});

describe("a workspace page", () => {
  test("an owner's members page: the switcher, the sections as links that carry the workspace, and Invite", () => {
    const markup = render(`/w/${ACME}/members`, TWO_WORKSPACES);
    expect(markup).toContain('aria-label="Workspace: Acme Field Team. Switch workspace"');
    expect(markup).toContain(">Owner<");
    expect(hrefs(markup)).toEqual(
      expect.arrayContaining([`/w/${ACME}/members`, `/w/${ACME}/settings`, `/w/${ACME}/audit`]),
    );
    expect(markup).toMatch(/aria-current="page"[^>]*>.*Members/);
    expect(markup).toContain(">Invite<");
    expect(markup).toContain("priya@acme.test");
  });

  test("a developer sees only Settings, and no Invite", () => {
    const markup = render(`/w/${NORTHWIND}/settings`, TWO_WORKSPACES);
    expect(markup).toContain('aria-label="Workspace: Northwind Pilot. Switch workspace"');
    expect(hrefs(markup)).toContain(`/w/${NORTHWIND}/settings`);
    expect(hrefs(markup)).not.toContain(`/w/${NORTHWIND}/members`);
    expect(hrefs(markup)).not.toContain(`/w/${NORTHWIND}/audit`);
    expect(markup).not.toContain(">Invite<");
    expect(markup).toContain("Workspace ID");
    expect(markup).toContain("Leave workspace");
  });

  test("Enterprise is not in the navigation", () => {
    for (const path of [`/w/${ACME}/members`, `/w/${ACME}/settings`, "/nowhere"]) {
      const markup = render(path, TWO_WORKSPACES);
      expect(markup).not.toContain("Enterprise");
      expect(hrefs(markup).some(href => href.startsWith("/enterprise"))).toBe(false);
    }
  });

  test("the enterprise pages still open by direct address", () => {
    const markup = render("/enterprise", TWO_WORKSPACES);
    expect(markup).toContain("Create your enterprise organization");
  });

  test("an unknown address is page not found, with a way back to a workspace", () => {
    const markup = render("/nowhere", TWO_WORKSPACES);
    expect(markup).toContain("Page not found");
    expect(markup).toContain("Go to Acme Field Team");
  });
});

describe("a workspace the viewer may not see", () => {
  const fetchSpy = () =>
    spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "forbidden", error_description: "not allowed in this workspace" }, { status: 403 })) as unknown as typeof fetch);
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  test("Core's 403 and 404 both read as no access; other failures do not", () => {
    expect(isNoAccess(new WorkspaceApiError(403, "forbidden", "x"))).toBe(true);
    expect(isNoAccess(new WorkspaceApiError(404, "workspace_not_found", "x"))).toBe(true);
    expect(isNoAccess(new WorkspaceApiError(500, "server_error", "x"))).toBe(false);
    expect(isNoAccess(new Error("x"))).toBe(false);
  });

  test("shows one clear not-found-or-no-access page", async () => {
    const spy = fetchSpy();
    restore = () => spy.mockRestore();
    // A server render would otherwise show the refetch a mounted observer starts for a failed query.
    const client = seeded(TWO_WORKSPACES, new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }));
    await client.prefetchQuery(workspaceDetailQuery(api, "ws_other"));
    const markup = render("/w/ws_other/members", TWO_WORKSPACES, {}, client);
    expect(markup).toContain("Workspace not found");
    expect(markup).toContain("you don&#x27;t have access to it");
    expect(markup).not.toContain(">Invite<");
    expect(markup).toContain('aria-label="Choose a workspace"');
  });
});

describe("the workspace switcher", () => {
  const workspaces = [
    { workspaceId: ACME, name: "Acme Field Team", roleLabel: "Owner", href: `/w/${ACME}/members` },
    { workspaceId: NORTHWIND, name: "Northwind Pilot", roleLabel: "Developer", href: `/w/${NORTHWIND}/members` },
  ];
  const invitation = { key: "link", label: "Join Contoso", detail: "As Member", href: "/invitation" };
  const open = (props: Partial<Parameters<typeof WorkspaceSwitcher>[0]> = {}) =>
    renderToStaticMarkup(
      <WorkspaceSwitcher
        current={workspaces[0]!}
        workspaces={workspaces}
        invitations={[]}
        canCreate
        createNotice={null}
        onCreate={() => {}}
        defaultOpen
        {...props}
      />,
    );

  test("lists your workspaces with the current one checked, then Create workspace", () => {
    const markup = open();
    expect(markup).toContain('role="menu"');
    expect(markup).toContain("Northwind Pilot");
    expect(markup).toContain(`href="/w/${NORTHWIND}/members"`);
    expect(markup).toContain('aria-label="Current workspace"');
    expect(markup).toContain("Create workspace");
    expect(markup).not.toContain("Pending invitations");
    expect(markup.indexOf("Northwind Pilot")).toBeLessThan(markup.indexOf("Create workspace"));
  });

  test("pending invitations come last, with a count", () => {
    const markup = open({ invitations: [invitation] });
    expect(markup).toContain("Pending invitations");
    expect(markup).toContain("Join Contoso");
    expect(markup).toContain('href="/invitation"');
    expect(markup).toContain("(1 pending invitation)");
    expect(markup.indexOf("Create workspace")).toBeLessThan(markup.indexOf("Pending invitations"));
  });

  test("says why creating is not offered on this deployment", () => {
    const creation: WorkspaceCreation = { allowed: false, reason: "organization_admins_only" };
    const markup = open({ canCreate: false, createNotice: creationNotice(creation) });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("created by its administrators");
  });

  test("closed, it shows only the current workspace and your role", () => {
    const markup = open({ defaultOpen: false });
    expect(markup).toContain("Acme Field Team");
    expect(markup).toContain("Owner");
    expect(markup).not.toContain('role="menu"');
  });
});

describe("before a workspace", () => {
  test("with no workspaces, / is the first run: a centred Create your workspace card", () => {
    const markup = render("/", { list: [] });
    expect(markup).toContain("Welcome to Mentra");
    expect(markup).toContain("Create your workspace");
    expect(markup).toContain("Workspace name");
    expect(markup).not.toContain("Pending invitation");
  });

  test("a pending invitation is listed above the create card, with Accept, and its token is never rendered", () => {
    const preview = { workspaceName: "Acme Field Team", email: "new@acme.test", role: "member" as const };
    const markup = render("/", { list: [], preview }, { inviteToken: TOKEN });
    expect(markup).toContain("Join Acme Field Team");
    expect(markup).toContain("Accept invitation");
    expect(markup.indexOf("Accept invitation")).toBeLessThan(markup.indexOf("Create your workspace"));
    expect(markup).not.toContain(TOKEN);
  });

  test("when creating is not allowed the first run says why", () => {
    const markup = render("/", { list: [] }, { creation: { allowed: false, reason: "email_unverified" } });
    expect(markup).toContain("Verify your account");
    expect(markup).not.toContain("Workspace name");
  });

  test("an invitation link opens the accept card, with the way back to your workspaces", () => {
    const preview = { workspaceName: "Northwind Pilot", email: "sam@acme.test", role: "developer" as const };
    const markup = render("/invitation", { ...TWO_WORKSPACES, preview }, { inviteToken: TOKEN });
    expect(markup).toContain("You&#x27;re invited");
    expect(markup).toContain("Join Northwind Pilot");
    expect(markup).toContain("Developer");
    expect(markup).toContain("Dismiss");
    expect(markup).toContain(`href="/w/${ACME}"`);
    expect(markup).not.toContain("Create your workspace");
    expect(markup).not.toContain(TOKEN);
  });
});

test("the login gate says to sign in with the invited address when an invitation is pending", () => {
  const loginUrl = "/api/portal/auth/login?return_to=%2Finvitation";
  expect(renderToStaticMarkup(<LoginGate invitePending loginUrl={loginUrl} />)).toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("trusted identity issuers");
});
