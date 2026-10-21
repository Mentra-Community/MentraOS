/**
 * The portal's Licenses page, Members list and personal Billing page, mounted over the real clients (the workspace
 * API, billing's contract-checked client, the portal's own navigation) and a fake Core (test-core.ts) that answers
 * from the approved design's scenarios. A DOM (happy-dom) stands in for the browser, so a click, the address and the
 * window's ways out are the real ones. `app.test.tsx` has the server-rendered checks of the frame around them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { PortalRoutes } from "./App";
import { fetchPortalMe, type PortalMe, type PortalModules } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PORTAL_ME_KEY, PortalProvider, type PortalSession } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import {
  ACME,
  CALL_BILLING,
  CALL_LICENSE,
  EXAMPLE_BILLING,
  FLEET_BILLING,
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

const BILLING_ON: PortalModules = { billing: true, billingCatalog: true };
/** A non-staff Admin on staging: licenses are theirs to see, billing is staff's. */
const CATALOG_ONLY: PortalModules = { billing: false, billingCatalog: true };

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
  return <PortalRoutes route={parseRoute(usePathname())} me={me} />;
}

const text = () => document.body.textContent ?? "";
const has = (needle: string) => text().includes(needle);
const buttonNamed = (name: RegExp) => findAll<HTMLElement>("button, a").find(element => name.test(element.textContent?.trim() ?? "") || name.test(element.getAttribute("aria-label") ?? ""));
const hrefs = () => findAll<HTMLAnchorElement>("a[href]").map(anchor => anchor.getAttribute("href"));

/** The page's own requests to billing (not Core's workspace API). */
const billingRequests = (core: ReturnType<typeof fakeCore>) => core.requests.filter(request => request.path.startsWith("/api/portal/billing/"));

/**
 * Opens `path` as a person with `modules`, over a fake Core answering `scenario`. Resolves once `ready` holds on the
 * page (a request answered, a render it asked for).
 */
