/**
 * The portal's Licenses page and Members list, mounted over the real clients (the workspace
 * API, billing's contract-checked client, the portal's own navigation) and a fake Core (test-core.ts) that answers
 * from the approved design's scenarios. A DOM (happy-dom) stands in for the browser, so a click, the address and the
 * window's ways out are the real ones. `app.test.tsx` has the server-rendered checks of the frame around them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { PortalRoutes } from "./App";
import type { PortalMe, PortalModules } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PORTAL_ME_KEY, PortalProvider, type PortalSession } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import {
  ACME,
  CALL_BILLING,
  CALL_LICENSE,
  EXAMPLE_BILLING,
  FLEET_BILLING,
  FLEET_LICENSE,
  FLEET_PAST_DUE,
  HOSTED,
  SCENARIOS,
  TEST_MODE,
  fakeCore,
  purchaseOf,
  statusOf,
  workspaceCatalog,
  type Scenario,
} from "./test-core";
import { byText, cleanup, click, find, findAll, isNeutral, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import type { BillingAction } from "@mentra/workspace-contract/portal-billing";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(async () => {
  await cleanup();
  mock.restore();
});

// ---- the rig ------------------------------------------------------------------------------------------------------

const BILLING_ON: PortalModules = { billing: true };
/** A Core without billing, such as a Private Cloud. */
const BILLING_OFF: PortalModules = { billing: false };

const meWith = (modules: PortalModules): PortalMe => ({
  authenticated: true,
  user: { id: "u_dana", email: "dana@example.com", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: false,
  org: null,
  modules,
});

const portalSession = (modules: PortalModules): PortalSession => ({
  userEmail: "dana@example.com",
  accountEmail: "dana@example.com",
  creation: { allowed: true, reason: null },
  link: { status: "none" },
  invitations: [],
  forgetInvitation() {},
  signOut() {},
  signingOut: false,
  developerConsoleUrl: null,
  modules,
  sessionExpired() {},
});

/** The app's routing over a path: what `PortalPage` does with `usePathname`. */
function Routes({ me }: { me: PortalMe }) {
  const pathname = usePathname();
  return <PortalRoutes route={parseRoute(pathname)} me={me} />;
}

const text = () => document.body.textContent ?? "";
const has = (needle: string) => text().includes(needle);
const openDialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
const buttonNamed = (name: RegExp) => findAll<HTMLElement>("button, a").find(element => name.test(element.textContent?.trim() ?? "") || name.test(element.getAttribute("aria-label") ?? ""));
const hrefs = () => findAll<HTMLAnchorElement>("a[href]").map(anchor => anchor.getAttribute("href"));

/** The page's own requests to billing (not Core's workspace API). */
const billingRequests = (core: ReturnType<typeof fakeCore>) => core.requests.filter(request => request.path.startsWith("/api/portal/billing/"));

/**
 * Opens `path` as a person with `modules`, over a fake Core answering `scenario`. Resolves once `ready` holds on the
 * page (a request answered, a render it asked for).
 */
async function open(
  path: string,
  scenario: Scenario,
  options: { modules?: PortalModules; me?: PortalMe; ready?: string; slowLicensesMs?: number } = {},
) {
  window.history.replaceState(null, "", path);
  const core = fakeCore(scenario);
  const licensesPath = `/api/portal/workspaces/${ACME}/licenses`;
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    // `slowLicensesMs`: Core's licenses list answers that much later than the rest.
    if (options.slowLicensesMs && new URL(String(input), "https://portal.example.test").pathname === licensesPath) {
      await new Promise(resolve => setTimeout(resolve, options.slowLicensesMs));
    }
    return core.fetch(input, init);
  }) as typeof fetch);
  const modules = options.modules ?? BILLING_ON;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PortalProvider value={portalSession(modules)}>
        <Routes me={options.me ?? meWith(modules)} />
      </PortalProvider>
    </QueryClientProvider>,
  );
  if (options.ready) await until(() => has(options.ready!), `the page to show ${options.ready}`);
  return { core, client };
}

/**
 * The window's two ways out, replaced by recorders. `closeAfterOpen` is a person closing the blank tab while billing
 * answers: it reads as open when the portal checks it first, closed after.
 */
