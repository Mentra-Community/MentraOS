import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import type { LicenseView, MemberView, WorkspaceDetail, WorkspaceRole } from "@mentra/workspace-contract";
import type { BillingCatalog, BillingStatus, CatalogEntry, LicenseBilling, Offer, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "./api";
import { createBillingApi, type BillingApi } from "./billing-api";
import { ACCOUNT_SCOPE, workspaceScope } from "./billing-scope";
import { BillingRefusedError } from "./billing-errors";
import { WorkspaceLicensesHeaderActions, WorkspaceLicensesView, type WorkspaceLicensesHeaderActionsProps, type WorkspaceLicensesViewProps } from "./components/licenses/licenses-view";
import { PersonalBillingHeaderActions, PersonalBillingView, type PersonalBillingHeaderActionsProps, type PersonalBillingViewProps } from "./components/licenses/personal-billing-view";
import * as pkg from "./index";
import { billingKeys, workspaceKeys } from "./queries";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor, perSeat, usd } from "./test-billing-fixtures";
import { cleanup, click, find, findAll, flush, render, setupDom, teardownDom, until } from "./test-dom";
import { detailFor, licenseFor, offlineApi, WORKSPACE_ID, WORKSPACE_NAME } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

// ---- who, what and when -------------------------------------------------------------------------------------------

const START = "2026-10-20T12:00:00.000Z";
const WS = WORKSPACE_ID;
const CALL = "mentra.call.unlimited";
const FLEET = "mentra.fleet";
const PAGE = "https://pay.example.test/session";
const SECOND = "https://invoice.example.test/i/second";

/** The processor's name, which no page says (in two halves, as the strings' own scan does), "Paid through", and a processor's ids. */
const LEAK = new RegExp(`${["str", "ipe"].join("")}|paid through|\\b(?:cus|sub|price|prod|pi|cs|in|si|seti|plink)_[A-Za-z0-9]{6,}`, "i");

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
const HANNAH = person("hannah", "Hannah Kim");
const TOM = person("tom", "Tom Becker");
const NOAH = person("noah", "Noah Fischer");
const LUIS = person("luis", "Luis Ortega");
const SELF = person("self", "Sam Self", { membershipId: "wm_self", mentraUserId: "u_self" });
const PEOPLE = [DANA, HANNAH, TOM, NOAH, LUIS, SELF];

const seatsOf = (people: readonly MemberView[]) =>
  people.map((member) => ({ membershipId: member.membershipId, mentraUserId: member.mentraUserId ?? "", assignedAt: START }));

const callLicense = (extra: Partial<LicenseView> = {}) =>
  licenseFor({ licenseId: "lic_call", product: CALL, quantity: 5, seatsUsed: 3, seats: seatsOf([HANNAH, TOM, NOAH]), ...extra });
const fleetLicense = (extra: Partial<LicenseView> = {}) =>
  licenseFor({ licenseId: "lic_fleet", product: FLEET, quantity: 10, seatsUsed: 4, seats: seatsOf([DANA, HANNAH, TOM, NOAH]), ...extra });

// ---- what billing sends -------------------------------------------------------------------------------------------

const workspaceOffer = (overrides: Partial<Offer> = {}): Offer => ({
  price: perSeat(1500),
  tax: "excluded",
  buy: { minSeats: 1, maxSeats: 500, defaultSeats: 10 },
  ...overrides,
});
const personOffer = (overrides: Partial<Offer> = {}): Offer => ({
  price: perSeat(2900),
  tax: "excluded",
  buy: { minSeats: 1, maxSeats: 1, defaultSeats: 1 },
  ...overrides,
});
const callEntry = (overrides: Partial<CatalogEntry> = {}) => catalogEntryFor({ offer: workspaceOffer({ price: perSeat(2900) }), ...overrides });
const fleetEntry = (overrides: Partial<CatalogEntry> = {}) => fleetEntryFor({ offer: workspaceOffer(), ...overrides });
const exampleEntry = (overrides: Partial<CatalogEntry> = {}) =>
  catalogEntryFor({
    product: "mentra.example",
    name: "Example Add-on",
    shortName: undefined,
    description: "A placeholder for the next product.",
    icon: null,
    features: [{ key: "example.one", name: "Feature one" }],
    ownerTypes: ["workspace", "person"],
    offer: workspaceOffer({ price: perSeat(900) }),
    ...overrides,
  });
const WORKSPACE_PRODUCTS = [callEntry(), fleetEntry(), exampleEntry()];
/** What a person is offered: the products sold to people, at a person's one seat. */
const PERSON_PRODUCTS = [
  callEntry({ offer: personOffer() }),
  fleetEntry({ offer: workspaceOffer(), ownerTypes: ["workspace"] }),
  exampleEntry({ offer: personOffer({ price: perSeat(900) }) }),
];

const callBilling = (extra: Partial<LicenseBilling> = {}) => licenseBillingFor({ licenseId: "lic_call", product: CALL, ...extra });
const fleetBilling = (extra: Partial<LicenseBilling> = {}) =>
  licenseBillingFor({
    licenseId: "lic_fleet",
    product: FLEET,
    quantity: 10,
    price: perSeat(1500),
    total: usd(15000),
    renewsAt: "2026-11-02T12:00:00.000Z",
    ...extra,
  });
const INVOICES = { kind: "billing_and_invoices", fallbackLabel: "Billing & invoices" };
const TOTAL = { amount: usd(29500), recurrence: { interval: "month" as const, count: 1 }, tax: "excluded", licenseCount: 2 };

const statusFor = (overrides: Partial<BillingStatus> = {}): BillingStatus => ({
  locale: "en-US",
  licenses: [callBilling(), fleetBilling()],
  total: TOTAL,
  actions: [INVOICES],
  testMode: null,
  purchase: null,
  ...overrides,
});
const catalogOf = (products: readonly CatalogEntry[] = WORKSPACE_PRODUCTS): BillingCatalog => ({ locale: "en-US", products: [...products] });

const purchaseOf = (extra: Partial<PurchaseStatus> = {}): PurchaseStatus => ({
  purchaseId: "pur_1",
  status: "processing",
  product: CALL,
  quantity: 5,
  paid: true,
  licenseId: null,
  ...extra,
});

// ---- the rig ------------------------------------------------------------------------------------------------------

interface Answers {
  detail: WorkspaceDetail;
  licenses: LicenseView[] | Error;
  members: MemberView[] | Error;
  catalog: BillingCatalog | Error;
  status: BillingStatus | Error;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const answer = <T,>(value: T | Error): T => {
  if (value instanceof Error) throw value;
  return value;
};

/**
 * Billing, Core's workspace API and the host's two ways out, each answering from `answers` (which a test may change
 * between reads) and recording what is asked of it. A read can be held back (`gates`) to have it in flight.
 */
function rig(options: Partial<Answers> & { role?: WorkspaceRole; session?: (request: Record<string, unknown>) => Promise<{ url: string }> } = {}) {
  const { role = "admin", session: sessionAnswer, ...given } = options;
  const answers: Answers = {
    detail: detailFor(role),
    licenses: [callLicense(), fleetLicense()],
    members: PEOPLE,
    catalog: catalogOf(),
    status: statusFor(),
    ...given,
  };
  const gates: { status: Promise<void> | null; licenses: Promise<void> | null } = { status: null, licenses: null };
  const events: string[] = [];
  const tab = {
    go: mock((url: string) => void events.push(`go:${url}`)),
    close: mock(() => void events.push("close")),
  };
  const leave = mock((url: string) => void events.push(`leave:${url}`));
  const openTab = mock(() => {
    events.push("openTab");
    return tab;
  });
  const getWorkspace = mock(async (_workspaceId: string) => answers.detail);
  const listLicenses = mock(async (_workspaceId: string) => {
    if (gates.licenses) await gates.licenses;
    return answer(answers.licenses);
  });
  const listMembers = mock(async (_workspaceId: string) => answer(answers.members));
  const api = { ...offlineApi().api, getWorkspace, listLicenses, listMembers } as WorkspaceApi;

  const catalog = mock(async (_scope: unknown) => answer(answers.catalog));
  const status = mock(async (_scope: unknown, _options?: { purchase?: string | null }) => {
    if (gates.status) await gates.status;
    return answer(answers.status);
  });
  const session = mock(async (_scope: unknown, request: Record<string, unknown>) => {
    events.push(`session:${String(request.action)}`);
    return sessionAnswer ? sessionAnswer(request) : { url: PAGE };
  });
  const purchase = mock(async (_scope: unknown, _request: { product: string; seats: number }) => ({ url: PAGE }));
  const billing = { base: "/api/portal/billing", locale: "en-US", catalog, status, session, purchase } as unknown as BillingApi;
  const onDone = mock(() => {});
  return { answers, gates, events, tab, leave, openTab, api, getWorkspace, listLicenses, listMembers, billing, catalog, status, session, purchase, onDone, navigateOut: { leave, openTab } };
}
type Rig = ReturnType<typeof rig>;

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, refetchOnWindowFocus: false } } });

