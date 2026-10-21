import { afterAll, afterEach, beforeAll, describe, expect, jest, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import type { BillingStatus, CatalogEntry, LicenseBilling } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "./api";
import { WorkspaceApiError } from "./errors";
import { BillingRefusedError, type BillingApi } from "./billing-api";
import { workspaceScope } from "./billing-scope";
import { formatMoney } from "./lib/billing-format";
import { LicenseCard, type LicenseCardProps } from "./components/licenses/license-card";
import { WorkspaceLicensesPanel } from "./components/licenses-panel";
import {
  LicensesSummary,
  LicensesUnavailable,
  PURCHASE_TIMEOUT_MS,
  PurchaseBanner,
  TestModeBanner,
} from "./components/licenses/banners";
import { PeoplePickerDialog } from "./components/licenses/people-picker";
import { joinLicenses, type JoinedLicense } from "./lib/license-join";
import { billingKeys, billingStatusQuery, licensesQuery, workspaceKeys } from "./queries";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor, perSeat, usd } from "./test-billing-fixtures";
import { cleanup, click, find, findAll, render, setupDom, teardownDom, typeInto } from "./test-dom";
import { detailFor, licenseFor, offlineApi, WORKSPACE_ID } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(async () => {
  jest.useRealTimers();
  await cleanup();
});

// ---- people, licenses and the rig every test stands on -------------------------------------------------------

const START = "2026-10-20T12:00:00.000Z";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const WS = WORKSPACE_ID;
const CALL = "mentra.call.unlimited";
const FLEET = "mentra.fleet";
const PAGE = "https://pay.example.test/session";

const person = (id: string, name: string | null, extra: Partial<MemberView> = {}): MemberView => ({
  membershipId: `wm_${id}`,
  mentraUserId: `u_${id}`,
  email: `${id}@acme.test`,
  name,
  role: "member",
  startedAt: START,
  pending: false,
  ...extra,
});
const DANA = person("dana", "Dana Reyes");
const PRIYA = person("priya", "Priya Natarajan");
const MARCUS = person("marcus", "Marcus Chen");
const SOFIA = person("sofia", "Sofia Alvarez");
const JAMAL = person("jamal", "Jamal Wright");
const HANNAH = person("hannah", "Hannah Kim");
const TOM = person("tom", "Tom Becker");
const NOAH = person("noah", "Noah Fischer");
const INES = person("ines", "Ines Moreau");
const OMAR = person("omar", "Omar Haddad");
const KEVIN = person("kevin.osei", null);
const LUIS = person("luis", "Luis Ortega");
const AMARA = person("amara", "Amara Okafor");
const GRACE = person("grace", "Grace Oduya", { pending: true, mentraUserId: null });
const PEOPLE = [DANA, PRIYA, MARCUS, SOFIA, JAMAL, HANNAH, TOM, NOAH, INES, OMAR, KEVIN, LUIS, AMARA, GRACE];
const TEN = [DANA, PRIYA, MARCUS, SOFIA, JAMAL, HANNAH, TOM, NOAH, INES, OMAR];

const seatsOf = (people: readonly MemberView[]) =>
  people.map((member) => ({ membershipId: member.membershipId, mentraUserId: member.mentraUserId ?? "", assignedAt: START }));

/** A Core license of `quantity` seats held by `holders`. */
function coreLicense(quantity: number, holders: readonly MemberView[], extra: Partial<LicenseView> = {}): LicenseView {
  return licenseFor({ licenseId: "lic_call", quantity, seatsUsed: holders.length, seats: seatsOf(holders), ...extra });
}

/** Core's license (or none) joined with billing's entry (or none), as the page would have it. */
function joined(license: LicenseView | null, billing: Partial<LicenseBilling> | null, entry: CatalogEntry = catalogEntryFor()): JoinedLicense {
  const [card] = joinLicenses({
    licenses: license ? [license] : [],
    billing: billing ? [licenseBillingFor(billing)] : [],
    catalog: [entry, fleetEntryFor()],
  });
  return card!;
}

const EMPTY_STATUS: BillingStatus = { locale: "en-US", licenses: [], total: null, actions: [], testMode: null, purchase: null };

/** Billing, the workspace API and the host's two ways out, all recording what happens to them and in what order. */
function rig(options: { blocked?: boolean; session?: (request: Record<string, unknown>) => Promise<{ url: string }> } = {}) {
  const events: string[] = [];
  const tab = {
    go: mock((url: string) => void events.push(`go:${url}`)),
    close: mock(() => void events.push("close")),
  };
  const leave = mock((url: string) => void events.push(`leave:${url}`));
  const openTab = mock(() => {
    events.push("openTab");
    return options.blocked ? null : tab;
  });
  const session = mock(async (_scope: unknown, request: Record<string, unknown>) => {
    events.push(`session:${String(request.action)}`);
    return options.session ? options.session(request) : { url: PAGE };
  });
  const status = mock(async () => EMPTY_STATUS);
  const billing = {
    base: "/api/portal/billing",
    locale: "en-US",
    session,
    status,
    catalog: mock(async () => {
      throw new Error("not used");
    }),
    purchase: mock(async () => {
      throw new Error("not used");
    }),
  } as unknown as BillingApi;
  const listLicenses = mock(async () => [] as LicenseView[]);
  const releaseSeat = mock(async () => undefined);
  const assignSeats = mock(async (_workspaceId: string, _pairs: Array<{ licenseId: string; membershipId: string }>) => [] as LicenseView[]);
  const api: WorkspaceApi = { ...offlineApi().api, listLicenses, releaseSeat, assignSeats } as WorkspaceApi;
  return { events, tab, leave, openTab, session, status, billing, api, listLicenses, releaseSeat, assignSeats, navigateOut: { leave, openTab } };
}
type Rig = ReturnType<typeof rig>;

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

async function mount(ui: ReactElement, client = newClient()): Promise<QueryClient> {
  await render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return client;
}

function cardProps(r: Rig, card: JoinedLicense, over: Partial<LicenseCardProps> = {}): LicenseCardProps {
  return {
    card,
    view: "workspace",
    scope: workspaceScope(WS),
    billing: r.billing,
    navigateOut: r.navigateOut,
    locale: "en-US",
    workspaceName: "Acme Field Services",
    api: r.api,
    members: PEOPLE,
    canAssign: true,
    now: NOW,
    ...over,
  };
}

async function mountCard(r: Rig, card: JoinedLicense, over: Partial<LicenseCardProps> = {}, client = newClient()) {
  await mount(<LicenseCard {...cardProps(r, card, over)} />, client);
  return client;
}

const nameOf = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
const text = (within: ParentNode = document.body) => (within.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (within: ParentNode = document) => findAll("button", within).map(nameOf);
const buttonNamed = (name: string, within: ParentNode = document) => {
  const found = findAll<HTMLButtonElement>("button", within).find((button) => nameOf(button) === name);
  if (!found) throw new Error(`no button named "${name}" among ${JSON.stringify(buttons(within))}`);
  return found;
};
const hasButton = (name: string, within: ParentNode = document) => buttons(within).includes(name);
const press = (name: string, within: ParentNode = document) => click(buttonNamed(name, within));
const theCard = () => find('[data-slot="card"]');
const menuTrigger = () => find<HTMLButtonElement>('[aria-haspopup="menu"]');
const menuItems = () => findAll('[role="menuitem"]').map((item) => (item.textContent ?? "").trim());
/** Lets what is pending settle, including TanStack Query's notifications, which it batches onto a timer. */
const flush = async () => {
  // Twice: a refetch that a notification started needs its own turn to land.
  for (let turn = 0; turn < 2; turn++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
};
/** The roster's rows: the list of holders and free seats (not the feature chips, which are a list too). */
const rosterRows = (within: ParentNode = theCard()) => findAll("ul.divide-y > li", within);

async function openMenu() {
  await click(menuTrigger());
}

// ---- the card ------------------------------------------------------------------------------------------------

describe("an active license", () => {
  test("shows its badge, seats, renewal and cost", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    const card = text(theCard());
    for (const expected of ["Mentra Call Unlimited", "Unlimited Teams calls in Mentra Call.", "Active", "3 of 5 in use", "2 free", "Renews", "Nov 20, 2026", "Every month", "$145 a month", "5 × $29 · before tax"]) {
      expect(card).toContain(expected);
    }
    // The facts are one description list: label, value and foot in groups.
    expect(findAll("dl > div > dt", theCard()).map((term) => term.textContent)).toEqual(["Seats", "Renews", "Cost"]);
  });

  test("feature chips show only for a product with more than one feature", async () => {
    await mountCard(rig(), joined(coreLicense(5, []), {}));
    expect(findAll("ul[aria-label='Includes']")).toHaveLength(0);
    await cleanup();
    const fleet = joinLicenses({
      licenses: [licenseFor({ licenseId: "lic_fleet", product: FLEET, quantity: 10, seatsUsed: 0, seats: [] })],
      billing: [licenseBillingFor({ licenseId: "lic_fleet", product: FLEET })],
      catalog: [fleetEntryFor()],
    })[0]!;
    await mountCard(rig(), fleet);
    expect(findAll("li", find("ul[aria-label='Includes']")).map((item) => item.textContent)).toEqual([
      "Managed phones and glasses",
      "Miniapp assignments",
      "Usage reports",
    ]);
  });

  test("a later scheduled end shows 'Renews' with 'Until <date>'", async () => {
    await mountCard(rig(), joined(coreLicense(5, []), { endsAt: "2026-12-01T12:00:00.000Z" }));
    const card = text(theCard());
    expect(card).toContain("Active");
    expect(card).toContain("Renews");
    expect(card).toContain("Nov 20, 2026");
    expect(card).toContain("Until Dec 1, 2026");
    expect(card).not.toContain("Every month");
  });

  test("it is a group named for the product, with a heading, and its icon is decorative", async () => {
    await mountCard(rig(), joined(coreLicense(5, []), {}));
    expect(theCard().getAttribute("role")).toBe("group");
    expect(theCard().getAttribute("aria-label")).toBe("Mentra Call Unlimited");
    expect(find("h2", theCard()).textContent).toBe("Mentra Call Unlimited");
    expect(find<HTMLImageElement>("img", theCard()).getAttribute("alt")).toBe("");
    expect(theCard().getAttribute("data-ring")).toBeNull();
  });

  test("a license just bought is ringed in green", async () => {
    await mountCard(rig(), joined(coreLicense(5, []), {}), { highlight: true });
    expect(theCard().getAttribute("data-ring")).toBe("highlight");
    expect(theCard().className).toContain("ring-info");
  });
});

describe("an ending license", () => {
  const ending = (extra: Partial<LicenseBilling> = {}) =>
    joined(coreLicense(5, [HANNAH, TOM, NOAH]), {
      status: "ending",
      fallbackStatusLabel: "Ending",
      renewsAt: undefined,
      endsAt: "2026-11-20T12:00:00.000Z",
      actions: [{ kind: "renew", fallbackLabel: "Renew" }],
      ...extra,
    });

  test("says when it ends and that it doesn't renew, with no more charges", async () => {
    await mountCard(rig(), ending());
    const card = text(theCard());
    expect(card).toContain("Ends Nov 20");
    expect(card).toContain("Ends");
    expect(card).toContain("Nov 20, 2026");
    expect(card).toContain("Doesn't renew");
    expect(card).toContain("No more charges");
    expect(card).not.toContain("Renews");
    // Grey: the customer chose it.
    expect(find("span.bg-surface", theCard()).textContent).toBe("Ends Nov 20");
  });

  test("Renew is in the menu, and there is no Add seats anywhere", async () => {
    await mountCard(rig(), ending());
    expect(hasButton("Renew")).toBe(false);
    await openMenu();
    expect(menuItems()).toEqual(["RenewOpens a secure billing page"]);
    expect(text(theCard())).not.toContain("Add seats");
  });

  test("a full ending license asks to unassign, and offers no way to add seats", async () => {
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH]), { status: "ending", fallbackStatusLabel: "Ending", endsAt: "2026-11-20T12:00:00.000Z", actions: [{ kind: "renew", fallbackLabel: "Renew" }] }));
    const card = text(theCard());
    expect(card).toContain("All 3 seats are in use.");
    expect(card).toContain("Unassign someone to free their seat.");
    expect(card).not.toContain("Add seats");
  });
});

