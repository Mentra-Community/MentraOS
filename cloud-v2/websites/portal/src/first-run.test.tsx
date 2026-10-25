/**
 * The first run, mounted over the real clients and a small fake Core, in a DOM (happy-dom): a person who arrives
 * without a workspace gets one made (`POST /api/portal/workspaces/ensure`) unless they have an invitation to
 * accept, are not allowed one, or came to a workspace by its id. The address, `?buy=` included, survives all of it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { capabilitiesForRole, type InvitationPreview, type WorkspaceDetail } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, findAll, flush, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import { workspaceKeys } from "@mentra/workspace-ui";
import { act, StrictMode } from "react";
import { LoginGate, PortalRoutes } from "./App";
import type { PortalMe } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PortalProvider, portalWorkspaceApi, type PortalSession, type WorkspaceCreation } from "./lib/portal";
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

const BUY = "/licenses?buy=mentra.call.unlimited";
const LINK_TOKEN = "link-token-never-rendered";

const ME: PortalMe = {
  authenticated: true,
  user: { id: "u_dana", email: "dana@example.com", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: false,
  org: null,
  // Billing is offered, so Licenses is a page this person's own workspace has.
  modules: { billing: true },
};

function detail(workspaceId: string, member = true): WorkspaceDetail {
  return {
    workspaceId,
    name: `Name of ${workspaceId}`,
    status: "active",
    authorizationRevision: 1,
    membership: member ? { membershipId: `wm_${workspaceId}`, role: "owner" } : null,
    capabilities: [...capabilitiesForRole("owner")],
    ...(member ? {} : { organizationAdmin: true }),
  };
}

function invitationTo(workspaceId: string, email = ME.user.email ?? ""): InvitationPreview {
  return {
    invitationId: `winv_${workspaceId}`,
    workspaceId,
    workspaceName: `Name of ${workspaceId}`,
    email,
    role: "owner",
    invitedByEmail: "olivia@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

interface Core {
  listed: string[];
  adminOf: string[];
  /** Invitations addressed to the person (`GET /invitations/mine`). */
  invitations: InvitationPreview[];
  /** What the tab's link looks up to; null when the link is no longer valid. */
  link: InvitationPreview | null;
  /** `ensure` finds a workspace the list had not shown yet, and answers 200 with it. */
  ensureFindsExisting: boolean;
  /** How many `ensure` calls fail before one succeeds. */
  ensureFailures: number;
  /** `ensure` is refused with this status (403: creation is not allowed after all). */
  ensureStatus: number | null;
  /** `ensure` makes the workspace, but the list does not show it (a read that came back stale or failed). */
  listHidesMade: boolean;
  /** `ensure` does not answer until this resolves. */
  ensureGate: Promise<void> | null;
  /** `GET /invitations/mine` does not answer until this resolves. */
  mineGate: Promise<void> | null;
  /** `GET /invitations/mine` fails with this status (0: the connection drops). */
  mineStatus: number | null;
  /** The link lookup fails with this status. */
  linkStatus: number | null;
  /** How many times `ensure` was called. */
  ensures: number;
  requests: string[];
}