async function open(path: string, scenario: Scenario, options: { modules?: PortalModules; me?: PortalMe; ready?: string } = {}) {
  window.history.replaceState(null, "", path);
  const core = fakeCore(scenario);
  spyOn(globalThis, "fetch").mockImplementation(core.fetch);
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
  test("/w/<id>/licenses renders the view: the cards, the total and the header actions, with billing's data", async () => {
    const { core } = await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(find("h1").textContent).toBe("Licenses");
    expect(has("What Acme Field Services pays for, and who has each license.")).toBe(true);
    expect(has("Fleet")).toBe(true);
    expect(has("2 products")).toBe(true);
    expect(has("$295 a month in total")).toBe(true);
    // The header actions are in the title bar, beside the title.
    const header = find("header");
    expect(header.textContent).toContain("Billing & invoices");
    expect(header.textContent).toContain("Buy licenses");
    // Billing was asked in the portal's locale, for this workspace.
    const asked = billingRequests(core);
    expect(asked.map(request => request.path)).toEqual(expect.arrayContaining([`/api/portal/billing/workspaces/${ACME}/catalog`, `/api/portal/billing/workspaces/${ACME}/status`]));
    for (const request of asked) expect(request.query.get("locale")).toBe("en-US");
  });

  test("mounts no module: nothing is imported from Core, and nothing of a module's host is on the page", async () => {
    const { core } = await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(core.requests.some(request => request.path.includes("/ui/"))).toBe(false);
    expect(document.querySelector("section[aria-label='Billing']")).toBeNull();
    expect(document.querySelector("section[aria-label='Fleet Management']")).toBeNull();
    expect(has("Loading Billing")).toBe(false);
    expect(has("Billing is unavailable")).toBe(false);
  });

  test("and the pages that draw licenses do not so much as import the module host", async () => {
    for (const file of ["pages/licenses.tsx", "pages/account-billing.tsx", "pages/workspace.tsx"]) {
      const source = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
      const specifiers = new Bun.Transpiler({ loader: "tsx" }).scanImports(source).map(entry => entry.path);
      expect(specifiers.filter(path => path.includes("portal-module-host"))).toEqual([]);
    }
  });

  test("an Owner offered billing sees the money, and may buy; the page is the view, not the old panel", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(has("$145")).toBe(true);
    expect(buttonNamed(/^Buy licenses$/)).toBeDefined();
    expect(buttonNamed(/Billing & invoices/)).toBeDefined();
    // Core's roster of who holds a license is the new card's: the folded strip of people.
    expect(has("Assigned to")).toBe(true);
  });

  test("a non-staff Admin on staging (licenses, no billing) gets the Licenses item and cards without money", async () => {
    const scenario: Scenario = { ...SCENARIOS.twoActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    const { core } = await open(`/w/${ACME}/licenses`, scenario, { modules: CATALOG_ONLY, ready: "Mentra Call Unlimited" });
    expect(hrefs()).toContain(`/w/${ACME}/licenses`);
    expect(find("h1").textContent).toBe("Licenses");
    // Names and licenses, and none of billing's: no money, no dates, no actions, no buying.
    expect(has("Fleet")).toBe(true);
    expect(text()).not.toMatch(/\$\d/);
    expect(buttonNamed(/Billing & invoices/)).toBeUndefined();
    expect(buttonNamed(/Buy licenses/)).toBeUndefined();
    expect(buttonNamed(/Add licenses/)).toBeUndefined();
    // Only the catalog, which anyone may read, was asked of billing: never its status.
    expect(billingRequests(core).map(request => request.path)).toEqual([`/api/portal/billing/workspaces/${ACME}/catalog`]);
    // And the account menu, once opened, has no Billing page for them (it is offered by `billing`, not by the catalog).
    await click(find("button[aria-label='Open account menu']"));
    expect(has("Sign out")).toBe(true);
    expect(hrefs()).not.toContain("/account/billing");
    expect(buttonNamed(/^Billing$/)).toBeUndefined();
  });

  test("and the account menu has Billing for someone offered billing", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(hrefs()).not.toContain("/account/billing");
    await click(find("button[aria-label='Open account menu']"));
    const item = findAll<HTMLAnchorElement>("a[href='/account/billing']");
    expect(item.map(anchor => anchor.textContent?.trim())).toEqual(["Billing"]);
    expect(has("Sign out")).toBe(true);
  });

  test("Retry on the Licenses page also reads who the person is again, so a page opened before billing was ready can recover", async () => {
    // Billing wasn't ready when `me` was read (`billingCatalog: false`), and the workspace already holds licenses.
    const { client } = await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), {
      modules: { billing: false, billingCatalog: false },
      ready: "Licenses are unavailable",
    });
    client.setQueryData(PORTAL_ME_KEY, meWith({ billing: false, billingCatalog: false }));
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(false);
    await click(buttonNamed(/^Retry$/)!);
    expect(client.getQueryState(PORTAL_ME_KEY)?.isInvalidated).toBe(true);
  });

  test("a Member sees the products they hold a license for, and nothing of billing's", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.twoActive(),
      role: "member",
      licenses: [CALL_LICENSE].map(license => ({ ...license, seats: license.seats!.slice(0, 1), seatsUsed: 3 })),
      workspaceCatalog: workspaceCatalog(false),
    };
    const { core } = await open(`/w/${ACME}/licenses`, scenario, { modules: BILLING_ON, ready: "Assigned to you" });
    expect(has("Mentra Call Unlimited")).toBe(true);
    expect(has("What Acme Field Services pays for")).toBe(false);
    expect(has("Your licenses in Acme Field Services.")).toBe(true);
    expect(text()).not.toMatch(/\$\d/);
    expect(buttonNamed(/Billing & invoices/)).toBeUndefined();
    expect(billingRequests(core).some(request => request.path.endsWith("/status"))).toBe(false);
    // Nor the members of the workspace.
    expect(core.requests.some(request => request.path.endsWith("/members"))).toBe(false);
  });
});

// ---- purchase return ----------------------------------------------------------------------------------------------