function ways(options: { closeAfterOpen?: boolean } = {}) {
  const assign = spyOn(window.location, "assign").mockImplementation(() => {});
  const events: string[] = [];
  let reads = 0;
  const tab = {
    opener: "set" as unknown,
    _closed: false,
    get closed() {
      return options.closeAfterOpen ? reads++ > 0 : tab._closed;
    },
    location: { replace: (url: string) => void events.push(`replace:${url}`) },
    close() {
      tab._closed = true;
      events.push("close");
    },
  };
  const openWindow = spyOn(window, "open").mockImplementation((() => {
    events.push("open");
    return tab;
  }) as unknown as typeof window.open);
  return { assign, openWindow, events, tab };
}

const search = () => window.location.search;

// ---- the Licenses page --------------------------------------------------------------------------------------------

describe("the Licenses page", () => {
  test("/licenses renders the view: the cards and the header actions, with billing's data, and no total line", async () => {
    const { core } = await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(find("h1").textContent).toBe("Subscriptions");
    // The title has no subtitle.
    expect(has("pays for")).toBe(false);
    expect(find("h1").nextElementSibling).toBeNull();
    expect(has("Fleet")).toBe(true);
    // Each card has its own cost; nothing above them counts the products or adds them up.
    expect(has("2 products")).toBe(false);
    expect(has("in total")).toBe(false);
    // The header action is in the title bar, beside the title: Billing, and no Buy (buying more is on each card).
    const header = find("header");
    expect(header.textContent).toContain("Billing");
    expect(header.textContent).not.toContain("Buy more seats");
    // Billing was asked in the portal's locale, for this workspace.
    const asked = billingRequests(core);
    expect(asked.map(request => request.path)).toEqual(expect.arrayContaining([`/api/portal/billing/workspaces/${ACME}/catalog`, `/api/portal/billing/workspaces/${ACME}/status`]));
    for (const request of asked) expect(request.query.get("locale")).toBe("en-US");
  });

  test("mounts no module: nothing is imported from Core, and nothing of a module's host is on the page", async () => {
    const { core } = await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(core.requests.some(request => request.path.includes("/ui/"))).toBe(false);
    expect(document.querySelector("section[aria-label='Billing']")).toBeNull();
    expect(document.querySelector("section[aria-label='Fleet Management']")).toBeNull();
    expect(has("Loading Billing")).toBe(false);
    expect(has("Billing is unavailable")).toBe(false);
  });

  test("and the pages that draw licenses do not so much as import the module host", async () => {
    for (const file of ["pages/licenses.tsx", "pages/workspace.tsx"]) {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
      const specifiers = new Bun.Transpiler({ loader: "tsx" }).scanImports(source).map(entry => entry.path);
      expect(specifiers.filter(path => path.includes("portal-module-host"))).toEqual([]);
    }
  });

  test("an Owner offered billing sees the money, and may buy; the page is the view, not the old panel", async () => {
    await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(has("$145")).toBe(true);
    expect(buttonNamed(/^Buy more seats$/)).toBeDefined();
    expect(buttonNamed(/^Billing$/)).toBeDefined();
    // Core's roster of who holds a license is the new card's: the folded strip of people.
    expect(has("Assigned to")).toBe(true);
  });

  test("the account menu has no Billing, even for someone offered billing", async () => {
    await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(hrefs()).not.toContain("/account/billing");
    await click(find("button[aria-label='Open account menu']"));
    expect(findAll<HTMLAnchorElement>("a[href='/account/billing']")).toEqual([]);
    expect(has("Sign out")).toBe(true);
  });

  test("Retry on the Licenses page also reads who the person is again, so a page opened before billing was ready can recover", async () => {
    // Billing wasn't ready when `me` was read (`billing: false`), and the workspace already holds licenses.
    const { client } = await open(`/licenses`, SCENARIOS.twoActive(), { modules: BILLING_OFF, ready: "Subscriptions are unavailable" });
    client.setQueryData(PORTAL_ME_KEY, meWith(BILLING_OFF));
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(false);
    await click(buttonNamed(/^Retry$/)!);
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(true);
  });

  test("the bare address opens Licenses for a Member who holds one, even when the list answers late", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.twoActive(),
      role: "member",
      licenses: [CALL_LICENSE].map(license => ({ ...license, seats: license.seats!.slice(0, 1), seatsUsed: 3 })),
      workspaceCatalog: workspaceCatalog(false),
    };
    await open(`/`, scenario, { modules: BILLING_ON, slowLicensesMs: 150, ready: "Assigned to you" });
    expect(window.location.pathname).toBe("/licenses");
  });

  test("a Member sees the products they hold a license for, and nothing of billing's", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.twoActive(),
      role: "member",
      licenses: [CALL_LICENSE].map(license => ({ ...license, seats: license.seats!.slice(0, 1), seatsUsed: 3 })),
      workspaceCatalog: workspaceCatalog(false),
    };
    const { core } = await open(`/licenses`, scenario, { modules: BILLING_ON, ready: "Assigned to you" });
    expect(has("Mentra Call Unlimited")).toBe(true);
    expect(has("What Acme Field Services pays for")).toBe(false);
    expect(has("Your subscriptions in")).toBe(false);
    expect(text()).not.toMatch(/\$\d/);
    expect(buttonNamed(/^Billing$/)).toBeUndefined();
    expect(billingRequests(core).some(request => request.path.endsWith("/status"))).toBe(false);
    // Nor the members of the workspace.
    expect(core.requests.some(request => request.path.endsWith("/members"))).toBe(false);
  });
});