const viewProps = (r: Rig, over: Partial<WorkspaceLicensesViewProps> = {}): WorkspaceLicensesViewProps => ({
  api: r.api,
  billing: r.billing,
  workspaceId: WS,
  offer: { catalog: true, manage: true },
  purchaseId: null,
  onPurchaseDone: r.onDone,
  navigateOut: r.navigateOut,
  ...over,
});
const personalProps = (r: Rig, over: Partial<PersonalBillingViewProps> = {}): PersonalBillingViewProps => ({
  billing: r.billing,
  purchaseId: null,
  onPurchaseDone: r.onDone,
  navigateOut: r.navigateOut,
  ...over,
});

const headerProps = (r: Rig, over: Partial<WorkspaceLicensesHeaderActionsProps> = {}): WorkspaceLicensesHeaderActionsProps => ({
  api: r.api,
  billing: r.billing,
  workspaceId: WS,
  offer: { catalog: true, manage: true },
  purchaseId: null,
  navigateOut: r.navigateOut,
  ...over,
});
const personalHeaderProps = (r: Rig, over: Partial<PersonalBillingHeaderActionsProps> = {}): PersonalBillingHeaderActionsProps => ({
  billing: r.billing,
  purchaseId: null,
  navigateOut: r.navigateOut,
  ...over,
});

async function mount(ui: ReactElement, client = newClient()) {
  const mounted = await render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...mounted };
}

/** Waits for the page to leave its loading state, whether it ends up showing the licenses or the unavailable state. */
const loaded = () => until(() => !/Loading (licenses|billing)…/.test(text()), "the page to load");

async function mountView(r: Rig, over: Partial<WorkspaceLicensesViewProps> = {}, client = newClient()) {
  const mounted = await mount(<WorkspaceLicensesView {...viewProps(r, over)} />, client);
  await loaded();
  return mounted;
}
/** Waits until every read the page started has finished (a header draws nothing while it waits, so there is no text to wait for). */
async function idle(client: QueryClient) {
  await until(() => client.isFetching() === 0, "the reads to finish");
  await flush();
  await until(() => client.isFetching() === 0, "the reads to finish");
}
/** The Licenses page's header actions on their own, after they have read what they need. */
async function mountHeader(r: Rig, over: Partial<WorkspaceLicensesHeaderActionsProps> = {}, client = newClient()) {
  const mounted = await mount(<WorkspaceLicensesHeaderActions {...headerProps(r, over)} />, client);
  await idle(client);
  return mounted;
}
/** The personal page's header actions on their own. */
async function mountPersonalHeader(r: Rig, over: Partial<PersonalBillingHeaderActionsProps> = {}, client = newClient()) {
  const mounted = await mount(<PersonalBillingHeaderActions {...personalHeaderProps(r, over)} />, client);
  await idle(client);
  return mounted;
}
async function mountPersonal(r: Rig, over: Partial<PersonalBillingViewProps> = {}, client = newClient()) {
  const mounted = await mount(<PersonalBillingView {...personalProps(r, over)} />, client);
  await loaded();
  return mounted;
}

const text = (within: ParentNode = document.body) => (within.textContent ?? "").replace(/\s+/g, " ").trim();
const nameOf = (element: Element) => element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
const buttons = (within: ParentNode = document) => findAll("button", within).map(nameOf);
const hasButton = (name: string, within: ParentNode = document) => buttons(within).includes(name);
const buttonNamed = (name: string, within: ParentNode = document) => {
  const found = findAll<HTMLButtonElement>("button", within).find((button) => nameOf(button) === name);
  if (!found) throw new Error(`no button named "${name}" among ${JSON.stringify(buttons(within))}`);
  return found;
};
/** The license cards, in the order they are drawn. */
const cardElements = () => findAll('[data-slot="card"][role="group"]');
const cardNames = () => cardElements().map((element) => element.getAttribute("aria-label"));
const cardNamed = (name: string) => {
  const found = cardElements().find((element) => element.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no card named "${name}" among ${JSON.stringify(cardNames())}`);
  return found;
};
/**
 * Elements are compared as booleans, never through `expect(element).toBe(other)`: a failing one makes Bun print both
 * DOM trees, which takes minutes, and a hang says nothing about what went wrong.
 */
const gridProducts = () => findAll("[data-product]").map((element) => element.getAttribute("data-product"));
const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter((dialog) => dialog.open);
const unavailable = () => text().includes("Licenses are unavailable") || text().includes("Billing is unavailable");
const delay = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

// ---- who sees what ------------------------------------------------------------------------------------------------

describe("who sees what", () => {
  test("a manager who is offered billing sees every license with its money and the page total", async () => {
    const r = rig();
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    const call = text(cardNamed("Mentra Call Unlimited"));
    for (const expected of ["Active", "3 of 5 in use", "Nov 20, 2026", "$145 a month", "5 × $29 · before tax"]) expect(call).toContain(expected);
    expect(text(cardNamed("Fleet"))).toContain("$150 a month");
    expect(text()).toContain("2 licenses · $295 a month in total");
    // The header buttons are the host's to place (`WorkspaceLicensesHeaderActions`): the page draws none.
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy a license")).toBe(false);
    // The seats are Core's to assign: the people come with the page.
    expect(buttons(cardNamed("Mentra Call Unlimited"))).toContain("Seat holders");
    expect(text(cardNamed("Mentra Call Unlimited"))).toContain("Hannah Kim, Tom Becker and Noah Fischer");
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: null }]);
    expect(r.catalog.mock.calls[0]).toEqual([workspaceScope(WS)]);
    expect(r.listMembers).toHaveBeenCalledTimes(1);
  });

  test("a manager who isn't offered billing sees every license with its seats and assigns them, but no money, no billing and no buying", async () => {
    const r = rig();
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    const page = text();
    expect(page).toContain("3 of 5 in use");
    expect(page).toContain("4 of 10 in use");
    expect(page).not.toContain("$");
    expect(page).not.toContain("Renews");
    expect(page).not.toContain("licenses ·");
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy a license")).toBe(false);
    expect(findAll("[data-hosted-page]")).toHaveLength(0);
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(0);
    // The seats are theirs to give out.
    await click(buttonNamed("Seat holders", cardNamed("Mentra Call Unlimited")));
    expect(hasButton("Assign seats", cardNamed("Mentra Call Unlimited"))).toBe(true);
    expect(hasButton("Unassign Hannah Kim", cardNamed("Mentra Call Unlimited"))).toBe(true);
    // And billing's status is never asked for.
    expect(r.status).not.toHaveBeenCalled();
    expect(r.catalog).toHaveBeenCalledTimes(1);
  });

  test("a member with a seat sees only that license as 'You have a seat': no total, money, other people or controls", async () => {
    const r = rig({
      role: "member",
      licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })],
      members: new Error("a member cannot list the members"),
      status: new Error("a member's page asks for no status"),
    });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
    const page = text();
    expect(page).toContain("You have a seat");
    expect(page).toContain("Your seat");
    expect(page).toContain("Since Oct 20, 2026");
    expect(page).toContain(`Given by ${WORKSPACE_NAME}`);
    expect(page).toContain("Works in");
    expect(page).toContain("Mentra Call");
    expect(page).toContain(`${WORKSPACE_NAME}'s Admins and Owners give out seats.`);
    expect(page).not.toContain("$");
    expect(page).not.toContain("licenses ·");
    expect(page).not.toContain("in use");
    expect(page).not.toContain("Seat holders");
    expect(buttons()).toEqual([]);
    // No request for billing's status, and none for a members list the member may not read.
    expect(r.status).not.toHaveBeenCalled();
    expect(r.listMembers).not.toHaveBeenCalled();
  });

  test("a developer is a member here: the same page", async () => {
    const r = rig({ role: "developer", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain("You have a seat");
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a member without a seat is told so, and the sentence names the workspace", async () => {
    const r = rig({ role: "member", licenses: [] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual([]);
    expect(text()).toContain(`You don't have a seat in ${WORKSPACE_NAME}`);
    expect(text()).toContain("Its Admins and Owners give out seats. Once you have one, it works the next time you open the miniapp it's for.");
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a license of the member's without a seat of theirs is left out rather than claimed", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 0, seats: [] }), fleetLicense({ seats: seatsOf([SELF]), seatsUsed: 1 })] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Fleet"]);
  });

  test("an Organization Admin who is no member is a manager: the capabilities decide, not the membership", async () => {
    const detail = { ...detailFor("owner"), membership: null };
    const r = rig({ detail });
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(text()).toContain("2 licenses · $295 a month in total");
  });

  test("a license that has ended is no card", async () => {
    const r = rig({ licenses: [callLicense(), fleetLicense({ endedAt: "2026-10-01T12:00:00.000Z" })], status: statusFor({ licenses: [callBilling()], total: { ...TOTAL, licenseCount: 1 } }) });
    await mountView(r);
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
  });
});

// ---- when it can't be shown ---------------------------------------------------------------------------------------

describe("unavailable", () => {
  test("when the catalog fails the page says so, with Retry, and draws no cards", async () => {
    const r = rig({ catalog: new Error("catalog down") });
    await mountView(r);
    expect(text()).toContain("Licenses are unavailable");
    expect(text()).toContain("They can't be shown right now. Try again in a moment.");
    expect(hasButton("Retry")).toBe(true);
    expect(cardNames()).toEqual([]);
    expect(hasButton("Buy a license")).toBe(false);
  });

  test("when the status fails for a manager the same", async () => {
    const r = rig({ status: new Error("status down") });
    await mountView(r);
    expect(text()).toContain("Licenses are unavailable");
    expect(hasButton("Retry")).toBe(true);
    expect(cardNames()).toEqual([]);
  });

  test("an answer that doesn't match the contract is the same state", async () => {
    const real = createBillingApi({
      locale: "en-US",
      fetch: (async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "https://portal.example.test").pathname;
        const body = path.endsWith("/catalog") ? catalogOf() : { licenses: "none" };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch,
    });
    const r = rig();
    await mountView({ ...r, billing: real } as Rig);
    expect(text()).toContain("Licenses are unavailable");
  });

  test("Retry reads again, and the page comes back", async () => {
    const r = rig({ status: new Error("status down") });
    await mountView(r);
    expect(unavailable()).toBe(true);
    const calls = r.status.mock.calls.length;
    r.answers.status = statusFor();
    await click(buttonNamed("Retry"));
    await until(() => cardNames().length === 2, "the cards after Retry");
    expect(r.status.mock.calls.length).toBeGreaterThan(calls);
    expect(unavailable()).toBe(false);
    expect(text()).toContain("2 licenses · $295 a month in total");
  });

  test("when Core's licenses or the people can't be read, it is the same state, not cards without names", async () => {
    await mountView(rig({ licenses: new Error("core down") }));
    expect(text()).toContain("Licenses are unavailable");
    await cleanup();
    await mountView(rig({ members: new Error("members down") }));
    expect(text()).toContain("Licenses are unavailable");
    expect(cardNames()).toEqual([]);
  });

  test("a member's page doesn't ask for the status, and a failing one can't break it", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })], status: new Error("never asked") });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(unavailable()).toBe(false);
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a member's page needs the catalog to name the license, so without it that page is unavailable too", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })], catalog: new Error("catalog down") });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain("Licenses are unavailable");
    expect(cardNames()).toEqual([]);
  });

  test("a member with nothing to name needs no catalog to be told they have no seat", async () => {
    const r = rig({ role: "member", licenses: [], catalog: new Error("catalog down") });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain(`You don't have a seat in ${WORKSPACE_NAME}`);
    expect(unavailable()).toBe(false);
  });

  test("where billing's catalog isn't offered at all (offer.catalog false) there is nothing to name a license with: unavailable, and no catalog request", async () => {
    const r = rig();
    await mountView(r, { offer: { catalog: false, manage: false } });
    expect(text()).toContain("Licenses are unavailable");
    expect(r.catalog).not.toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a read that fails after the page has loaded keeps what is on screen", async () => {
    const r = rig();
    const { client } = await mountView(r);
    const before = cardNamed("Fleet");
    r.answers.status = new Error("status down");
    r.answers.licenses = new Error("core down");
    await act(async () => {
      await client.invalidateQueries({ queryKey: billingKeys.statuses(workspaceScope(WS)) });
      await client.invalidateQueries({ queryKey: workspaceKeys.licenses(r.api, WS) });
    });
    await flush();
    expect(unavailable()).toBe(false);
    expect(cardNamed("Fleet") === before).toBe(true);
  });
});