function fakeCore(setup: Partial<Core>) {
  const core: Core = {
    listed: [],
    adminOf: [],
    invitations: [],
    link: null,
    ensureFindsExisting: false,
    ensureFailures: 0,
    ensureStatus: null,
    listHidesMade: false,
    ensureGate: null,
    mineGate: null,
    mineStatus: null,
    linkStatus: null,
    ensures: 0,
    requests: [],
    ...setup,
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://portal.example.test");
    const method = (init?.method ?? "GET").toUpperCase();
    core.requests.push(`${method} ${url.pathname}`);
    const base = "/api/portal/workspaces";
    const path = url.pathname;
    if (path === base) {
      if (core.listHidesMade && core.ensures > 0) return json({ error: "failed", error_description: "Could not list." }, 500);
      return json({ items: core.listed.map(id => ({ ...detail(id), membership: { membershipId: `wm_${id}`, role: "owner" } })) });
    }
    if (path === `${base}/ensure` && method === "POST") {
      core.ensures += 1;
      expect(init?.body).toBeUndefined();
      await core.ensureGate;
      if (core.ensureStatus !== null) return json({ error: "workspace_creation_not_allowed", error_description: "Creation is not allowed." }, core.ensureStatus);
      if (core.ensureFailures > 0) {
        core.ensureFailures -= 1;
        return json({ error: "internal_error", error_description: "try later" }, 500);
      }
      if (core.ensureFindsExisting) core.listed.push("ws_existing");
      if (core.listed.length > 0) return json(detail(core.listed[0]!), 200);
      core.listed.push("ws_made");
      return json(detail("ws_made"), 201);
    }
    if (path === `${base}/invitations/mine`) {
      await core.mineGate;
      if (core.mineStatus === 0) throw new TypeError("offline");
      if (core.mineStatus !== null) return json({ error: "failed", error_description: "Could not list your invitations." }, core.mineStatus);
      return json({ items: core.invitations });
    }
    if (path === `${base}/invitations/peek` && method === "POST") {
      if (core.linkStatus !== null) return json({ error: "failed", error_description: "Could not look up the invitation." }, core.linkStatus);
      return core.link ? json(core.link) : json({ error: "invitation_not_found", error_description: "gone" }, 404);
    }
    if (path === `${base}/invitations/accept` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { invitationId?: string; token?: string };
      const invitation = body.token ? core.link! : core.invitations.find(item => item.invitationId === body.invitationId)!;
      core.listed.push(invitation.workspaceId);
      core.invitations = core.invitations.filter(item => item.invitationId !== invitation.invitationId);
      return json({ workspaceId: invitation.workspaceId, membershipId: `wm_${invitation.workspaceId}` });
    }
    const workspace = new RegExp(`^${base}/([^/]+)(?:/(.*))?$`).exec(path);
    if (workspace) {
      const id = decodeURIComponent(workspace[1]!);
      const rest = workspace[2];
      const known = core.listed.includes(id) || core.adminOf.includes(id);
      if (!known) return json({ error: "workspace_not_found", error_description: "no such workspace" }, 404);
      if (!rest) return json(detail(id, core.listed.includes(id)));
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
function Portal({ creation, link }: { creation: WorkspaceCreation; link: string | null }) {
  const pathname = usePathname();
  const invites = usePortalInvitations({
    initialToken: link,
    signedIn: true,
    accountEmail: ME.user.email ?? null,
    pathname,
    sessionStore: memory(),
    localStore: memory(),
  });
  const session: PortalSession = {
    userEmail: ME.user.email ?? "",
    accountEmail: ME.user.email ?? null,
    creation,
    link: invites.link,
    invitations: invites.invitations,
    forgetInvitation: invites.forgetInvitation,
    invitationsUnavailable: invites.unavailable,
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

interface Options extends Partial<Core> {
  creation?: WorkspaceCreation;
  /** The tab holds an invitation link. */
  withLink?: boolean;
  /** The list and the invitations are already in the cache, so the first run mounts with its answer in hand. */
  warm?: boolean;
}

function app({ creation = { allowed: true, reason: null }, withLink = false }: Options, client: QueryClient) {
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <Portal creation={creation} link={withLink ? LINK_TOKEN : null} />
      </QueryClientProvider>
    </StrictMode>
  );
}

async function open(address: string, options: Options = {}) {
  window.history.replaceState(null, "", address);
  const { core, fetcher } = fakeCore(options);
  spyOn(globalThis, "fetch").mockImplementation(fetcher as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, refetchOnWindowFocus: false, ...(options.warm ? { staleTime: Infinity } : {}) } } });
  if (options.warm) {
    client.setQueryData(workspaceKeys.list(portalWorkspaceApi), []);
    client.setQueryData(workspaceKeys.myInvitations(portalWorkspaceApi), []);
  }
  const mounted = await render(app(options, client));
  return { core, mounted, options, client };
}

const page = () => document.body.textContent ?? "";
const heading = () => document.querySelector("h1")?.textContent ?? null;
const address = () => `${window.location.pathname}${window.location.search}`;
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => (release = resolve));
  return { promise, release };
};

