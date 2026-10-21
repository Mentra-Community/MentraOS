/**
 * The word "seat" is not one a person reads. A license is one person's right to a product (the Microsoft 365
 * meaning): a workspace buys a number of licenses for a product, and each is assigned to one member. API and code
 * names keep `seats`, `add_seats` and the rest; this guard is about what the pages show.
 *
 * It mounts the real pages over the fake Core, drives them through every state and dialog the Licenses page, the
 * Members list and the personal Billing page have, and after each step takes everything a person or a screen reader
 * can get from the page: its text (visually hidden text included, and the text of dialogs that are closed) and the
 * words in its attributes (`aria-label`, `title`, `alt`, `placeholder` and the like). None may match
 * `/\bseats?\b/i`.
 *
 * A guard that never reached a state would pass for it, so the last test checks that the sentences the states exist
 * to show were on some screen.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { licenseStrings as t } from "@mentra/workspace-ui";
import { click, cleanup, find, findAll, render, setupDom, teardownDom, typeInto, until, wordsUnder } from "@mentra/workspace-ui/test-dom";
import type { LicenseView } from "@mentra/workspace-contract";
import type { BillingAction, LicenseBilling } from "@mentra/workspace-contract/portal-billing";
import { PortalRoutes } from "./App";
import type { PortalMe, PortalModules } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PortalProvider, type PortalSession } from "./lib/portal";
import { parseRoute } from "./lib/routes";
import {
  ACME,
  CALL_BILLING,
  CALL_LICENSE,
  EXAMPLE_BILLING,
  EXAMPLE_LICENSE,
  FLEET_BILLING,
  FLEET_LICENSE,
  PEOPLE,
  SCENARIOS,
  TEST_MODE,
  fakeCore,
  purchaseOf,
  statusOf,
  workspaceCatalog,
  type Scenario,
} from "./test-core";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(async () => {
  await cleanup();
  mock.restore();
});

// ---- what a person can take from the page ---------------------------------------------------------------------------

/** The word, whole: `seatsUsed` and `add_seats` are code, and are never on a page; "Seat holders" and "free seats" are. */
const SEAT = /\bseats?\b/i;

/** Everything any screen showed, for the last test. */
const seen = new Set<string>();

/** Fails, naming the screen, if anything a person can read or hear on the page (see `wordsUnder`) says "seat". */
function expectNoSeat(screen: string) {
  const words = wordsUnder();
  for (const word of words) seen.add(word.replace(/^<[^>]*> /, ""));
  expect([screen, words.filter((word) => SEAT.test(word))]).toEqual([screen, []]);
}

describe("the guard sees what it should", () => {
  test("a seat in text, in visually hidden text, and in an aria-label, a title or a placeholder", () => {
    document.body.innerHTML = `
      <p>Seat holders</p>
      <span class="sr-only">Assign 2 seats</span>
      <button aria-label="One seat fewer">-</button>
      <div title="Seats">x</div>
      <input placeholder="Search seat holders">
      <p>Licenses and the seatsUsed code</p>`;
    const found = wordsUnder().filter((word) => SEAT.test(word));
    expect(found).toEqual([
      "<p> Seat holders",
      "<span> Assign 2 seats",
      "<button aria-label> One seat fewer",
      "<div title> Seats",
      "<input placeholder> Search seat holders",
    ]);
    document.body.innerHTML = "";
  });
});

// ---- the rig ------------------------------------------------------------------------------------------------------

const BILLING_ON: PortalModules = { billing: true, billingCatalog: true };
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

function Routes({ me }: { me: PortalMe }) {
  return <PortalRoutes route={parseRoute(usePathname())} me={me} />;
}

const text = () => document.body.textContent ?? "";
const has = (needle: string) => text().includes(needle);

