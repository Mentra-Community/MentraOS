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
  type InvitationPreview,
  type WorkspaceListItem,
} from "@mentra/workspace-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate, PortalRoutes } from "./App";
import { portalLinks, switcherInvitation } from "./components/portal-shell";
import { WorkspaceSwitcher } from "./components/workspace-switcher";
import type { PortalMe } from "./lib/api";
import type { PendingInvitation } from "./lib/invitations";
import { creationNotice, PortalProvider, portalWorkspaceApi, type PortalSession, type WorkspaceCreation } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import type { InviteStorage } from "./lib/workspace-invite";
import { isNoAccess, ORGANIZATION_ADMIN_NOTE, roleLabel, visibleSections, workspaceNav } from "./pages/workspace";

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
  { membershipId: `wm_${ACME}`, mentraUserId: "u_self", email: "sam@acme.test", role: "owner", startedAt: "2026-09-01T10:00:00.000Z", pending: false },
  { membershipId: "wm_2", mentraUserId: "u_2", email: "priya@acme.test", role: "admin", startedAt: "2026-09-02T10:00:00.000Z", pending: false },
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
    accountEmail: "sam@acme.test",
    creation: { allowed: true, reason: null },
    link: { status: "none" },
    invitations: [],
    forgetInvitation() {},
    signOut() {},
    signingOut: false,
    developerConsoleUrl: null,
    ...overrides,
  };
}

function invitationTo(workspaceName: string, fields: Partial<InvitationPreview> = {}): InvitationPreview {
  return {
    invitationId: `winv_${workspaceName.replace(/\W/g, "")}`,
    workspaceId: `ws_${workspaceName.replace(/\W/g, "").toLowerCase()}`,
    workspaceName,
    email: "sam@acme.test",
    role: "member",
    invitedByEmail: "olivia@acme.test",
    expiresAt: "2026-10-26T01:25:48.000Z",
    ...fields,
  };
}

/** A session holding this tab's valid invitation link to `preview`. */
function withLink(preview: InvitationPreview, accountEmail = "sam@acme.test"): Partial<PortalSession> {
  const forOtherAccount = preview.email.toLowerCase() !== accountEmail.toLowerCase();
  return {
    accountEmail,
    link: { status: "valid", token: TOKEN, preview },
    invitations: [{ preview, token: TOKEN, forOtherAccount }],
  };
}

/** A session with invitations addressed to the signed-in person (no link). */
function withMine(...previews: InvitationPreview[]): Partial<PortalSession> {
  return { invitations: previews.map((preview): PendingInvitation => ({ preview, token: null, forOtherAccount: false })) };
}

interface Seed {
  list?: WorkspaceListItem[];
  details?: WorkspaceDetail[];
  members?: MemberView[];
  preview?: InvitationPreview;
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