// ---- the page's layout --------------------------------------------------------------------------------------------

describe("the layout", () => {
  test("with no licenses a manager who is offered billing gets the catalog grid, and no header buttons", async () => {
    const r = rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [] }) });
    await mountView(r);
    expect(find("h2").textContent).toBe("Buy a license for your members");
    expect(text()).toContain("You'll pay by card on a secure payment page, then come back here to give out the seats.");
    expect(gridProducts()).toEqual([CALL, FLEET, "mentra.example"]);
    expect(cardNames()).toEqual([]);
    expect(hasButton("Buy a license")).toBe(false);
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(text()).not.toContain("licenses ·");
    // The grid is told how many people the workspace has, for its seats step.
    await click(findAll<HTMLButtonElement>("button", find(`[data-product="${FLEET}"]`)).find((button) => button.textContent === "Buy")!);
    expect(text(openDialogs()[0]!)).toContain(`Your workspace has ${PEOPLE.length} members.`);
  });

  test("with licenses the total line follows billing's total, and the page draws no header buttons of its own", async () => {
    const r = rig();
    await mountView(r);
    expect(text()).toContain("2 licenses · $295 a month in total");
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy a license")).toBe(false);
    // The summary is billing's own total: with none there is no line, and Core adds nothing up.
    await cleanup();
    await mountView(rig({ status: statusFor({ total: null }) }));
    expect(text()).not.toContain("a month in total");
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
  });

  test("with one license its roster is open", async () => {
    const r = rig({ licenses: [callLicense()], status: statusFor({ licenses: [callBilling()], total: { ...TOTAL, amount: usd(14500), licenseCount: 1 } }) });
    await mountView(r);
    expect(text()).toContain("1 license · $145 a month in total");
    const card = cardNamed("Mentra Call Unlimited");
    expect(hasButton("Unassign Hannah Kim", card)).toBe(true);
    expect(hasButton("Assign seats", card)).toBe(true);
    expect(text(card)).toContain("Free seat");
  });

  test("with several each card folds its seats into a strip that opens its own roster", async () => {
    const r = rig();
    await mountView(r);
    const call = cardNamed("Mentra Call Unlimited");
    expect(hasButton("Unassign Hannah Kim", call)).toBe(false);
    expect(text(call)).toContain("Hannah Kim, Tom Becker and Noah Fischer");
    expect(buttons(call)).toContain("Seat holders");
    await click(buttonNamed("Seat holders", call));
    expect(hasButton("Unassign Hannah Kim", cardNamed("Mentra Call Unlimited"))).toBe(true);
    // The other card is still a strip.
    expect(hasButton("Unassign Dana Reyes", cardNamed("Fleet"))).toBe(false);
  });

  test("problem cards come first: a failed payment before the rest", async () => {
    const failed = callBilling({
      status: "past_due",
      fallbackStatusLabel: "Past due",
      seatsStopAt: "2026-11-23T12:00:00.000Z",
      actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }],
    });
    await mountView(rig({ status: statusFor({ licenses: [failed, fleetBilling()] }) }));
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);
    expect(cardNamed("Mentra Call Unlimited").getAttribute("data-ring")).toBe("warn");
  });

  test("a billing entry Core hasn't received is a card of its own, and shows no seats", async () => {
    const half = fleetBilling({ licenseId: "lic_half", status: "incomplete", fallbackStatusLabel: "Incomplete", actions: [{ kind: "complete_payment", fallbackLabel: "Complete payment", returns: false }] });
    const r = rig({ licenses: [callLicense()], status: statusFor({ licenses: [callBilling(), half], total: { ...TOTAL, licenseCount: 1 } }) });
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(text(cardNamed("Fleet"))).toContain("Payment incomplete");
    expect(hasButton("Complete payment", cardNamed("Fleet"))).toBe(true);
    expect(text(cardNamed("Fleet"))).not.toContain("in use");
  });

  test("a manager with no licenses and nothing offered is told there are none, not shown a blank page", async () => {
    const r = rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [] }), catalog: catalogOf([callEntry({ offer: undefined })]) });
    await mountView(r);
    expect(text()).toContain("This workspace has no licenses yet.");
    expect(text()).not.toContain("Buy a license");
    expect(text()).not.toContain("You'll pay by card");
  });

  test("a manager who isn't offered billing and has no licenses sees no buying copy, only that there are none", async () => {
    const r = rig({ licenses: [], catalog: catalogOf([callEntry({ offer: undefined }), fleetEntry({ offer: undefined })]) });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain("This workspace has no licenses yet.");
    expect(findAll("h2")).toHaveLength(0);
    expect(text()).not.toContain("Buy a license");
    expect(text()).not.toContain("You'll pay by card");
    expect(gridProducts()).toEqual([]);
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a catalog whose entries carry no offer draws no heading, even for a viewer the host believes is offered billing", async () => {
    const r = rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [] }), catalog: catalogOf([callEntry({ offer: undefined })]) });
    await mountView(r);
    expect(findAll("h2")).toHaveLength(0);
    expect(text()).not.toContain("You'll pay by card");
  });
});