describe("a payment that failed", () => {
  const failed = (extra: Partial<LicenseBilling> = {}, license = coreLicense(5, [HANNAH, TOM, NOAH])) =>
    joined(license, {
      status: "past_due",
      fallbackStatusLabel: "Past due",
      renewsAt: "2026-11-02T12:00:00.000Z",
      seatsStopAt: "2026-11-23T12:00:00.000Z",
      actions: [
        { kind: "update_payment", fallbackLabel: "Update payment method" },
        { kind: "complete_payment", fallbackLabel: "Complete payment" },
        { kind: "cancel", fallbackLabel: "Cancel" },
      ],
      ...extra,
    });

  test("is ringed in amber with the badge, the notice and the unpaid renewal", async () => {
    // The renewal came (Oct 30) and was not paid; the clock is Nov 1.
    await mountCard(rig(), failed({ renewsAt: "2026-10-30T12:00:00.000Z" }));
    expect(theCard().getAttribute("data-ring")).toBe("warn");
    expect(theCard().className).toContain("ring-error");
    const card = text(theCard());
    expect(card).toContain("Payment failed");
    expect(card).toContain("Seats stop on Nov 23, 2026 unless payment goes through.");
    expect(card).toContain("Update the payment method to keep them.");
    expect(card).toContain("Renewal");
    expect(card).toContain("Oct 30, 2026");
    expect(card).toContain("Not paid");
    expect(card).not.toContain("Renews");
  });

  test("says Not paid for a renewal due this very moment", async () => {
    await mountCard(rig(), failed({ renewsAt: new Date(NOW).toISOString() }));
    const card = text(theCard());
    expect(card).toContain("Renewal");
    expect(card).toContain("Nov 1, 2026");
    expect(card).toContain("Not paid");
  });

  test("shows the plain renewal date while the renewal is still to come: a mid-period charge failed, the period was paid", async () => {
    // Nov 2 is after the clock (Nov 1): billing's past_due is a charge for added seats, not this period's.
    await mountCard(rig(), failed({ renewsAt: "2026-11-02T12:00:00.000Z" }));
    const card = text(theCard());
    expect(card).toContain("Renews");
    expect(card).toContain("Nov 2, 2026");
    expect(card).toContain("Every month");
    expect(card).not.toContain("Not paid");
    expect(card).not.toContain("Renewal");
    // The failure is still the card's state: the badge, the ring, the notice and its deadline.
    expect(theCard().getAttribute("data-ring")).toBe("warn");
    expect(card).toContain("Payment failed");
    expect(card).toContain("Seats stop on Nov 23, 2026 unless payment goes through.");
    expect(buttons(find(".rounded-notice"))).toEqual(["Update payment method", "Complete payment"]);
  });

  test("a renewal still to come keeps a scheduled end as it does for an active license", async () => {
    await mountCard(rig(), failed({ renewsAt: "2026-11-02T12:00:00.000Z", endsAt: "2026-12-02T12:00:00.000Z" }));
    const card = text(theCard());
    expect(card).toContain("Renews");
    expect(card).toContain("Until Dec 2, 2026");
    expect(card).not.toContain("Not paid");
  });

  test("the same license says Not paid once the clock passes the renewal", async () => {
    const license = failed({ renewsAt: "2026-11-02T12:00:00.000Z" });
    await mountCard(rig(), license, { now: Date.parse("2026-11-02T11:59:59.000Z") });
    expect(text(theCard())).not.toContain("Not paid");
    await cleanup();
    await mountCard(rig(), license, { now: Date.parse("2026-11-02T12:00:01.000Z") });
    expect(text(theCard())).toContain("Not paid");
    expect(text(theCard())).toContain("Renewal");
  });

  test("a failed payment with no renewal date shows neither", async () => {
    await mountCard(rig(), failed({ renewsAt: undefined }));
    const card = text(theCard());
    expect(card).not.toContain("Not paid");
    expect(card).toContain("Payment failed");
  });

  test("Update payment method is the primary button, with Complete payment beside it", async () => {
    await mountCard(rig(), failed());
    const notice = find(".rounded-notice");
    expect(buttons(notice)).toEqual(["Update payment method", "Complete payment"]);
    expect(buttonNamed("Update payment method", notice).className).toContain("bg-primary");
    expect(buttonNamed("Complete payment", notice).className).not.toContain("bg-primary");
    // Every ↗ button is marked, and the payment actions are not repeated in the menu.
    expect(findAll("[data-hosted-page]", notice)).toHaveLength(2);
    await openMenu();
    expect(menuItems()).toEqual(["CancelOpens a secure billing page"]);
  });

  test("with only Complete payment listed, that is the primary button", async () => {
    await mountCard(rig(), failed({ actions: [{ kind: "complete_payment", fallbackLabel: "Complete payment" }] }));
    expect(buttons(find(".rounded-notice"))).toEqual(["Complete payment"]);
    expect(buttonNamed("Complete payment").className).toContain("bg-primary");
  });

  test("after the date it says the seats stopped and that they come back", async () => {
    await mountCard(rig(), failed(), { now: Date.parse("2026-12-01T12:00:00.000Z") });
    const card = text(theCard());
    expect(card).toContain("Seats stopped on Nov 23, 2026. They come back once payment goes through.");
    expect(card).not.toContain("unless payment goes through");
  });

  test("with no date from billing it names none", async () => {
    await mountCard(rig(), failed({ seatsStopAt: undefined }));
    const card = text(theCard());
    expect(card).toContain("The last payment didn't go through.");
    expect(card).toContain("Update the payment method to keep the seats.");
    expect(card).not.toContain("Nov 23");
  });

  test("an update that returns navigates this tab", async () => {
    const r = rig();
    await mountCard(r, failed());
    await press("Update payment method");
    await flush();
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "update_payment", licenseId: "lic_call" });
    expect(r.leave).toHaveBeenCalledWith(PAGE);
    expect(r.openTab).not.toHaveBeenCalled();
  });
});