describe("coming back from checkout", () => {
  const bought = SCENARIOS.purchased;

  test("?purchase=pur_1 reaches the view: billing is asked about it and the banner says the licenses are ready", async () => {
    const { core } = await open(`/w/${ACME}/licenses?purchase=pur_1`, bought(), { ready: "Your 10 Fleet licenses are ready" });
    const statuses = billingRequests(core).filter(request => request.path.endsWith("/status"));
    expect(statuses.length).toBeGreaterThan(0);
    for (const request of statuses) expect(request.query.get("purchase")).toBe("pur_1");
    // The header actions read the same status (one request, not two).
    expect(statuses).toHaveLength(1);
  });

  test("dismissing the banner takes ?purchase= out of the address, and billing is asked without it from then on", async () => {
    const { core } = await open(`/w/${ACME}/licenses?purchase=pur_1`, bought(), { ready: "Your 10 Fleet licenses are ready" });
    const before = window.history.length;
    await click(buttonNamed(/^Dismiss$/)!);
    expect(search()).toBe("");
    expect(window.location.pathname).toBe(`/w/${ACME}/licenses`);
    // The address was changed in place: Back does not return to the banner.
    expect(window.history.length).toBe(before);
    expect(has("Your 10 Fleet licenses are ready")).toBe(false);
    await until(() => billingRequests(core).filter(request => request.path.endsWith("/status")).some(request => request.query.get("purchase") === null), "a status read without the purchase");
    // The cards stayed.
    expect(has("Mentra Call Unlimited")).toBe(true);
  });
});

// ---- the personal page --------------------------------------------------------------------------------------------

describe("the personal Billing page", () => {
  test("/account/billing renders the personal view for someone offered billing", async () => {
    const { core } = await open("/account/billing", SCENARIOS.personalActive(), { ready: "Mentra Call Unlimited" });
    expect(find("h1").textContent).toBe("Billing");
    expect(has("Licenses you buy for yourself, apart from any workspace's.")).toBe(true);
    expect(has("$29")).toBe(true);
    expect(find("header").textContent).toContain("Billing & invoices");
    // Billing's account routes, not a workspace's.
    const paths = billingRequests(core).map(request => request.path);
    expect(paths).toEqual(expect.arrayContaining(["/api/portal/billing/account/catalog", "/api/portal/billing/account/status"]));
    expect(paths.some(path => path.includes("/workspaces/"))).toBe(false);
    for (const request of billingRequests(core)) expect(request.query.get("locale")).toBe("en-US");
    // The personal layout: Your account, with Billing under it.
    expect(find("nav[aria-label='Account']").textContent).toContain("Your account");
  });

  test("shows the catalog to someone with nothing yet", async () => {
    await open("/account/billing", SCENARIOS.personalCatalog(), { ready: "Mentra Call Unlimited" });
    expect(has("Example Add-on")).toBe(true);
    // Fleet is sold to workspaces only.
    expect(has("Fleet")).toBe(false);
  });

  test("is not found for anyone who isn't offered billing, whatever else they may see, and asks billing for nothing", async () => {
    for (const modules of [{ billing: false, billingCatalog: false }, CATALOG_ONLY]) {
      const { core } = await open("/account/billing", SCENARIOS.personalActive(), { modules });
      expect(has("Page not found")).toBe(true);
      expect(has("Mentra Call Unlimited")).toBe(false);
      expect(billingRequests(core)).toEqual([]);
      await cleanup();
      mock.restore();
    }
  });

  test("?purchase= is followed and dismissed on the personal page too", async () => {
    const scenario: Scenario = {
      ...SCENARIOS.personalActive(),
      accountStatus: ({ purchase }) =>
        statusOf(SCENARIOS.personalActive().accountStatus ? (SCENARIOS.personalActive().accountStatus as ReturnType<typeof statusOf>).licenses : [], {
          purchase: purchase === "pur_9" ? purchaseOf({ purchaseId: "pur_9", status: "ready", product: "mentra.call.unlimited", quantity: 1, licenseId: "lic_me" }) : null,
        }),
    };
    const { core } = await open("/account/billing?purchase=pur_9", scenario, { ready: "is ready" });
    expect(billingRequests(core).filter(request => request.path.endsWith("/status")).every(request => request.query.get("purchase") === "pur_9")).toBe(true);
    await click(buttonNamed(/^Dismiss$/)!);
    expect(search()).toBe("");
  });
});

// ---- Members and the member panel ---------------------------------------------------------------------------------