// ---- purchase return ----------------------------------------------------------------------------------------------

describe("coming back from checkout", () => {
  const bought = SCENARIOS.purchased;

  test("?purchase=pur_1 reaches the view: billing is asked about it and a dialog says the licenses are ready", async () => {
    const { core } = await open(`/licenses?purchase=pur_1`, bought(), { ready: "You now have Fleet!" });
    expect(openDialog()!.textContent).toContain("You now have Fleet!");
    // Dana holds one of them: the dialog is titled with that, beside Fleet's tile (its letter is hidden from a screen
    // reader), not with the product.
    expect(openDialog()!.querySelector("h2")!.textContent).toBe("FYou now have Fleet!");
    expect(openDialog()!.querySelector("h2 [aria-hidden='true']")!.textContent).toBe("F");
    const statuses = billingRequests(core).filter(request => request.path.endsWith("/status"));
    expect(statuses.length).toBeGreaterThan(0);
    for (const request of statuses) expect(request.query.get("purchase")).toBe("pur_1");
    // The header actions read the same status (one request, not two).
    expect(statuses).toHaveLength(1);
  });

  test("OK closes the dialog and takes ?purchase= out of the address in place; the page keeps the purchase it followed", async () => {
    const { core } = await open(`/licenses?purchase=pur_1`, bought(), { ready: "You now have Fleet!" });
    const before = window.history.length;
    expect(buttonNamed(/^Dismiss$/)).toBeUndefined();
    await click(buttonNamed(/^OK$/)!);
    expect(search()).toBe("");
    expect(window.location.pathname).toBe(`/licenses`);
    // The address was changed in place: Back does not return to the dialog, and a reload does not open it again.
    expect(window.history.length).toBe(before);
    expect(openDialog()).toBeNull();
    expect(has("You now have Fleet!")).toBe(false);
    // The cards stayed, the license just bought still first and ringed, and billing is asked about nothing else.
    expect(has("Mentra Call Unlimited")).toBe(true);
    const first = document.querySelector('[data-slot="card"][role="group"]')!;
    expect(first.getAttribute("aria-label")).toBe("Fleet");
    expect(first.getAttribute("data-ring")).toBe("highlight");
    expect(billingRequests(core).filter(request => request.path.endsWith("/status")).every(request => request.query.get("purchase") === "pur_1")).toBe(true);
  });
});

// ---- the ?buy= link -----------------------------------------------------------------------------------------------