/** Opens `path` as a person with `modules` over a fake Core answering `scenario`, once `ready` is on the page. */
async function open(path: string, scenario: Scenario, ready: string, modules: PortalModules = BILLING_ON) {
  window.history.replaceState(null, "", path);
  const core = fakeCore(scenario);
  spyOn(globalThis, "fetch").mockImplementation(core.fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  await render(
    <QueryClientProvider client={client}>
      <PortalProvider value={portalSession(modules)}>
        <Routes me={meWith(modules)} />
      </PortalProvider>
    </QueryClientProvider>,
  );
  await until(() => has(ready), `the page to show ${ready}`);
  return core;
}

/** The buttons (and links) whose name is exactly `name`, by their text or their aria-label. */
function named(name: string | RegExp, within: ParentNode = document): HTMLElement[] {
  const matches = (value: string | null | undefined) => (typeof name === "string" ? value?.trim() === name : name.test(value?.trim() ?? ""));
  return findAll<HTMLElement>("button, a", within).filter((element) => matches(element.textContent) || matches(element.getAttribute("aria-label")));
}
const one = (name: string | RegExp, within?: ParentNode) => {
  const found = named(name, within)[0];
  if (!found) throw new Error(`no button named ${String(name)}`);
  return found;
};

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** A Core license of `quantity` licenses, held by these people (keys of `PEOPLE`). */
function coreLicense(base: LicenseView, quantity: number, holders: string[]): LicenseView {
  return {
    ...base,
    quantity,
    seatsUsed: holders.length,
    seats: holders.map((key) => ({ membershipId: `wm_${key}`, mentraUserId: `u_${key}`, assignedAt: "2026-10-20T12:00:00.000Z" })),
  };
}

const action = (kind: string, fallbackLabel: string): BillingAction => ({ kind, fallbackLabel });
const entry = (base: LicenseBilling, extra: Partial<LicenseBilling>): LicenseBilling => ({ ...base, ...extra });

/** One license in a state, as a page with only it: Core's side and billing's. */
function single(license: LicenseView, billing: LicenseBilling): Scenario {
  return { licenses: [license], workspaceStatus: statusOf([billing]) };
}

// ---- the Licenses page: a card in each state --------------------------------------------------------------------

/**
 * What a card can do that shows more words: its roster opened, Unassign asking first, its menu, its picker with people
 * chosen, one by one up to every person who can be.
 */
async function exploreCards(screen: string) {
  expectNoSeat(`${screen}: the page`);
  for (const toggle of findAll<HTMLElement>("[data-slot='card'] button[aria-expanded='false']:not([aria-haspopup])")) {
    await click(toggle);
  }
  expectNoSeat(`${screen}: the rosters open`);

  const unassign = findAll<HTMLElement>("[data-slot='card'] button").find((button) => button.getAttribute("aria-label")?.startsWith("Unassign "));
  if (unassign) {
    await click(unassign);
    expectNoSeat(`${screen}: Unassign asks first, in a dialog`);
    await click(one(t.seats.cancel, find("dialog[open]")));
  }

  for (const menu of findAll<HTMLElement>("[data-slot='card'] [aria-haspopup='menu']")) {
    await click(menu);
    expectNoSeat(`${screen}: the menu`);
    await click(menu);
  }

  const assign = named(t.seats.assignSeats)[0];
  if (assign) {
    await click(assign);
    const dialog = find<HTMLDialogElement>("dialog[open]");
    expectNoSeat(`${screen}: the people picker`);
    // The picker's rows are people in a list; choose them one by one, so every count and every fit line is shown.
    const boxes = findAll<HTMLInputElement>("input[type=checkbox]:not([disabled])", dialog);
    for (const [index, box] of boxes.slice(0, 7).entries()) {
      await click(box);
      expectNoSeat(`${screen}: the picker with ${index + 1} chosen`);
    }
    await typeInto(find<HTMLInputElement>("input[type=search], input[type=text]", dialog), "ha");
    expectNoSeat(`${screen}: the picker searched`);
    await click(one(t.picker.cancel, dialog));
  }
}

describe("a license's card, in each state", () => {
  test("active, with some licenses free and some people holding them; and one that is full", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), "Mentra Call Unlimited");
    await exploreCards("active and full");
  });

  test("a single license shows its roster at once, and the full one offers Add licenses", async () => {
    await open(`/w/${ACME}/licenses`, single(FLEET_LICENSE, FLEET_BILLING), "Fleet");
    await exploreCards("one full license");
  });

  test("a single license of one, held: 'the license is assigned'", async () => {
    const license = coreLicense(CALL_LICENSE, 1, ["hannah"]);
    await open(`/w/${ACME}/licenses`, single(license, entry(CALL_BILLING, { quantity: 1 })), "Mentra Call Unlimited");
    await exploreCards("one license of one");
  });

  test("nobody holds any: more than three available fold into one row", async () => {
    await open(`/w/${ACME}/licenses`, single(coreLicense(CALL_LICENSE, 7, []), entry(CALL_BILLING, { quantity: 7 })), "Mentra Call Unlimited");
    await exploreCards("empty");
  });

  test("a roster of more than seven has a search", async () => {
    await open(`/w/${ACME}/licenses`, single(FLEET_LICENSE, FLEET_BILLING), "Fleet");
    expect(findAll("input[type=search]").length).toBeGreaterThan(0);
    await exploreCards("a long roster");
  });

  test("payment failed: before the day the licenses stop, and after it", async () => {
    for (const [label, stopAt] of [["before", inDays(3)], ["after", inDays(-3)]] as const) {
      const failed = entry(FLEET_BILLING, {
        status: "past_due",
        fallbackStatusLabel: "Payment failed",
        renewsAt: inDays(-2),
        seatsStopAt: stopAt,
        actions: [action("update_payment", "Update payment method"), action("complete_payment", "Complete payment"), action("cancel", "Cancel")],
      });
      await open(`/w/${ACME}/licenses`, { licenses: [CALL_LICENSE, FLEET_LICENSE], workspaceStatus: statusOf([CALL_BILLING, failed]) }, "Fleet");
      await exploreCards(`payment failed ${label} the day`);
      await cleanup();
      mock.restore();
    }
  });

  test("payment failed with no day from billing", async () => {
    const failed = entry(FLEET_BILLING, { status: "past_due", fallbackStatusLabel: "Payment failed", seatsStopAt: undefined });
    await open(`/w/${ACME}/licenses`, single(FLEET_LICENSE, failed), "Fleet");
    await exploreCards("payment failed, no day");
  });

  test("ending, and full", async () => {
    const ending = entry(CALL_BILLING, {
      status: "ending",
      fallbackStatusLabel: "Ending",
      renewsAt: undefined,
      endsAt: inDays(9),
      actions: [action("renew", "Renew")],
    });
    await open(`/w/${ACME}/licenses`, single(coreLicense(CALL_LICENSE, 3, ["hannah", "tom", "noah"]), entry(ending, { quantity: 3 })), "Mentra Call Unlimited");
    await exploreCards("ending and full");
  });

  test("payment incomplete, and setting up", async () => {
    for (const status of ["incomplete", "processing"] as const) {
      const billing = entry(EXAMPLE_BILLING, {
        status,
        fallbackStatusLabel: status,
        actions: status === "incomplete" ? [action("complete_payment", "Complete payment")] : [],
      });
      await open(`/w/${ACME}/licenses`, { licenses: [CALL_LICENSE, EXAMPLE_LICENSE], workspaceStatus: statusOf([CALL_BILLING, billing]) }, "Example Add-on");
      await exploreCards(status);
      await cleanup();
      mock.restore();
    }
  });

  test("more people assigned than licenses paid for, with Add licenses and without", async () => {
    const over = coreLicense(CALL_LICENSE, 3, ["hannah", "tom", "noah", "ines", "omar"]);
    await open(`/w/${ACME}/licenses`, single(over, entry(CALL_BILLING, { quantity: 3 })), "Mentra Call Unlimited");
    await exploreCards("over-assigned");
    await cleanup();
    mock.restore();
    await open(`/w/${ACME}/licenses`, single(over, entry(CALL_BILLING, { quantity: 3, actions: [action("cancel", "Cancel")] })), "Mentra Call Unlimited");
    await exploreCards("over-assigned, nothing to add");
  });

  test("a status and an action this portal doesn't know keep billing's own words", async () => {
    const odd = entry(CALL_BILLING, {
      status: "paused",
      fallbackStatusLabel: "Paused",
      actions: [action("add_seats", "Add licenses"), action("change_seats", "Change license count"), action("pause_collection", "Pause billing")],
    });
    await open(`/w/${ACME}/licenses`, single(CALL_LICENSE, odd), "Mentra Call Unlimited");
    await exploreCards("an unknown status");
  });

  test("a manager not offered billing sees the licenses without money", async () => {
    const scenario: Scenario = { ...SCENARIOS.twoActive(), role: "admin", workspaceCatalog: workspaceCatalog(false) };
    await open(`/w/${ACME}/licenses`, scenario, "Mentra Call Unlimited", CATALOG_ONLY);
    await exploreCards("without billing");
  });

  test("the total counts products", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.threeActive(), "Mentra Call Unlimited");
    expect(has("3 products")).toBe(true);
    expectNoSeat("the total");
  });
});