// ---- after checkout -----------------------------------------------------------------------------------------------

describe("purchases", () => {
  const POLL = { pollMs: 15, timeoutMs: 400 };
  const processing = () =>
    statusFor({
      licenses: [fleetBilling(), callBilling({ status: "processing", fallbackStatusLabel: "Setting up" })],
      purchase: purchaseOf(),
    });
  const ready = () => statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) });

  test("?purchase gives the banner flow: setting up, then ready; the purchased card comes first, ringed, with its roster open", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    // Billing is asked about the purchase; the page is polling for the license to arrive.
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: "pur_1" }]);
    expect(text()).toContain("Payment received");
    expect(text()).toContain("Setting up 5 Mentra Call Unlimited seats. This takes a few seconds; you can stay on this page.");
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);
    expect(text(cardNamed("Mentra Call Unlimited"))).toContain("Setting up");

    r.answers.status = ready();
    r.answers.licenses = [fleetLicense(), callLicense({ seatsUsed: 0, seats: [] })];
    await until(() => text().includes("Your 5 Mentra Call Unlimited seats are ready"), "the banner to say ready");
    expect(text()).toContain("Payment received, and Mentra Call Unlimited is active. Give the seats to members below, or from Members.");
    expect(buttons()).toContain("Dismiss");
    // Purchased card first (not by name: Fleet sorts before it), ringed in green, its roster open.
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);
    const card = cardNamed("Mentra Call Unlimited");
    expect(card.getAttribute("data-ring")).toBe("highlight");
    expect(text(card)).toContain("5 free seats");
    expect(text(card)).toContain("Nobody has a seat yet");
    expect(buttons(card)).not.toContain("Seat holders");
    expect(buttons(cardNamed("Fleet"))).toContain("Seat holders");
  });

  test("it polls billing's status and Core's licenses together until the license is ready and listed, then stops", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    const statusCalls = () => r.status.mock.calls.length;
    const licenseCalls = () => r.listLicenses.mock.calls.length;
    const first = { status: statusCalls(), licenses: licenseCalls() };
    await until(() => statusCalls() >= first.status + 2 && licenseCalls() >= first.licenses + 2, "two rounds of polling");
    // Billing says ready before Core lists the license: still polling, still setting up.
    r.answers.status = ready();
    await until(() => statusCalls() >= first.status + 4, "more polling");
    expect(text()).not.toContain("are ready");
    expect(text()).toContain("Setting up");
    r.answers.licenses = [fleetLicense(), callLicense({ seatsUsed: 0, seats: [] })];
    await until(() => text().includes("are ready"), "ready");
    const after = { status: statusCalls(), licenses: licenseCalls() };
    await delay(POLL.pollMs * 8);
    expect(statusCalls()).toBeLessThanOrEqual(after.status + 1);
    expect(licenseCalls()).toBeLessThanOrEqual(after.licenses + 1);
  });

  test("a poll doesn't restart a read that is still out: a slow answer is waited for, not asked again every two seconds", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    const hold = deferred();
    r.gates.status = hold.promise;
    r.gates.licenses = hold.promise;
    const before = { status: r.status.mock.calls.length, licenses: r.listLicenses.mock.calls.length };
    await until(() => r.status.mock.calls.length > before.status && r.listLicenses.mock.calls.length > before.licenses, "both reads in flight");
    const started = { status: r.status.mock.calls.length, licenses: r.listLicenses.mock.calls.length };
    // Many polls come and go while they are out; none cancels one and asks again.
    await delay(POLL.pollMs * 8);
    expect(r.status.mock.calls.length).toBe(started.status);
    expect(r.listLicenses.mock.calls.length).toBe(started.licenses);
    r.gates.status = null;
    r.gates.licenses = null;
    await act(async () => hold.resolve());
    await flush();
  });

  test("by default it polls every two seconds and gives up after a minute", async () => {
    expect(pkg.PURCHASE_POLL_MS).toBe(2000);
    expect(pkg.PURCHASE_TIMEOUT_MS).toBe(60000);
    // The pace and the patience are the constants' unless the host says otherwise: watch what the page schedules.
    const intervals: unknown[] = [];
    const timeouts: unknown[] = [];
    const { setInterval: realInterval, setTimeout: realTimeout } = globalThis;
    globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      intervals.push(ms);
      return realInterval(handler, ms, ...args);
    }) as typeof setInterval;
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      timeouts.push(ms);
      return realTimeout(handler, ms, ...args);
    }) as typeof setTimeout;
    try {
      await mountView(rig({ licenses: [fleetLicense()], status: processing() }), { purchaseId: "pur_1" });
    } finally {
      globalThis.setInterval = realInterval;
      globalThis.setTimeout = realTimeout;
    }
    expect(intervals).toContain(2000);
    expect(timeouts).toContain(60000);
  });

  test("a license that hasn't reached Core after the minute says so, with Reload, and polling stops", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    await mountView(r, { purchaseId: "pur_1", pollMs: 15, timeoutMs: 120 });
    await until(() => text().includes("Your payment went through"), "the timeout");
    expect(text()).toContain("The seats can take a few minutes to appear.");
    expect(hasButton("Reload")).toBe(true);
    const calls = r.status.mock.calls.length;
    await delay(150);
    expect(r.status.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  test("a checkout that collected no payment says 'Purchase complete', and never 'Payment received'", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call", paid: false }) }) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Mentra Call Unlimited is active.");
    expect(text()).toContain("Your 5 Mentra Call Unlimited seats are ready");
    expect(text()).not.toContain("Payment received");
  });

  test("Dismiss tells the host, which removes ?purchase=; the banner and the ring go", async () => {
    const r = rig({ status: ready() });
    const { rerender, client } = await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(cardNames()[0]).toBe("Mentra Call Unlimited");
    expect(cardNamed("Mentra Call Unlimited").getAttribute("data-ring")).toBe("highlight");
    await click(buttonNamed("Dismiss"));
    expect(r.onDone).toHaveBeenCalledTimes(1);
    // Hidden at once, whatever the host does with the address.
    expect(text()).not.toContain("are ready");
    await rerender(
      <QueryClientProvider client={client}>
        <WorkspaceLicensesView {...viewProps(r, { purchaseId: null, ...POLL })} />
      </QueryClientProvider>,
    );
    await loaded();
    expect(text()).not.toContain("are ready");
    expect(cardNamed("Mentra Call Unlimited").getAttribute("data-ring")).toBeNull();
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
  });

  test("an unknown or another owner's purchase (purchase: null) shows no banner and no polling", async () => {
    const r = rig({ status: statusFor({ purchase: null }) });
    await mountView(r, { purchaseId: "pur_nobody", ...POLL });
    expect(text()).not.toContain("Payment received");
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: "pur_nobody" }]);
    const calls = r.status.mock.calls.length;
    await delay(POLL.pollMs * 6);
    expect(r.status.mock.calls.length).toBe(calls);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
  });

  test("a viewer who isn't offered billing gets no purchase banner and no status request, whatever the address says", async () => {
    const r = rig();
    await mountView(r, { offer: { catalog: true, manage: false }, purchaseId: "pur_1", ...POLL });
    expect(r.status).not.toHaveBeenCalled();
    expect(text()).not.toContain("Payment received");
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
  });

  test("the banner names the product from the catalog, or by its key when the catalog lacks it", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ product: "mentra.gone", status: "ready", licenseId: "lic_call", quantity: 2 }) }) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Your 2 mentra.gone seats are ready");
  });
});

// ---- test mode ----------------------------------------------------------------------------------------------------