describe("a link that asks to buy one product", () => {
  const CALL_LINK = "/licenses?buy=mentra.call.unlimited";
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog[open]");
  const posts = (core: ReturnType<typeof fakeCore>, route: "purchase" | "session") =>
    core.requests.filter(request => request.method === "POST" && request.path.endsWith(`/${route}`));
  /** Call's three subscriptions are all assigned to others, billing's quantity says three, and Dana (the Owner) holds Fleet only. */
  const callFull: Scenario = {
    ...SCENARIOS.twoActive(),
    licenses: [{ ...CALL_LICENSE, quantity: 3 }, FLEET_LICENSE],
    workspaceStatus: statusOf([{ ...CALL_BILLING, quantity: 3 }, FLEET_BILLING]),
  };

  test("a workspace without the product goes straight to checkout for one license: no dialog, no click, and the address is /licenses before it leaves", async () => {
    const out = ways();
    const before = window.history.length;
    const { core } = await open(CALL_LINK, SCENARIOS.catalog(), {});
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.checkout]]);
    expect(posts(core, "purchase").map(request => request.body)).toEqual([{ product: "mentra.call.unlimited", seats: 1, locale: expect.any(String) }]);
    expect(window.location.pathname).toBe("/licenses");
    expect(search()).toBe("");
    expect(window.history.length).toBe(before);
    expect(out.openWindow).not.toHaveBeenCalled();
  });

  test("while billing is asked for the page the dialog says 'Opening checkout…'", async () => {
    ways();
    const slow: Scenario = { ...SCENARIOS.catalog(), hosted: () => ({ url: HOSTED.checkout }) };
    await open(CALL_LINK, slow, { ready: "Opening checkout…" });
    expect(dialog()!.textContent).toContain("Mentra Call Unlimited");
  });

  test("a refusal from billing is a dialog with its words", async () => {
    ways();
    const refused: Scenario = { ...SCENARIOS.catalog(), hosted: () => ({ status: 409, body: { error: "checkout_in_progress" } }) };
    await open(CALL_LINK, refused, { ready: "is already under way" });
    expect(dialog()!.textContent).toContain("A purchase of Mentra Call Unlimited is already under way. Finish it, or try again in a minute.");
    expect(dialog()!.textContent).toContain("Done");
    expect(search()).toBe("");
  });

  test("in a workspace of one person it is the same: one license, straight to checkout", async () => {
    const out = ways();
    const { core } = await open(CALL_LINK, SCENARIOS.solo(), {});
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(posts(core, "purchase")[0]!.body).toMatchObject({ seats: 1 });
  });

  test("?workspace= naming the person's own workspace goes with it: both leave the address", async () => {
    const out = ways();
    await open(`${CALL_LINK}&workspace=${ACME}`, SCENARIOS.catalog(), {});
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(window.location.pathname + search()).toBe("/licenses");
  });

  test("an Owner whose workspace's licenses are all assigned to others goes straight to billing for one more, assigned to her, and the address is /licenses", async () => {
    const out = ways();
    const { core } = await open(CALL_LINK, callFull, {});
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.checkout]]);
    expect(posts(core, "session").map(request => request.body)).toEqual([
      { action: "add_seats", licenseId: "lic_call", seats: 1, forMe: true, locale: expect.any(String) },
    ]);
    expect(posts(core, "purchase")).toEqual([]);
    expect(window.location.pathname + search()).toBe("/licenses");
    expect(out.openWindow).not.toHaveBeenCalled();
  });

  test("a free license is assigned to the person who followed the link, with no click and no payment, and a dialog says so", async () => {
    const { core } = await open(CALL_LINK, SCENARIOS.twoActive(), { ready: "You now have Mentra Call Unlimited!" });
    expect(dialog()!.textContent).not.toContain("unassigned subscriptions");
    const puts = core.requests.filter(request => request.method === "PUT");
    expect(puts.map(request => request.path)).toEqual(["/api/portal/workspaces/ws_acme/licenses/lic_call/seats/wm_dana"]);
    expect(posts(core, "purchase")).toEqual([]);
    expect(posts(core, "session")).toEqual([]);
    expect(search()).toBe("");
    await until(() => has("4 of 5 assigned"), "the card to count the new seat");
  });

  test("an Owner who holds the product is told she already has it", async () => {
    const { core } = await open("/licenses?buy=mentra.fleet", SCENARIOS.twoActive(), { ready: "You already have Fleet." });
    expect(dialog()!.textContent).toContain("Done");
    expect(window.location.pathname + search()).toBe("/licenses");
    expect(core.requests.filter(request => request.method !== "GET")).toEqual([]);
  });

  test("a Member is told who to ask, in a dialog, and the address keeps no ?buy=", async () => {
    const scenario: Scenario = { ...SCENARIOS.catalog(), role: "member", workspaceCatalog: workspaceCatalog(false) };
    await open(CALL_LINK, scenario, { ready: "Ask one of them." });
    expect(dialog()!.textContent).toContain("Only Admins and Owners of Acme Field Services can buy Mentra Call Unlimited. Ask one of them.");
    expect(window.location.pathname + search()).toBe("/licenses");
  });

  test("a Member who holds a license is told they already have it, on the page they already have", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.twoActive(),
      role: "member",
      viewer: "hannah",
      licenses: [CALL_LICENSE],
      workspaceCatalog: workspaceCatalog(false),
    };
    await open(CALL_LINK, scenario, { ready: "You already have Mentra Call Unlimited." });
    expect(has("Assigned to you")).toBe(true);
    expect(search()).toBe("");
  });

  test("a product that isn't for sale is a dialog", async () => {
    await open("/licenses?buy=nothing.here", SCENARIOS.catalog(), { ready: "That product isn't for sale." });
    expect(dialog()!.textContent).toContain("That product isn't for sale.");
    expect(search()).toBe("");
  });

  test("a manager on a Core without billing is told licenses can't be bought here", async () => {
    const scenario: Scenario = { ...SCENARIOS.catalog(), role: "admin" };
    const { core } = await open("/licenses?buy=example.addon", scenario, { modules: BILLING_OFF, ready: "Subscriptions can't be bought here." });
    expect(billingRequests(core)).toEqual([]);
    expect(dialog()!.textContent).toContain("Subscriptions can't be bought here.");
    expect(search()).toBe("");
  });

  test("no ?buy= in the address, no dialog and nothing requested", async () => {
    const { core } = await open("/licenses", SCENARIOS.catalog(), { ready: "Mentra Call Unlimited" });
    expect(dialog()).toBeNull();
    expect(core.requests.filter(request => request.method !== "GET")).toEqual([]);
  });
});