// ---- a member's own card -----------------------------------------------------------------------------------------

describe("a member's own card", () => {
  test("with a license", async () => {
    const mine: Scenario = {
      ...SCENARIOS.twoActive(),
      role: "member",
      viewer: "hannah",
      licenses: [CALL_LICENSE].map((license) => ({ ...license, seats: license.seats!.slice(0, 1), seatsUsed: 3 })),
      workspaceCatalog: workspaceCatalog(false),
    };
    await open(`/w/${ACME}/licenses`, mine, t.status.youHaveASeat);
    expectNoSeat("the member's own card");
  });
});


// ---- the catalog and the buy dialog --------------------------------------------------------------------------------

describe("the catalog grid and the buy dialog", () => {
  test("a workspace with nothing yet: the grid, the buy step with its stepper, and the sum", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.catalog(), t.catalog.workspace.title);
    expectNoSeat("the catalog grid");
    await click(one("Buy", find("[data-product='mentra.fleet']")));
    await until(() => has(t.buy.continue), "the buy step");
    expectNoSeat("the buy step");
    const field = find<HTMLInputElement>("input[role=spinbutton]");
    for (const label of [t.buy.more, t.buy.more, t.buy.fewer]) {
      await click(one(label));
      expectNoSeat(`the buy step, ${label}`);
    }
    await typeInto(field, "1");
    expectNoSeat("the buy step with one");
    await typeInto(field, "500");
    expectNoSeat("the buy step with the most");
  });

  test("the dialog from the header, with a product the workspace holds and ones it doesn't", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.twoActive(), "Mentra Call Unlimited");
    await click(one(t.page.buyLicenses));
    await until(() => has(t.catalog.dialog.description), "the catalog dialog");
    expectNoSeat("the catalog dialog");
    expect(has(t.catalog.youHaveSeats(5))).toBe(true);
    await click(one("Buy", find("[data-product='example.addon']")));
    await until(() => has(t.buy.continue), "the buy step");
    expectNoSeat("the buy step over the dialog");
  });

  test("test mode", async () => {
    await open(`/w/${ACME}/licenses`, SCENARIOS.testMode(), t.testMode.label(TEST_MODE.environment));
    expectNoSeat("test mode");
    // The × is named, and hiding the notice leaves the rest of the page as it was.
    await click(find(`[role='note'] button[aria-label='${t.testMode.hide}']`));
    expectNoSeat("test mode, hidden");
  });
});