describe("a person with no workspace and no invitation gets one made", () => {
  test("/licenses?buy= shows Setting up your workspace, calls ensure once, and becomes Licenses at the same address", async () => {
    const gate = deferred();
    const { core, mounted, options, client } = await open(BUY, { ensureGate: gate.promise });
    await until(() => core.ensures === 1, "ensure to be called");
    expect(page()).toContain("Setting up your workspace");
    // Rendering again (and React's strict mode, which runs every effect twice) asks nothing more.
    await mounted.rerender(app(options, client));
    await flush();
    expect(core.ensures).toBe(1);

    gate.release();
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(core.ensures).toBe(1);
    expect(page()).toContain("Name of ws_made");
    expect(address()).toBe(BUY);
  });

  test("with everything already in the cache, strict mode's second effect pass asks nothing more", async () => {
    const gate = deferred();
    const { core } = await open(BUY, { warm: true, ensureGate: gate.promise });
    await until(() => core.ensures >= 1, "ensure to be called");
    await flush();
    expect(core.ensures).toBe(1);
    gate.release();
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(core.ensures).toBe(1);
  });

  test("the new workspace is requested after the list shows it, and the list is asked again", async () => {
    const { core } = await open("/members");
    await until(() => page().includes("Name of ws_made"), "the new workspace");
    expect(core.requests.filter(request => request === "GET /api/portal/workspaces").length).toBeGreaterThanOrEqual(2);
    expect(address()).toBe("/members");
  });

  test("an Organization Admin with no workspace of their own gets one at a bare address", async () => {
    const { core } = await open("/licenses", { adminOf: ["ws_x"] });
    await until(() => core.ensures === 1 && page().includes("Name of ws_made"), "their workspace");
  });

  test("a person who already has one (ensure answers 200) lands in it", async () => {
    const { core } = await open("/members", { ensureFindsExisting: true });
    await until(() => page().includes("Name of ws_existing"), "their workspace");
    expect(core.ensures).toBe(1);
  });

  test("a failed ensure says so and Try again asks once more", async () => {
    const { core } = await open(BUY, { ensureFailures: 1 });
    await until(() => page().includes("Couldn't set up your workspace."), "the failure");
    expect(core.ensures).toBe(1);
    await flush();
    expect(core.ensures).toBe(1);
    await click(byText("Try again", "button"));
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(core.ensures).toBe(2);
    expect(address()).toBe(BUY);
  });

  test("an ensure Core refuses (403) is decision 6's page, with no Try again", async () => {
    const { core } = await open(BUY, { ensureStatus: 403 });
    await until(() => page().includes("You're not in a workspace yet."), "the page");
    expect(page()).toContain("You can't create a workspace with this account.");
    expect(page()).toContain("Open an invitation link someone sent you to join their workspace.");
    expect(page()).not.toContain("Couldn't set up your workspace.");
    expect(findAll("button").some(button => button.textContent === "Try again")).toBe(false);
    await flush();
    expect(core.ensures).toBe(1);
    expect(address()).toBe(BUY);
  });

  test("an ensure that succeeds while the list cannot show the workspace ends in the failure state, and Try again asks again", async () => {
    const { core } = await open(BUY, { listHidesMade: true });
    await until(() => page().includes("Couldn't set up your workspace."), "the failure");
    expect(page()).not.toContain("Setting up your workspace");
    expect(core.ensures).toBe(1);
    core.listHidesMade = false;
    await click(byText("Try again", "button"));
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(core.ensures).toBe(2);
  });

  test("losing the workspace later makes a new one", async () => {
    const { core, client } = await open("/members");
    await until(() => page().includes("Name of ws_made"), "the new workspace");
    expect(core.ensures).toBe(1);
    // Deleted or left from here, or elsewhere: the list no longer has it.
    core.listed = [];
    await act(async () => {
      await client.invalidateQueries({ queryKey: workspaceKeys.list(portalWorkspaceApi) });
    });
    await until(() => core.ensures === 2, "ensure to be called again");
    await until(() => core.listed.length === 1 && page().includes("Name of ws_made"), "a new workspace");
  });
});

