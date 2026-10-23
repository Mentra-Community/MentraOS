/**
 * The portal's short addresses, mounted over the real clients and a small fake Core, in a DOM (happy-dom): the
 * address a person lands on after a redirect or an invitation, and which workspace is current. The
 * pure rules are in lib/routes.test.ts; `app.test.tsx` has the server-rendered frame.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { capabilitiesForRole, type InvitationPreview, type WorkspaceDetail, type WorkspaceRole } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, findAll, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import { PortalRoutes } from "./App";
import type { PortalMe } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PortalProvider, type PortalSession } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import type { InviteStorage } from "./lib/workspace-invite";

beforeAll(setupDom);
afterAll(teardownDom);
beforeEach(() => window.localStorage.clear());
afterEach(async () => {
  await cleanup();
  mock.restore();
});

const ME: PortalMe = {
  authenticated: true,
  user: { id: "u_dana", email: "dana@example.com", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: false,
  org: null,
  modules: { billing: false, billingCatalog: false },
};

const LAST_WORKSPACE_KEY = "mentra.portal.lastWorkspace";

function detail(workspaceId: string, role: WorkspaceRole, member = true): WorkspaceDetail {
  return {
    workspaceId,
    name: `Name of ${workspaceId}`,
    status: "active",
    authorizationRevision: 1,
    membership: member ? { membershipId: `wm_${workspaceId}`, role } : null,
    capabilities: [...capabilitiesForRole(role)],
    ...(member ? {} : { organizationAdmin: true }),
  };
}

interface Core {
  /** The workspaces the person is in, in the order Core lists them. */
  listed: string[];
  /** Workspaces they can open only as an Organization Admin. */
  adminOf: string[];
  /** What Core answers a workspace it does not know. */
  unknown: 403 | 404;
  invitations: InvitationPreview[];
  requests: string[];
}

function fakeCore(setup: Partial<Core>) {
  const core: Core = { listed: [], adminOf: [], unknown: 404, invitations: [], requests: [], ...setup };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://portal.example.test");
    const method = (init?.method ?? "GET").toUpperCase();
    core.requests.push(`${method} ${url.pathname}`);
    const base = "/api/portal/workspaces";
    const path = url.pathname;
    if (path === base) return json({ items: core.listed.map(id => ({ ...detail(id, "owner"), membership: { membershipId: `wm_${id}`, role: "owner" } })) });
    if (path === `${base}/invitations/mine`) return json({ items: core.invitations });
    if (path === `${base}/invitations/accept` && method === "POST") {
      const { invitationId } = JSON.parse(String(init?.body)) as { invitationId: string };
      const invitation = core.invitations.find(item => item.invitationId === invitationId)!;
      core.listed.push(invitation.workspaceId);
      core.invitations = core.invitations.filter(item => item !== invitation);
      return json({ workspaceId: invitation.workspaceId, membershipId: `wm_${invitation.workspaceId}` });
    }
    const workspace = new RegExp(`^${base}/([^/]+)(?:/(.*))?$`).exec(path);
    if (workspace) {
      const id = decodeURIComponent(workspace[1]!);
      const rest = workspace[2];
      const known = core.listed.includes(id) || core.adminOf.includes(id);
      if (!known) return json({ error: "workspace_not_found", error_description: "no such workspace" }, core.unknown);
      if (!rest) return json(detail(id, "owner", core.listed.includes(id)));
      if (rest === "members" || rest === "invitations" || rest === "licenses") return json({ items: [] });
    }
    return json({ error: "not_found", error_description: path }, 404);
  };
  return { core, fetcher };
}

const memory = (): InviteStorage => {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: key => void data.delete(key) };
};