// ---- banners -------------------------------------------------------------------------------------------------------

describe("after checkout", () => {
  test("setting up, and ready", async () => {
    const setting: Scenario = {
      ...SCENARIOS.twoActive(),
      workspaceStatus: statusOf([CALL_BILLING, FLEET_BILLING], { purchase: purchaseOf({ status: "processing", licenseId: null }) }),
    };
    await open(`/w/${ACME}/licenses?purchase=pur_1`, setting, t.purchase.settingUp);
    expectNoSeat("setting up");
    await cleanup();
    mock.restore();
    await open(`/w/${ACME}/licenses?purchase=pur_1`, SCENARIOS.purchased(), t.purchase.readyTitle({ seats: 10, product: "Fleet" }));
    expectNoSeat("ready");
  });

  test("a person's purchase", async () => {
    const scenario: Scenario = {
      licenses: [],
      accountStatus: ({ purchase }) =>
        statusOf([entry(CALL_BILLING, { licenseId: "lic_me", quantity: 1, actions: [action("cancel", "Cancel")] })], {
          purchase: purchase === "pur_9" ? purchaseOf({ purchaseId: "pur_9", status: "ready", product: "mentra.call.unlimited", quantity: 1, licenseId: "lic_me" }) : null,
        }),
    };
    await open("/account/billing?purchase=pur_9", scenario, t.purchase.personReadyTitle("Mentra Call Unlimited"));
    expectNoSeat("a person's purchase");
  });
});