describe("an invitation the person can accept comes first", () => {
  test("their invitations show in place and ensure is never called; accepting keeps the address and its ?buy=", async () => {
    const { core } = await open(BUY, { invitations: [invitationTo("ws_joined")] });
    await until(() => page().includes("Join Name of ws_joined"), "the invitation");
    await flush();
    expect(core.ensures).toBe(0);
    expect(address()).toBe(BUY);

    await click(byText("Accept invitation", "button"));
    await until(() => page().includes("Name of ws_joined") && heading() === "Licenses", "the joined workspace's Licenses page");
    expect(address()).toBe(BUY);
    expect(core.ensures).toBe(0);
  });

  test("a valid link for this account is the same: it shows, ensure waits, and accepting keeps ?buy=", async () => {
    const { core } = await open(BUY, { withLink: true, link: invitationTo("ws_linked") });
    await until(() => page().includes("Join Name of ws_linked"), "the link's invitation");
    await flush();
    expect(core.ensures).toBe(0);
    await click(byText("Accept invitation", "button"));
    await until(() => page().includes("Name of ws_linked") && heading() === "Licenses", "the joined workspace");
    expect(address()).toBe(BUY);
    expect(core.ensures).toBe(0);
  });

  test("the portal waits for the invitation lookup before it decides", async () => {
    const gate = deferred();
    const { core } = await open(BUY, { mineGate: gate.promise, invitations: [invitationTo("ws_joined")] });
    await until(() => page().includes("Looking for your invitations"), "the wait");
    await flush();
    expect(core.ensures).toBe(0);
    gate.release();
    await until(() => page().includes("Join Name of ws_joined"), "the invitation");
    expect(core.ensures).toBe(0);
  });

  test("dismissing the last one makes the workspace", async () => {
    const { core } = await open(BUY, { invitations: [invitationTo("ws_joined")] });
    await until(() => page().includes("Join Name of ws_joined"), "the invitation");
    expect(core.ensures).toBe(0);
    await click(byText("Dismiss", "button"));
    await until(() => core.ensures === 1, "ensure to be called");
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(address()).toBe(BUY);
  });

  test("dismissing one of two does not", async () => {
    const { core } = await open(BUY, { invitations: [invitationTo("ws_one"), invitationTo("ws_two")] });
    await until(() => page().includes("Join Name of ws_two"), "both invitations");
    await click(findAll<HTMLButtonElement>("button").find(button => button.textContent === "Dismiss")!);
    await flush();
    expect(core.ensures).toBe(0);
  });

  test("an invitation for another account does not stop it", async () => {
    const { core } = await open(BUY, { withLink: true, link: invitationTo("ws_other", "someone@else.test") });
    await until(() => core.ensures === 1, "ensure to be called");
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(address()).toBe(BUY);
  });

  test("a link that is no longer valid does not stop it", async () => {
    const { core } = await open(BUY, { withLink: true, link: null });
    await until(() => core.ensures === 1, "ensure to be called");
    await until(() => heading() === "Licenses", "the Licenses page");
  });
});