describe("Members with licenses", () => {
  const panel = () => document.querySelector<HTMLDialogElement>("dialog[data-slot='side-panel']");
  const panelOpen = () => panel()?.hasAttribute("open") ?? false;
  const openRow = (name: string) => click(find(`button[aria-label='Open ${name}']`));

  test("the list gains the Licenses column with a chip per license held, from billing's catalog", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(() => has("Licenses") && findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
    const row = byText("Hannah Kim", "[data-slot='member-name']").closest("tr")!;
    expect(row.textContent).toContain("Call Unlimited");
    const luis = byText("Luis Ortega", "[data-slot='member-name']").closest("tr")!;
    expect(luis.textContent).toContain("None");
  });

  test("?member=<membershipId> opens the member panel, with their licenses", async () => {
    await open(`/w/${ACME}/members?member=wm_luis`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(panelOpen, "the member panel");
    expect(panel()!.textContent).toContain("Luis Ortega");
    expect(panel()!.textContent).toContain("Remove from workspace");
    await until(() => (panel()!.textContent ?? "").includes("Mentra Call Unlimited"), "the panel's Licenses section");
  });

  test("opening a member from the list puts ?member= in the address", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    expect(panelOpen()).toBe(false);
    await openRow("Luis Ortega");
    expect(search()).toBe("?member=wm_luis");
    await until(panelOpen, "the member panel");
  });

  test("closing the panel removes the parameter", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await openRow("Luis Ortega");
    await until(panelOpen, "the member panel");
    await click(find("button[aria-label='Close']", panel()!));
    await until(() => !panelOpen() && search() === "", "the panel to close");
    expect(window.location.pathname).toBe(`/w/${ACME}/members`);
  });

  test("a panel opened by an address closes in place, and the parameter goes", async () => {
    await open(`/w/${ACME}/members?member=wm_amara`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(panelOpen, "the member panel");
    const before = window.history.length;
    await click(find("button[aria-label='Close']", panel()!));
    await until(() => !panelOpen(), "the panel to close");
    expect(search()).toBe("");
    expect(window.history.length).toBe(before);
  });

  test("Back closes the panel", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await openRow("Amara Okafor");
    await until(panelOpen, "the member panel");
    await act(async () => window.history.back());
    await until(() => !panelOpen() && search() === "", "Back to close the panel");
    expect(has("Hannah Kim")).toBe(true);
  });

  test("Add licenses ↗ is offered only where billing lists add_seats, and asks billing for that session", async () => {
    const { core } = await open(`/w/${ACME}/members?member=wm_luis`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    const out = ways();
    await until(() => buttonNamed(/Add licenses/) !== undefined, "Add licenses in the panel");
    // Fleet is full; Call and Example Add-on have licenses available and no button.
    expect(findAll("button, a").filter(element => /Add licenses/.test(element.textContent ?? ""))).toHaveLength(1);
    await click(buttonNamed(/Add licenses/)!);
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.checkout]]);
    const posted = core.requests.find(request => request.method === "POST" && request.path.endsWith("/session"))!;
    expect(posted.body).toEqual({ action: "add_seats", licenseId: "lic_fleet", locale: "en-US" });
  });

  test("Add licenses ↗ is a hosted action like any other: one billing lists with returns: false opens a tab in the click", async () => {
    const seatsPage: BillingAction = { kind: "add_seats", fallbackLabel: "Add licenses", returns: false };
    const scenario: Scenario = {
      ...SCENARIOS.threeActive(),
      workspaceStatus: statusOf([CALL_BILLING, { ...FLEET_BILLING, actions: [seatsPage] }, EXAMPLE_BILLING]),
      hosted: () => ({ url: HOSTED.seats }),
    };
    await open(`/w/${ACME}/members?member=wm_luis`, scenario, { ready: "Hannah Kim" });
    const out = ways();
    await until(() => buttonNamed(/Add licenses/) !== undefined, "Add licenses in the panel");
    await click(buttonNamed(/Add licenses/)!);
    // The tab was opened in the click itself, before billing answered; this tab stays.
    expect(out.events[0]).toBe("open");
    await until(() => out.events.includes(`replace:${HOSTED.seats}`), "the tab to be sent on");
    expect(out.assign).not.toHaveBeenCalled();
    expect(out.tab.opener).toBeNull();
  });

  test("a refused Add licenses ↗ says so in the panel, in the neutral notice, and goes nowhere", async () => {
    const scenario: Scenario = { ...SCENARIOS.threeActive(), hosted: () => ({ url: "javascript:alert(1)" }) };
    await open(`/w/${ACME}/members?member=wm_luis`, scenario, { ready: "Hannah Kim" });
    const out = ways();
    await until(() => buttonNamed(/Add licenses/) !== undefined, "Add licenses in the panel");
    await click(buttonNamed(/Add licenses/)!);
    await until(() => has("Billing couldn't do that. Try again."), "the refusal");
    const alerts = findAll("dialog [role='alert']");
    expect(alerts.map(alert => alert.textContent)).toEqual(["Billing couldn't do that. Try again."]);
    expect(alerts.every(isNeutral)).toBe(true);
    expect(out.assign).not.toHaveBeenCalled();
    expect(out.openWindow).not.toHaveBeenCalled();
  });

  test("Add licenses ↗ in the Assign licenses dialog goes the same way", async () => {
    const { core } = await open(`/w/${ACME}/members`, { ...SCENARIOS.threeActive(), hosted: () => ({ url: HOSTED.seats }) }, { ready: "Call Unlimited" });
    const out = ways();
    await click(find("input[aria-label='Select Luis Ortega']"));
    await click(find("input[aria-label='Select Amara Okafor']"));
    await click(buttonNamed(/^Assign licenses$/)!);
    await until(() => findAll("dialog button").some(button => /Add licenses/.test(button.textContent ?? "")), "Add licenses in the dialog");
    await click(findAll("dialog button").find(button => /Add licenses/.test(button.textContent ?? ""))!);
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.seats]]);
    const posted = core.requests.find(request => request.method === "POST" && request.path.endsWith("/session"))!;
    expect(posted.body).toEqual({ action: "add_seats", licenseId: "lic_fleet", locale: "en-US" });
  });

  test("a license billing lists no add_seats for offers no Add licenses ↗ (a failed payment's)", async () => {
    const scenario: Scenario = { ...SCENARIOS.paymentFailed() };
    await open(`/w/${ACME}/members?member=wm_luis`, scenario, { ready: "Hannah Kim" });
    await until(() => (panel()?.textContent ?? "").includes("Fleet"), "the panel's Licenses section");
    expect(buttonNamed(/Add licenses/)).toBeUndefined();
  });

  test("without billing (a non-staff Admin) the list still has its chips, and no Add licenses and no status request", async () => {
    const scenario: Scenario = { ...SCENARIOS.threeActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    const { core } = await open(`/w/${ACME}/members?member=wm_luis`, scenario, { modules: CATALOG_ONLY, ready: "Hannah Kim" });
    await until(() => (panel()?.textContent ?? "").includes("Mentra Call Unlimited"), "the panel's Licenses section");
    expect(buttonNamed(/Add licenses/)).toBeUndefined();
    expect(billingRequests(core).some(request => request.path.endsWith("/status"))).toBe(false);
  });

  test("without a catalog the list works without any of it (billing off: no Licenses column)", async () => {
    const { core } = await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), {
      modules: { billing: false, billingCatalog: false },
      ready: "Hannah Kim",
    });
    expect(findAll("ul[aria-label='Licenses']")).toHaveLength(0);
    expect(billingRequests(core)).toEqual([]);
  });
});