describe("test mode", () => {
  const testMode = { cardNumber: "4242424242424242", environment: "Staging" };

  test("the banner is above everything when testMode is set", async () => {
    const r = rig({ status: statusFor({ testMode, purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) }) });
    const { container } = await mountView(r, { purchaseId: "pur_1", pollMs: 15 });
    const note = find('[role="note"]');
    expect(note.textContent).toContain("Test mode · Staging");
    expect(note.textContent).toContain("4242 4242 4242 4242");
    // First thing on the page: before the purchase banner and every card.
    expect(container.firstElementChild!.firstElementChild === note).toBe(true);
    for (const later of [find("[data-phase]"), cardElements()[0]!]) {
      expect(note.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test("it is above the catalog too, when there are no licenses", async () => {
    const r = rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [], testMode }) });
    const { container } = await mountView(r);
    const note = find('[role="note"]');
    expect(container.firstElementChild!.firstElementChild === note).toBe(true);
    expect(note.compareDocumentPosition(find("h2")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("there is none without it", async () => {
    await mountView(rig());
    expect(findAll('[role="note"]')).toHaveLength(0);
  });
});

// ---- the personal Billing page ------------------------------------------------------------------------------------

describe("the personal Billing page", () => {
  const mine = (extra: Partial<LicenseBilling> = {}) =>
    licenseBillingFor({ licenseId: "lic_me", product: CALL, quantity: 1, price: perSeat(2900), total: usd(2900), ...extra });
  const personStatus = (overrides: Partial<BillingStatus> = {}) =>
    statusFor({ licenses: [mine()], total: { ...TOTAL, amount: usd(2900), licenseCount: 1 }, ...overrides });
  const personRig = (overrides: Partial<Answers> = {}) => rig({ catalog: catalogOf(PERSON_PRODUCTS), status: personStatus(), ...overrides });

  test("with nothing yet it is the catalog of what a person can buy: only person products, each with its price", async () => {
    const r = personRig({ status: statusFor({ licenses: [], total: null, actions: [] }) });
    await mountPersonal(r);
    expect(find("h2").textContent).toBe("Buy a license for yourself");
    expect(text()).toContain("You'll pay by card on a secure payment page, then come back here.");
    expect(gridProducts()).toEqual([CALL, "mentra.example"]);
    expect(text(find(`[data-product="${CALL}"]`))).toContain("$29 a month");
    expect(text()).not.toContain("Fleet");
    expect(hasButton("Buy a license")).toBe(false);
    expect(r.catalog.mock.calls[0]).toEqual([ACCOUNT_SCOPE]);
    expect(r.status.mock.calls[0]).toEqual([ACCOUNT_SCOPE, { purchase: null }]);
    // Billing's the only source: nothing about a workspace is asked.
    expect(r.getWorkspace).not.toHaveBeenCalled();
    expect(r.listLicenses).not.toHaveBeenCalled();
  });

  test("with a license it is a card with no seats, its renewal and cost, and a menu; the header buttons are the host's", async () => {
    const r = personRig();
    await mountPersonal(r);
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
    const card = text(cardNamed("Mentra Call Unlimited"));
    // A person's one seat has no "1 × $29": the cost is the month's amount, and that it is before tax.
    for (const expected of ["Active", "Renews", "Nov 20, 2026", "$29 a month", "before tax"]) expect(card).toContain(expected);
    for (const absent of ["Seats", "in use", "Seat holders", "Assign", "5 ×", "1 ×"]) expect(card).not.toContain(absent);
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy a license")).toBe(false);
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(1);
  });

  test("a failed payment shows the same amber notice and deadline as a workspace's", async () => {
    const failed = mine({
      status: "past_due",
      fallbackStatusLabel: "Past due",
      seatsStopAt: "2026-11-23T12:00:00.000Z",
      actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }],
    });
    await mountPersonal(personRig({ status: personStatus({ licenses: [failed] }) }));
    expect(text()).toContain("Seats stop on Nov 23, 2026 unless payment goes through.");
    expect(cardNamed("Mentra Call Unlimited").getAttribute("data-ring")).toBe("warn");
    expect(hasButton("Update payment method")).toBe(true);
  });

  test("after checkout: 'Payment received', then '<product> is ready' on the account, with the new card first and ringed", async () => {
    const r = personRig({
      catalog: catalogOf([...PERSON_PRODUCTS]),
      status: personStatus({
        licenses: [mine({ licenseId: "lic_a", product: "mentra.example", price: perSeat(900) }), mine({ licenseId: "lic_me" })],
        purchase: purchaseOf({ product: CALL, quantity: 1, status: "processing", licenseId: null }),
      }),
    });
    await mountPersonal(r, { purchaseId: "pur_1", pollMs: 15, timeoutMs: 400 });
    expect(r.status.mock.calls[0]).toEqual([ACCOUNT_SCOPE, { purchase: "pur_1" }]);
    expect(text()).toContain("Payment received");
    expect(text()).toContain("Setting up Mentra Call Unlimited. This takes a few seconds; you can stay on this page.");
    r.answers.status = personStatus({
      licenses: [mine({ licenseId: "lic_a", product: "mentra.example", price: perSeat(900) }), mine({ licenseId: "lic_me" })],
      purchase: purchaseOf({ product: CALL, quantity: 1, status: "ready", licenseId: "lic_me" }),
    });
    await until(() => text().includes("Mentra Call Unlimited is ready"), "the banner to say ready");
    expect(text()).toContain("Payment received, and Mentra Call Unlimited is active on your account.");
    // A person's license is billing's alone: there is no Core list to wait for, and the card is first and ringed.
    expect(r.listLicenses).not.toHaveBeenCalled();
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Example Add-on"]);
    expect(cardElements()[0]!.getAttribute("data-ring")).toBe("highlight");
    await click(buttonNamed("Dismiss"));
    expect(r.onDone).toHaveBeenCalledTimes(1);
  });

  test("a checkout that collected no payment says 'Purchase complete' and that it is active on the account", async () => {
    const r = personRig({ status: personStatus({ purchase: purchaseOf({ quantity: 1, status: "ready", licenseId: "lic_me", paid: false }) }) });
    await mountPersonal(r, { purchaseId: "pur_1" });
    expect(text()).toContain("Mentra Call Unlimited is active on your account.");
    expect(text()).not.toContain("Payment received");
  });

  test("the test-mode banner is above everything here too", async () => {
    const r = personRig({ status: personStatus({ testMode: { cardNumber: "4242424242424242", environment: "Dev" } }) });
    const { container } = await mountPersonal(r);
    expect(container.firstElementChild!.firstElementChild).toBe(find('[role="note"]'));
  });

  test("'Billing is unavailable' appears when billing can't be read, with Retry", async () => {
    const r = personRig({ status: new Error("down") });
    await mountPersonal(r);
    expect(text()).toContain("Billing is unavailable");
    expect(text()).toContain("It can't be shown right now. Try again in a moment.");
    expect(text()).not.toContain("Licenses are unavailable");
    r.answers.status = personStatus();
    await click(buttonNamed("Retry"));
    await until(() => cardNames().length === 1, "the card after Retry");
    expect(unavailable()).toBe(false);
    await cleanup();
    await mountPersonal(personRig({ catalog: new Error("down") }));
    expect(text()).toContain("Billing is unavailable");
  });

  test("with nothing to buy and nothing held it says so, not a blank page", async () => {
    const r = personRig({ catalog: catalogOf([fleetEntry({ ownerTypes: ["workspace"] })]), status: statusFor({ licenses: [], total: null, actions: [] }) });
    await mountPersonal(r);
    expect(text()).toContain("There is nothing to buy for yourself right now.");
    expect(findAll("h2")).toHaveLength(0);
  });
});

// ---- the header actions -------------------------------------------------------------------------------------------

describe("the Licenses page's header actions", () => {
  test("a manager offered billing, with licenses, has 'Billing & invoices ↗' and 'Buy a license'", async () => {
    const r = rig();
    await mountHeader(r);
    expect(buttons()).toEqual(["Billing & invoices", "Buy a license"]);
    // Only the first leaves the portal.
    expect(buttonNamed("Billing & invoices").hasAttribute("data-hosted-page")).toBe(true);
    expect(buttonNamed("Buy a license").hasAttribute("data-hosted-page")).toBe(false);
    // It reads what the page reads, under the same keys, and no more.
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: null }]);
    expect(r.catalog).toHaveBeenCalledTimes(1);
  });

  test("an Organization Admin who is no member has them: the capabilities decide", async () => {
    await mountHeader(rig({ detail: { ...detailFor("owner"), membership: null } }));
    expect(buttons()).toEqual(["Billing & invoices", "Buy a license"]);
  });

  test("nothing is drawn where the viewer isn't offered billing, or is a member, or there are no licenses to act on", async () => {
    const cases: Array<[string, () => Rig, Partial<WorkspaceLicensesHeaderActionsProps>]> = [
      ["not offered billing", () => rig(), { offer: { catalog: true, manage: false } }],
      ["a member", () => rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] }), { offer: { catalog: true, manage: false } }],
      ["no licenses (the page is the catalog)", () => rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [INVOICES] }) }), {}],
      ["only an ended license", () => rig({ licenses: [fleetLicense({ endedAt: "2026-10-01T12:00:00.000Z" })], status: statusFor({ licenses: [], total: null }) }), {}],
    ];
    for (const [what, build, over] of cases) {
      const { container } = await mountHeader(build(), over);
      expect([what, text(container), buttons()]).toEqual([what, "", []]);
      await cleanup();
    }
  });

  test("a member's header asks for no status and no members", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })], status: new Error("never asked") });
    await mountHeader(r, { offer: { catalog: true, manage: false } });
    expect(r.status).not.toHaveBeenCalled();
    expect(r.listMembers).not.toHaveBeenCalled();
  });

  test("a header for someone not offered billing asks for nothing at all", async () => {
    const r = rig();
    const { container } = await mountHeader(r, { offer: { catalog: true, manage: false } });
    expect(text(container)).toBe("");
    for (const asked of [r.getWorkspace, r.listLicenses, r.listMembers, r.catalog, r.status]) expect(asked).not.toHaveBeenCalled();
  });

  test("a viewer the page treats as a member gets no buttons, even if the host says billing is offered", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] });
    const { container } = await mountHeader(r, { offer: { catalog: true, manage: true } });
    expect(text(container)).toBe("");
  });

  test("nothing is drawn while the reads are out, or when one the page needs failed (the page says unavailable)", async () => {
    const hold = deferred();
    const waiting = rig();
    waiting.gates.status = hold.promise;
    const { container } = await mount(<WorkspaceLicensesHeaderActions {...headerProps(waiting)} />);
    await flush();
    expect(text(container)).toBe("");
    waiting.gates.status = null;
    await act(async () => hold.resolve());
    await until(() => buttons().length === 2, "the buttons once it has read");
    await cleanup();
    const broken: Array<[string, Partial<Answers>]> = [
      ["catalog", { catalog: new Error("down") }],
      ["status", { status: new Error("down") }],
      ["licenses", { licenses: new Error("down") }],
      ["members", { members: new Error("down") }],
    ];
    for (const [what, answers] of broken) {
      const { container: shown } = await mountHeader(rig(answers));
      expect([what, text(shown)]).toEqual([what, ""]);
      await cleanup();
    }
  });

  test("'Billing & invoices' is there only where billing lists it for the account", async () => {
    await mountHeader(rig({ status: statusFor({ actions: [] }) }));
    expect(buttons()).toEqual(["Buy a license"]);
  });

  test("'Buy a license' is there only where billing offers workspaces something (an entry with an offer)", async () => {
    await mountHeader(rig({ catalog: catalogOf([callEntry({ offer: undefined }), fleetEntry({ offer: undefined })]) }));
    expect(buttons()).toEqual(["Billing & invoices"]);
    await cleanup();
    // An entry offered to people only is nothing for a workspace.
    await mountHeader(rig({ catalog: catalogOf([callEntry({ offer: undefined }), fleetEntry({ offer: personOffer(), ownerTypes: ["person"] })]) }));
    expect(buttons()).toEqual(["Billing & invoices"]);
    await cleanup();
    // With neither there is nothing at all.
    const { container } = await mountHeader(rig({ status: statusFor({ actions: [] }), catalog: catalogOf([callEntry({ offer: undefined })]) }));
    expect(text(container)).toBe("");
  });

  test("'Billing & invoices' asks billing for the account's session and goes there in this tab", async () => {
    const r = rig();
    await mountHeader(r);
    await click(buttonNamed("Billing & invoices"));
    await until(() => r.leave.mock.calls.length === 1, "the browser to leave");
    expect(r.session.mock.calls).toEqual([[workspaceScope(WS), { action: "billing_and_invoices" }]]);
    expect(r.leave).toHaveBeenCalledWith(PAGE);
    expect(r.openTab).not.toHaveBeenCalled();
  });

  test("'Billing & invoices' listed with returns: false opens its tab in the click", async () => {
    const detached = { ...INVOICES, returns: false };
    const r = rig({ status: statusFor({ actions: [detached] }) });
    await mountHeader(r);
    await click(buttonNamed("Billing & invoices"));
    await until(() => r.tab.go.mock.calls.length === 1, "the tab to be sent on");
    expect(r.events).toEqual(["openTab", "session:billing_and_invoices", `go:${PAGE}`]);
    expect(r.leave).not.toHaveBeenCalled();
  });

  test("a refusal is shown in words next to the buttons", async () => {
    const r = rig({
      session: async () => {
        throw new BillingRefusedError("no_billing_account", {}, 404);
      },
    });
    await mountHeader(r);
    await click(buttonNamed("Billing & invoices"));
    await until(() => findAll('[role="alert"]').length === 1, "the refusal");
    expect(r.leave).not.toHaveBeenCalled();
    expect(buttonNamed("Billing & invoices").hasAttribute("disabled")).toBe(false);
  });

  test("'Buy a license' owns its dialog: a held product offers Add seats, any other its price and Buy", async () => {
    const r = rig();
    await mountHeader(r);
    expect(openDialogs()).toHaveLength(0);
    await click(buttonNamed("Buy a license"));
    const dialog = openDialogs()[0]!;
    expect(text(dialog)).toContain("Products for your workspace. For one you have, add seats instead.");
    const row = (product: string) => find(`[data-product="${product}"]`, dialog);
    expect(text(row(CALL))).toContain("You have 5 seats");
    expect(hasButton("Add seats", row(CALL))).toBe(true);
    expect(text(row(FLEET))).toContain("You have 10 seats");
    expect(text(row("mentra.example"))).toContain("$9 per seat a month");
    expect(hasButton("Buy", row("mentra.example"))).toBe(true);
    // Buy's seats step is told how many people the workspace has.
    await click(buttonNamed("Buy", row("mentra.example")));
    expect(openDialogs().map((open) => text(open)).join(" ")).toContain(`Your workspace has ${PEOPLE.length} members.`);
  });

  test("a new-tab Add seats from that dialog reads Core's licenses again when the person comes back", async () => {
    const detached = { kind: "add_seats", fallbackLabel: "Add seats", returns: false };
    const r = rig({ status: statusFor({ licenses: [callBilling({ actions: [detached] }), fleetBilling()] }) });
    await mountHeader(r);
    await click(buttonNamed("Buy a license"));
    const row = find(`[data-product="${CALL}"]`, openDialogs()[0]!);
    await click(buttonNamed("Add seats", row));
    await until(() => r.tab.go.mock.calls.length === 1, "the tab to be sent on");
    expect(r.events.slice(-2)).toEqual(["session:add_seats", `go:${PAGE}`]);
    const licensesBefore = r.listLicenses.mock.calls.length;
    const statusBefore = r.status.mock.calls.length;
    await act(async () => void window.dispatchEvent(new Event("focus")));
    await until(() => r.listLicenses.mock.calls.length > licensesBefore && r.status.mock.calls.length > statusBefore, "both reads again");
  });

  test("it reads the status under the page's key, so a purchase's progress is one request", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) }) });
    await mountHeader(r, { purchaseId: "pur_1" });
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: "pur_1" }]);
    expect(buttons()).toEqual(["Billing & invoices", "Buy a license"]);
  });
});