describe("coming back from the page that added a license for her (?added=)", () => {
  const added: Scenario = {
    ...SCENARIOS.twoActive(),
    licenses: [{ ...CALL_LICENSE, quantity: 4, seatsUsed: 4, seats: [...CALL_LICENSE.seats!, { membershipId: "wm_dana", mentraUserId: "u_dana", assignedAt: "2026-10-21T12:00:00.000Z" }] }, FLEET_LICENSE],
    workspaceStatus: statusOf([{ ...CALL_BILLING, quantity: 4 }, FLEET_BILLING]),
  };
  test("/licenses?added=<id> says it is assigned once the seat is there, in a dialog, and OK leaves /licenses", async () => {
    const before = window.history.length;
    await open("/licenses?added=lic_call", added, { ready: "Open the Mentra App now to use it on your smart glasses." });
    expect(openDialog()!.textContent).toContain("You now have Mentra Call Unlimited!");
    expect(search()).toBe("?added=lic_call");
    await click(buttonNamed(/^OK$/)!);
    expect(window.location.pathname).toBe("/licenses");
    expect(search()).toBe("");
    // The address was changed in place: Back does not return to the dialog.
    expect(window.history.length).toBe(before);
    expect(openDialog()).toBeNull();
    expect(has("Open the Mentra App now to use it on your smart glasses.")).toBe(false);
  });

  test("?workspace= and ?added= leave the address separately: closing keeps the workspace", async () => {
    await open(`/licenses?workspace=${ACME}&added=lic_call`, added, { ready: "Open the Mentra App now to use it on your smart glasses." });
    await click(buttonNamed(/^OK$/)!);
    expect(search()).not.toContain("added");
  });

  test("while the seat is on its way the dialog says it is being set up, and OK closes it", async () => {
    await open("/licenses?added=lic_call", SCENARIOS.twoActive(), { ready: "Setting up 1 Mentra Call Unlimited subscription." });
    expect(openDialog()!.textContent).toContain("Setting up…");
    expect(has("You now have")).toBe(false);
    await click(buttonNamed(/^OK$/)!);
    expect(openDialog()).toBeNull();
    expect(search()).toBe("");
  });

  test("no ?added= in the address, no dialog", async () => {
    await open("/licenses", added, { ready: "Mentra Call Unlimited" });
    expect(openDialog()).toBeNull();
  });
});

describe("coming back from checkout, to the person's own workspace", () => {
  test("/licenses?workspace=<own>&purchase=pur_1 shows the dialog at /licenses?purchase=pur_1", async () => {
    await open(`/licenses?workspace=${ACME}&purchase=pur_1`, SCENARIOS.purchased(), { ready: "You now have Fleet!" });
    await until(() => window.location.pathname + search() === "/licenses?purchase=pur_1", "the address to lose ?workspace=");
  });

  test("the buyer was given one: the dialog says it is hers", async () => {
    await open(`/licenses?purchase=pur_1`, SCENARIOS.purchasedForYou(), { ready: "You now have Mentra Call Unlimited!" });
    expect(has("Open the Mentra App now to use it on your smart glasses.")).toBe(true);
    expect(has("Assign the rest")).toBe(false);
  });
});