// ---- the Members list, Assign licenses and the member panel ---------------------------------------------------------

describe("Members", () => {
  const panelOpen = () => document.querySelector("dialog[data-slot='side-panel']")?.hasAttribute("open") ?? false;
  const choose = async (...names: string[]) => {
    for (const name of names) await click(find(`input[aria-label='Select ${name}']`));
  };

  test("the list, with its licenses column and the selection bar", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), "Hannah Kim");
    await until(() => findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
    expectNoSeat("the Members list");
    await choose("Luis Ortega", "Amara Okafor");
    await until(() => has(t.members.selected(2)), "the selection bar");
    expectNoSeat("the selection bar");
  });

  test("Assign licenses, with people chosen so each license shows each line it can", async () => {
    await open(`/w/${ACME}/members`, SCENARIOS.threeActive(), "Hannah Kim");
    await until(() => findAll("ul[aria-label='Licenses']").length > 0, "the Licenses column");
    // Call has 2 of 5 free, Fleet none, and Example Add-on has 1 of 3 free with Dana and Amara holding it. Amara alone
    // already holds it; then Luis with her; then more than Call has room for; then a person who hasn't signed in.
    for (const names of [["Amara Okafor"], ["Luis Ortega"], ["Sofia Alvarez"], ["Jamal Wright", "Hannah Kim"], ["Grace Oduya"]]) {
      await choose(...names);
      await click(one(t.members.assignLicenses));
      await until(() => has(t.assign.title), "Assign licenses");
      expectNoSeat(`Assign licenses, with ${names.join(" and ")} added`);
      await click(one(t.picker.cancel, find("dialog[open]")));
    }
  });

  test("the member panel: a person, one on the Fleet that is full, and one who hasn't signed in", async () => {
    for (const [member, shown] of [["wm_luis", "Mentra Call Unlimited"], ["wm_hannah", "Mentra Call Unlimited"], ["wm_grace", "after their first sign-in"]] as const) {
      await open(`/w/${ACME}/members?member=${member}`, SCENARIOS.threeActive(), "Remove from workspace");
      await until(() => panelOpen() && has(shown), "the panel's licenses");
      expectNoSeat(`the member panel of ${member}`);
      await cleanup();
      mock.restore();
    }
  });

  test("the member panel when more are assigned than paid for", async () => {
    const over = coreLicense(CALL_LICENSE, 2, ["hannah", "tom", "noah"]);
    const scenario: Scenario = { licenses: [over, FLEET_LICENSE], workspaceStatus: statusOf([entry(CALL_BILLING, { quantity: 2 }), FLEET_BILLING]) };
    await open(`/w/${ACME}/members?member=wm_luis`, scenario, "Remove from workspace");
    await until(() => has("Mentra Call Unlimited") && has(t.memberPanel.overAssigned(1)), "the panel's licenses");
    expectNoSeat("the member panel, over-assigned");
  });

  test("a refused Add licenses", async () => {
    await open(`/w/${ACME}/members?member=wm_luis`, { ...SCENARIOS.threeActive(), hosted: () => ({ url: "javascript:alert(1)" }) }, "Remove from workspace");
    await until(() => named(/Add licenses/).length > 0, "Add licenses in the panel");
    spyOn(window, "open").mockImplementation((() => null) as unknown as typeof window.open);
    await click(named(/Add licenses/)[0]!);
    await until(() => has("Billing couldn't do that"), "the refusal");
    expectNoSeat("a refusal in the panel");
  });
});