/** The portal as the app wires it: invitations from the real hook, routes over the address. */
function Portal() {
  const pathname = usePathname();
  const invites = usePortalInvitations({
    initialToken: null,
    signedIn: true,
    accountEmail: ME.user.email ?? null,
    pathname,
    sessionStore: memory(),
    localStore: memory(),
  });
  const session: PortalSession = {
    userEmail: ME.user.email ?? "",
    accountEmail: ME.user.email ?? null,
    creation: { allowed: true, reason: null },
    link: invites.link,
    invitations: invites.invitations,
    forgetInvitation: invites.forgetInvitation,
    signOut() {},
    signingOut: false,
    developerConsoleUrl: null,
    modules: ME.modules,
    sessionExpired() {},
  };
  return (
    <PortalProvider value={session}>
      <PortalRoutes route={parseRoute(pathname)} me={ME} />
    </PortalProvider>
  );
}

async function open(address: string, setup: Partial<Core>, ready: string) {
  window.history.replaceState(null, "", address);
  const { core, fetcher } = fakeCore(setup);
  spyOn(globalThis, "fetch").mockImplementation(fetcher as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  await render(
    <QueryClientProvider client={client}>
      <Portal />
    </QueryClientProvider>,
  );
  await until(() => (document.body.textContent ?? "").includes(ready), `the page to show ${ready}`);
  return core;
}

const address = () => `${window.location.pathname}${window.location.search}`;
const sidebarHrefs = () =>
  findAll<HTMLAnchorElement>("nav a[href]")
    .map(anchor => anchor.getAttribute("href")!)
    .filter(href => ["/members", "/settings", "/licenses", "/fleet"].includes(href.split("?")[0]!));
const page = () => document.body.textContent ?? "";

describe("older addresses land on the same page, keeping their query", () => {
  test("/w/<own>/<section>?… opens the section at its short address, with the rest of the query", async () => {
    await open("/w/ws_own/settings?purchase=pur_1&tab=2", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/settings?purchase=pur_1&tab=2", "the short address");
  });

  test("/w/<id> opens the workspace's first section, and an unknown section does the same", async () => {
    await open("/w/ws_own", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/members", "the first section");
    await cleanup();
    await open("/w/ws_own/nope?purchase=pur_1", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address().startsWith("/members"), "the first section");
  });

  test("a workspace the person only manages as an Organization Admin keeps its ?workspace=", async () => {
    await open("/w/ws_x/members?tab=2", { listed: ["ws_own"], adminOf: ["ws_x"] }, "Name of ws_x");
    await until(() => address() === "/members?workspace=ws_x&tab=2", "the workspace named in the address");
  });
});

describe("the current workspace", () => {
  test("a person's own workspace gets bare links, and a redundant ?workspace= is dropped in place", async () => {
    await open("/settings?workspace=ws_own&purchase=pur_1", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/settings?purchase=pur_1", "the redundant parameter to go");
    expect(sidebarHrefs()).toEqual(["/members", "/settings"]);
  });

  test("an Organization Admin at a customer's workspace gets ?workspace= on every sidebar link, and it is not remembered", async () => {
    await open("/members?workspace=ws_x", { listed: ["ws_own"], adminOf: ["ws_x"] }, "Name of ws_x");
    expect(address()).toBe("/members?workspace=ws_x");
    expect(sidebarHrefs()).toEqual(["/members?workspace=ws_x", "/settings?workspace=ws_x"]);
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
  });

  test("a workspace opened from the person's list is remembered, and then the bare address opens it", async () => {
    await open("/settings?workspace=ws_b", { listed: ["ws_a", "ws_b"] }, "Name of ws_b");
    await until(() => window.localStorage.getItem(LAST_WORKSPACE_KEY) === "ws_b", "the workspace to be remembered");
    await until(() => address() === "/settings", "ws_b to be the bare address");
    // There is no switcher to name the other one from.
    expect(document.querySelector("button[aria-label^='Workspace:']")).toBeNull();
    expect(sidebarHrefs()).toEqual(["/members", "/settings"]);
  });

  test("a remembered workspace the person is not in is ignored: the first one opens and the stale one is never asked for", async () => {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "ws_gone");
    const core = await open("/settings", { listed: ["ws_a", "ws_b"], adminOf: ["ws_gone"] }, "Name of ws_a");
    expect(core.requests.some(request => request.includes("ws_gone"))).toBe(false);
    expect(address()).toBe("/settings");
  });

  test("/ opens the current workspace's first section", async () => {
    await open("/", { listed: ["ws_a", "ws_b"] }, "Name of ws_a");
    await until(() => address() === "/members", "the first section");
  });
});

describe("each tab stays on its own workspace", () => {
  test("another tab picking a workspace does not move this one", async () => {
    const core = await open("/settings", { listed: ["ws_a", "ws_b"] }, "Name of ws_a");
    // Another tab remembers ws_b.
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "ws_b");
    // This tab renders again (it navigates within the portal).
    await click(find("nav a[href='/members']"));
    await until(() => address() === "/members", "the Members page");
    expect(core.requests.some(request => request.endsWith("/ws_b"))).toBe(false);
    expect(page()).toContain("Name of ws_a");
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe("ws_b");
  });

  test("this tab's own pick is what its bare address means from then on", async () => {
    await open("/settings?workspace=ws_b", { listed: ["ws_a", "ws_b"] }, "Name of ws_b");
    await until(() => address() === "/settings", "ws_b to be the bare address");
    expect(window.localStorage.getItem(LAST_WORKSPACE_KEY)).toBe("ws_b");
    // Another tab remembers ws_a; this one still means ws_b.
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "ws_a");
    await click(find("nav a[href='/settings']"));
    await until(() => address() === "/settings", "the Settings page");
    expect(page()).toContain("Name of ws_b");
  });
});

describe("a malformed or repeated ?workspace=", () => {
  test("an id Core does not know is the not found page, however it is spelled", async () => {
    await open("/members?workspace=%E0%A4%A", { listed: ["ws_own"] }, "Workspace not found");
  });

  test("a blank ?workspace= is none: the person's own workspace opens", async () => {
    await open("/settings?workspace=%20", { listed: ["ws_own"] }, "Name of ws_own");
    expect(page()).not.toContain("Workspace not found");
  });

  test("with two, the first is used, and a redundant one takes both out", async () => {
    await open("/settings?workspace=ws_own&workspace=ws_x&purchase=pur_1", { listed: ["ws_own"], adminOf: ["ws_x"] }, "Name of ws_own");
    await until(() => address() === "/settings?purchase=pur_1", "the redundant parameters to go");
  });
});

describe("redirects keep what the address carried", () => {
  test("/ to the first section keeps every query parameter", async () => {
    await open("/?purchase=pur_1&tab=2", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/members?purchase=pur_1&tab=2", "the first section, query kept");
  });

  test("an older address keeps its hash", async () => {
    await open("/w/ws_own/settings?tab=2#danger", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/settings?tab=2", "the short address");
    expect(window.location.hash).toBe("#danger");
  });

  test("an older address with no section keeps its hash through the redirect to the first section", async () => {
    await open("/w/ws_own?tab=2#danger", { listed: ["ws_own"] }, "Name of ws_own");
    await until(() => address() === "/members?tab=2", "the first section, query kept");
    expect(window.location.hash).toBe("#danger");
  });
});

describe("a workspace the person cannot open", () => {
  for (const status of [404, 403] as const) {
    test(`?workspace= for one Core answers ${status} is the not found page`, async () => {
      await open("/members?workspace=ws_nope", { listed: ["ws_own"], unknown: status }, "Workspace not found");
      expect(address()).toBe("/members?workspace=ws_nope");
    });
  }
});

describe("accepting an invitation keeps the address", () => {
  const invitation: InvitationPreview = {
    invitationId: "winv_1",
    workspaceId: "ws_joined",
    workspaceName: "Joined",
    email: ME.user.email ?? "",
    role: "owner",
    invitedByEmail: "olivia@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  test("on a page with ?buy= it lands on the same page and ?buy= in the joined workspace", async () => {
    const core = await open("/settings?buy=x", { invitations: [invitation] }, "Join Joined");
    await click(byText("Accept invitation", "button"));
    await until(() => core.requests.includes("GET /api/portal/workspaces/ws_joined"), "the joined workspace to open");
    await until(() => page().includes("Name of ws_joined"), "its page");
    // The joined workspace is the person's only one, so it is what the bare address opens.
    await until(() => address() === "/settings?buy=x", "the address to stay short");
  });
});