// ---- older Cores --------------------------------------------------------------------------------------------------

describe("an older Core", () => {
  test("whose /me has no billingCatalog is read as billing: the Licenses page is drawn with money", async () => {
    const older = { ...meWith(BILLING_ON), modules: { billing: true } };
    spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(older)) as unknown as typeof fetch);
    const me = await fetchPortalMe();
    mock.restore();
    expect(me.modules).toEqual(BILLING_ON);
    const { core } = await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), { me, modules: me.modules, ready: "Mentra Call Unlimited" });
    expect(has("$145")).toBe(true);
    expect(billingRequests(core).some(request => request.path.endsWith("/catalog"))).toBe(true);
  });
});

// ---- leaving ------------------------------------------------------------------------------------------------------

describe("leaving for a hosted page", () => {
  const invoices = () => buttonNamed(/Billing & invoices/)!;
  const GENERIC = "Billing couldn't do that. Try again.";

  const answering = (url: string, extra: Partial<Scenario> = {}): Scenario => ({
    ...SCENARIOS.twoActive(),
    hosted: () => ({ url }),
    ...extra,
  });

  test("an action session's URL goes to window.location.assign, in this tab", async () => {
    const { core } = await open(`/w/${ACME}/licenses`, answering(HOSTED.invoices), { ready: "Mentra Call Unlimited" });
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
    await open(`/w/${ACME}/licenses`, answering(url), { ready: "Mentra Call Unlimited" });
    const out = ways();
    await click(invoices());
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[url]]);
  });

  test.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://billing.example.test/pay", "http://localhost.evil.test/pay"])(
    "refuses %s with the generic refusal, and goes nowhere",
    async url => {
      await open(`/w/${ACME}/licenses`, answering(url), { ready: "Mentra Call Unlimited" });
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
    await open(`/w/${ACME}/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
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
      await open(`/w/${ACME}/licenses`, unpaid(url), { ready: "Mentra Call Unlimited" });
      const out = ways();
      await click(buttonNamed(/Complete payment/)!);
      await until(() => has(GENERIC), "the refusal");
      expect(out.events).toEqual(["open", "close"]);
      expect(out.assign).not.toHaveBeenCalled();
    },
  );

  test("a tab the person closed while billing answered is not an error: the link to the page is offered instead", async () => {
    await open(`/w/${ACME}/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
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
    await open(`/w/${ACME}/licenses`, unpaid(HOSTED.invoice), { ready: "Mentra Call Unlimited" });
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
    const { core } = await open(`/w/${ACME}/licenses`, answering(HOSTED.checkout, SCENARIOS.catalog()), { ready: "Mentra Call Unlimited" });
    const out = ways();
    await click(findAll<HTMLElement>("button").find(button => button.textContent?.trim() === "Buy")!);
    await until(() => has("Continue to payment"), "the licenses step");
    await click(buttonNamed(/Continue to payment/)!);
    await until(() => out.assign.mock.calls.length > 0, "the browser to leave");
    expect(out.assign.mock.calls).toEqual([[HOSTED.checkout]]);
    const posted = core.requests.find(request => request.method === "POST" && request.path.endsWith("/purchase"))!;
    expect(posted.body).toMatchObject({ seats: 10, locale: "en-US" });
  });
});