describe("a hosted page that doesn't return", () => {
  const invoice = () =>
    joined(coreLicense(5, [HANNAH]), {
      status: "past_due",
      fallbackStatusLabel: "Past due",
      renewsAt: "2026-11-02T12:00:00.000Z",
      seatsStopAt: "2026-11-23T12:00:00.000Z",
      actions: [
        { kind: "update_payment", fallbackLabel: "Update payment method" },
        { kind: "complete_payment", fallbackLabel: "Complete payment", returns: false },
      ],
    });

  test("opens a blank tab in the click, asks for the session, then sends that tab there", async () => {
    let answer!: (value: { url: string }) => void;
    const r = rig({ session: () => new Promise((resolve) => (answer = resolve)) });
    await mountCard(r, invoice());
    await press("Complete payment");
    // The tab is open and the session asked for; nothing has been sent anywhere yet.
    expect(r.events).toEqual(["openTab", "session:complete_payment"]);
    expect(buttonNamed("Complete payment").getAttribute("aria-busy")).toBe("true");
    expect(buttonNamed("Complete payment").hasAttribute("disabled")).toBe(true);
    await act(async () => answer({ url: "https://invoice.example.test/i/1" }));
    expect(r.events).toEqual(["openTab", "session:complete_payment", "go:https://invoice.example.test/i/1"]);
    expect(r.leave).not.toHaveBeenCalled();
    expect(r.tab.close).not.toHaveBeenCalled();
    expect(buttonNamed("Complete payment").hasAttribute("disabled")).toBe(false);
  });

  test("says it opens in a new tab, to a screen reader", async () => {
    await mountCard(rig(), invoice());
    const hint = find(`#${buttonNamed("Complete payment").getAttribute("aria-describedby")}`);
    expect(hint.textContent).toBe("Opens a secure billing page in a new tab");
    const other = find(`#${buttonNamed("Update payment method").getAttribute("aria-describedby")}`);
    expect(other.textContent).toBe("Opens a secure billing page");
  });

  test("a session that fails closes the tab and shows the refusal", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("license_not_found", {}, 404);
      },
    });
    await mountCard(r, invoice());
    await press("Complete payment");
    await flush();
    expect(r.events).toEqual(["openTab", "session:complete_payment", "close"]);
    expect(r.tab.go).not.toHaveBeenCalled();
    expect(find('[role="alert"]').textContent).toBe("That license no longer exists. Reload the page.");
    // Another try is possible.
    expect(buttonNamed("Complete payment").hasAttribute("disabled")).toBe(false);
  });

  test("a failure that isn't a refusal says billing couldn't do it", async () => {
    const r = rig({
      session: async () => {
        throw new Error("network");
      },
    });
    await mountCard(r, invoice());
    await press("Update payment method");
    await flush();
    expect(find('[role="alert"]').textContent).toBe("Billing couldn't do that. Try again.");
  });

  test("a blocked tab gives the page back as a link for a second click", async () => {
    const r = rig({ blocked: true });
    await mountCard(r, invoice());
    await press("Complete payment");
    await flush();
    expect(r.tab.go).not.toHaveBeenCalled();
    expect(r.leave).not.toHaveBeenCalled();
    const link = find<HTMLAnchorElement>("a[data-hosted-page]");
    expect(link.textContent).toBe("Open the payment page");
    expect(link.getAttribute("href")).toBe(PAGE);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(find(`#${link.getAttribute("aria-describedby")}`).textContent).toBe("Opens a secure billing page in a new tab");
  });

  test("the licenses and billing's status are read again when the window regains focus", async () => {
    const r = rig();
    const scope = workspaceScope(WS);
    function Watch() {
      useQuery(billingStatusQuery(r.billing, scope));
      useQuery(licensesQuery(r.api, WS));
      return null;
    }
    await mount(
      <>
        <Watch />
        <LicenseCard {...cardProps(r, invoice())} />
      </>,
    );
    await flush();
    expect(r.status).toHaveBeenCalledTimes(1);
    expect(r.listLicenses).toHaveBeenCalledTimes(1);
    // Coming back before anything was started reads nothing.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(r.status).toHaveBeenCalledTimes(1);
    await press("Complete payment");
    await flush();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(r.status).toHaveBeenCalledTimes(2);
    expect(r.listLicenses).toHaveBeenCalledTimes(2);
  });

  test("an action that returns doesn't wait for the window's focus", async () => {
    const r = rig();
    const scope = workspaceScope(WS);
    function Watch() {
      useQuery(billingStatusQuery(r.billing, scope));
      return null;
    }
    await mount(
      <>
        <Watch />
        <LicenseCard {...cardProps(r, invoice())} />
      </>,
    );
    await flush();
    await press("Update payment method");
    await flush();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(r.status).toHaveBeenCalledTimes(1);
  });

  test("a card that is gone before its session answers sends the tab on and registers nothing", async () => {
    let answer!: (value: { url: string }) => void;
    const r = rig({ session: () => new Promise((resolve) => (answer = resolve)) });
    const client = newClient();
    const key = billingKeys.status(r.billing, workspaceScope(WS));
    client.setQueryData(key, EMPTY_STATUS);
    await mountCard(r, invoice(), {}, client);
    await press("Complete payment");
    await cleanup();
    await act(async () => answer({ url: "https://invoice.example.test/i/1" }));
    expect(r.tab.go).toHaveBeenCalledWith("https://invoice.example.test/i/1");
    // Nothing is left listening: coming back to the window reads nothing.
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await flush();
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });

  test("a card that is gone before a session that returns answers doesn't send this tab anywhere", async () => {
    let answer!: (value: { url: string }) => void;
    const r = rig({ session: () => new Promise((resolve) => (answer = resolve)) });
    await mountCard(r, invoice());
    await press("Update payment method");
    expect(r.events).toEqual(["session:update_payment"]);
    await cleanup();
    await act(async () => answer({ url: PAGE }));
    expect(r.leave).not.toHaveBeenCalled();
    expect(r.openTab).not.toHaveBeenCalled();
  });

  test("the tab is opened by the click itself, not after anything is awaited", async () => {
    const r = rig({ session: () => new Promise(() => {}) });
    await mountCard(r, invoice());
    const button = buttonNamed("Complete payment");
    let openedInTheClick = -1;
    // Only the synchronous part of the click runs inside this callback.
    act(() => {
      button.click();
      openedInTheClick = r.openTab.mock.calls.length;
    });
    expect(openedInTheClick).toBe(1);
    expect(r.events).toEqual(["openTab", "session:complete_payment"]);
  });

  test("so is the tab for a menu item that doesn't return", async () => {
    let answer!: (value: { url: string }) => void;
    const r = rig({ session: () => new Promise((resolve) => (answer = resolve)) });
    await mountCard(r, joined(coreLicense(5, [HANNAH]), { actions: [{ kind: "view_invoice", fallbackLabel: "View invoice", returns: false }] }));
    await openMenu();
    expect(menuItems()).toEqual(["View invoiceOpens a secure billing page in a new tab"]);
    const item = find('[role="menuitem"]');
    let openedInTheClick = -1;
    act(() => {
      item.click();
      openedInTheClick = r.openTab.mock.calls.length;
    });
    expect(openedInTheClick).toBe(1);
    expect(r.events).toEqual(["openTab", "session:view_invoice"]);
    await act(async () => answer({ url: "https://invoice.example.test/i/2" }));
    expect(r.events).toEqual(["openTab", "session:view_invoice", "go:https://invoice.example.test/i/2"]);
    expect(r.leave).not.toHaveBeenCalled();
  });

  test("a failed session from the menu closes the tab and says why on the card", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("unknown_action", {}, 400);
      },
    });
    await mountCard(r, joined(coreLicense(5, [HANNAH]), { actions: [{ kind: "view_invoice", fallbackLabel: "View invoice", returns: false }] }));
    await openMenu();
    await click(find('[role="menuitem"]'));
    await flush();
    expect(r.events).toEqual(["openTab", "session:view_invoice", "close"]);
    expect(find('[role="alert"]', theCard()).textContent).toBe("That isn't available for this license any more. Reload the page and try again.");
  });
});

describe("the … menu while a session is requested", () => {
  const deferred = () => {
    let answer!: (value: { url: string }) => void;
    const session = () => new Promise<{ url: string }>((resolve) => (answer = resolve));
    return { session, answer: (url = PAGE) => act(async () => answer({ url })) };
  };

  test("shows a spinner on its trigger, which can't be pressed, until billing answers", async () => {
    const d = deferred();
    await mountCard(rig({ session: d.session }), joined(coreLicense(5, [HANNAH]), { actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] }));
    expect(findAll(".animate-spin", menuTrigger())).toHaveLength(0);
    await openMenu();
    await click(find('[role="menuitem"]'));
    expect(findAll(".animate-spin", menuTrigger())).toHaveLength(1);
    expect(menuTrigger().hasAttribute("disabled")).toBe(true);
    await d.answer();
    expect(findAll(".animate-spin", menuTrigger())).toHaveLength(0);
    expect(menuTrigger().hasAttribute("disabled")).toBe(false);
  });

  test("shows none for a button elsewhere on the card, though the menu waits too", async () => {
    const d = deferred();
    await mountCard(
      rig({ session: d.session }),
      joined(coreLicense(5, [HANNAH]), {
        status: "past_due",
        fallbackStatusLabel: "x",
        actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }, { kind: "cancel", fallbackLabel: "Cancel" }],
      }),
    );
    await press("Update payment method");
    expect(findAll(".animate-spin", menuTrigger())).toHaveLength(0);
    expect(menuTrigger().hasAttribute("disabled")).toBe(true);
    await d.answer();
  });
});

describe("the portal's locale", () => {
  test("reaches a card's dates, the roster's 'Since' and the cost", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), {}), { locale: "de-DE" });
    const card = text(theCard());
    expect(card).toContain("20.11.2026");
    expect(card).not.toContain("Nov 20, 2026");
    expect(card).toContain("Since 20.10.2026");
    expect(card).not.toContain("Oct 20, 2026");
    // German puts a no-break space before the currency sign; the card's text has plain spaces.
    const euros = (minor: number) => formatMoney(usd(minor), "de-DE").replace(/\s+/g, " ");
    expect(card).toContain(`${euros(14500)} a month`);
    expect(card).toContain(`5 × ${euros(2900)} · before tax`);
    expect(card).not.toContain("$145");
  });

  test("and the badge's short date", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { status: "ending", fallbackStatusLabel: "Ending", endsAt: "2026-11-20T12:00:00.000Z", actions: [] }), { locale: "en-GB" });
    expect(text(theCard())).toContain("Ends 20 Nov");
    expect(text(theCard())).toContain("20 Nov 2026");
  });

  test("a member's 'Since' follows it too", async () => {
    const own = coreLicense(5, [], { seats: [{ membershipId: "wm_me", mentraUserId: "u_me", assignedAt: "2026-10-20T12:00:00.000Z" }], seatsUsed: 1 });
    await mountCard(rig(), joined(own, null), { view: "member", api: undefined, locale: "de-DE" });
    expect(text(theCard())).toContain("Since 20.10.2026");
  });
});