describe("the personal Billing page's header actions", () => {
  const mine = (extra: Partial<LicenseBilling> = {}) =>
    licenseBillingFor({ licenseId: "lic_me", product: CALL, quantity: 1, price: perSeat(2900), total: usd(2900), ...extra });
  const personStatus = (overrides: Partial<BillingStatus> = {}) => statusFor({ licenses: [mine()], total: null, ...overrides });
  const personRig = (overrides: Partial<Answers> = {}) => rig({ catalog: catalogOf(PERSON_PRODUCTS), status: personStatus(), ...overrides });

  test("with a license it has 'Billing & invoices ↗' and 'Buy a license'", async () => {
    const r = personRig();
    await mountPersonalHeader(r);
    expect(buttons()).toEqual(["Billing & invoices", "Buy a license"]);
    expect(buttonNamed("Billing & invoices").hasAttribute("data-hosted-page")).toBe(true);
    expect(buttonNamed("Buy a license").hasAttribute("data-hosted-page")).toBe(false);
    expect(r.catalog.mock.calls).toEqual([[ACCOUNT_SCOPE]]);
    expect(r.status.mock.calls[0]).toEqual([ACCOUNT_SCOPE, { purchase: null }]);
    // Billing's the only source.
    expect(r.getWorkspace).not.toHaveBeenCalled();
    expect(r.listLicenses).not.toHaveBeenCalled();
  });

  test("with nothing held (the page is the catalog), while loading, or when billing can't be read, nothing is drawn", async () => {
    const hold = deferred();
    const waiting = personRig();
    waiting.gates.status = hold.promise;
    const { container } = await mount(<PersonalBillingHeaderActions {...personalHeaderProps(waiting)} />);
    await flush();
    expect(text(container)).toBe("");
    waiting.gates.status = null;
    await act(async () => hold.resolve());
    await until(() => buttons().length === 2, "the buttons once it has read");
    await cleanup();
    const cases: Array<[string, Partial<Answers>]> = [
      ["nothing held", { status: statusFor({ licenses: [], total: null, actions: [INVOICES] }) }],
      ["status down", { status: new Error("down") }],
      ["catalog down", { catalog: new Error("down") }],
    ];
    for (const [what, answers] of cases) {
      const { container: shown } = await mountPersonalHeader(personRig(answers));
      expect([what, text(shown)]).toEqual([what, ""]);
      await cleanup();
    }
  });

  test("'Billing & invoices' is there only where billing lists it", async () => {
    await mountPersonalHeader(personRig({ status: personStatus({ actions: [] }) }));
    expect(buttons()).toEqual(["Buy a license"]);
  });

  test("'Buy a license' shows only while something is left to buy: catalogForOwner(person).some(canBuy)", async () => {
    // Everything a person can buy is held or can't be sold now: nothing is left.
    const allHeld = personRig({
      catalog: catalogOf([
        callEntry({ offer: personOffer({ buy: null }) }),
        exampleEntry({ offer: personOffer({ buy: null, price: perSeat(900) }) }),
        fleetEntry({ ownerTypes: ["workspace"] }),
      ]),
    });
    await mountPersonalHeader(allHeld);
    expect(buttons()).toEqual(["Billing & invoices"]);
    await cleanup();
    // A workspace product with a buyable offer doesn't count: it isn't for a person.
    await mountPersonalHeader(personRig({ catalog: catalogOf([callEntry({ offer: personOffer({ buy: null }) }), fleetEntry({ ownerTypes: ["workspace"] })]) }));
    expect(buttons()).toEqual(["Billing & invoices"]);
    await cleanup();
    await mountPersonalHeader(personRig());
    expect(buttons()).toEqual(["Billing & invoices", "Buy a license"]);
    await cleanup();
    // With neither there is nothing.
    const { container } = await mountPersonalHeader(
      personRig({ status: personStatus({ actions: [] }), catalog: catalogOf([callEntry({ offer: personOffer({ buy: null }) })]) }),
    );
    expect(text(container)).toBe("");
  });

  test("'Buy a license' owns its dialog: what they hold says 'You have it', and a Buy goes straight to payment", async () => {
    const r = personRig();
    await mountPersonalHeader(r);
    await click(buttonNamed("Buy a license"));
    const dialog = openDialogs()[0]!;
    expect(text(dialog)).toContain("Products you can buy for yourself.");
    expect(text(find(`[data-product="${CALL}"]`, dialog))).toContain("You have it");
    expect(find(`[data-product="${CALL}"]`, dialog).querySelector("button")).toBeNull();
    // Fleet is sold to workspaces only.
    expect(findAll(`[data-product="${FLEET}"]`)).toHaveLength(0);
    // Buy goes straight to payment for the one seat, with no seats step.
    await click(buttonNamed("Buy", find('[data-product="mentra.example"]', dialog)));
    await until(() => r.leave.mock.calls.length === 1, "the browser to leave");
    expect(r.purchase.mock.calls).toEqual([[ACCOUNT_SCOPE, { product: "mentra.example", seats: 1 }]]);
    expect(r.leave).toHaveBeenCalledWith(PAGE);
    expect(text(dialog)).not.toContain("Continue to payment");
  });

  test("'Billing & invoices' goes to the account's hosted page", async () => {
    const r = personRig();
    await mountPersonalHeader(r);
    await click(buttonNamed("Billing & invoices"));
    await until(() => r.leave.mock.calls.length === 1, "the browser to leave");
    expect(r.session.mock.calls).toEqual([[ACCOUNT_SCOPE, { action: "billing_and_invoices" }]]);
  });

  test("a refusal is shown in words next to the buttons", async () => {
    const r = personRig({});
    const failing = rig({
      catalog: catalogOf(PERSON_PRODUCTS),
      status: personStatus(),
      session: async () => {
        throw new BillingRefusedError("no_billing_account", {}, 404);
      },
    });
    await mountPersonalHeader(failing);
    await click(buttonNamed("Billing & invoices"));
    await until(() => findAll('[role="alert"]').length === 1, "the refusal");
    expect(failing.leave).not.toHaveBeenCalled();
    expect(r.leave).not.toHaveBeenCalled();
  });
});

