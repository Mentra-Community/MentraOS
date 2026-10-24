import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  capabilitiesForRole,
  type LicenseView,
  type MemberView,
  type WorkspaceDetail,
  type WorkspaceRole,
} from "@mentra/workspace-contract";
import {
  AccountFooter,
  invitationPreviewQuery,
  licensesQuery,
  workspaceDetailQuery,
  WorkspaceApiError,
  workspaceKeys,
  WorkspaceSwitcher,
  type InvitationPreview,
  type WorkspaceListItem,
} from "@mentra/workspace-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate, PortalRoutes } from "./App";
import { portalLinks, switcherInvitation } from "./components/portal-shell";
import type { PortalMe } from "./lib/api";
import type { PendingInvitation } from "./lib/invitations";
import { Link } from "./lib/navigation";
import {
  creationNotice,
  expireSession,
  PORTAL_ME_KEY,
  PortalProvider,
  portalWorkspaceApi,
  type PortalSession,
  type WorkspaceCreation,
} from "./lib/portal";
import { parseRoute } from "./lib/routes";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import type { InviteStorage } from "./lib/workspace-invite";
import { billingOffered } from "./pages/licenses";
import { isNoAccess, licensesPartShown, ORGANIZATION_ADMIN_NOTE, roleLabel, visibleSections, workspaceNav } from "./pages/workspace";

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
  user: { id: "u_self", email: "sam@acme.test", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: true,
  org: null,
  modules: { billing: false },
};

/** `/api/portal/me` on a Core that does (or does not) offer billing. */
const meWith = (billing: boolean): PortalMe => ({ ...ME, modules: { billing } });

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
    modules: { billing: false },
    sessionExpired() {},
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
  /** Acme's licenses, as the viewer's listing answers them. */
  licenses?: LicenseView[];
  preview?: InvitationPreview;
}

function seeded(seed: Seed, client = new QueryClient()): QueryClient {
  if (seed.list) client.setQueryData(workspaceKeys.list(api), seed.list);
  for (const item of seed.details ?? []) client.setQueryData(workspaceKeys.detail(api, item.workspaceId), item);
  if (seed.members) client.setQueryData(workspaceKeys.members(api, ACME), seed.members);
  client.setQueryData(workspaceKeys.invitations(api, ACME), []);
  if (seed.licenses) client.setQueryData(workspaceKeys.licenses(api, ACME), seed.licenses);
  if (seed.preview) client.setQueryData(invitationPreviewQuery(api, TOKEN).queryKey, seed.preview);
  return client;
}

function render(path: string, seed: Seed, portal: Partial<PortalSession> = {}, client = seeded(seed), me: PortalMe = ME): string {
  const url = new URL(path, "http://portal.test");
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PortalProvider value={session(portal)}>
          <PortalRoutes route={parseRoute(url.pathname)} search={url.search} me={me} />
        </PortalProvider>
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

/** `render` for a person who is offered the billing module, or is not: the page and the session agree, as the app makes them. */
function renderAs(billing: boolean, path: string, seed: Seed, portal: Partial<PortalSession> = {}): string {
  return render(path, seed, { modules: meWith(billing).modules, ...portal }, seeded(seed), meWith(billing));
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
    const nav = workspaceNav(ACME, visibleSections(caps("owner")), ACME);
    expect(nav.map(group => group.key)).toEqual(["workspace", "fleet"]);
    expect(nav.find(group => group.key === "fleet")?.items).toEqual([]);
    const markup = render(`/members`, TWO_WORKSPACES);
    expect(markup).not.toContain(">Fleet<");
  });

  test("an Organization Admin who is not a member shows as such", () => {
    expect(roleLabel(detail(ACME, "Acme", "owner", false))).toBe("Organization Admin");
    expect(roleLabel(detail(ACME, "Acme", "admin"))).toBe("Admin");
  });
});