// ---- the personal Billing page ---------------------------------------------------------------------------------------

describe("the personal Billing page", () => {
  test("with a license and the catalog dialog open, and with none", async () => {
    await open("/account/billing", SCENARIOS.personalActive(), "Mentra Call Unlimited");
    await exploreCards("the personal page, one license");
    await click(one(t.page.buyALicense));
    await until(() => has(t.catalog.dialog.personDescription), "the catalog dialog");
    expectNoSeat("the personal catalog dialog");
    await cleanup();
    mock.restore();
    await open("/account/billing", SCENARIOS.personalCatalog(), t.catalog.person.title);
    expectNoSeat("the personal catalog");
  });
});

// ---- the screens were reached ----------------------------------------------------------------------------------------

describe("the states were reached", () => {
  // The sentences the states above exist to show. A guard that never drew them would say nothing about them.
  const WITNESSES: Array<[string, string]> = [
    ["the roster", t.seats.title],
    ["an available license", t.seats.freeSeat],
    ["available licenses folded", t.seats.freeSeats(7)],
    ["a full license", t.seats.allInUse(10)],
    ["a license of one, held", t.seats.allInUse(1)],
    ["the roster's search", t.seats.searchPlaceholder],
    ["Assign licenses on a card", t.seats.assignSeats],
    ["nobody holds one", t.seats.nobodyYet],
    ["the people picker", t.picker.title],
    ["a person who has one", t.picker.hasASeat],
    ["a person who hasn't signed in", t.picker.afterFirstSignIn],
    ["the buy step", t.buy.seats],
    ["one fewer", t.buy.fewer],
    ["a failed payment's day", "Licenses stop working on"],
    ["a day that has passed", "Licenses stopped working on"],
    ["a failed payment with no day", t.notice.pastDue({ date: null, stopped: false }).body!],
    ["the over-assigned notice", t.notice.over({ used: 5, quantity: 3, canAddSeats: true }).title],
    ["a member's own card", t.facts.own.seat],
    ["a member's badge", t.status.youHaveASeat],
    ["the catalog's held row", t.catalog.youHaveSeats(5)],
    ["the workspace's header button", t.page.buyLicenses],
    ["the personal header button", t.page.buyALicense],
    ["the workspace's catalog dialog", t.catalog.dialog.title],
    ["the personal catalog dialog", t.catalog.dialog.personTitle],
    ["the member panel", t.memberPanel.intro("Luis Ortega")],
    ["a pending member", t.memberPanel.afterFirstSignIn("grace@example.com")],
    ["the panel's over-assigned line", t.memberPanel.overAssigned(1)],
    ["Assign licenses", t.assign.title],
    ["test mode", t.testMode.lead],
    ["the test-mode notice's ×", t.testMode.hide],
    ["the page without the notice", "Buy licenses for your members"],
    ["setting up", t.purchase.settingUpSeats({ seats: 10, product: "Fleet" })],
    ["ready", t.purchase.readyTitle({ seats: 10, product: "Fleet" })],
    ["a person's purchase", t.purchase.personReadyTitle("Mentra Call Unlimited")],
    ["the total", "3 products"],
  ];

  test.each(WITNESSES)("%s", (_what, sentence) => {
    expect([...seen].some((words) => words.includes(sentence))).toBe(true);
  });

  test("and many sentences were read, not a few", () => {
    expect(seen.size).toBeGreaterThan(300);
    // The people in the fixtures are real names; none of the words is theirs.
    expect(PEOPLE.length).toBeGreaterThan(10);
  });
});