describe("only the actions billing lists", () => {
  test("a license whose billing lists no add_seats has no Add seats in its strip, roster or over notice, and words its sentences without it", async () => {
    const noAdd = { actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] };
    // Full, in the roster.
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH]), noAdd));
    expect(text(theCard())).toContain("Unassign someone to free their seat.");
    expect(text(theCard())).not.toContain("Add seats");
    await cleanup();
    // Full, in the strip.
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH]), noAdd), { folded: true });
    expect(hasButton("Add seats")).toBe(false);
    expect(hasButton("Assign seats")).toBe(false);
    await cleanup();
    // Over.
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH, DANA, PRIYA]), noAdd));
    const over = text(find(".rounded-notice"));
    expect(over).toContain("Unassign 2 of them. No one else can get a seat until then.");
    expect(over).not.toContain("add 2 seats");
    expect(text(theCard())).not.toContain("Add 2 seats");
    expect(text(theCard())).not.toContain("Add seats");
  });

  test("the picker says '3 of 4 fit: remove one.' and has no Add seats", async () => {
    const r = rig();
    await mount(<PeoplePickerDialog open onClose={() => {}} api={r.api} workspaceId={WS} license={coreLicense(5, [DANA, PRIYA])} productName="Mentra Call Unlimited" members={PEOPLE} addSeats={null} />);
    for (const member of [HANNAH, TOM, NOAH, INES]) await click(checkboxFor(member.name!));
    expect(text()).toContain("3 of 4 fit: remove one.");
    expect(text()).not.toContain("or add seats");
    expect(hasButton("Add seats")).toBe(false);
  });

  test("an active license that lists add_seats has it with its seats", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    expect(hasButton("Add seats", theCard())).toBe(true);
  });
});

describe("what a card never shows", () => {
  test("a seatsStopAt on a license that hasn't failed is shown nowhere", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { seatsStopAt: "2026-11-23T12:00:00.000Z" }));
    const card = text(theCard());
    expect(card).toContain("Active");
    expect(card).not.toContain("Nov 23");
    expect(card).not.toContain("Seats stop");
  });

  test("no state says 'Paid through'", async () => {
    const states: Array<Partial<LicenseBilling>> = [
      { status: "active" },
      { status: "active", endsAt: "2026-12-01T12:00:00.000Z" },
      { status: "ending", endsAt: "2026-11-20T12:00:00.000Z" },
      { status: "past_due", seatsStopAt: "2026-11-23T12:00:00.000Z" },
      { status: "incomplete" },
      { status: "processing" },
      { status: "paused", fallbackStatusLabel: "Paused" },
    ];
    for (const billing of states) {
      await mountCard(rig(), joined(coreLicense(5, [HANNAH]), billing));
      expect(text(theCard()), JSON.stringify(billing)).not.toMatch(/paid through/i);
      await cleanup();
    }
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), null), { view: "workspace" });
    expect(text(theCard())).not.toMatch(/paid through/i);
  });
});

describe("more seats assigned than the license covers", () => {
  const over = () => joined(coreLicense(3, [HANNAH, TOM, NOAH, DANA, PRIYA]), { actions: [{ kind: "add_seats", fallbackLabel: "Add seats" }, { kind: "cancel", fallbackLabel: "Cancel" }] });

  test("is an amber '2 over' with the notice and the seats' amber foot", async () => {
    await mountCard(rig(), over());
    const card = text(theCard());
    expect(card).toContain("2 over");
    expect(card).toContain("5 people have a seat, but the license covers 3.");
    expect(card).toContain("Unassign 2 of them, or add 2 seats. No one else can get a seat until then.");
    expect(card).toContain("5 assigned");
    expect(card).toContain("2 more than the 3 covered");
    expect(find("span.bg-error", theCard()).textContent).toBe("2 over");
  });

  test("turns assigning off: nobody can be assigned, but a seat can still be unassigned", async () => {
    await mountCard(rig(), over());
    expect(hasButton("Assign seats")).toBe(false);
    expect(hasButton("Assign")).toBe(false);
    expect(text(theCard())).not.toContain("Free seat");
    expect(text(theCard())).not.toContain("All 3 seats are in use");
    expect(buttons().filter((name) => name.startsWith("Unassign "))).toHaveLength(5);
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  test("'Add 2 seats' asks for the session with that many seats, and leaves", async () => {
    const r = rig();
    await mountCard(r, over());
    await press("Add 2 seats", find(".rounded-notice"));
    await flush();
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "add_seats", licenseId: "lic_call", seats: 2 });
    expect(r.leave).toHaveBeenCalledWith(PAGE);
  });

  test("it is still amber when billing says payment failed, with both notices", async () => {
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH, DANA]), { status: "past_due", fallbackStatusLabel: "x", seatsStopAt: "2026-11-23T12:00:00.000Z", actions: [] }));
    const card = text(theCard());
    expect(card).toContain("Payment failed");
    expect(card).not.toContain("1 over");
    expect(card).toContain("Seats stop on Nov 23, 2026");
    expect(card).toContain("4 people have a seat, but the license covers 3.");
  });
});

describe("values the card doesn't know", () => {
  test("an unknown status is a grey badge with billing's label and no notice", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { status: "paused", fallbackStatusLabel: "Paused for now" }));
    expect(find("span.bg-surface", theCard()).textContent).toBe("Paused for now");
    expect(findAll(".rounded-notice")).toHaveLength(0);
    expect(theCard().getAttribute("data-ring")).toBeNull();
  });

  test("an unknown action is a menu item under billing's label, which asks for a session of that kind and leaves", async () => {
    const r = rig();
    await mountCard(r, joined(coreLicense(5, [HANNAH]), { actions: [{ kind: "pause_billing", fallbackLabel: "Pause billing" }] }));
    await openMenu();
    expect(menuItems()).toEqual(["Pause billingOpens a secure billing page"]);
    await click(find('[role="menuitem"]'));
    await flush();
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "pause_billing", licenseId: "lic_call" });
    expect(r.leave).toHaveBeenCalledWith(PAGE);
  });

  test("a known kind with no place on the card (a payment action on an active license) is in the menu, not lost", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }, { kind: "change_seats", fallbackLabel: "Change seats" }] }));
    await openMenu();
    expect(menuItems()).toEqual(["Update payment methodOpens a secure billing page", "Change seatsOpens a secure billing page"]);
  });

  test("an unknown price scheme shows billing's label and adds nothing up", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { price: { scheme: "tiered", fallbackLabel: "From $10 per seat a month" }, total: null }));
    const card = text(theCard());
    expect(card).toContain("From $10 per seat a month");
    expect(card).not.toContain("×");
    expect(card).not.toContain("$145");
  });

  test("an unknown tax value adds no words", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), { tax: "reverse_charge" }));
    expect(text(theCard())).toContain("5 × $29");
    expect(text(theCard())).not.toContain("5 × $29 ·");
  });

  test("a license whose product the catalog lacks is named by its key, with a letter tile", async () => {
    const [card] = joinLicenses({ licenses: [coreLicense(5, [HANNAH], { product: "acme.secret" })], billing: [licenseBillingFor({ product: "acme.secret" })], catalog: [] });
    await mountCard(rig(), card!);
    expect(find("h2", theCard()).textContent).toBe("acme.secret");
    expect(findAll("img", theCard())).toHaveLength(0);
    expect(find("[aria-hidden='true'].font-semibold", theCard()).textContent).toBe("A");
  });
});

describe("a license being set up, or whose first payment isn't finished", () => {
  test("a billing-only processing entry is a 'Setting up' card with placeholder facts", async () => {
    await mountCard(rig(), joined(null, { licenseId: "lic_new", status: "processing", fallbackStatusLabel: "Setting up", actions: [] }));
    const card = text(theCard());
    expect(card).toContain("Setting up");
    expect(findAll("dl > div > dt", theCard()).map((term) => term.textContent)).toEqual(["Seats", "Renews", "Cost"]);
    expect(findAll("dl span.bg-surface", theCard()).length).toBeGreaterThanOrEqual(6);
    expect(card).not.toContain("$");
    expect(card).not.toContain("in use");
    expect(findAll(".animate-spin", theCard())).toHaveLength(1);
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(0);
  });

  test("an incomplete one is amber, 'Payment incomplete', with its notice and Complete payment", async () => {
    const r = rig();
    await mountCard(r, joined(null, { licenseId: "lic_half", status: "incomplete", fallbackStatusLabel: "Incomplete", actions: [{ kind: "complete_payment", fallbackLabel: "Complete payment", returns: false }] }));
    const card = text(theCard());
    expect(card).toContain("Payment incomplete");
    expect(card).toContain("The first payment for Mentra Call Unlimited isn't finished.");
    expect(card).toContain("Finish it to start the license.");
    expect(find("span.bg-error", theCard()).textContent).toBe("Payment incomplete");
    expect(buttonNamed("Complete payment").className).toContain("bg-primary");
    // Seats and the term aren't known; the cost is billing's.
    expect(card).toContain("$145 a month");
    await press("Complete payment");
    await flush();
    expect(r.openTab).toHaveBeenCalledTimes(1);
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "complete_payment", licenseId: "lic_half" });
  });
});