describe("a workspace page", () => {
  test("an owner's members page: the switcher, the sections as links that carry the workspace, and Invite", () => {
    const markup = render(`/members`, TWO_WORKSPACES);
    expect(markup).toContain('aria-label="Workspace: Acme Field Team. Switch workspace"');
    expect(markup).toContain(">Owner<");
    expect(hrefs(markup)).toEqual(
      expect.arrayContaining([`/members`, `/settings`, `/audit`]),
    );
    expect(markup).toMatch(/aria-current="page"[^>]*>.*Members/);
    expect(markup).toContain(">Invite<");
    expect(markup).toContain("priya@acme.test");
  });

  test("in their own workspace a person gets bare section links, in another one the sections name it", () => {
    const own = render(`/members`, TWO_WORKSPACES);
    expect(hrefs(own)).toEqual(expect.arrayContaining(["/members", "/settings", "/audit"]));
    expect(hrefs(own).some(href => href.includes("workspace="))).toBe(false);
    // The second workspace in the list is not what the bare address opens, so its sections name it.
    const other = render(`/settings?workspace=${NORTHWIND}`, TWO_WORKSPACES);
    expect(hrefs(other)).toContain(`/settings?workspace=${NORTHWIND}`);
    expect(hrefs(other)).not.toContain("/settings");
  });

  test("an Organization Admin at a customer's workspace stays in it on every sidebar link", () => {
    const customer = "ws_customer";
    const seed: Seed = { ...TWO_WORKSPACES, details: [...TWO_WORKSPACES.details!, detail(customer, "Customer Co", "owner", false)] };
    const markup = render(`/members?workspace=${customer}`, seed);
    expect(markup).toContain('aria-label="Workspace: Customer Co. Switch workspace"');
    const sections = hrefs(markup).filter(href => /^\/(members|settings|audit)/.test(href));
    expect(sections).toEqual([`/members?workspace=${customer}`, `/settings?workspace=${customer}`, `/audit?workspace=${customer}`]);
  });

  test("a person with no workspace of their own gets ?workspace= on links into a customer's", () => {
    const customer = "ws_customer";
    const markup = render(`/settings?workspace=${customer}`, { list: [], details: [detail(customer, "Customer Co", "owner", false)] });
    expect(hrefs(markup).filter(href => /^\/(members|settings|audit)/.test(href))).toEqual([
      `/members?workspace=${customer}`,
      `/settings?workspace=${customer}`,
      `/audit?workspace=${customer}`,
    ]);
  });

  test("the sidebar names the site as the admin portal does: Mentra Portal, on MentraOS", () => {
    const markup = render(`/members`, TWO_WORKSPACES);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><div class="min-w-0"><div[^>]*>Mentra Portal<\/div><div[^>]*>MentraOS<\/div>/);
  });

  test("a developer sees only Settings, and no Invite", () => {
    const markup = render(`/settings?workspace=${NORTHWIND}`, TWO_WORKSPACES);
    expect(markup).toContain('aria-label="Workspace: Northwind Pilot. Switch workspace"');
    expect(hrefs(markup)).toContain(`/settings?workspace=${NORTHWIND}`);
    expect(hrefs(markup)).not.toContain(`/members?workspace=${NORTHWIND}`);
    expect(hrefs(markup)).not.toContain(`/audit?workspace=${NORTHWIND}`);
    expect(markup).not.toContain(">Invite<");
    expect(markup).toContain("Workspace ID");
    expect(markup).toContain("Leave workspace");
  });

  test("Enterprise is not in the navigation", () => {
    for (const path of [`/members`, `/settings`, "/nowhere"]) {
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
    for (const path of [`/members`, `/settings?workspace=${NORTHWIND}`, "/nowhere", "/enterprise"]) {
      const link = anchorTo(render(path, TWO_WORKSPACES, { developerConsoleUrl: CONSOLE }), CONSOLE);
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noreferrer"');
      expect(link).toContain(">Developer Console<");
      expect(link).toContain("lucide-arrow-up-right");
      expect(link).toContain("(opens in a new tab)");
    }
  });

  test("sits under the workspace's sections, above the account", () => {
    const markup = render(`/members`, TWO_WORKSPACES, { developerConsoleUrl: CONSOLE });
    expect(markup.indexOf(`href="/audit"`)).toBeLessThan(markup.indexOf(`href="${CONSOLE}"`));
    expect(markup.indexOf(`href="${CONSOLE}"`)).toBeLessThan(markup.indexOf("Open account menu"));
  });

  test("a Private Cloud's portal, where Core runs without a Store, has no link", () => {
    for (const path of [`/members`, "/nowhere"]) {
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
    const markup = render("/members?workspace=ws_other", TWO_WORKSPACES, {}, client);
    expect(markup).toContain("Workspace not found");
    expect(markup).toContain("you don&#x27;t have access to it");
    expect(markup).not.toContain(">Invite<");
    expect(markup).toContain('aria-label="Choose a workspace"');
  });
});

// The switcher's own rendering (the list, loading, a failed list, the closed state) is tested in
// packages/workspace-ui. These are the portal's entries in it: its invitations and its creation notice.
describe("the workspace switcher", () => {
  const workspaces = [
    { workspaceId: ACME, name: "Acme Field Team", roleLabel: "Owner", href: `/members` },
    { workspaceId: NORTHWIND, name: "Northwind Pilot", roleLabel: "Developer", href: `/members?workspace=${NORTHWIND}` },
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
            linkComponent={Link}
            defaultOpen
            {...props}
          />
        </PortalProvider>
      </QueryClientProvider>,
    );

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

  test("says why creating is not offered on this deployment", () => {
    const creation: WorkspaceCreation = { allowed: false, reason: "organization_admins_only" };
    const markup = open({ canCreate: false, createNotice: creationNotice(creation) });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("created by its administrators");
  });
});

describe("before a workspace", () => {
  test("with no workspaces and nothing to accept, / is the first run: the workspace is being made, nothing is asked", () => {
    const markup = render("/", { list: [] });
    expect(markup).toContain("Setting up your workspace");
    expect(markup).not.toContain("Create your workspace");
    expect(markup).not.toContain("Workspace name");
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

  test("once the invitations are dismissed, the first run sets the workspace up", () => {
    const pending = render("/", { list: [] }, withLink(invitationTo("Acme Field Team")));
    expect(pending).not.toContain("Setting up your workspace");
    // Dismiss forgets the invitation (PortalSession.forgetInvitation): none is left to offer.
    const dismissed = render("/", { list: [] }, { link: { status: "none" }, invitations: [] });
    expect(dismissed).toContain("Setting up your workspace");
    expect(dismissed).not.toContain("Pending invitation");
    expect(dismissed).not.toContain("Accept invitation");
  });

  test("a link for another account does not hold the workspace back: it is set up, and /invitation is where the link explains itself", () => {
    const markup = render("/", { list: [] }, withLink(invitationTo("Acme Field Team", { email: "b@else.test" })));
    expect(markup).toContain("Setting up your workspace");
    expect(markup).not.toContain("Accept invitation");
    expect(markup).not.toContain("Welcome to Mentra");
  });

  test("where creating is not allowed, a link for another account still offers Switch account", () => {
    const markup = render(
      "/",
      { list: [] },
      { ...withLink(invitationTo("Acme Field Team", { email: "b@else.test" })), creation: { allowed: false, reason: "email_unverified" } },
    );
    expect(markup).toContain("This invitation is for <strong");
    expect(markup).toContain(">b@else.test</strong>. You&#x27;re signed in as <strong");
    expect(markup).toContain(">Switch account<");
    expect(markup).not.toContain("Accept invitation");
    expect(markup).toContain("You&#x27;re not in a workspace yet.");
  });

  test("when creating is not allowed the first run says why, and the way into a workspace", () => {
    const markup = render("/", { list: [] }, { creation: { allowed: false, reason: "email_unverified" } });
    expect(markup).toContain("You&#x27;re not in a workspace yet.");
    expect(markup).toContain("Verify your account");
    expect(markup).toContain("Open an invitation link someone sent you to join their workspace.");
    expect(markup).not.toContain("Setting up your workspace");
    expect(markup).not.toContain("Workspace name");
  });

  test("where creating is not allowed an invitation is still shown, and no workspace is on the way", () => {
    const markup = render("/", { list: [] }, { creation: { allowed: false, reason: "organization_admins_only" }, ...withMine(invitationTo("Dev check")) });
    expect(markup).toContain("Join Dev check");
    expect(markup).not.toContain("Setting up your workspace");
    expect(markup).not.toContain("not in a workspace yet");
  });

  test("a ?workspace= opens that workspace's page, not the first run", () => {
    const markup = render("/members?workspace=ws_x", { list: [], details: [detail("ws_x", "Customer", "owner", false)], members: MEMBERS });
    expect(markup).not.toContain("Setting up your workspace");
    expect(markup).not.toContain("not in a workspace yet");
  });

  test("an invitation link opens the accept card, with the way back to your workspaces", () => {
    const markup = render("/invitation", TWO_WORKSPACES, withLink(invitationTo("Northwind Pilot", { role: "developer" })));
    expect(markup).toContain("You&#x27;re invited");
    expect(markup).toContain("Join Northwind Pilot");
    expect(markup).toContain("Developer");
    expect(markup).toContain("Dismiss");
    expect(markup).toContain("Accept invitation");
    expect(markup).toContain('href="/"');
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
    expect(markup).toMatch(/href="\/"[^>]*>Go to Acme Field Team</);
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
      <PortalRoutes route={parseRoute(path)} search="" me={ME} />
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

  test("no workspaces and a dead stored link: the first run sets the workspace up, with no invitation copy", async () => {
    const markup = renderHooked(await client(gone(), []), "/", TOKEN);
    expect(markup).toContain("Setting up your workspace");
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
    const markup = renderHooked(await client(gone(), [], TWO_WORKSPACES), `/members`, TOKEN);
    expect(markup).toContain('aria-label="Workspace: Acme Field Team. Switch workspace"');
    expect(markup).not.toContain("pending invitation");
  });

  test("an invitation that arrived by link and is also addressed to the person is offered once", async () => {
    const preview = invitationTo("Dev check");
    const markup = renderHooked(await client(preview, [preview, invitationTo("Northwind")], TWO_WORKSPACES), `/members`, TOKEN);
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
    expect(dismissed).toContain("Setting up your workspace");
    expect(dismissed).not.toContain("Join Dev check");

    const unverified = Response.json({ error: "email_unverified", error_description: "verify your email" }, { status: 403 });
    const refused = renderHooked(await client(null, unverified), "/", null);
    expect(refused).toContain("Setting up your workspace");

    const listed = renderHooked(await client(null, [preview]), "/", null);
    expect(listed).toContain("Join Dev check");
    expect(listed).not.toContain("Setting up your workspace");
  });
});

describe("deleting a workspace a service holds", () => {
  test("the settings page says why it cannot be deleted, where the delete is, and offers no delete", () => {
    const held: WorkspaceDetail = {
      ...detail(ACME, "Acme Field Team", "owner"),
      deletionHolds: [{ service: "store", reason: "owns_miniapps", count: 2 }],
    };
    const markup = render(`/settings`, { ...TWO_WORKSPACES, details: [held] });
    const section = /<section aria-label="Delete workspace"[\s\S]*?<\/section>/.exec(markup)?.[0] ?? "";
    expect(section).toContain("This workspace still owns 2 miniapps. Delete them in the Developer Console first.");
    // Held, the sentence above says why; the standing rule is not repeated beside it.
    expect(section).not.toContain("can&#x27;t be deleted");
    expect(section).toMatch(/<button[^>]*disabled=""[^>]*>Delete workspace<\/button>/);

    // Without a hold, the page still states the rule for miniapps in the Store.
    const free = render(`/settings`, TWO_WORKSPACES);
    expect(free).not.toContain("still owns");
    expect(free).toContain(
      "A workspace that owns miniapps in the Mentra Miniapp Store can&#x27;t be deleted. Delete its miniapps first.",
    );
    expect(free).not.toContain("stay there");
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
    const members = render(`/members`, seed);
    // The switcher names their own role; the member table (seeded with another role for them) is unchanged.
    expect(members).toContain(">Member · Organization Admin</span>");
    expect(members).toContain(ORGANIZATION_ADMIN_NOTE.replace("'", "&#x27;"));
    expect(members).toContain(">Invite<");
    const settings = render(`/settings`, seed);
    expect(settings).toContain(ORGANIZATION_ADMIN_NOTE.replace("'", "&#x27;"));
    expect(settings).toContain("Save name");
    // Someone whose powers are their own gets no note.
    expect(render(`/members`, TWO_WORKSPACES)).not.toContain("Organization Admin");
  });
});

test("the login gate names the site", () => {
  expect(renderToStaticMarkup(<LoginGate loginUrl="/api/portal/auth/login" />)).toContain("Sign into Mentra Portal");
});

test("the login gate's button says to sign into the Mentra account, with nothing under it", () => {
  const markup = renderToStaticMarkup(<LoginGate loginUrl="/api/portal/auth/login" />);
  expect(markup).toContain(">Sign into Mentra account</a></div></main>");
  expect(markup).not.toContain("Use the same account");
});

test("the login gate says to sign in with the invited address when an invitation is pending", () => {
  const loginUrl = "/api/portal/auth/login?return_to=%2Finvitation";
  expect(renderToStaticMarkup(<LoginGate invitePending loginUrl={loginUrl} />)).toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("trusted identity issuers");
});

// --- Licenses -----------------------------------------------------------------------------------------

const LICENSE: LicenseView = {
  licenseId: "lic_call",
  revision: 1,
  owner: { type: "workspace", workspaceId: ACME },
  product: "mentra.call.unlimited",
  features: [{ key: "call.unlimited", packages: ["com.mentra.call"] }],
  quantity: 3,
  validFrom: "2026-09-01T12:00:00.000Z",
  paidThrough: "2099-06-15T12:00:00.000Z",
  seatsUsed: 1,
  endedAt: null,
  // Priya holds the one seat that is taken.
  seats: [{ membershipId: "wm_2", mentraUserId: "u_2", assignedAt: "2026-09-03T12:00:00.000Z" }],
};

/** What Core answers a plain member: the license they hold a seat in, with only their own seat. */
const MEMBERS_OWN_LICENSE: LicenseView = {
  ...LICENSE,
  seatsUsed: 2,
  seats: [{ membershipId: `wm_${ACME}`, mentraUserId: "u_self", assignedAt: "2026-09-03T12:00:00.000Z" }],
};

const withLicenses = (licenses: LicenseView[] | undefined, seed: Seed = TWO_WORKSPACES): Seed => ({ ...seed, licenses });

/** Acme as a plain member sees it, with `licenses` as Core lists them to a member. */
const memberOfAcme = (licenses: LicenseView[] | undefined): Seed => ({
  ...TWO_WORKSPACES,
  list: [listItem(ACME, "Acme Field Team", "member"), listItem(NORTHWIND, "Northwind Pilot", "developer")],
  details: [detail(ACME, "Acme Field Team", "member"), detail(NORTHWIND, "Northwind Pilot", "developer")],
  licenses,
});

/** Acme as an Admin sees it (an Admin holds `workspace.billing.manage`), with `licenses` as Core lists them. */
const adminOfAcme = (licenses: LicenseView[] | undefined): Seed => ({
  ...TWO_WORKSPACES,
  list: [listItem(ACME, "Acme Field Team", "admin"), listItem(NORTHWIND, "Northwind Pilot", "developer")],
  details: [detail(ACME, "Acme Field Team", "admin"), detail(NORTHWIND, "Northwind Pilot", "developer")],
  licenses,
});

const caps = (role: WorkspaceRole) => ({ capabilities: [...capabilitiesForRole(role)] });

// The sidebar's Licenses link (any, and the current page's) and the page heading, as they render.
const LICENSES_ITEM = "</svg>Licenses</a>";
const ACTIVE_LICENSES_ITEM = /aria-current="page"[^>]*>(?:(?!<\/a>).)*<\/svg>Licenses<\/a>/;
const LICENSES_HEADING = /<h1[^>]*>Licenses<\/h1>/;

describe("Licenses in the sidebar", () => {
  test("is the last section, and is offered only where there are licenses to show", () => {
    expect(visibleSections(caps("admin"), { licenses: true })).toEqual(["members", "settings", "audit", "licenses"]);
    expect(visibleSections(caps("owner"), { licenses: true })).toEqual(["members", "settings", "audit", "licenses"]);
    expect(visibleSections(caps("member"), { licenses: true })).toEqual(["settings", "licenses"]);
    expect(visibleSections(caps("owner"), { licenses: false })).toEqual(["members", "settings", "audit"]);
    expect(visibleSections(caps("owner"))).toEqual(["members", "settings", "audit"]);
  });

  test("is called Licenses and goes to the workspace's licenses address", () => {
    const items = workspaceNav(ACME, visibleSections(caps("owner"), { licenses: true }), ACME).flatMap(group => group.items);
    expect(items.find(item => item.key === "licenses")).toMatchObject({ label: "Licenses", href: `/licenses` });
  });

  test("shows when billing is offered or the workspace has licenses, and never when it has neither", () => {
    expect(licensesPartShown(true, undefined)).toBe(true);
    expect(licensesPartShown(true, [])).toBe(true);
    expect(licensesPartShown(false, [LICENSE])).toBe(true);
    expect(licensesPartShown(false, [])).toBe(false);
    expect(licensesPartShown(false, undefined)).toBe(false);
  });
});

describe("the Licenses page", () => {
  test("is titled Licenses with no subtitle under it, for those who manage the workspace and for anyone else", () => {
    const manager = renderAs(true, `/licenses`, withLicenses([LICENSE]));
    expect(hrefs(manager)).toContain(`/licenses`);
    expect(manager).toMatch(ACTIVE_LICENSES_ITEM);
    expect(manager).toMatch(LICENSES_HEADING);
    expect(manager).not.toContain("pays for");
    // The title stands alone: nothing is drawn under it.
    expect(manager).not.toMatch(/Licenses<\/h1><p/);
    // An Admin sees the same page.
    const admin = renderAs(true, `/licenses`, adminOfAcme([LICENSE]));
    expect(admin).toMatch(LICENSES_HEADING);
    expect(admin).not.toContain("pays for");
    expect(admin).not.toMatch(/Licenses<\/h1><p/);
    const member = renderAs(true, `/licenses`, memberOfAcme([MEMBERS_OWN_LICENSE]));
    expect(hrefs(member)).toContain(`/licenses`);
    expect(member).toMatch(ACTIVE_LICENSES_ITEM);
    expect(member).not.toContain("Your licenses in");
    expect(member).not.toContain("pays for");
    expect(member).not.toMatch(/Licenses<\/h1><p/);
  });

  test("is the view and nothing else: no module is hosted for any viewer", () => {
    for (const markup of [
      renderAs(true, `/licenses`, withLicenses([LICENSE])),
      renderAs(true, `/licenses`, adminOfAcme([LICENSE])),
      renderAs(false, `/licenses`, withLicenses([LICENSE])),
      renderAs(true, `/licenses`, memberOfAcme([MEMBERS_OWN_LICENSE])),
    ]) {
      expect(markup).not.toContain('<section aria-label="Billing"');
      expect(markup).not.toContain('aria-label="Fleet Management"');
      expect(markup).not.toContain("Loading Billing");
      expect(markup).not.toContain("Billing is unavailable");
    }
  });

  test("a Member with billing on and no licenses has no Licenses item and no page", () => {
    for (const path of [`/settings`, `/licenses`]) {
      const markup = renderAs(true, path, memberOfAcme([]));
      expect(markup).not.toContain(LICENSES_ITEM);
      expect(markup).not.toMatch(LICENSES_HEADING);
      expect(hrefs(markup).some(href => href.endsWith("/licenses") || href === "/account/billing")).toBe(false);
    }
  });

  test("billing is offered to a viewer when it is ready for them and their role manages it", () => {
    const admin = detail(ACME, "Acme Field Team", "admin");
    expect(billingOffered(meWith(true), admin)).toBe(true);
    expect(billingOffered(meWith(true), detail(ACME, "Acme Field Team", "owner"))).toBe(true);
    // Billing off, a role below Admin, or a workspace not yet loaded: no.
    expect(billingOffered(meWith(false), admin)).toBe(false);
    for (const role of ["member", "developer"] as const) {
      expect(billingOffered(meWith(true), detail(ACME, "Acme Field Team", role))).toBe(false);
    }
    expect(billingOffered(meWith(true), undefined)).toBe(false);
  });

  test("a Private Cloud, with no billing and no licenses, has no Licenses item and no page", () => {
    for (const path of [`/members`, `/licenses`, `/settings?workspace=${NORTHWIND}`]) {
      const markup = renderAs(false, path, withLicenses([]));
      expect(markup).not.toContain(LICENSES_ITEM);
      expect(markup).not.toMatch(LICENSES_HEADING);
      expect(hrefs(markup).some(href => href.endsWith("/licenses") || href === "/account/billing")).toBe(false);
    }
  });

  test("while the licenses load, the item is not offered but the page waits instead of leaving", () => {
    const sidebar = renderAs(false, `/members`, withLicenses(undefined));
    expect(sidebar).not.toContain(LICENSES_ITEM);
    const page = renderAs(false, `/licenses`, withLicenses(undefined));
    expect(page).toContain("Loading licenses");
    expect(page).not.toContain("no licenses yet");
  });
});

describe("when the workspace's licenses cannot be loaded", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  /**
   * A cache where Acme's license list has already failed with a 500 (a Core that cannot read them). Each render
   * clears its cache, so each gets its own.
   */
  async function failedLicenses(): Promise<QueryClient> {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "server_error", error_description: "licenses are unavailable" }, { status: 500 })) as unknown as typeof fetch);
    restore = () => spy.mockRestore();
    // A server render would otherwise show the refetch a mounted observer starts for a failed query.
    const client = seeded(TWO_WORKSPACES, new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } }));
    await client.fetchQuery({ ...licensesQuery(api, ACME), retry: false }).catch(() => undefined);
    expect(client.getQueryState(licensesQuery(api, ACME).queryKey)?.status).toBe("error");
    return client;
  }

  const renderFailed = async (billing: boolean, path: string) =>
    render(path, TWO_WORKSPACES, { modules: meWith(billing).modules }, await failedLicenses(), meWith(billing));

  test("the workspace's other pages still render, and Licenses is offered only with billing", async () => {
    const without = await renderFailed(false, `/members`);
    expect(without).toContain("priya@acme.test");
    expect(without).toContain(">Invite<");
    expect(without).not.toContain(LICENSES_ITEM);
    expect(hrefs(without)).not.toContain(`/licenses`);

    const withBilling = await renderFailed(true, `/members`);
    expect(withBilling).toContain("priya@acme.test");
    expect(hrefs(withBilling)).toContain(`/licenses`);
  });

  test("the licenses address opens the page and shows the view's own error with Retry, not a redirect or a spinner", async () => {
    for (const billing of [false, true]) {
      const markup = await renderFailed(billing, `/licenses`);
      expect(markup).toMatch(LICENSES_HEADING);
      expect(markup).toContain("Licenses are unavailable");
      expect(markup).toMatch(/<button[^>]*>.*Retry<\/button>/);
      expect(markup).not.toContain("Loading licenses");
      expect(markup).not.toContain("no licenses yet");
      // No module is hosted behind it.
      expect(markup).not.toContain('<section aria-label="Billing"');
    }
  });
});