// ---- nothing leaks ------------------------------------------------------------------------------------------------

describe("the test-mode notice", () => {
  const HIDE = "[role='note'] button[aria-label='Hide the test mode notice']";
  const personalWithTestMode = (): Scenario => {
    const base = SCENARIOS.personalActive();
    return { ...base, accountStatus: statusOf((base.accountStatus as ReturnType<typeof statusOf>).licenses, { testMode: TEST_MODE }) };
  };
  afterEach(() => window.sessionStorage.clear());

  test("× hides it on the Licenses page and, in the same session, on the personal Billing page, and the other way round", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.testMode(), { ready: "Test mode · Staging" });
    expect(findAll("[role='note']")).toHaveLength(1);
    await click(find(HIDE));
    expect(findAll("[role='note']")).toHaveLength(0);
    expect(has("Buy licenses for your members")).toBe(true);
    await cleanup();
    mock.restore();
    await open("/account/billing", personalWithTestMode(), { ready: "Mentra Call Unlimited" });
    expect(findAll("[role='note']")).toHaveLength(0);
    await cleanup();
    mock.restore();
    // A new session shows it again, here, and hiding it here hides it on the Licenses page.
    window.sessionStorage.clear();
    await open("/account/billing", personalWithTestMode(), { ready: "Test mode · Staging" });
    await click(find(HIDE));
    await cleanup();
    mock.restore();
    await open(`/w/${ACME}/licenses`, SCENARIOS.testMode(), { ready: "Buy licenses for your members" });
    expect(findAll("[role='note']")).toHaveLength(0);
  });
});

describe("what no page says", () => {
  const PROCESSOR = new RegExp(["st", "ripe"].join(""), "i");
  const IDS = /\b(?:cus|sub|price|prod|pi|cs|in|si|seti|plink)_[A-Za-z0-9]{6,}/;

  test("neither the processor's name nor one of its ids, on the Licenses page, Members, or the personal page", async () => {
    const pages: Array<[string, Scenario, string]> = [
      [`/w/${ACME}/licenses`, SCENARIOS.paymentFailed(), "Mentra Call Unlimited"],
      [`/w/${ACME}/members?member=wm_luis`, SCENARIOS.threeActive(), "Hannah Kim"],
      ["/account/billing", SCENARIOS.personalActive(), "Mentra Call Unlimited"],
      [`/w/${ACME}/licenses`, SCENARIOS.testMode(), "Mentra Call Unlimited"],
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