describe("a viewer who isn't offered billing", () => {
  test("sees only the seats: no money, no dates, no actions", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), null));
    const card = text(theCard());
    expect(card).toContain("3 of 5 in use");
    expect(card).toContain("2 free");
    expect(card).not.toContain("$");
    expect(card).not.toContain("Renews");
    expect(card).not.toContain("Cost");
    expect(card).not.toContain("Active");
    expect(findAll("dl > div > dt", theCard()).map((term) => term.textContent)).toEqual(["Seats"]);
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(0);
    expect(hasButton("Add seats")).toBe(false);
    // The seats still work.
    expect(hasButton("Assign seats")).toBe(true);
  });

  test("still sees that the license is over-assigned", async () => {
    await mountCard(rig(), joined(coreLicense(3, [HANNAH, TOM, NOAH, DANA]), null));
    expect(text(theCard())).toContain("1 over");
    expect(text(theCard())).toContain("Unassign 1 of them. No one else can get a seat until then.");
  });
});

describe("a member's own view", () => {
  test("says they have a seat, since when, who gave it and where it works", async () => {
    const own = coreLicense(5, [], { seats: [{ membershipId: "wm_me", mentraUserId: "u_me", assignedAt: "2026-10-20T12:00:00.000Z" }], seatsUsed: 1 });
    await mountCard(rig(), joined(own, null), { view: "member", api: undefined, members: [] });
    const card = text(theCard());
    expect(card).toContain("You have a seat");
    expect(card).toContain("Your seat");
    expect(card).toContain("Since Oct 20, 2026");
    expect(card).toContain("Given by Acme Field Services");
    expect(card).toContain("Works in");
    expect(card).toContain("Mentra Call");
    expect(card).toContain("The next time you open it");
    // No totals, no money, no controls, nobody else.
    for (const absent of ["in use", "$", "Seat holders", "Assign", "Renews", "Cost"]) expect(card).not.toContain(absent);
    expect(buttons(theCard())).toEqual([]);
  });

  test("shows no billing even if some arrived with it", async () => {
    const own = coreLicense(5, [], { seats: [{ membershipId: "wm_me", mentraUserId: "u_me", assignedAt: START }], seatsUsed: 1 });
    await mountCard(rig(), joined(own, {}), { view: "member", api: undefined });
    expect(text(theCard())).not.toContain("$");
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(0);
  });

  test("a product that is for no miniapp has no 'Works in'", async () => {
    const own = coreLicense(5, [], { product: FLEET, seats: [{ membershipId: "wm_me", mentraUserId: "u_me", assignedAt: START }], seatsUsed: 1 });
    const [card] = joinLicenses({ licenses: [own], catalog: [fleetEntryFor()] });
    await mountCard(rig(), card!, { view: "member", api: undefined });
    expect(text(theCard())).toContain("Your seat");
    expect(text(theCard())).not.toContain("Works in");
  });
});

describe("a person's own license", () => {
  test("has its renewal and cost, per person, and no seats", async () => {
    const r = rig();
    const [card] = joinLicenses({ licenses: [], billing: [licenseBillingFor({ licenseId: "lic_me", quantity: 1, total: usd(2900), actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] })], catalog: [catalogEntryFor()] });
    await mountCard(r, card!, { view: "person", scope: { kind: "account" }, api: undefined });
    const text_ = text(theCard());
    expect(text_).toContain("Renews");
    expect(find("dl > div:nth-child(2) > dd:nth-of-type(1)", theCard()).textContent).toBe("$29 a month");
    expect(find("dl > div:nth-child(2) > dd:nth-of-type(2)", theCard()).textContent).toBe("before tax");
    expect(text_).not.toContain("1 ×");
    expect(text_).not.toContain("Seats");
    expect(text_).not.toContain("Seat holders");
    await openMenu();
    await click(find('[role="menuitem"]'));
    await flush();
    expect(r.session).toHaveBeenCalledWith({ kind: "account" }, { action: "cancel", licenseId: "lic_me" });
  });
});

describe("icons", () => {
  test("an icon outside billing's own path is a letter tile, and never reaches the page", async () => {
    const unsafe = catalogEntryFor({ icon: "https://evil.example/x.png" });
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), {}, unsafe));
    expect(findAll("img", theCard())).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("evil.example");
    expect(find("[aria-hidden='true'].font-semibold", theCard()).textContent).toBe("M");
  });

  test("billing's own icon is drawn", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), {}));
    expect(find<HTMLImageElement>("img", theCard()).getAttribute("src")).toBe("/api/portal/billing/ui/icons/mentra-call.png");
  });
});

describe("the order of the cards", () => {
  test("past due, incomplete and over come first, then the purchased license, then by name", async () => {
    const r = rig();
    const cards = joinLicenses({
      licenses: [
        coreLicense(5, [], { licenseId: "lic_b", product: "p.beta" }),
        coreLicense(5, [], { licenseId: "lic_a", product: "p.alpha" }),
        coreLicense(2, [HANNAH, TOM, NOAH], { licenseId: "lic_over", product: "p.over" }),
        coreLicense(5, [], { licenseId: "lic_bought", product: "p.bought" }),
        coreLicense(5, [], { licenseId: "lic_failed", product: "p.failed" }),
      ],
      billing: [
        licenseBillingFor({ licenseId: "lic_failed", product: "p.failed", status: "past_due", fallbackStatusLabel: "x" }),
        licenseBillingFor({ licenseId: "lic_half", product: "p.half", status: "incomplete", fallbackStatusLabel: "x" }),
      ],
      catalog: ["alpha", "beta", "over", "bought", "failed", "half"].map((name) => catalogEntryFor({ product: `p.${name}`, name: name[0]!.toUpperCase() + name.slice(1) })),
      purchase: { licenseId: "lic_bought" },
    });
    await mount(
      <>
        {cards.map((card) => (
          <LicenseCard key={card.licenseId} {...cardProps(r, card)} />
        ))}
      </>,
    );
    expect(findAll("h2").map((heading) => heading.textContent)).toEqual(["Failed", "Half", "Over", "Bought", "Alpha", "Beta"]);
  });
});

// ---- the seats -----------------------------------------------------------------------------------------------