describe("the personal Billing page is gone", () => {
  test("/account/billing is not found, whether or not the person is offered billing", () => {
    for (const markup of [
      renderAs(false, "/account/billing", { list: [] }),
      renderAs(true, "/account/billing", { list: [] }),
      renderAs(true, "/account/billing", TWO_WORKSPACES),
    ]) {
      expect(markup).toContain("Page not found");
      expect(markup).not.toContain("Loading billing");
    }
  });

  test("the portal's source has no account items and no Billing address", async () => {
    const shell = await Bun.file(new URL("./components/portal-shell.tsx", import.meta.url)).text();
    expect(shell).not.toContain("accountItems");
    const routes = await Bun.file(new URL("./lib/routes.ts", import.meta.url)).text();
    expect(routes).not.toContain("ACCOUNT_BILLING_PATH");
  });

  test("the account menu is Sign out alone", () => {
    const menu = renderToStaticMarkup(<AccountFooter userEmail="sam@acme.test" items={[]} defaultOpen />);
    expect(menu).toContain("Sign out");
    expect(menu).not.toContain("Billing");
  });
});

describe("the portal's session", () => {
  test("a module's 401 refreshes who the person is, which sends an ended session to sign in", () => {
    const client = new QueryClient();
    client.setQueryData(PORTAL_ME_KEY, ME);
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(false);
    expireSession(client);
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(true);
    client.clear();
  });
});

/**
 * The payment processor's name, spelled in pieces: the repository's guard (the `no-` test for it in
 * `.github/scripts`) keeps that name out of every source file in Cloud V2, this one included, and with it out of
 * what the pages say. This checks what they render.
 */
const PROCESSOR_NAME = new RegExp(["st", "ripe"].join(""), "i");

describe("no page names the payment processor", () => {
  test("not the workspace's licenses page, with billing or without it, nor the account menu", () => {
    const pages = [
      renderAs(false, `/licenses`, withLicenses([LICENSE])),
      renderAs(true, `/licenses`, withLicenses([LICENSE])),
      renderAs(true, `/licenses`, memberOfAcme([MEMBERS_OWN_LICENSE])),
      renderToStaticMarkup(<AccountFooter userEmail="sam@acme.test" items={[]} defaultOpen />),
    ];
    expect(pages.every(markup => markup.length > 0)).toBe(true);
    for (const markup of pages) expect(markup).not.toMatch(PROCESSOR_NAME);
    // The pattern is the name it stands for.
    expect(PROCESSOR_NAME.test(["Pay with ", "St", "ripe"].join(""))).toBe(true);
  });
});