describe("what the portal no longer has", () => {
  test("/account/billing is the not-found page, and no link in the portal leads there", async () => {
    await open("/account/billing", SCENARIOS.twoActive(), { ready: "Page not found" });
    expect(hrefs()).not.toContain("/account/billing");
  });
});

// ---- Members ------------------------------------------------------------------------------------------------------

describe("Members", () => {
  const rowOf = (name: string) => byText(name, "[data-slot='member-name']").closest("tr")!;
  const menuFor = (name: string) => find(`button[aria-label='More for ${name}']`);
  const openDialog = () => document.querySelector("dialog[open]");

  test("the list gains the Licenses column with a chip per license held, from billing's catalog, and only shows them", async () => {
    await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(() => has("Subscriptions") && findAll("ul[aria-label='Subscriptions']").length > 0, "the Subscriptions column");
    expect(rowOf("Hannah Kim").textContent).toContain("Call Unlimited");
    expect(rowOf("Luis Ortega").textContent).toContain("None");
    // Licenses are assigned from the Licenses page: no checkbox, no selection bar, no Assign licenses here.
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    expect(findAll("[data-slot='selection-bar']")).toHaveLength(0);
    expect(buttonNamed(/^Assign subscriptions$/)).toBeUndefined();
    expect(findAll("button, a", find("ul[aria-label='Subscriptions']", rowOf("Hannah Kim")))).toHaveLength(0);
  });

  test("a row opens nothing, and ?member= in the address is not read: there is no member panel", async () => {
    await open(`/members?member=wm_luis`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    expect(document.querySelector("dialog[data-slot='side-panel']")).toBeNull();
    expect(openDialog()).toBeNull();
    await click(rowOf("Luis Ortega"));
    expect(openDialog()).toBeNull();
    expect(document.querySelector("button[aria-label='Open Luis Ortega']")).toBeNull();
    // The address is left as it was.
    expect(search()).toBe("?member=wm_luis");
  });

  test("the Members page never asks billing for its status: the chips need only the catalog", async () => {
    const { core } = await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(() => findAll("ul[aria-label='Subscriptions']").length > 0, "the Subscriptions column");
    expect(billingRequests(core).map(request => request.path)).toEqual([`/api/portal/billing/workspaces/${ACME}/catalog`]);
  });

  test("an Owner changes a role from the row's menu, with the revision the page last saw", async () => {
    const { core } = await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await click(menuFor("Hannah Kim"));
    const items = findAll('[role="menuitem"]').map(item => item.textContent?.trim());
    expect(items).toEqual(["Change role to Developer", "Change role to Admin", "Change role to Owner", "Remove from workspace"]);
    await click(byText("Change role to Admin", '[role="menuitem"]'));
    await until(() => core.requests.some(request => request.method === "PATCH"), "the role change");
    const patch = core.requests.find(request => request.method === "PATCH")!;
    expect(patch.path).toBe(`/api/portal/workspaces/${ACME}/members/wm_hannah`);
    expect(patch.body).toEqual({ role: "admin", expectedRevision: 3 });
    await until(() => rowOf("Hannah Kim").textContent!.includes("Admin"), "the new role");
  });

  test("Remove asks in a dialog first, and removes the member only once it is confirmed", async () => {
    const { core } = await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await click(menuFor("Hannah Kim"));
    await click(byText("Remove from workspace", '[role="menuitem"]'));
    expect(find("h2", openDialog()!).textContent).toBe("Remove Hannah Kim from this workspace?");
    expect(core.requests.some(request => request.method === "DELETE")).toBe(false);
    await click(byText("Remove", "button", openDialog()!));
    await until(() => core.requests.some(request => request.method === "DELETE"), "the removal");
    expect(core.requests.find(request => request.method === "DELETE")!.path).toBe(`/api/portal/workspaces/${ACME}/members/wm_hannah`);
    await until(() => !has("Hannah Kim"), "the row to go");
    expect(openDialog()).toBeNull();
  });

  test("there is no menu on the viewer's own row", async () => {
    await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    expect(document.querySelector("button[aria-label='More for Dana Reyes']")).toBeNull();
    expect(findAll("button[aria-label^='More for ']").length).toBeGreaterThan(5);
  });

  test("an Admin's list has its chips, and asks billing for the catalog only, never its status", async () => {
    const scenario: Scenario = { ...SCENARIOS.threeActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    const { core } = await open(`/members`, scenario, { modules: BILLING_ON, ready: "Hannah Kim" });
    await until(() => findAll("ul[aria-label='Subscriptions']").length > 0, "the Subscriptions column");
    expect(rowOf("Hannah Kim").textContent).toContain("Call Unlimited");
    expect(billingRequests(core).some(request => request.path.endsWith("/status"))).toBe(false);
  });

  test("without a catalog the list works without any of it (billing off: no Licenses column)", async () => {
    const { core } = await open(`/members`, SCENARIOS.threeActive(), { modules: BILLING_OFF, ready: "Hannah Kim" });
    expect(findAll("ul[aria-label='Subscriptions']")).toHaveLength(0);
    expect(billingRequests(core)).toEqual([]);
  });
});

// ---- leaving ------------------------------------------------------------------------------------------------------

describe("leaving for a hosted page", () => {
  const invoices = () => buttonNamed(/^Billing$/)!;
  const GENERIC = "Billing couldn't do that. Try again.";

  const answering = (url: string, extra: Partial<Scenario> = {}): Scenario => ({
    ...SCENARIOS.twoActive(),
    hosted: () => ({ url }),
    ...extra,
  });

  test("an action session's URL goes to window.location.assign, in this tab", async () => {
    const { core } = await open(`/licenses`, answering(HOSTED.invoices), { ready: "Mentra Call Unlimited" });
    const out = ways();
    await click(invoices());
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.invoices]]);
    expect(out.openWindow).not.toHaveBeenCalled();
    const posted = core.requests.find(request => request.method === "POST" && request.path.endsWith("/session"))!;
    expect(posted.path).toBe(`/api/portal/billing/workspaces/${ACME}/session`);
    expect(posted.body).toEqual({ action: "billing_and_invoices", locale: "en-US" });
  });

  test.each(["https://billing.example.test/pay", "http://localhost:3000/pay", "http://127.0.0.1:8080/pay"])("follows %s", async url => {
    await open(`/licenses`, answering(url), { ready: "Mentra Call Unlimited" });
    const out = ways();
    await click(invoices());
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[url]]);
  });

  test.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://billing.example.test/pay", "http://localhost.evil.test/pay"])(
    "refuses %s with the generic refusal, and goes nowhere",
    async url => {
      await open(`/licenses`, answering(url), { ready: "Mentra Call Unlimited" });
      const out = ways();
      await click(invoices());
      await until(() => has(GENERIC), "the refusal");
      expect(out.assign).not.toHaveBeenCalled();
      expect(out.openWindow).not.toHaveBeenCalled();
      expect(find("[role='alert']").textContent).toContain(GENERIC);
    },
  );

  /** Fleet's payment failed, and billing lists an invoice's payment page, which does not come back to the portal. */
  const invoicePage: BillingAction = { kind: "complete_payment", fallbackLabel: "Complete payment", returns: false };
  const unpaid = (url: string): Scenario => ({
    ...SCENARIOS.paymentFailed(),
    workspaceStatus: statusOf([CALL_BILLING, { ...FLEET_PAST_DUE, actions: [invoicePage] }, EXAMPLE_BILLING]),
    hosted: () => ({ url }),
  });

  test("an action listed with returns: false goes to a tab opened in the click, and this tab stays", async () => {
    await open(`/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
    const out = ways();
    await click(buttonNamed(/Complete payment/)!);
    // The tab was opened in the click itself, before billing answered.
    expect(out.events[0]).toBe("open");
    await until(() => out.events.includes(`replace:${HOSTED.invoice}`), "the tab to be sent on");
    expect(out.tab.opener).toBeNull();
    expect(out.assign).not.toHaveBeenCalled();
    expect(out.events).toEqual(["open", `replace:${HOSTED.invoice}`]);
  });

  test.each(["javascript:alert(1)", "data:text/html,x", "http://billing.example.test/pay"])(
    "a returns: false action whose URL is %s is refused: the tab it opened is closed",
    async url => {
      await open(`/licenses`, unpaid(url), { ready: "Mentra Call Unlimited" });
      const out = ways();
      await click(buttonNamed(/Complete payment/)!);
      await until(() => has(GENERIC), "the refusal");
      expect(out.events).toEqual(["open", "close"]);
      expect(out.assign).not.toHaveBeenCalled();
    },
  );

  test("a tab the person closed while billing answered is not an error: the link to the page is offered instead", async () => {
    await open(`/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
    const out = ways({ closeAfterOpen: true });
    await click(buttonNamed(/Complete payment/)!);
    await until(() => has("Open the payment page"), "the link");
    const link = findAll<HTMLAnchorElement>("a").find(anchor => anchor.textContent?.includes("Open the payment page"))!;
    expect(link.getAttribute("href")).toBe(HOSTED.invoice);
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(has("Billing couldn't do that")).toBe(false);
    expect(out.events).toEqual(["open"]);
    expect(out.assign).not.toHaveBeenCalled();
  });

  test("a tab the browser blocked leaves a link to the page for a second click", async () => {
    await open(`/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
    const out = ways();
    out.openWindow.mockImplementation((() => null) as unknown as typeof window.open);
    await click(buttonNamed(/Complete payment/)!);
    await until(() => has("Open the payment page"), "the link");
    const link = findAll<HTMLAnchorElement>("a").find(anchor => anchor.textContent?.includes("Open the payment page"))!;
    expect(link.getAttribute("href")).toBe(HOSTED.invoice);
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(out.assign).not.toHaveBeenCalled();
  });

  test("a purchase goes the same way: the checkout's URL to this tab", async () => {
    const { core } = await open(`/licenses`, answering(HOSTED.checkout, SCENARIOS.catalog()), { ready: "Mentra Call Unlimited" });
    const out = ways();
    // Buy goes straight to checkout, with no step in between.
    await click(findAll<HTMLElement>("button").find(button => button.textContent?.trim() === "Buy")!);
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.checkout]]);
    expect(has("Continue to payment")).toBe(false);
    const posted = core.requests.find(request => request.method === "POST" && request.path.endsWith("/purchase"))!;
    // Billing's smallest purchase: more seats are bought from the card afterwards.
    expect(posted.body).toMatchObject({ seats: 1, locale: "en-US" });
  });
});

// ---- nothing leaks ------------------------------------------------------------------------------------------------

describe("the test-mode notice", () => {
  const HIDE = "[role='note'] button[aria-label='Hide the test mode notice']";
  afterEach(() => window.sessionStorage.clear());

  test("× hides it on the Licenses page for the rest of the session, and a new session shows it again", async () => {
    await open(`/licenses`, SCENARIOS.testMode(), { ready: "Test mode · Staging" });
    expect(findAll("[role='note']")).toHaveLength(1);
    await click(find(HIDE));
    expect(findAll("[role='note']")).toHaveLength(0);
    expect(has("Buy subscriptions for your members")).toBe(true);
    await cleanup();
    mock.restore();
    await open(`/licenses`, SCENARIOS.testMode(), { ready: "Buy subscriptions for your members" });
    expect(findAll("[role='note']")).toHaveLength(0);
    await cleanup();
    mock.restore();
    window.sessionStorage.clear();
    await open(`/licenses`, SCENARIOS.testMode(), { ready: "Test mode · Staging" });
    expect(findAll("[role='note']")).toHaveLength(1);
  });
});

describe("what no page says", () => {
  const PROCESSOR = new RegExp(["st", "ripe"].join(""), "i");
  const IDS = /\b(?:cus|sub|price|prod|pi|cs|in|si|seti|plink)_[A-Za-z0-9]{6,}/;

  test("neither the processor's name nor one of its ids, on the Licenses page or Members", async () => {
    const pages: Array<[string, Scenario, string]> = [
      [`/licenses`, SCENARIOS.paymentFailed(), "Mentra Call Unlimited"],
      [`/members`, SCENARIOS.threeActive(), "Hannah Kim"],
      [`/licenses`, SCENARIOS.testMode(), "Mentra Call Unlimited"],
    ];
    for (const [path, scenario, ready] of pages) {
      await open(path, scenario, { ready });
      expect(text()).not.toMatch(PROCESSOR);
      expect(text()).not.toMatch(IDS);
      expect(text()).not.toMatch(/paid through/i);
      await cleanup();
      mock.restore();
    }
  });
});