describe("seats", () => {
  const fleet = (holders: readonly MemberView[], extra: Partial<LicenseBilling> = {}) =>
    joinLicenses({
      licenses: [licenseFor({ licenseId: "lic_fleet", product: FLEET, quantity: 10, seatsUsed: holders.length, seats: seatsOf(holders) })],
      billing: [licenseBillingFor({ licenseId: "lic_fleet", product: FLEET, quantity: 10, price: perSeat(1500), total: usd(15000), ...extra })],
      catalog: [fleetEntryFor()],
    })[0]!;

  test("the strip names the first holders and counts the rest, with four avatars and +6", async () => {
    await mountCard(rig(), fleet(TEN), { folded: true });
    expect(text(theCard())).toContain("Dana Reyes, Priya Natarajan and 8 others");
    const stack = find("[data-slot='avatar-stack']", theCard());
    expect(stack.getAttribute("aria-hidden")).toBe("true");
    expect(findAll("span", stack).map((span) => span.textContent).filter(Boolean)).toEqual(["DR", "PN", "MC", "SA", "+6"]);
    // All ten are taken: the next action is Add seats.
    expect(hasButton("Add seats")).toBe(true);
    expect(hasButton("Assign seats")).toBe(false);
  });

  test("an empty strip says nobody has a seat yet, and offers Assign seats", async () => {
    await mountCard(rig(), fleet([]), { folded: true });
    expect(text(theCard())).toContain("Nobody has a seat yet");
    expect(hasButton("Assign seats")).toBe(true);
    expect(findAll("[data-slot='avatar-stack']", theCard())).toHaveLength(0);
  });

  test("the strip's Seat holders opens the roster, and the roster's title closes it again", async () => {
    await mountCard(rig(), fleet(TEN), { folded: true });
    expect(rosterRows()).toHaveLength(0);
    const toggle = buttonNamed("Seat holders");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(rosterRows()).toHaveLength(11);
    expect(text(theCard())).toContain("All 10 seats are in use.");
    expect(text(theCard())).toContain("Add seats to give one to someone else, or unassign someone to free theirs.");
    const close = find("h3 button", theCard());
    expect(close.getAttribute("aria-expanded")).toBe("true");
    await click(close);
    expect(rosterRows()).toHaveLength(0);
    expect(text(theCard())).toContain("Dana Reyes, Priya Natarajan and 8 others");
  });

  test("a single license shows its roster open, with no strip", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    expect(find("h3", theCard()).textContent).toBe("Seat holders3");
    expect(findAll("h3 button", theCard())).toHaveLength(0);
    // Name over email, since when, and Unassign.
    const rows = rosterRows();
    expect(text(rows[0]!)).toContain("Hannah Kim");
    expect(text(rows[0]!)).toContain("hannah@acme.test");
    expect(text(rows[0]!)).toContain("Since Oct 20, 2026");
    expect(hasButton("Unassign Hannah Kim")).toBe(true);
  });

  test("a holder with no name is shown by their email alone", async () => {
    await mountCard(rig(), joined(coreLicense(5, [KEVIN]), {}));
    const row = rosterRows()[0]!;
    expect(text(row)).toContain("kevin.osei@acme.test");
    expect(findAll("span.block", row).map((span) => span.textContent)).toEqual(["kevin.osei@acme.test"]);
  });

  test("a holder who isn't in the member list is shown by their user id", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH]), {}), { members: [] });
    expect(text(rosterRows()[0]!)).toContain("u_hannah");
  });

  test("free seats: up to three are a row each with Assign; Add seats and Assign seats head the roster", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    expect(rosterRows().filter((row) => text(row).startsWith("Free seat"))).toHaveLength(2);
    expect(buttons(theCard()).filter((name) => name === "Assign")).toHaveLength(2);
    expect(hasButton("Add seats", theCard())).toBe(true);
    expect(hasButton("Assign seats", theCard())).toBe(true);
  });

  test("more than three free seats fold into one row", async () => {
    await mountCard(rig(), joined(coreLicense(5, []), {}));
    expect(text(theCard())).toContain("5 free seats");
    expect(text(theCard())).toContain("Nobody has a seat yet.");
    expect(rosterRows().filter((row) => text(row).startsWith("Free seat"))).toHaveLength(0);
  });

  test("the roster searches by name or email once there are more than eight holders", async () => {
    await mountCard(rig(), fleet(TEN));
    const search = find<HTMLInputElement>("input[type=search]", theCard());
    expect(search.getAttribute("aria-label")).toBe("Search seat holders");
    expect(rosterRows().filter((row) => text(row).includes("@acme.test"))).toHaveLength(10);
    await typeInto(search, "omar");
    expect(rosterRows().map((row) => text(row))).toEqual([expect.stringContaining("Omar Haddad")]);
    await typeInto(search, "marcus@");
    expect(rosterRows().map((row) => text(row))).toEqual([expect.stringContaining("Marcus Chen")]);
    await typeInto(search, "zzz");
    expect(text(theCard())).toContain("No one matches your search.");
  });

  test("a roster of eight or fewer has no search", async () => {
    await mountCard(rig(), joined(coreLicense(10, TEN.slice(0, 8)), {}));
    expect(findAll("input[type=search]", theCard())).toHaveLength(0);
  });

  test("the full roster has Add seats ↗ in its last row", async () => {
    const r = rig();
    await mountCard(r, joined(coreLicense(3, [HANNAH, TOM, NOAH]), {}));
    const last = rosterRows().at(-1)!;
    expect(text(last)).toContain("All 3 seats are in use.");
    await press("Add seats", last);
    await flush();
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "add_seats", licenseId: "lic_call" });
    expect(r.leave).toHaveBeenCalledWith(PAGE);
  });

  test("Unassign asks first, then takes the seat back, and billing's status is marked stale with the licenses", async () => {
    const r = rig();
    const client = newClient();
    const scope = workspaceScope(WS);
    client.setQueryData(billingKeys.status(r.billing, scope), EMPTY_STATUS);
    client.setQueryData(billingKeys.catalog(r.billing, scope), { locale: "en-US", products: [] });
    client.setQueryData(workspaceKeys.licenses(r.api, WS), []);
    await mountCard(r, joined(coreLicense(5, [HANNAH, TOM]), {}), {}, client);
    await press("Unassign Hannah Kim");
    expect(text(find('[role="group"]', theCard()))).toContain("Unassign Hannah Kim?");
    expect(r.releaseSeat).not.toHaveBeenCalled();
    await press("Unassign", find('[role="group"]', theCard()));
    await flush();
    expect(r.releaseSeat).toHaveBeenCalledWith(WS, "lic_call", "wm_hannah");
    expect(client.getQueryState(billingKeys.status(r.billing, scope))?.isInvalidated).toBe(true);
    expect(client.getQueryState(workspaceKeys.licenses(r.api, WS))?.isInvalidated).toBe(true);
    // Billing's catalog doesn't depend on a seat.
    expect(client.getQueryState(billingKeys.catalog(r.billing, scope))?.isInvalidated).toBe(false);
  });

  test("backing out of Unassign takes nothing back", async () => {
    const r = rig();
    await mountCard(r, joined(coreLicense(5, [HANNAH]), {}));
    await press("Unassign Hannah Kim");
    await press("Cancel", find('[role="group"]', theCard()));
    expect(r.releaseSeat).not.toHaveBeenCalled();
    expect(hasButton("Unassign Hannah Kim")).toBe(true);
  });

  test("a failed Unassign says why", async () => {
    const r = rig();
    r.releaseSeat.mockImplementation(async () => {
      throw new WorkspaceApiError(403, "forbidden", "forbidden");
    });
    await mountCard(r, joined(coreLicense(5, [HANNAH]), {}));
    await press("Unassign Hannah Kim");
    await press("Unassign", find('[role="group"]', theCard()));
    await flush();
    expect(find('[role="alert"]', theCard()).textContent).toBe("You do not have permission to do that.");
  });

  test("without permission to assign there is no Assign, no Unassign and no picker", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}), { canAssign: false });
    expect(buttons(theCard()).filter((name) => name.startsWith("Unassign") || name.startsWith("Assign"))).toEqual([]);
    expect(text(theCard())).toContain("Hannah Kim");
    expect(document.querySelector("dialog")).toBeNull();
  });

  test("Assign seats opens the picker for that license", async () => {
    await mountCard(rig(), joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    expect(find("dialog").hasAttribute("open")).toBe(false);
    await press("Assign seats", theCard());
    expect(find("dialog").hasAttribute("open")).toBe(true);
    expect(text(find("dialog"))).toContain("Assign seats");
    expect(text(find("dialog"))).toContain("Mentra Call Unlimited · 2 free seats");
    // A free seat's own Assign opens it too.
    await click(find('dialog button[aria-label="Close"]'));
    await press("Assign", rosterRows().find((row) => text(row).startsWith("Free seat"))!);
    expect(find("dialog").hasAttribute("open")).toBe(true);
  });
});

// ---- the people picker ----------------------------------------------------------------------------------------

/** The checkbox in the row of the person with this name. */
function checkboxFor(name: string): HTMLInputElement {
  const row = findAll("dialog li").find((item) => text(item).includes(name));
  if (!row) throw new Error(`no picker row for ${name}`);
  return find<HTMLInputElement>("input[type=checkbox]", row);
}
const assignButton = () => findAll<HTMLButtonElement>("dialog button").find((button) => /^Assign( \d+ seats?)?$/.test(nameOf(button)))!;

