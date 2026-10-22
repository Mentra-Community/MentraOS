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
import { AccountBillingScreen } from "./pages/account-billing";
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
  const pathname = usePathname();
  // The personal Billing page has no address any more; it is mounted by hand until it is removed.
  if (pathname === "/account/billing") return <AccountBillingScreen />;
  return <PortalRoutes route={parseRoute(pathname)} me={me} />;
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
  test("/licenses renders the view: the cards, the total and the header actions, with billing's data", async () => {
    const { core } = await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(find("h1").textContent).toBe("Licenses");
    // The title has no subtitle.
    expect(has("pays for")).toBe(false);
    expect(find("h1").nextElementSibling).toBeNull();
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
    const { core } = await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
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
    await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(has("$145")).toBe(true);
    expect(buttonNamed(/^Buy licenses$/)).toBeDefined();
    expect(buttonNamed(/Billing & invoices/)).toBeDefined();
    // Core's roster of who holds a license is the new card's: the folded strip of people.
    expect(has("Assigned to")).toBe(true);
  });

  test("a non-staff Admin on staging (licenses, no billing) gets the Licenses item and cards without money", async () => {
    const scenario: Scenario = { ...SCENARIOS.twoActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    const { core } = await open(`/licenses`, scenario, { modules: CATALOG_ONLY, ready: "Mentra Call Unlimited" });
    expect(hrefs()).toContain(`/licenses`);
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
    await open(`/licenses`, SCENARIOS.twoActive(), { ready: "Mentra Call Unlimited" });
    expect(hrefs()).not.toContain("/account/billing");
    await click(find("button[aria-label='Open account menu']"));
    const item = findAll<HTMLAnchorElement>("a[href='/account/billing']");
    expect(item.map(anchor => anchor.textContent?.trim())).toEqual(["Billing"]);
    expect(has("Sign out")).toBe(true);
  });

  test("Retry on the Licenses page also reads who the person is again, so a page opened before billing was ready can recover", async () => {
    // Billing wasn't ready when `me` was read (`billingCatalog: false`), and the workspace already holds licenses.
    const { client } = await open(`/licenses`, SCENARIOS.twoActive(), {
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
    const { core } = await open(`/licenses`, scenario, { modules: BILLING_ON, ready: "Assigned to you" });
    expect(has("Mentra Call Unlimited")).toBe(true);
    expect(has("What Acme Field Services pays for")).toBe(false);
    expect(has("Your licenses in")).toBe(false);
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
    const { core } = await open(`/licenses?purchase=pur_1`, bought(), { ready: "Your 10 Fleet licenses are ready" });
    const statuses = billingRequests(core).filter(request => request.path.endsWith("/status"));
    expect(statuses.length).toBeGreaterThan(0);
    for (const request of statuses) expect(request.query.get("purchase")).toBe("pur_1");
    // The header actions read the same status (one request, not two).
    expect(statuses).toHaveLength(1);
  });

  test("dismissing the banner takes ?purchase= out of the address, and billing is asked without it from then on", async () => {
    const { core } = await open(`/licenses?purchase=pur_1`, bought(), { ready: "Your 10 Fleet licenses are ready" });
    const before = window.history.length;
    await click(buttonNamed(/^Dismiss$/)!);
    expect(search()).toBe("");
    expect(window.location.pathname).toBe(`/licenses`);
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

// ---- Members ------------------------------------------------------------------------------------------------------

describe("Members", () => {
  const rowOf = (name: string) => byText(name, "[data-slot='member-name']").closest("tr")!;
  const menuFor = (name: string) => find(`button[aria-label='More for ${name}']`);
  const openDialog = () => document.querySelector("dialog[open]");

  test("the list gains the Licenses column with a chip per license held, from billing's catalog, and only shows them", async () => {
    await open(`/members`, SCENARIOS.threeActive(), { ready: "Hannah Kim" });
    await until(() => has("Licenses") && findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
    expect(rowOf("Hannah Kim").textContent).toContain("Call Unlimited");
    expect(rowOf("Luis Ortega").textContent).toContain("None");
    // Licenses are assigned from the Licenses page: no checkbox, no selection bar, no Assign licenses here.
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    expect(findAll("[data-slot='selection-bar']")).toHaveLength(0);
    expect(buttonNamed(/^Assign licenses$/)).toBeUndefined();
    expect(findAll("button, a", find("ul[aria-label='Licenses']", rowOf("Hannah Kim")))).toHaveLength(0);
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
    await until(() => findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
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

  test("without billing (a non-staff Admin) the list still has its chips, and asks billing for no status", async () => {
    const scenario: Scenario = { ...SCENARIOS.threeActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    const { core } = await open(`/members`, scenario, { modules: CATALOG_ONLY, ready: "Hannah Kim" });
    await until(() => findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
    expect(rowOf("Hannah Kim").textContent).toContain("Call Unlimited");
    expect(billingRequests(core).some(request => request.path.endsWith("/status"))).toBe(false);
  });

  test("without a catalog the list works without any of it (billing off: no Licenses column)", async () => {
    const { core } = await open(`/members`, SCENARIOS.threeActive(), {
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
    const { core } = await open(`/licenses`, SCENARIOS.twoActive(), { me, modules: me.modules, ready: "Mentra Call Unlimited" });
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
    await open(`/licenses`, SCENARIOS.testMode(), { ready: "Test mode · Staging" });
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
    await open(`/licenses`, SCENARIOS.testMode(), { ready: "Buy licenses for your members" });
    expect(findAll("[role='note']")).toHaveLength(0);
  });
});

describe("what no page says", () => {
  const PROCESSOR = new RegExp(["st", "ripe"].join(""), "i");
  const IDS = /\b(?:cus|sub|price|prod|pi|cs|in|si|seti|plink)_[A-Za-z0-9]{6,}/;

  test("neither the processor's name nor one of its ids, on the Licenses page, Members, or the personal page", async () => {
    const pages: Array<[string, Scenario, string]> = [
      [`/licenses`, SCENARIOS.paymentFailed(), "Mentra Call Unlimited"],
      [`/members`, SCENARIOS.threeActive(), "Hannah Kim"],
      ["/account/billing", SCENARIOS.personalActive(), "Mentra Call Unlimited"],
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