describe("invitations that could not be read hold the first run back", () => {
  const unreadable = "Could not list your invitations.";

  test("a failed /invitations/mine (5xx) makes nothing and offers Try again, which looks again", async () => {
    const { core } = await open(BUY, { mineStatus: 500 });
    await until(() => page().includes(unreadable), "the unavailable state");
    expect(page()).toContain("Try again");
    await flush();
    expect(core.ensures).toBe(0);
    expect(page()).not.toContain("Setting up your workspace");
    // Back up, with an invitation waiting: it is shown, and still nothing is made.
    core.mineStatus = null;
    core.invitations = [invitationTo("ws_other")];
    await click(byText("Try again", "button"));
    await until(() => page().includes("Name of ws_other"), "the invitation");
    expect(core.ensures).toBe(0);
    expect(address()).toBe(BUY);
  });

  test("and once it answers with none, the workspace is made", async () => {
    const { core } = await open(BUY, { mineStatus: 503 });
    await until(() => page().includes(unreadable), "the unavailable state");
    core.mineStatus = null;
    await click(byText("Try again", "button"));
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(core.ensures).toBe(1);
  });

  test("a link lookup that failed (5xx) makes nothing and offers Try again", async () => {
    const { core } = await open(BUY, { withLink: true, link: invitationTo("ws_other"), linkStatus: 502 });
    await until(() => page().includes("Could not look up the invitation."), "the unavailable state");
    await flush();
    expect(core.ensures).toBe(0);
    core.linkStatus = null;
    await click(byText("Try again", "button"));
    await until(() => page().includes("Name of ws_other"), "the invitation");
    expect(core.ensures).toBe(0);
  });

  test("a dropped connection holds it back the same way", async () => {
    const { core } = await open(BUY, { mineStatus: 0 });
    await until(() => page().includes("Could not reach the server"), "the unavailable state");
    await flush();
    expect(core.ensures).toBe(0);
  });

  test("a 4xx is an answer: an unverified email (403) on /invitations/mine holds nothing back", async () => {
    const { core } = await open(BUY, { mineStatus: 403 });
    await until(() => core.ensures === 1, "ensure to be called");
    await until(() => heading() === "Licenses", "the Licenses page");
    expect(page()).not.toContain(unreadable);
  });

  test("and so is a link Core refuses (400): it does not hold forever", async () => {
    const { core } = await open(BUY, { withLink: true, link: invitationTo("ws_other"), linkStatus: 400 });
    await until(() => core.ensures === 1, "ensure to be called");
    await until(() => heading() === "Licenses", "the Licenses page");
  });

  test("where creation is not allowed, unreadable invitations change nothing: the notice shows", async () => {
    const { core } = await open(BUY, { mineStatus: 500, creation: { allowed: false, reason: "email_unverified" } });
    await until(() => heading() === "You're not in a workspace yet.", "the notice");
    expect(core.ensures).toBe(0);
  });
});

describe("no workspace is made", () => {
  test("?workspace= names the workspace, so ensure is never called", async () => {
    const { core } = await open("/licenses?workspace=ws_x", { adminOf: ["ws_x"] });
    await until(() => page().includes("Name of ws_x"), "the workspace");
    await flush();
    expect(core.ensures).toBe(0);
  });

  test("a ?workspace= Core does not know is the not found page, and ensure is never called", async () => {
    const { core } = await open("/licenses?workspace=ws_nope");
    await until(() => page().includes("Workspace not found"), "the not found page");
    await flush();
    expect(core.ensures).toBe(0);
  });

  test("where creation is not allowed the first run says why and calls nothing", async () => {
    const { core } = await open(BUY, { creation: { allowed: false, reason: "email_unverified" } });
    await until(() => page().includes("You're not in a workspace yet."), "the notice");
    expect(page()).toContain("Verify your account's email address to create a workspace.");
    expect(page()).toContain("Open an invitation link someone sent you to join their workspace.");
    expect(page()).not.toContain("Create your workspace");
    await flush();
    expect(core.ensures).toBe(0);
  });

  test("where only administrators create workspaces, the notice names that", async () => {
    const { core } = await open("/", { creation: { allowed: false, reason: "organization_admins_only" } });
    await until(() => page().includes("You're not in a workspace yet."), "the notice");
    expect(page()).toContain("On this deployment, workspaces are created by its administrators.");
    expect(core.ensures).toBe(0);
  });

  test("where creation is not allowed, an invitation is still offered", async () => {
    const { core } = await open(BUY, { creation: { allowed: false, reason: "email_unverified" }, invitations: [invitationTo("ws_joined")] });
    await until(() => page().includes("Join Name of ws_joined"), "the invitation");
    expect(core.ensures).toBe(0);
  });
});