describe("the people picker", () => {
  const picker = (r: Rig, license: LicenseView, over: { onClose?: () => void; addSeats?: Parameters<typeof PeoplePickerDialog>[0]["addSeats"] } = {}) => (
    <PeoplePickerDialog
      open
      onClose={over.onClose ?? (() => {})}
      api={r.api}
      workspaceId={WS}
      license={license}
      productName="Mentra Call Unlimited"
      members={PEOPLE}
      addSeats={over.addSeats ?? null}
    />
  );

  test("is titled and says how many seats are free", async () => {
    const r = rig();
    await mount(picker(r, coreLicense(5, [DANA, PRIYA])));
    const dialog = text(find("dialog"));
    expect(dialog).toContain("Assign seats");
    expect(dialog).toContain("Mentra Call Unlimited · 3 free seats");
    expect(dialog).toContain("0 of 3 free seats chosen");
    expect(assignButton().hasAttribute("disabled")).toBe(true);
    expect(nameOf(assignButton())).toBe("Assign");
  });

  test("searches by name and by email", async () => {
    await mount(picker(rig(), coreLicense(5, [DANA])));
    const search = find<HTMLInputElement>("dialog input[type=search]");
    expect(search.getAttribute("aria-label")).toBe("Search by name or email");
    await typeInto(search, "luis");
    expect(findAll("dialog li").map((row) => text(row))).toEqual([expect.stringContaining("Luis Ortega")]);
    // Kevin has no name: his email is how he is found.
    await typeInto(search, "osei");
    expect(findAll("dialog li").map((row) => text(row))).toEqual([expect.stringContaining("kevin.osei@acme.test")]);
    await typeInto(search, "  AMARA@ ");
    expect(findAll("dialog li").map((row) => text(row))).toEqual([expect.stringContaining("Amara Okafor")]);
    await typeInto(search, "nobody at all");
    expect(text(find("dialog"))).toContain("No one matches your search.");
  });

  test("lists those who hold a seat and those who haven't signed in, and won't let them be chosen", async () => {
    await mount(picker(rig(), coreLicense(5, [DANA, PRIYA])));
    const rows = findAll("dialog li");
    const row = (name: string) => rows.find((item) => text(item).includes(name))!;
    expect(text(row("Dana Reyes"))).toContain("Has a seat");
    expect(text(row("Grace Oduya"))).toContain("After first sign-in");
    expect(checkboxFor("Dana Reyes").disabled).toBe(true);
    expect(checkboxFor("Grace Oduya").disabled).toBe(true);
    expect(checkboxFor("Luis Ortega").disabled).toBe(false);
    // People who can be chosen come first, then those who haven't signed in, then holders.
    const order = rows.map((item) => (text(item).includes("Has a seat") ? "holds" : text(item).includes("After first sign-in") ? "pending" : "open"));
    expect(order).toEqual([...Array(11).fill("open"), "pending", "holds", "holds"]);
  });

  test("a checkbox is named by its row, so a label click chooses", async () => {
    await mount(picker(rig(), coreLicense(5, [DANA])));
    const label = checkboxFor("Luis Ortega").closest("label")!;
    expect(label.textContent).toContain("Luis Ortega");
    await click(label);
    expect(checkboxFor("Luis Ortega").checked).toBe(true);
    expect(text(find("dialog"))).toContain("1 of 4 free seats chosen");
    expect(nameOf(assignButton())).toBe("Assign 1 seat");
  });

  test("four chosen with three free says '3 of 4 fit: remove one or add seats.', with Assign off", async () => {
    const add = mock(() => {});
    await mount(picker(rig(), coreLicense(5, [DANA, PRIYA]), { addSeats: { onClick: add } }));
    for (const member of [HANNAH, TOM, NOAH, INES]) await click(checkboxFor(member.name!));
    expect(text(find("dialog"))).toContain("3 of 4 fit: remove one or add seats.");
    expect(text(find("dialog"))).toContain("4 of 3 free seats chosen");
    expect(assignButton().hasAttribute("disabled")).toBe(true);
    // Adding seats is how to fit them, and it leaves for billing.
    await click(buttonNamed("Add seats", find("dialog")));
    expect(add).toHaveBeenCalledTimes(1);
    // Removing one makes it fit.
    await click(checkboxFor("Ines Moreau"));
    expect(text(find("dialog"))).not.toContain("fit:");
    expect(assignButton().hasAttribute("disabled")).toBe(false);
  });

  test("the overflow notice is neutral: amber is for payments and over-assignment", async () => {
    await mount(picker(rig(), coreLicense(5, [DANA, PRIYA, MARCUS, SOFIA]), { addSeats: { onClick: () => {} } }));
    for (const member of [HANNAH, TOM]) await click(checkboxFor(member.name!));
    const notice = find("dialog .rounded-notice");
    expect(notice.className).toContain("bg-surface");
    expect(notice.className).not.toContain("bg-error");
    expect(text(notice)).toContain("1 of 2 fit: remove one or add seats.");
  });

  test("three chosen calls assignSeats once with three pairs, and closes", async () => {
    const r = rig();
    const onClose = mock(() => {});
    await mount(picker(r, coreLicense(5, [DANA, PRIYA]), { onClose }));
    for (const member of [HANNAH, TOM, NOAH]) await click(checkboxFor(member.name!));
    expect(nameOf(assignButton())).toBe("Assign 3 seats");
    await click(assignButton());
    await flush();
    expect(r.assignSeats).toHaveBeenCalledTimes(1);
    // In the order the list shows them, whichever was ticked first.
    expect(r.assignSeats).toHaveBeenCalledWith(WS, [
      { licenseId: "lic_call", membershipId: "wm_hannah" },
      { licenseId: "lic_call", membershipId: "wm_noah" },
      { licenseId: "lic_call", membershipId: "wm_tom" },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a 409 refetches, shows what changed and keeps the dialog open with the choice", async () => {
    const r = rig();
    r.assignSeats.mockImplementation(async () => {
      throw new WorkspaceApiError(409, "no_seats_available", "no_seats_available");
    });
    const onClose = mock(() => {});
    const client = newClient();
    const scope = workspaceScope(WS);
    client.setQueryData(billingKeys.status(r.billing, scope), EMPTY_STATUS);
    function Watch() {
      useQuery(licensesQuery(r.api, WS));
      return null;
    }
    await mount(
      <>
        <Watch />
        {picker(r, coreLicense(5, [DANA, PRIYA]), { onClose })}
      </>,
      client,
    );
    await flush();
    expect(r.listLicenses).toHaveBeenCalledTimes(1);
    for (const member of [HANNAH, TOM]) await click(checkboxFor(member.name!));
    await click(assignButton());
    await flush();
    expect(find('dialog [role="alert"]').textContent).toBe("Seats changed while you were choosing. Nothing was assigned. Check the counts and try again.");
    expect(r.listLicenses).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(billingKeys.status(r.billing, scope))?.isInvalidated).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(checkboxFor("Hannah Kim").checked).toBe(true);
    expect(checkboxFor("Tom Becker").checked).toBe(true);
    // Changing the choice clears the message.
    await click(checkboxFor("Tom Becker"));
    expect(findAll('dialog [role="alert"]')).toHaveLength(0);
  });

  test("another failure says what went wrong", async () => {
    const r = rig();
    r.assignSeats.mockImplementation(async () => {
      throw new WorkspaceApiError(403, "forbidden", "forbidden");
    });
    await mount(picker(r, coreLicense(5, [DANA])));
    await click(checkboxFor("Luis Ortega"));
    await click(assignButton());
    await flush();
    expect(find('dialog [role="alert"]').textContent).toBe("You do not have permission to do that.");
  });

  test("a choice does not outlive the dialog", async () => {
    const r = rig();
    const license = coreLicense(5, [DANA]);
    const view = await render(<QueryClientProvider client={newClient()}>{picker(r, license)}</QueryClientProvider>);
    await click(checkboxFor("Luis Ortega"));
    await view.rerender(
      <QueryClientProvider client={newClient()}>
        <PeoplePickerDialog open={false} onClose={() => {}} api={r.api} workspaceId={WS} license={license} productName="x" members={PEOPLE} addSeats={null} />
      </QueryClientProvider>,
    );
    expect(findAll("dialog input[type=checkbox]")).toHaveLength(0);
  });

  test("a failed Add seats pressed in the picker says why inside the picker, not behind it", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("license_not_found", {}, 404);
      },
    });
    await mountCard(r, joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    await press("Assign seats", theCard());
    for (const member of [LUIS, AMARA, INES]) await click(checkboxFor(member.name!));
    expect(text(find("dialog"))).toContain("2 of 3 fit: remove one or add seats.");
    await press("Add seats", find("dialog"));
    await flush();
    expect(r.session).toHaveBeenCalledTimes(1);
    expect(r.session).toHaveBeenCalledWith(workspaceScope(WS), { action: "add_seats", licenseId: "lic_call" });
    // The one alert is in the dialog, which is where the person is looking.
    const alerts = findAll('[role="alert"]');
    expect(alerts.map((alert) => alert.textContent)).toEqual(["That license no longer exists. Reload the page."]);
    expect(alerts[0]!.closest("dialog")).not.toBeNull();
    // The choice is still there to act on, and the button can be pressed again.
    expect(checkboxFor("Luis Ortega").checked).toBe(true);
    expect(buttonNamed("Add seats", find("dialog")).hasAttribute("disabled")).toBe(false);
    // Closing the dialog doesn't lose it: the card shows it.
    await click(find('dialog button[aria-label="Close"]'));
    const after = findAll('[role="alert"]');
    expect(after.map((alert) => alert.textContent)).toEqual(["That license no longer exists. Reload the page."]);
    expect(after[0]!.closest("dialog")).toBeNull();
    expect(theCard().contains(after[0]!)).toBe(true);
  });

  test("a refusal the picker already showed is gone when the picker is opened again", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("license_not_found", {}, 404);
      },
    });
    await mountCard(r, joined(coreLicense(5, [HANNAH, TOM, NOAH]), {}));
    await press("Assign seats", theCard());
    for (const member of [LUIS, AMARA, INES]) await click(checkboxFor(member.name!));
    await press("Add seats", find("dialog"));
    await flush();
    expect(findAll('dialog [role="alert"]')).toHaveLength(1);
    await click(find('dialog button[aria-label="Close"]'));
    // Closed, the card shows it (nothing is lost) ...
    expect(findAll('[role="alert"]', theCard())).toHaveLength(1);
    // ... and a new opening starts clean: not in the dialog, and not behind it either.
    await press("Assign seats", theCard());
    expect(findAll('[role="alert"]')).toHaveLength(0);
    await click(find('dialog button[aria-label="Close"]'));
    expect(findAll('[role="alert"]')).toHaveLength(0);
  });

  test("and so is the link of a blocked tab the picker showed", async () => {
    const r = rig({ blocked: true });
    await mountCard(r, joined(coreLicense(5, [HANNAH, TOM, NOAH]), { actions: [{ kind: "add_seats", fallbackLabel: "Add seats", returns: false }] }));
    await press("Assign seats", theCard());
    for (const member of [LUIS, AMARA, INES]) await click(checkboxFor(member.name!));
    await press("Add seats", find("dialog"));
    await flush();
    expect(findAll("dialog a[data-hosted-page]")).toHaveLength(1);
    await click(find('dialog button[aria-label="Close"]'));
    await press("Assign seats", theCard());
    expect(findAll("a[data-hosted-page]")).toHaveLength(0);
  });

  test("opening the picker leaves a refusal of the card's own Add seats where it is", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("license_not_found", {}, 404);
      },
    });
    await mountCard(r, joined(coreLicense(3, [HANNAH, TOM]), {}));
    await press("Add seats", theCard());
    await flush();
    expect(findAll('[role="alert"]', theCard())).toHaveLength(1);
    await press("Assign seats", theCard());
    expect(findAll('[role="alert"]', theCard())).toHaveLength(1);
    expect(findAll('dialog [role="alert"]')).toHaveLength(0);
  });

  test("a refusal of Add seats from the card's roster stays on the card, with nothing in the dialog", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("license_not_found", {}, 404);
      },
    });
    await mountCard(r, joined(coreLicense(3, [HANNAH, TOM, NOAH]), {}));
    await press("Add seats", theCard());
    await flush();
    expect(findAll("dialog [role='alert']")).toHaveLength(0);
    expect(find('[role="alert"]', theCard()).textContent).toBe("That license no longer exists. Reload the page.");
  });

  test("a blocked tab for Add seats pressed in the picker gives its link inside the picker", async () => {
    const r = rig({ blocked: true });
    await mountCard(r, joined(coreLicense(5, [HANNAH, TOM, NOAH]), { actions: [{ kind: "add_seats", fallbackLabel: "Add seats", returns: false }] }));
    await press("Assign seats", theCard());
    for (const member of [LUIS, AMARA, INES]) await click(checkboxFor(member.name!));
    await press("Add seats", find("dialog"));
    await flush();
    const links = findAll<HTMLAnchorElement>("a[data-hosted-page]");
    expect(links).toHaveLength(1);
    expect(links[0]!.closest("dialog")).not.toBeNull();
    expect(links[0]!.getAttribute("href")).toBe(PAGE);
  });

  test("a full license says so, and offers nothing to assign", async () => {
    await mount(picker(rig(), coreLicense(2, [DANA, PRIYA]), { addSeats: null }));
    await click(checkboxFor("Luis Ortega"));
    expect(text(find("dialog"))).toContain("All 2 seats are in use.");
    expect(assignButton().hasAttribute("disabled")).toBe(true);
  });
});

// ---- the banners -----------------------------------------------------------------------------------------------