describe("a view and its header together", () => {
  test("the Licenses page: one read of everything, the view's cards and the header's buttons, no buttons in the view", async () => {
    const r = rig();
    const client = newClient();
    await mount(
      <>
        <WorkspaceLicensesHeaderActions {...headerProps(r)} />
        <WorkspaceLicensesView {...viewProps(r)} />
      </>,
      client,
    );
    await loaded();
    await idle(client);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(buttons().filter((name) => name === "Billing & invoices" || name === "Buy a license")).toEqual(["Billing & invoices", "Buy a license"]);
    // The catalog (and everything else both read) was requested once, not once each.
    expect(r.catalog).toHaveBeenCalledTimes(1);
    expect(r.status).toHaveBeenCalledTimes(1);
    expect(r.listLicenses).toHaveBeenCalledTimes(1);
    expect(r.getWorkspace).toHaveBeenCalledTimes(1);
    expect(r.listMembers).toHaveBeenCalledTimes(1);
    // The buttons are the header's: they stay where the host put them, outside the view's cards.
    for (const card of cardElements()) expect(buttons(card)).not.toContain("Billing & invoices");
  });

  test("with a purchase in the address, the same single read of the status", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) }) });
    const client = newClient();
    await mount(
      <>
        <WorkspaceLicensesHeaderActions {...headerProps(r, { purchaseId: "pur_1" })} />
        <WorkspaceLicensesView {...viewProps(r, { purchaseId: "pur_1", pollMs: 1_000_000 })} />
      </>,
      client,
    );
    await loaded();
    await idle(client);
    expect(r.status).toHaveBeenCalledTimes(1);
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: "pur_1" }]);
    expect(r.catalog).toHaveBeenCalledTimes(1);
    expect(hasButton("Buy a license")).toBe(true);
  });

  test("the personal page: one read of the catalog and of the status", async () => {
    const r = rig({ catalog: catalogOf(PERSON_PRODUCTS), status: statusFor({ licenses: [licenseBillingFor({ licenseId: "lic_me", quantity: 1 })], total: null }) });
    const client = newClient();
    await mount(
      <>
        <PersonalBillingHeaderActions {...personalHeaderProps(r)} />
        <PersonalBillingView {...personalProps(r)} />
      </>,
      client,
    );
    await loaded();
    await idle(client);
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
    expect(buttons().filter((name) => name === "Billing & invoices" || name === "Buy a license")).toEqual(["Billing & invoices", "Buy a license"]);
    expect(r.catalog).toHaveBeenCalledTimes(1);
    expect(r.status).toHaveBeenCalledTimes(1);
  });
});

// ---- nothing leaks ------------------------------------------------------------------------------------------------