describe("the sign-in gate", () => {
  test("says to use the Mentra App's account, and comes back to the address", async () => {
    window.history.replaceState(null, "", BUY);
    spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ error: "not_found" }, { status: 404 })) as unknown as typeof fetch);
    await render(<LoginGate />);
    expect(page()).toContain("Use the same account you sign in to the Mentra App with.");
    expect(page()).not.toContain("Sign in with your Mentra account.");
    const href = find<HTMLAnchorElement>("a[href^='/api/portal/auth/login']").getAttribute("href")!;
    expect(new URL(href, "https://portal.example.test").searchParams.get("return_to")).toBe(BUY);
  });

  /** The gate over a public read that answers `answer` (a name, or a Response), asked of the product's own address. */
  async function gateAnswering(answer: Response | Error, path = BUY) {
    window.history.replaceState(null, "", path);
    const asked: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }) as unknown as typeof fetch);
    await render(<LoginGate />);
    await flush();
    return asked;
  }

  test("a ?buy= link says what the sign-in is for, by the product's name from the public read, above the Mentra App line", async () => {
    const asked = await gateAnswering(Response.json({ name: "Mentra Call Unlimited" }));
    await until(() => page().includes("Sign in to buy Mentra Call Unlimited."), "the product's name");
    expect(asked).toEqual(["/api/portal/billing/public/products/mentra.call.unlimited"]);
    expect(page().indexOf("Sign in to buy Mentra Call Unlimited.")).toBeLessThan(page().indexOf("Use the same account you sign in to the Mentra App with."));
    expect(page()).not.toContain("Manage your workspaces");
    expect(page()).not.toContain("a license.");
  });

  test("where the name can't be read it says 'Sign in to buy a license.': an unknown product, an error, no connection", async () => {
    for (const answer of [Response.json({ error: "not_found" }, { status: 404 }), Response.json({}, { status: 500 }), new Error("offline")]) {
      await gateAnswering(answer);
      await until(() => page().includes("Sign in to buy a license."), "the generic line");
      expect(page()).toContain("Use the same account you sign in to the Mentra App with.");
      await cleanup();
    }
  });

  test("it says nothing of the product until the read has answered, then once", async () => {
    window.history.replaceState(null, "", BUY);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    spyOn(globalThis, "fetch").mockImplementation((async () => {
      await gate;
      return Response.json({ name: "Mentra Call Unlimited" });
    }) as unknown as typeof fetch);
    await render(<LoginGate />);
    await flush();
    expect(page()).not.toContain("Sign in to buy");
    release();
    await until(() => page().includes("Sign in to buy Mentra Call Unlimited."), "the product's name");
  });

  test("without ?buy= the gate is as it was and asks nothing", async () => {
    const asked = await gateAnswering(Response.json({ name: "x" }), "/licenses");
    expect(asked).toEqual([]);
    expect(page()).toContain("Manage your workspaces, their members, roles and invitations.");
    expect(page()).not.toContain("Sign in to buy");
  });

  test("a pending invitation keeps its own line", async () => {
    window.history.replaceState(null, "", BUY);
    const asked: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({});
    }) as unknown as typeof fetch);
    await render(<LoginGate invitePending />);
    await flush();
    expect(page()).toContain("your invitation was sent to");
    expect(asked).toEqual([]);
  });
});