describe("the purchase banner", () => {
  const processing = { status: "processing", quantity: 5, paid: true };
  const ready = { status: "ready", quantity: 5, paid: true };
  const banner = (props: Partial<Parameters<typeof PurchaseBanner>[0]> = {}) => (
    <PurchaseBanner purchase={ready} productName="Mentra Call Unlimited" listed onDismiss={() => {}} {...props} />
  );

  test("is 'Payment received' and 'Setting up…' while billing is still working", async () => {
    await mount(banner({ purchase: processing, listed: false }));
    const words = text(find("section"));
    expect(words).toContain("Payment received");
    expect(words).toContain("Setting up 5 Mentra Call Unlimited seats. This takes a few seconds; you can stay on this page.");
    expect(words).toContain("Setting up…");
    expect(find("section").getAttribute("role")).toBe("status");
    expect(findAll(".animate-spin", find("section"))).toHaveLength(1);
    expect(hasButton("Dismiss")).toBe(false);
  });

  test("moves to ready when billing says ready and Core lists the license", async () => {
    const dismissed = mock(() => {});
    const view = await render(<QueryClientProvider client={newClient()}>{banner({ purchase: processing, listed: false, onDismiss: dismissed })}</QueryClientProvider>);
    // Billing is ready, Core hasn't got it: still setting up.
    await view.rerender(<QueryClientProvider client={newClient()}>{banner({ purchase: ready, listed: false, onDismiss: dismissed })}</QueryClientProvider>);
    expect(text(find("section"))).toContain("Payment received");
    expect(find("section").getAttribute("data-phase")).toBe("processing");
    // Core has it, billing is still working: also setting up.
    await view.rerender(<QueryClientProvider client={newClient()}>{banner({ purchase: processing, listed: true, onDismiss: dismissed })}</QueryClientProvider>);
    expect(find("section").getAttribute("data-phase")).toBe("processing");
    await view.rerender(<QueryClientProvider client={newClient()}>{banner({ purchase: ready, listed: true, onDismiss: dismissed })}</QueryClientProvider>);
    const words = text(find("section"));
    expect(find("section").getAttribute("data-phase")).toBe("ready");
    expect(words).toContain("Your 5 Mentra Call Unlimited seats are ready");
    expect(words).toContain("Payment received, and Mentra Call Unlimited is active. Give the seats to members below, or from Members.");
    expect(findAll(".animate-spin")).toHaveLength(0);
    await press("Dismiss");
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  test("one seat says 'is ready'", async () => {
    await mount(banner({ purchase: { ...ready, quantity: 1 } }));
    expect(text(find("section"))).toContain("Your 1 Mentra Call Unlimited seat is ready");
  });

  test("after a minute without the license it says the payment went through, with Reload", async () => {
    jest.useFakeTimers();
    const onReload = mock(() => {});
    const onTimeout = mock(() => {});
    await mount(banner({ purchase: processing, listed: false, onReload, onTimeout }));
    expect(PURCHASE_TIMEOUT_MS).toBe(60_000);
    await act(async () => void jest.advanceTimersByTime(PURCHASE_TIMEOUT_MS - 1));
    expect(find("section").getAttribute("data-phase")).toBe("processing");
    expect(onTimeout).not.toHaveBeenCalled();
    await act(async () => void jest.advanceTimersByTime(1));
    const words = text(find("section"));
    expect(find("section").getAttribute("data-phase")).toBe("timeout");
    expect(words).toContain("Your payment went through");
    expect(words).toContain("The seats can take a few minutes to appear.");
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(hasButton("Dismiss")).toBe(false);
    await press("Reload");
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test("a license that arrives after the minute still turns it ready, and a ready one never times out", async () => {
    jest.useFakeTimers();
    const view = await render(<QueryClientProvider client={newClient()}>{banner({ purchase: processing, listed: false })}</QueryClientProvider>);
    await act(async () => void jest.advanceTimersByTime(PURCHASE_TIMEOUT_MS));
    expect(find("section").getAttribute("data-phase")).toBe("timeout");
    await view.rerender(<QueryClientProvider client={newClient()}>{banner({ purchase: ready, listed: true })}</QueryClientProvider>);
    expect(find("section").getAttribute("data-phase")).toBe("ready");
    await cleanup();
    const onTimeout = mock(() => {});
    await mount(banner({ purchase: ready, listed: true, onTimeout }));
    await act(async () => void jest.advanceTimersByTime(PURCHASE_TIMEOUT_MS * 2));
    expect(find("section").getAttribute("data-phase")).toBe("ready");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test("a checkout that collected no payment says 'Purchase complete' and never 'Payment received'", async () => {
    jest.useFakeTimers();
    const free = { ...processing, paid: false };
    const view = await render(<QueryClientProvider client={newClient()}>{banner({ purchase: free, listed: false })}</QueryClientProvider>);
    const seen: string[] = [text(find("section"))];
    expect(seen[0]).toContain("Purchase complete");
    await act(async () => void jest.advanceTimersByTime(PURCHASE_TIMEOUT_MS));
    seen.push(text(find("section")));
    expect(seen[1]).toContain("Your purchase went through");
    await view.rerender(<QueryClientProvider client={newClient()}>{banner({ purchase: { ...ready, paid: false }, listed: true })}</QueryClientProvider>);
    seen.push(text(find("section")));
    expect(seen[2]).toContain("Mentra Call Unlimited is active. Give the seats");
    for (const words of seen) {
      expect(words).not.toContain("Payment received");
      expect(words).not.toContain("payment went through");
    }
  });

  test("a person's reads in their own words", async () => {
    await mount(banner({ scope: "person", purchase: { ...processing, quantity: 1 }, listed: true }));
    expect(text(find("section"))).toContain("Setting up Mentra Call Unlimited. This takes a few seconds; you can stay on this page.");
    await cleanup();
    await mount(banner({ scope: "person" }));
    expect(text(find("section"))).toContain("Mentra Call Unlimited is ready");
    expect(text(find("section"))).toContain("Payment received, and Mentra Call Unlimited is active on your account.");
  });
});

describe("the test-mode banner", () => {
  test("names the environment, shows the card in groups and says only Organization Admins see billing", async () => {
    await mount(<TestModeBanner testMode={{ cardNumber: "4242424242424242", environment: "Staging" }} />);
    const words = text(find("[role=note]"));
    expect(words).toContain("Test mode · Staging");
    expect(words).toContain("Nothing here is charged. Pay with the test card 4242 4242 4242 4242, any future date and any CVC.");
    expect(words).toContain("On dev and staging only Organization Admins see billing, and seats bought here work only here.");
    expect(find("[role=note]").getAttribute("aria-label")).toBe("Test mode · Staging");
  });

  test("Copy copies the digits, not the groups", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => void written.push(value) } });
    await mount(<TestModeBanner testMode={{ cardNumber: "4242424242424242", environment: "Staging" }} />);
    await press("Copy card number");
    await flush();
    expect(written).toEqual(["4242424242424242"]);
    expect(text(find("[role=note]"))).toContain("Copied");
  });
});

describe("the summary and the unavailable state", () => {
  test("the summary is billing's total: '2 licenses · $295 a month in total'", async () => {
    await mount(<LicensesSummary total={{ amount: usd(29500), recurrence: { interval: "month", count: 1 }, tax: "excluded", licenseCount: 2 }} locale="en-US" />);
    expect(text()).toBe("2 licenses · $295 a month in total");
    expect(find("p span.font-semibold").textContent).toBe("2 licenses");
  });

  test("with no total from billing there is no line", async () => {
    await mount(<LicensesSummary total={null} locale="en-US" />);
    expect(text()).toBe("");
  });

  test("unavailable says so and offers Retry", async () => {
    const retry = mock(() => {});
    await mount(<LicensesUnavailable onRetry={retry} />);
    expect(text()).toContain("Licenses are unavailable");
    expect(text()).toContain("They can't be shown right now. Try again in a moment.");
    await press("Retry");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("the personal page's wording, and Retry is off while it retries", async () => {
    await mount(<LicensesUnavailable personal retrying onRetry={() => {}} />);
    expect(text()).toContain("Billing is unavailable");
    expect(buttonNamed("Retry").hasAttribute("disabled")).toBe(true);
  });
});

// ---- one alert element -------------------------------------------------------------------------------------------

describe("a refusal is drawn by the one alert element", () => {
  test("no Licenses component writes its own role=\"alert\": they all use AlertText (or HostedFeedback, which does)", () => {
    const dir = join(import.meta.dir, "components", "licenses");
    const own = readdirSync(dir)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => /role=["']alert["']/.test(readFileSync(join(dir, file), "utf8")));
    expect(own).toEqual([]);
  });
});

// ---- the older Licenses panel's seat mutations -------------------------------------------------------------------

describe("the Licenses panel's seat changes mark billing's status stale", () => {
  test("unassigning from the panel refreshes the licenses and billing's status for the workspace", async () => {
    const r = rig();
    const scope = workspaceScope(WS);
    const client = newClient();
    const detail = detailFor("owner");
    const licenses = [coreLicense(5, [HANNAH])];
    // The panel reads what is seeded and then refetches it; the server has to say the same thing, or the
    // refetch (which the harness waits for) would replace the seat the test is about with an empty list.
    r.listLicenses.mockImplementation(async () => licenses);
    client.setQueryData(workspaceKeys.detail(r.api, WS), detail);
    client.setQueryData(workspaceKeys.members(r.api, WS), PEOPLE);
    client.setQueryData(workspaceKeys.licenses(r.api, WS), licenses);
    client.setQueryData(billingKeys.status(r.billing, scope), EMPTY_STATUS);
    await mount(<WorkspaceLicensesPanel api={r.api} workspaceId={WS} />, client);
    await press("Unassign hannah@acme.test");
    await press("Confirm unassign");
    await flush();
    expect(r.releaseSeat).toHaveBeenCalledWith(WS, "lic_call", "wm_hannah");
    expect(client.getQueryState(billingKeys.status(r.billing, scope))?.isInvalidated).toBe(true);
  });
});