  test("the sidebar names the site as the admin portal does: Mentra Portal, on MentraOS", () => {
    const markup = render(`/w/${ACME}/members`, TWO_WORKSPACES);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><div class="min-w-0"><div[^>]*>Mentra Portal<\/div><div[^>]*>MentraOS<\/div>/);
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

describe("the Developer Console link", () => {
  const CONSOLE = "https://console.dev.mentraglass.com";
  /** The rendered link to `href`, start tag to end tag; null when there is none. */
  function anchorTo(markup: string, href: string): string | null {
    const start = markup.indexOf(`<a href="${href}"`);
    return start < 0 ? null : markup.slice(start, markup.indexOf("</a>", start) + "</a>".length);
  }

  test("is this environment's Developer Console, or nothing where there is none", () => {
    expect(portalLinks(CONSOLE)).toEqual([
      expect.objectContaining({ key: "developer-console", label: "Developer Console", href: CONSOLE }),
    ]);
    expect(portalLinks(null)).toEqual([]);
  });

  test("opens in a new tab, marked as leaving the portal, from every sidebar whatever the viewer's role", () => {
    for (const path of [`/w/${ACME}/members`, `/w/${NORTHWIND}/settings`, "/nowhere", "/enterprise"]) {
      const link = anchorTo(render(path, TWO_WORKSPACES, { developerConsoleUrl: CONSOLE }), CONSOLE);
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noreferrer"');
      expect(link).toContain(">Developer Console<");
      expect(link).toContain("lucide-arrow-up-right");
      expect(link).toContain("(opens in a new tab)");
    }
  });

  test("sits under the workspace's sections, above the account", () => {
    const markup = render(`/w/${ACME}/members`, TWO_WORKSPACES, { developerConsoleUrl: CONSOLE });
    expect(markup.indexOf(`href="/w/${ACME}/audit"`)).toBeLessThan(markup.indexOf(`href="${CONSOLE}"`));
    expect(markup.indexOf(`href="${CONSOLE}"`)).toBeLessThan(markup.indexOf("Open account menu"));
  });

  test("a Private Cloud's portal, where Core runs without a Store, has no link", () => {
    for (const path of [`/w/${ACME}/members`, "/nowhere"]) {
      const markup = render(path, TWO_WORKSPACES, { developerConsoleUrl: null });
      expect(markup).not.toContain("Developer Console");
      expect(markup).not.toContain('target="_blank"');
    }
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
  const invitation = switcherInvitation({ preview: invitationTo("Contoso"), token: null, forOtherAccount: false });
  // In the portal's providers: an invitation entry's Accept talks to the API and tells the portal.
  const open = (props: Partial<Parameters<typeof WorkspaceSwitcher>[0]> = {}) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <PortalProvider value={session()}>
          <WorkspaceSwitcher
            current={workspaces[0]!}
            workspaces={workspaces}
            invitations={[]}
            canCreate
            createNotice={null}
            onCreate={() => {}}
            defaultOpen
            {...props}
          />
        </PortalProvider>
      </QueryClientProvider>,
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

  test("pending invitations come last, with a count, who sent them, and Accept and Dismiss", () => {
    const markup = open({ invitations: [invitation] });
    expect(markup).toContain("Pending invitations");
    expect(markup).toContain("Join Contoso");
    expect(markup).toContain("Member · from olivia@acme.test");
    expect(markup).toMatch(/role="menuitem"[^>]*aria-label="Accept the invitation to Contoso"/);
    expect(markup).toMatch(/role="menuitem"[^>]*aria-label="Dismiss the invitation to Contoso"/);
    expect(markup).toContain("(1 pending invitation)");
    expect(markup.indexOf("Create workspace")).toBeLessThan(markup.indexOf("Pending invitations"));
  });

  test("an invitation for another account is named as such and reviewed on the invitation page", () => {
    const other = switcherInvitation({ preview: invitationTo("Contoso", { email: "b@else.test" }), token: TOKEN, forOtherAccount: true });
    expect(other.detail).toBe("For b@else.test");
    const markup = open({ invitations: [other] });
    expect(markup).toContain('href="/invitation"');
    expect(markup).toContain(">Review<");
    expect(markup).not.toContain("Accept the invitation");
  });

  test("no invitations, no badge and no section", () => {
    const markup = open({ invitations: [] });
    expect(markup).not.toContain("Pending invitations");
    expect(markup).not.toContain("pending invitation");
    expect(markup).not.toContain("ring-background absolute");
  });

  test("says why creating is not offered on this deployment", () => {
    const creation: WorkspaceCreation = { allowed: false, reason: "organization_admins_only" };
    const markup = open({ canCreate: false, createNotice: creationNotice(creation) });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("created by its administrators");
  });

  test("while the list loads, the menu says so", () => {
    const markup = open({ workspaces: undefined });
    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("Retry");
  });

  test("when the list cannot be loaded, the menu says so and offers a retry instead of loading forever", () => {
    const markup = open({ workspaces: undefined, listFailed: true, onRetry: () => {} });
    expect(markup).toContain("load your workspaces");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Loading…");
    expect(markup).toContain("Create workspace");
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

  test("a first run with an invitation link shows only the invitation, and its token is never rendered", () => {
    const markup = render("/", { list: [] }, withLink(invitationTo("Acme Field Team")));
    expect(markup).toContain("Welcome to Mentra");
    expect(markup).toContain("You&#x27;ve been invited to join a workspace.");
    expect(markup).toContain("Join Acme Field Team");
    expect(markup).toContain(">olivia@acme.test</strong> invited you");
    expect(markup).toContain("Accept invitation");
    expect(markup).toContain("Dismiss");
    expect(markup).not.toContain("Create your workspace");
    expect(markup).not.toContain("Workspace name");
    expect(markup).not.toContain(TOKEN);
  });

  test("someone who signs in without the link sees the invitations sent to their address, and only those", () => {
    const markup = render("/", { list: [] }, withMine(invitationTo("Dev check"), invitationTo("Northwind", { role: "developer" })));
    expect(markup).toContain("You&#x27;ve been invited to join 2 workspaces.");
    expect(markup).toMatch(/Pending invitations<span[^>]*>2<\/span>/);
    expect(markup).toContain("Join Dev check");
    expect(markup).toContain("Join Northwind");
    expect(markup.split("Accept invitation")).toHaveLength(3);
    expect(markup).not.toContain("Create your workspace");
  });

  test("once the invitations are dismissed, the first run offers Create your workspace", () => {
    const pending = render("/", { list: [] }, withLink(invitationTo("Acme Field Team")));
    expect(pending).not.toContain("Create your workspace");
    // Dismiss forgets the invitation (PortalSession.forgetInvitation): none is left to offer.
    const dismissed = render("/", { list: [] }, { link: { status: "none" }, invitations: [] });
    expect(dismissed).toContain("Create your workspace");
    expect(dismissed).toContain("Workspace name");
    expect(dismissed).not.toContain("Pending invitation");
    expect(dismissed).not.toContain("Accept invitation");
  });

  test("a link for another account says so and offers Switch account, and does not hide Create your workspace", () => {
    const markup = render("/", { list: [] }, withLink(invitationTo("Acme Field Team", { email: "b@else.test" })));
    expect(markup).toContain("This invitation is for <strong");
    expect(markup).toContain(">b@else.test</strong>. You&#x27;re signed in as <strong");
    expect(markup).toContain(">Switch account<");
    expect(markup).not.toContain("Accept invitation");
    expect(markup).toContain("Create your workspace");
  });

  test("when creating is not allowed the first run says why", () => {
    const markup = render("/", { list: [] }, { creation: { allowed: false, reason: "email_unverified" } });
    expect(markup).toContain("Verify your account");
    expect(markup).not.toContain("Workspace name");
  });

  test("an invitation link opens the accept card, with the way back to your workspaces", () => {
    const markup = render("/invitation", TWO_WORKSPACES, withLink(invitationTo("Northwind Pilot", { role: "developer" })));
    expect(markup).toContain("You&#x27;re invited");
    expect(markup).toContain("Join Northwind Pilot");
    expect(markup).toContain("Developer");
    expect(markup).toContain("Dismiss");
    expect(markup).toContain("Accept invitation");
    expect(markup).toContain(`href="/w/${ACME}"`);
    expect(markup).not.toContain("Create your workspace");
    expect(markup).not.toContain(TOKEN);
  });

  test("signed in as someone else, the invitation page says whose it is and offers Switch account, not Accept", () => {
    const markup = render("/invitation", TWO_WORKSPACES, withLink(invitationTo("Northwind Pilot", { email: "b@else.test" })));
    expect(markup).toContain("Switch accounts to accept");
    expect(markup).toContain("This invitation is for <strong");
    expect(markup).toContain(">b@else.test</strong>. You&#x27;re signed in as <strong");
    expect(markup).toContain(">sam@acme.test</strong>.");
    expect(markup).toContain(">Switch account<");
    expect(markup).toContain(">Dismiss<");
    expect(markup).not.toContain("Accept invitation");
    expect(markup).not.toContain("You&#x27;re invited");
    // Case and spacing aside, the same address is not someone else.
    const same = render("/invitation", TWO_WORKSPACES, withLink(invitationTo("Northwind Pilot", { email: "Sam@Acme.TEST" })));
    expect(same).toContain("Accept invitation");
    expect(same).not.toContain("Switch account");
  });

  test("a dead link is one consistent page: no longer valid, why, and the way back", () => {
    const markup = render("/invitation", TWO_WORKSPACES, { link: { status: "gone" } });
    expect(markup).toContain("Invitation no longer valid");
    expect(markup).toContain("Ask the person who invited you to send a new one.");
    expect(markup).toMatch(new RegExp(`href="/w/${ACME}"[^>]*>Go to Acme Field Team<`));
    for (const contradiction of ["You&#x27;re invited", "Accept to join", "Pending invitation", "Accept invitation", "Join "]) {
      expect(markup).not.toContain(contradiction);
    }
    // With no workspace, the way on is the first run.
    const firstRun = render("/invitation", { list: [] }, { link: { status: "gone" } });
    expect(firstRun).toMatch(/href="\/"[^>]*>Continue</);
  });
});

/** Session and local storage in memory. */
function memoryStorage(entries: Record<string, string> = {}): InviteStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

/** The portal as the app wires it: invitations from the real hook, over a seeded query cache. */
function HookedPortal({ path, token, local }: { path: string; token: string | null; local?: InviteStorage }) {
  const invites = usePortalInvitations({
    initialToken: token,
    signedIn: true,
    accountEmail: "sam@acme.test",
    pathname: path,
    sessionStore: memoryStorage(),
    localStore: local ?? memoryStorage(),
  });
  return (
    <PortalProvider value={session({ link: invites.link, invitations: invites.invitations, forgetInvitation: invites.forgetInvitation })}>
      <PortalRoutes route={parseRoute(path)} me={ME} />
    </PortalProvider>
  );
}

describe("invitations as the app finds them", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  /** A client where the link's look-up has already answered `peek` and the person's list `mine`. */
  async function client(peek: Response | InvitationPreview | null, mine: InvitationPreview[] | Response, seed: Seed = { list: [] }) {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/invitations/peek")) return peek instanceof Response ? peek.clone() : Response.json(peek);
      if (url.endsWith("/invitations/mine")) return mine instanceof Response ? mine.clone() : Response.json({ items: mine });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch);
    restore = () => spy.mockRestore();
    // A server render would otherwise show the refetch a mounted observer starts for a failed query.
    const qc = seeded(seed, new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }));
    if (peek !== null) await qc.prefetchQuery(invitationPreviewQuery(api, TOKEN));
    await qc.prefetchQuery({ queryKey: workspaceKeys.myInvitations(api), queryFn: () => api.listMyInvitations(), retry: false });
    return qc;
  }

  const gone = () => Response.json({ error: "invitation_not_found", error_description: "invitation not found" }, { status: 404 });

  const renderHooked = (qc: QueryClient, path: string, token: string | null, local?: InviteStorage) =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <HookedPortal path={path} token={token} local={local} />
      </QueryClientProvider>,
    );

  test("no workspaces and a dead stored link: the first run is Create your workspace, with no invitation copy", async () => {
    const markup = renderHooked(await client(gone(), []), "/", TOKEN);
    expect(markup).toContain("Create your workspace");
    expect(markup).toContain("Workspace name");
    for (const copy of ["Pending invitation", "invited", "no longer valid", "Accept invitation", "Join the workspace"]) {
      expect(markup).not.toContain(copy);
    }
  });

  test("the dead link's own page says so once, on /invitation", async () => {
    const markup = renderHooked(await client(gone(), []), "/invitation", TOKEN);
    expect(markup).toContain("Invitation no longer valid");
    expect(markup).not.toContain("Pending invitation");
  });

  test("a dead link never shows in the switcher: no entry, no badge", async () => {
    const markup = renderHooked(await client(gone(), [], TWO_WORKSPACES), `/w/${ACME}/members`, TOKEN);
    expect(markup).toContain('aria-label="Workspace: Acme Field Team. Switch workspace"');
    expect(markup).not.toContain("pending invitation");
  });

  test("an invitation that arrived by link and is also addressed to the person is offered once", async () => {
    const preview = invitationTo("Dev check");
    const markup = renderHooked(await client(preview, [preview, invitationTo("Northwind")], TWO_WORKSPACES), `/w/${ACME}/members`, TOKEN);
    expect(markup).toContain("(2 pending invitations)");
  });

  test("a valid link stays stored (the reason it is stored); accepting forgets it, dismissing another does not", async () => {
    const preview = invitationTo("Dev check");
    const qc = await client(preview, [preview, invitationTo("Northwind")]);
    const sessionStore = memoryStorage({ "mentra.workspaceInvite": TOKEN });
    const local = memoryStorage();
    let captured: ReturnType<typeof usePortalInvitations> | null = null;
    function Probe() {
      captured = usePortalInvitations({
        initialToken: TOKEN,
        signedIn: true,
        accountEmail: "sam@acme.test",
        pathname: "/",
        sessionStore,
        localStore: local,
      });
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const invites = captured!;
    expect(invites.inviteToken).toBe(TOKEN);
    expect(invites.link.status).toBe("valid");
    expect(sessionStore.data.get("mentra.workspaceInvite")).toBe(TOKEN);

    invites.forgetInvitation({ invitationId: "winv_Northwind", token: null }, "dismissed");
    expect(sessionStore.data.get("mentra.workspaceInvite")).toBe(TOKEN);
    expect(JSON.parse(local.data.get("mentra.dismissedInvitations")!)).toEqual(["winv_Northwind"]);

    invites.forgetInvitation({ invitationId: preview.invitationId, token: TOKEN }, "accepted");
    expect(sessionStore.data.has("mentra.workspaceInvite")).toBe(false);
  });

  test("invitations dismissed in this browser are not offered again; one Core will not list counts as none", async () => {
    const preview = invitationTo("Dev check");
    const local = memoryStorage({ "mentra.dismissedInvitations": JSON.stringify([preview.invitationId]) });
    const dismissed = renderHooked(await client(null, [preview]), "/", null, local);
    expect(dismissed).toContain("Create your workspace");
    expect(dismissed).not.toContain("Join Dev check");

    const unverified = Response.json({ error: "email_unverified", error_description: "verify your email" }, { status: 403 });
    const refused = renderHooked(await client(null, unverified), "/", null);
    expect(refused).toContain("Create your workspace");

    const listed = renderHooked(await client(null, [preview]), "/", null);
    expect(listed).toContain("Join Dev check");
    expect(listed).not.toContain("Create your workspace");
  });
});

describe("deleting a workspace a service holds", () => {
  test("the settings page says why it cannot be deleted, where the delete is, and offers no delete", () => {
    const held: WorkspaceDetail = {
      ...detail(ACME, "Acme Field Team", "owner"),
      deletionHolds: [{ service: "store", reason: "owns_miniapps", count: 2 }],
    };
    const markup = render(`/w/${ACME}/settings`, { ...TWO_WORKSPACES, details: [held] });
    const section = /<section aria-label="Delete workspace"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(section).toContain("This workspace still owns 2 published miniapps. Delete them in the Developer Console first.");
    expect(section).toMatch(/<button[^>]*disabled=""[^>]*>Delete workspace<\/button>/);

    // Without a hold, the page warns what deleting does to the miniapps the workspace still has in the Store.
    const free = render(`/w/${ACME}/settings`, TWO_WORKSPACES);
    expect(free).not.toContain("still owns");
    expect(free).toContain("Miniapps this workspace still has in the Mentra Miniapp Store stay there");
  });
});

describe("an Organization Admin is labelled by their own role", () => {
  const memberAdmin: WorkspaceDetail = { ...detail(ACME, "Dev check", "owner"), membership: { membershipId: "wm_x", role: "member" }, organizationAdmin: true };

  test("the switcher says Member · Organization Admin, not Owner; an owner is just Owner", () => {
    expect(roleLabel(memberAdmin)).toBe("Member · Organization Admin");
    expect(roleLabel({ ...detail(ACME, "Dev check", "owner"), organizationAdmin: true })).toBe("Owner");
    expect(roleLabel({ ...detail(ACME, "Dev check", "owner", false), organizationAdmin: true })).toBe("Organization Admin");
    expect(roleLabel({ ...detail(ACME, "Dev check", "developer"), organizationAdmin: false })).toBe("Developer");
  });

  test("their Members and Settings pages say where their powers come from; their controls stay", () => {
    const seed: Seed = { list: [listItem(ACME, "Dev check", "member")], details: [memberAdmin], members: MEMBERS };
    const members = render(`/w/${ACME}/members`, seed);
    // The switcher names their own role; the member table (seeded with another role for them) is unchanged.
    expect(members).toContain(">Member · Organization Admin</span>");
    expect(members).toContain(ORGANIZATION_ADMIN_NOTE.replace("'", "&#x27;"));
    expect(members).toContain(">Invite<");
    const settings = render(`/w/${ACME}/settings`, seed);
    expect(settings).toContain(ORGANIZATION_ADMIN_NOTE.replace("'", "&#x27;"));
    expect(settings).toContain("Save name");
    // Someone whose powers are their own gets no note.
    expect(render(`/w/${ACME}/members`, TWO_WORKSPACES)).not.toContain("Organization Admin");
  });
});

test("the login gate names the site", () => {
  expect(renderToStaticMarkup(<LoginGate loginUrl="/api/portal/auth/login" />)).toContain("Sign into Mentra Portal");
});

test("the login gate says to sign in with the invited address when an invitation is pending", () => {
  const loginUrl = "/api/portal/auth/login?return_to=%2Finvitation";
  expect(renderToStaticMarkup(<LoginGate invitePending loginUrl={loginUrl} />)).toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("trusted identity issuers");
});