describe("what no page says", () => {
  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ["a manager's page", () => mountView(rig({ status: statusFor({ testMode: { cardNumber: "4242424242424242", environment: "Staging" } }) }))],
    ["a manager's page with the catalog", () => mountView(rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [] }) }))],
    ["a page just after checkout", () => mountView(rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) }) }), { purchaseId: "pur_1" })],
    ["a failed payment", () => mountView(rig({ status: statusFor({ licenses: [callBilling({ status: "past_due", fallbackStatusLabel: "x", seatsStopAt: "2026-11-23T12:00:00.000Z" }), fleetBilling()] }) }))],
    ["a manager not offered billing", () => mountView(rig(), { offer: { catalog: true, manage: false } })],
    ["a member's page", () => mountView(rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] }), { offer: { catalog: true, manage: false } })],
    ["a member with no seat", () => mountView(rig({ role: "member", licenses: [] }), { offer: { catalog: true, manage: false } })],
    ["the unavailable page", () => mountView(rig({ status: new Error("down") }))],
    ["the personal page", () => mountPersonal(rig({ catalog: catalogOf(PERSON_PRODUCTS), status: statusFor({ licenses: [licenseBillingFor({ licenseId: "lic_me", quantity: 1 })], total: null }) }))],
    ["the personal catalog", () => mountPersonal(rig({ catalog: catalogOf(PERSON_PRODUCTS), status: statusFor({ licenses: [], total: null, actions: [] }) }))],
  ];

  for (const [name, show] of scenarios) {
    test(`${name}: no processor name, no 'Paid through', no processor id, and no native select`, async () => {
      await show();
      expect(text()).not.toMatch(LEAK);
      expect(findAll("select")).toHaveLength(0);
      // Nor in what the page says to a screen reader, or where it points.
      for (const element of findAll("[aria-label], [title], a[href]")) {
        expect([element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("href")].join(" ")).not.toMatch(LEAK);
      }
    });
  }

  test("the header buttons and the dialogs they open say none of it either", async () => {
    await mountHeader(rig());
    expect(hasButton("Billing & invoices") && hasButton("Buy a license")).toBe(true);
    expect(text()).not.toMatch(LEAK);
    await click(buttonNamed("Buy a license"));
    expect(text()).not.toMatch(LEAK);
    expect(findAll("select")).toHaveLength(0);
    await cleanup();
    const person = rig({ catalog: catalogOf(PERSON_PRODUCTS), status: statusFor({ licenses: [licenseBillingFor({ licenseId: "lic_me", quantity: 1 })], total: null }) });
    await mountPersonalHeader(person);
    expect(hasButton("Billing & invoices") && hasButton("Buy a license")).toBe(true);
    await click(buttonNamed("Buy a license"));
    expect(text()).not.toMatch(LEAK);
    expect(findAll("select")).toHaveLength(0);
  });
});

// ---- cards stay mounted -------------------------------------------------------------------------------------------

describe("a card stays mounted through a refetch", () => {
  const failedCall = () =>
    callBilling({
      status: "past_due",
      fallbackStatusLabel: "Past due",
      seatsStopAt: "2026-11-23T12:00:00.000Z",
      actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }],
    });

  test("with its session request in flight, so the click still takes the browser to the hosted page", async () => {
    const answerSession = deferred<{ url: string }>();
    const r = rig({ status: statusFor({ licenses: [failedCall(), fleetBilling()] }), session: () => answerSession.promise });
    const { client } = await mountView(r);
    const call = cardNamed("Mentra Call Unlimited");
    const fleet = cardNamed("Fleet");
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);

    // The press: billing is asked for the session and hasn't answered.
    await click(buttonNamed("Update payment method", call));
    await until(() => r.session.mock.calls.length === 1, "the session request");

    // Meanwhile billing's status and Core's licenses are read again, and held in flight.
    const status = deferred();
    const licenses = deferred();
    r.gates.status = status.promise;
    r.gates.licenses = licenses.promise;
    const statusCalls = r.status.mock.calls.length;
    const licenseCalls = r.listLicenses.mock.calls.length;
    await act(async () => {
      void client.invalidateQueries({ queryKey: billingKeys.statuses(workspaceScope(WS)) });
      void client.invalidateQueries({ queryKey: workspaceKeys.licenses(r.api, WS) });
    });
    await until(() => r.status.mock.calls.length > statusCalls && r.listLicenses.mock.calls.length > licenseCalls, "both reads in flight");
    expect(text()).not.toMatch(/Loading (licenses|billing)/);
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
    expect(cardNamed("Fleet") === fleet).toBe(true);

    // They answer with a different state and order: the cards are the same elements, moved.
    r.answers.status = statusFor({ licenses: [callBilling(), fleetBilling({ status: "past_due", fallbackStatusLabel: "Past due", actions: [] })] });
    r.answers.licenses = [callLicense({ quantity: 6 }), fleetLicense()];
    await act(async () => {
      r.gates.status = null;
      r.gates.licenses = null;
      status.resolve();
      licenses.resolve();
    });
    await until(() => cardNames()[0] === "Fleet", "the new order");
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
    expect(cardNamed("Fleet") === fleet).toBe(true);
    expect(call.isConnected && fleet.isConnected).toBe(true);
    expect(text(call)).toContain("3 of 6 in use");

    // The answer comes in, and the click still does what it was for.
    await act(async () => answerSession.resolve({ url: PAGE }));
    await until(() => r.leave.mock.calls.length === 1, "the browser to leave");
    expect(r.leave).toHaveBeenCalledWith(PAGE);
  });

  test("when ?purchase= is removed the status is read under a new key, and the cards are not swapped for a loading state", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) }) });
    const { rerender, client } = await mountView(r, { purchaseId: "pur_1", pollMs: 15 });
    const call = cardNamed("Mentra Call Unlimited");
    const fleet = cardNamed("Fleet");
    const hold = deferred();
    r.gates.status = hold.promise;
    r.answers.status = statusFor();
    await rerender(
      <QueryClientProvider client={client}>
        <WorkspaceLicensesView {...viewProps(r, { purchaseId: null, pollMs: 15 })} />
      </QueryClientProvider>,
    );
    await until(() => r.status.mock.calls.some(([, options]) => options?.purchase === null), "the new read");
    expect(text()).not.toMatch(/Loading (licenses|billing)/);
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
    expect(cardNamed("Fleet") === fleet).toBe(true);
    r.gates.status = null;
    await act(async () => hold.resolve());
    await until(() => cardNames()[0] === "Fleet", "the plain order");
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
  });

  test("a billing entry Core then receives is the same card, not a new one", async () => {
    const half = callBilling({ status: "processing", fallbackStatusLabel: "Setting up" });
    const r = rig({ licenses: [fleetLicense()], status: statusFor({ licenses: [fleetBilling(), half], purchase: purchaseOf() }) });
    const { client } = await mountView(r, { purchaseId: "pur_1", pollMs: 15 });
    const call = cardNamed("Mentra Call Unlimited");
    r.answers.licenses = [fleetLicense(), callLicense()];
    r.answers.status = statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call" }) });
    await act(async () => {
      await client.invalidateQueries({ queryKey: billingKeys.statuses(workspaceScope(WS)) });
      await client.invalidateQueries({ queryKey: workspaceKeys.licenses(r.api, WS) });
    });
    await until(() => text(cardNamed("Mentra Call Unlimited")).includes("3 of 5 in use"), "the license from Core");
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
  });

  test("the personal page too", async () => {
    const answerSession = deferred<{ url: string }>();
    const mine = licenseBillingFor({ licenseId: "lic_me", product: CALL, quantity: 1, status: "past_due", fallbackStatusLabel: "x", actions: [{ kind: "update_payment", fallbackLabel: "Update payment method" }] });
    const r = rig({ catalog: catalogOf(PERSON_PRODUCTS), status: statusFor({ licenses: [mine], total: null }), session: () => answerSession.promise });
    const { client } = await mountPersonal(r);
    const card = cardNamed("Mentra Call Unlimited");
    await click(buttonNamed("Update payment method"));
    await until(() => r.session.mock.calls.length === 1, "the session request");
    const hold = deferred();
    r.gates.status = hold.promise;
    await act(async () => void client.invalidateQueries({ queryKey: billingKeys.statuses(ACCOUNT_SCOPE) }));
    expect(text()).not.toMatch(/Loading billing/);
    expect(cardNamed("Mentra Call Unlimited") === card).toBe(true);
    r.gates.status = null;
    await act(async () => hold.resolve());
    await act(async () => answerSession.resolve({ url: PAGE }));
    await until(() => r.leave.mock.calls.length === 1, "the browser to leave");
    expect(card.isConnected).toBe(true);
  });
});

// ---- the package --------------------------------------------------------------------------------------------------

describe("the package", () => {
  test("exports both views and their header actions, and still the panel and productLabel the portal uses until it moves over", () => {
    expect(pkg.WorkspaceLicensesView).toBe(WorkspaceLicensesView);
    expect(pkg.PersonalBillingView).toBe(PersonalBillingView);
    expect(pkg.WorkspaceLicensesHeaderActions).toBe(WorkspaceLicensesHeaderActions);
    expect(pkg.PersonalBillingHeaderActions).toBe(PersonalBillingHeaderActions);
    expect(typeof pkg.WorkspaceLicensesPanel).toBe("function");
    expect(typeof pkg.productLabel).toBe("function");
  });
});
