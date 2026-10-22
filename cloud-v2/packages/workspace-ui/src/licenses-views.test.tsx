import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import type { LicenseView, MemberView, WorkspaceDetail, WorkspaceRole } from "@mentra/workspace-contract";
import type { BillingCatalog, BillingStatus, CatalogEntry, LicenseBilling, Offer, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "./api";
import { createBillingApi, type BillingApi } from "./billing-api";
import { workspaceScope } from "./billing-scope";
import { BillingRefusedError } from "./billing-errors";
import { WorkspaceLicensesHeaderActions, WorkspaceLicensesView, type WorkspaceLicensesHeaderActionsProps, type WorkspaceLicensesViewProps } from "./components/licenses/licenses-view";
import * as pkg from "./index";
import { billingKeys, workspaceKeys } from "./queries";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor, perSeat, usd } from "./test-billing-fixtures";
import { cleanup, click, find, findAll, flush, isNeutral, render, setupDom, teardownDom, until } from "./test-dom";
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
  buy: { minSeats: 1, maxSeats: 500 },
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
    offer: workspaceOffer({ price: perSeat(900) }),
    ...overrides,
  });
const WORKSPACE_PRODUCTS = [callEntry(), fleetEntry(), exampleEntry()];
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
const headerProps = (r: Rig, over: Partial<WorkspaceLicensesHeaderActionsProps> = {}): WorkspaceLicensesHeaderActionsProps => ({
  api: r.api,
  billing: r.billing,
  workspaceId: WS,
  offer: { catalog: true, manage: true },
  purchaseId: null,
  navigateOut: r.navigateOut,
  ...over,
});
async function mount(ui: ReactElement, client = newClient()) {
  const mounted = await render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...mounted };
}

/** Waits for the page to leave its loading state, whether it ends up showing the licenses or the unavailable state. */
const loaded = () => until(() => !/Loading licenses…/.test(text()), "the page to load");

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
/** Every text the page shows from now on, one per change to it: a state it passes through for a moment is caught too. */
function watchText() {
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(text()));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}

// ---- who sees what ------------------------------------------------------------------------------------------------

describe("who sees what", () => {
  test("a manager who is offered billing sees every license with its money and the page total", async () => {
    const r = rig();
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    const call = text(cardNamed("Mentra Call Unlimited"));
    for (const expected of ["Active", "3 of 5 assigned", "Nov 20, 2026", "$145 a month", "Before tax"]) expect(call).toContain(expected);
    expect(text(cardNamed("Fleet"))).toContain("$150 a month");
    expect(text()).toContain("2 products · $295 a month in total");
    // The header buttons are the host's to place (`WorkspaceLicensesHeaderActions`): the page draws none.
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy licenses")).toBe(false);
    // The seats are Core's to assign: the people come with the page.
    expect(buttons(cardNamed("Mentra Call Unlimited"))).toContain("Assigned to");
    expect(text(cardNamed("Mentra Call Unlimited"))).toContain("Hannah Kim, Tom Becker and Noah Fischer");
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: null }]);
    expect(r.catalog.mock.calls[0]).toEqual([workspaceScope(WS)]);
    expect(r.listMembers).toHaveBeenCalledTimes(1);
  });

  test("a manager who isn't offered billing sees every product with its licenses and assigns them, but no money, no billing and no buying", async () => {
    const r = rig();
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    const page = text();
    expect(page).toContain("3 of 5 assigned");
    expect(page).toContain("4 of 10 assigned");
    expect(page).not.toContain("$");
    expect(page).not.toContain("Renews");
    expect(page).not.toContain("products ·");
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy licenses")).toBe(false);
    expect(findAll("[data-hosted-page]")).toHaveLength(0);
    expect(findAll('[aria-haspopup="menu"]')).toHaveLength(0);
    // The seats are theirs to give out.
    await click(buttonNamed("Assigned to", cardNamed("Mentra Call Unlimited")));
    expect(hasButton("Assign licenses", cardNamed("Mentra Call Unlimited"))).toBe(true);
    expect(hasButton("Unassign Hannah Kim", cardNamed("Mentra Call Unlimited"))).toBe(true);
    // And billing's status is never asked for.
    expect(r.status).not.toHaveBeenCalled();
    expect(r.catalog).toHaveBeenCalledTimes(1);
  });

  test("a member with a license sees only that product as 'Assigned to you': no total, money, other people or controls", async () => {
    const r = rig({
      role: "member",
      licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })],
      members: new Error("a member cannot list the members"),
      status: new Error("a member's page asks for no status"),
    });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
    const page = text();
    expect(page).toContain("Assigned to you");
    expect(page).toContain("Your license");
    expect(page).toContain("Since Oct 20, 2026");
    expect(page).toContain(`Given by ${WORKSPACE_NAME}`);
    expect(page).toContain("Works in");
    expect(page).toContain("Mentra Call");
    expect(page).toContain(`${WORKSPACE_NAME}'s Admins and Owners assign licenses.`);
    expect(page).not.toContain("$");
    expect(page).not.toContain("products ·");
    expect(page).not.toContain("assigned");
    // The badge is "Assigned to you"; the roster's title, "Assigned to", is for managers.
    expect(page).not.toMatch(/Assigned to(?! you)/);
    expect(buttons()).toEqual([]);
    // No request for billing's status, and none for a members list the member may not read. The catalog is asked for
    // once, after Core's list says there is a license to name.
    expect(r.status).not.toHaveBeenCalled();
    expect(r.listMembers).not.toHaveBeenCalled();
    expect(r.catalog).toHaveBeenCalledTimes(1);
  });

  test("a developer is a member here: the same page", async () => {
    const r = rig({ role: "developer", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain("Assigned to you");
    expect(r.status).not.toHaveBeenCalled();
  });

  test("a member without a license is told so, and the sentence names the workspace", async () => {
    const r = rig({ role: "member", licenses: [] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual([]);
    expect(text()).toContain(`You don't have a license in ${WORKSPACE_NAME}`);
    expect(text()).toContain("Its Admins and Owners assign licenses. Once you have one, it works the next time you open the miniapp it's for.");
    expect(r.status).not.toHaveBeenCalled();
    // Nothing to name, so the catalog isn't asked for either.
    expect(r.catalog).not.toHaveBeenCalled();
  });

  test("a product of the member's without a license of theirs is left out rather than claimed", async () => {
    const r = rig({ role: "member", licenses: [callLicense({ seatsUsed: 0, seats: [] }), fleetLicense({ seats: seatsOf([SELF]), seatsUsed: 1 })] });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(cardNames()).toEqual(["Fleet"]);
  });

  test("an Organization Admin who is no member is a manager: the capabilities decide, not the membership", async () => {
    const detail = { ...detailFor("owner"), membership: null };
    const r = rig({ detail });
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(text()).toContain("2 products · $295 a month in total");
  });

  test("a license that has ended is no card", async () => {
    const r = rig({ licenses: [callLicense(), fleetLicense({ endedAt: "2026-10-01T12:00:00.000Z" })], status: statusFor({ licenses: [callBilling()], total: { ...TOTAL, licenseCount: 1 } }) });
    await mountView(r);
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
  });
});

// ---- when it can't be shown ---------------------------------------------------------------------------------------

describe("exports", () => {
  test("the hook's purchase request has its own name, apart from the contract's PurchaseRequest", () => {
    // A host that imports both `@mentra/workspace-ui` and `@mentra/workspace-contract/portal-billing` can use both.
    const bought: pkg.HostedPurchase = { product: CALL, seats: 2 };
    expect(bought).toEqual({ product: "mentra.call.unlimited", seats: 2 });
  });
});

describe("unavailable", () => {
  test("when the catalog fails the page says so, with Retry, and draws no cards", async () => {
    const r = rig({ catalog: new Error("catalog down") });
    await mountView(r);
    expect(text()).toContain("Licenses are unavailable");
    expect(text()).toContain("They can't be shown right now. Try again in a moment.");
    expect(hasButton("Retry")).toBe(true);
    expect(cardNames()).toEqual([]);
    expect(hasButton("Buy licenses")).toBe(false);
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
    expect(text()).toContain("2 products · $295 a month in total");
  });

  test("Retry also tells the host, so it can read what the page takes as given (whether billing is ready)", async () => {
    const r = rig({ status: new Error("status down") });
    const onRetry = mock(() => {});
    await mountView(r, { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
    await click(buttonNamed("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // A host that asks for nothing gets the same Retry.
    await cleanup();
    const plain = rig({ status: new Error("status down") });
    await mountView(plain);
    const calls = plain.status.mock.calls.length;
    await click(buttonNamed("Retry"));
    await until(() => plain.status.mock.calls.length > calls, "the read to be repeated");
  });

  test("while a failed read is read again, the page keeps saying so: Retry shows it is busy, and Loading never comes back", async () => {
    const r = rig({ status: new Error("status down") });
    const { client } = await mountView(r);
    expect(unavailable()).toBe(true);
    const hold = deferred();
    r.gates.status = hold.promise;
    const calls = r.status.mock.calls.length;
    const watch = watchText();
    await click(buttonNamed("Retry"));
    await until(() => r.status.mock.calls.length > calls, "the read to go out again");
    // The read is out and has no answer: the card is still the unavailable one, with Retry waiting on it.
    expect(text()).toContain("Licenses are unavailable");
    expect(text()).not.toContain("Loading licenses…");
    expect(buttonNamed("Retry").hasAttribute("disabled")).toBe(true);
    expect(buttonNamed("Retry").getAttribute("aria-busy")).toBe("true");
    r.gates.status = null;
    await act(async () => hold.resolve());
    await idle(client);
    // It failed again: the same card, with Retry free to press once more.
    expect(text()).toContain("Licenses are unavailable");
    expect(buttonNamed("Retry").hasAttribute("disabled")).toBe(false);
    watch.stop();
    expect(watch.seen.filter((shown) => shown.includes("Loading licenses…"))).toEqual([]);
  });

  test("polling after a purchase doesn't put 'Loading licenses…' back over the unavailable card, whichever read is failing", async () => {
    const broken: Array<[string, Partial<Answers>]> = [
      ["status", { status: new Error("status down") }],
      ["Core's licenses", { licenses: new Error("core down"), status: statusFor({ purchase: purchaseOf() }) }],
      ["catalog", { catalog: new Error("catalog down"), status: statusFor({ purchase: purchaseOf() }) }],
    ];
    for (const [what, answers] of broken) {
      const r = rig(answers);
      await mountView(r, { purchaseId: "pur_1", pollMs: 15, timeoutMs: 5_000 });
      expect([what, unavailable()]).toEqual([what, true]);
      const watch = watchText();
      const polled = r.status.mock.calls.length;
      await until(() => r.status.mock.calls.length >= polled + 4, `${what}: four more polls`);
      watch.stop();
      expect([what, watch.seen.filter((shown) => shown.includes("Loading licenses…"))]).toEqual([what, []]);
      expect([what, unavailable(), hasButton("Retry")]).toEqual([what, true, true]);
      await cleanup();
    }
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

  test("a member with nothing to name needs no catalog to be told they have no license", async () => {
    const r = rig({ role: "member", licenses: [], catalog: new Error("catalog down") });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain(`You don't have a license in ${WORKSPACE_NAME}`);
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
    expect(find("h2").textContent).toBe("Buy licenses for your members");
    expect(text()).toContain("You'll pay by card on a secure payment page, then come back here to assign the licenses.");
    expect(gridProducts()).toEqual([CALL, FLEET, "mentra.example"]);
    expect(cardNames()).toEqual([]);
    expect(hasButton("Buy licenses")).toBe(false);
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(text()).not.toContain("products ·");
    // The grid is told how many people the workspace has, for its seats step.
    await click(findAll<HTMLButtonElement>("button", find(`[data-product="${FLEET}"]`)).find((button) => button.textContent === "Buy")!);
    expect(text(openDialogs()[0]!)).toContain(`Your workspace has ${PEOPLE.length} members.`);
  });

  test("with licenses the total line follows billing's total, and the page draws no header buttons of its own", async () => {
    const r = rig();
    await mountView(r);
    expect(text()).toContain("2 products · $295 a month in total");
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(hasButton("Buy licenses")).toBe(false);
    // The summary is billing's own total: with none there is no line, and Core adds nothing up.
    await cleanup();
    await mountView(rig({ status: statusFor({ total: null }) }));
    expect(text()).not.toContain("a month in total");
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
  });

  test("with one license its roster is open", async () => {
    const r = rig({ licenses: [callLicense()], status: statusFor({ licenses: [callBilling()], total: { ...TOTAL, amount: usd(14500), licenseCount: 1 } }) });
    await mountView(r);
    expect(text()).toContain("1 product · $145 a month in total");
    const card = cardNamed("Mentra Call Unlimited");
    expect(hasButton("Unassign Hannah Kim", card)).toBe(true);
    expect(hasButton("Assign licenses", card)).toBe(true);
    expect(text(card)).toContain("Available license");
  });

  test("with several each card folds its licenses into a strip that opens its own roster", async () => {
    const r = rig();
    await mountView(r);
    const call = cardNamed("Mentra Call Unlimited");
    expect(hasButton("Unassign Hannah Kim", call)).toBe(false);
    expect(text(call)).toContain("Hannah Kim, Tom Becker and Noah Fischer");
    expect(buttons(call)).toContain("Assigned to");
    await click(buttonNamed("Assigned to", call));
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

  test("a billing entry Core hasn't received is a card of its own, and shows no list of people", async () => {
    const half = fleetBilling({ licenseId: "lic_half", status: "incomplete", fallbackStatusLabel: "Incomplete", actions: [{ kind: "complete_payment", fallbackLabel: "Complete payment", returns: false }] });
    const r = rig({ licenses: [callLicense()], status: statusFor({ licenses: [callBilling(), half], total: { ...TOTAL, licenseCount: 1 } }) });
    await mountView(r);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(text(cardNamed("Fleet"))).toContain("Payment incomplete");
    expect(hasButton("Complete payment", cardNamed("Fleet"))).toBe(true);
    expect(text(cardNamed("Fleet"))).not.toContain("assigned");
  });

  test("a manager with no licenses and nothing offered is told there are none, not shown a blank page", async () => {
    const r = rig({ licenses: [], status: statusFor({ licenses: [], total: null, actions: [] }), catalog: catalogOf([callEntry({ offer: undefined })]) });
    await mountView(r);
    expect(text()).toContain("This workspace has no products yet.");
    expect(text()).not.toContain("Buy licenses");
    expect(text()).not.toContain("You'll pay by card");
  });

  test("a manager who isn't offered billing and has no licenses sees no buying copy, only that there are none", async () => {
    const r = rig({ licenses: [], catalog: catalogOf([callEntry({ offer: undefined }), fleetEntry({ offer: undefined })]) });
    await mountView(r, { offer: { catalog: true, manage: false } });
    expect(text()).toContain("This workspace has no products yet.");
    expect(findAll("h2")).toHaveLength(0);
    expect(text()).not.toContain("Buy licenses");
    expect(text()).not.toContain("You'll pay by card");
    expect(gridProducts()).toEqual([]);
    expect(r.status).not.toHaveBeenCalled();
    // With no license to name and nothing to buy, the catalog isn't needed: it isn't asked for.
    expect(r.catalog).not.toHaveBeenCalled();
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
    expect(text()).toContain("Setting up 5 Mentra Call Unlimited licenses. This takes a few seconds; you can stay on this page.");
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);
    expect(text(cardNamed("Mentra Call Unlimited"))).toContain("Setting up");

    r.answers.status = ready();
    r.answers.licenses = [fleetLicense(), callLicense({ seatsUsed: 0, seats: [] })];
    await until(() => text().includes("Your 5 Mentra Call Unlimited licenses are ready"), "the banner to say ready");
    expect(text()).toContain("Payment received, and Mentra Call Unlimited is active. Assign the licenses to members below.");
    expect(buttons()).toContain("Dismiss");
    // Purchased card first (not by name: Fleet sorts before it), ringed in green, its roster open.
    expect(cardNames()).toEqual(["Mentra Call Unlimited", "Fleet"]);
    const card = cardNamed("Mentra Call Unlimited");
    expect(card.getAttribute("data-ring")).toBe("highlight");
    expect(text(card)).toContain("5 available licenses");
    expect(text(card)).toContain("No one has a license yet");
    expect(buttons(card)).not.toContain("Assigned to");
    expect(buttons(cardNamed("Fleet"))).toContain("Assigned to");
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
    expect(text()).toContain("The licenses can take a few minutes to appear.");
    expect(hasButton("Reload")).toBe(true);
    const calls = r.status.mock.calls.length;
    await delay(150);
    expect(r.status.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  test("polling stops at the deadline even when the page's reads fail and no banner ever mounts", async () => {
    const broken: Array<[string, Partial<Answers>]> = [
      ["status", { status: new Error("status down") }],
      ["Core's licenses", { licenses: new Error("core down"), status: processing() }],
      ["catalog", { catalog: new Error("catalog down"), status: processing() }],
    ];
    for (const [what, answers] of broken) {
      const r = rig(answers);
      // The deadline is far enough ahead (about 25 polls) that a slow machine still sees the page poll before it comes.
      const { client } = await mountView(r, { purchaseId: "pur_1", pollMs: 15, timeoutMs: 400 });
      // The page says so, and there is no banner to keep a clock.
      expect([what, text().includes("Licenses are unavailable"), findAll("[data-phase]").length]).toEqual([what, true, 0]);
      // It is still polling behind the card (this is what the deadline has to stop)...
      const early = r.status.mock.calls.length;
      await until(() => r.status.mock.calls.length >= early + 3, `${what}: polling behind the unavailable card`);
      // ...and stops at the deadline. (React renders what the deadline set when this act scope ends; a read still out,
      // with its retries, is let finish before counting.) After that the count stops growing.
      await delay(500);
      await idle(client);
      const stopped = r.status.mock.calls.length;
      const stoppedLicenses = r.listLicenses.mock.calls.length;
      await delay(200);
      expect([what, r.status.mock.calls.length]).toEqual([what, stopped]);
      expect([what, r.listLicenses.mock.calls.length]).toEqual([what, stoppedLicenses]);
      await cleanup();
    }
  });

  test("the deadline runs from the purchase, not from when a banner first shows: it is set while the page is still loading", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    const hold = deferred();
    r.gates.status = hold.promise;
    const timeouts: unknown[] = [];
    const { setTimeout: realTimeout } = globalThis;
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      timeouts.push(ms);
      return realTimeout(handler, ms, ...args);
    }) as typeof setTimeout;
    try {
      await mount(<WorkspaceLicensesView {...viewProps(r, { purchaseId: "pur_1" })} />);
      await flush();
      expect(text()).toContain("Loading licenses…");
      expect(findAll("[data-phase]")).toHaveLength(0);
    } finally {
      globalThis.setTimeout = realTimeout;
    }
    // Nothing to show yet, no banner, and the minute is already running.
    expect(timeouts).toContain(60000);
    r.gates.status = null;
    await act(async () => hold.resolve());
    await flush();
  });

  test("polling and the deadline stop when the view unmounts", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    await mountView(r, { purchaseId: "pur_1", pollMs: 15, timeoutMs: 5_000 });
    await until(() => r.status.mock.calls.length >= 3 && r.listLicenses.mock.calls.length >= 3, "polling");
    await cleanup();
    const status = r.status.mock.calls.length;
    const licenses = r.listLicenses.mock.calls.length;
    await delay(150);
    expect(r.status.mock.calls.length).toBe(status);
    expect(r.listLicenses.mock.calls.length).toBe(licenses);
  });

  test("only the view polls: unmounting the header leaves it going", async () => {
    const r = rig({ licenses: [fleetLicense()], status: processing() });
    const client = newClient();
    const { rerender } = await mount(
      <>
        <WorkspaceLicensesHeaderActions {...headerProps(r, { purchaseId: "pur_1" })} />
        <WorkspaceLicensesView {...viewProps(r, { purchaseId: "pur_1", ...POLL })} />
      </>,
      client,
    );
    await loaded();
    const before = r.status.mock.calls.length;
    await rerender(
      <QueryClientProvider client={client}>
        <WorkspaceLicensesView {...viewProps(r, { purchaseId: "pur_1", ...POLL })} />
      </QueryClientProvider>,
    );
    await until(() => r.status.mock.calls.length >= before + 2, "the view still polling");
  });

  test("a checkout that collected no payment says 'Purchase complete', and never 'Payment received'", async () => {
    const r = rig({ status: statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call", paid: false }) }) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Mentra Call Unlimited is active.");
    expect(text()).toContain("Your 5 Mentra Call Unlimited licenses are ready");
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
    expect(text()).toContain("Your 2 mentra.gone licenses are ready");
  });
});

// ---- the ?buy= link -----------------------------------------------------------------------------------------------

describe("the ?buy= link", () => {
  const EXAMPLE = "mentra.example";
  const note = (fragment: string) => findAll('[role="status"]').find((element) => text(element).includes(fragment));
  const onBuyHandled = () => mock(() => {});
  const noDialogs = () => expect(openDialogs()).toHaveLength(0);

  test("a product that can be bought opens the Buy dialog on it, at the member count, and tells the host once", async () => {
    const r = rig();
    const handled = onBuyHandled();
    await mountView(r, { buyProduct: EXAMPLE, onBuyHandled: handled });
    await until(() => openDialogs().length === 1, "the Buy dialog");
    const dialog = openDialogs()[0]!;
    expect(find("h2", dialog).textContent).toBe("Buy Example Add-on");
    expect(find<HTMLInputElement>('[role="spinbutton"]', dialog).value).toBe(String(PEOPLE.length));
    expect(handled).toHaveBeenCalledTimes(1);
    // Nothing goes to checkout without the click on Continue to payment.
    expect(r.purchase).not.toHaveBeenCalled();
    await delay(30);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  test("Continue to payment is what buys, with the count in the dialog", async () => {
    const r = rig();
    await mountView(r, { buyProduct: EXAMPLE, onBuyHandled: onBuyHandled() });
    await until(() => openDialogs().length === 1, "the Buy dialog");
    await click(buttonNamed("Continue to payment", openDialogs()[0]!));
    expect(r.purchase.mock.calls).toEqual([[workspaceScope(WS), { product: EXAMPLE, seats: PEOPLE.length }]]);
  });

  test("a workspace of one buys without a stepper", async () => {
    const r = rig({ members: [SELF] });
    await mountView(r, { buyProduct: EXAMPLE, onBuyHandled: onBuyHandled() });
    await until(() => openDialogs().length === 1, "the Buy dialog");
    const dialog = openDialogs()[0]!;
    expect(findAll('[role="spinbutton"]', dialog)).toHaveLength(0);
    expect(text(dialog)).toContain("It's yours once payment goes through.");
  });

  test("with no link nothing opens and the host is not told", async () => {
    const r = rig();
    const handled = onBuyHandled();
    await mountView(r, { buyProduct: null, onBuyHandled: handled });
    await delay(30);
    noDialogs();
    expect(handled).not.toHaveBeenCalled();
  });

  test("a product the workspace holds is a neutral note, and opens nothing", async () => {
    const r = rig();
    const handled = onBuyHandled();
    await mountView(r, { buyProduct: CALL, onBuyHandled: handled });
    await until(() => note("already has") !== undefined, "the note");
    expect(text(note("already has")!)).toBe(`${WORKSPACE_NAME} already has Mentra Call Unlimited.`);
    expect(isNeutral(note("already has")!)).toBe(true);
    noDialogs();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(r.purchase).not.toHaveBeenCalled();
  });

  test("a product billing won't sell now (buy is null) is the same note", async () => {
    const r = rig({ catalog: catalogOf([callEntry(), exampleEntry({ offer: workspaceOffer({ buy: null }) })]) });
    await mountView(r, { buyProduct: EXAMPLE, onBuyHandled: onBuyHandled() });
    await until(() => note("already has") !== undefined, "the note");
    expect(text(note("already has")!)).toBe(`${WORKSPACE_NAME} already has Example Add-on.`);
    noDialogs();
  });

  test("a product that isn't in the offers is 'That product isn't for sale.'", async () => {
    for (const key of ["mentra.nope", EXAMPLE]) {
      const r = rig({ catalog: catalogOf(key === EXAMPLE ? [callEntry(), exampleEntry({ offer: undefined })] : undefined) });
      const handled = onBuyHandled();
      await mountView(r, { buyProduct: key, onBuyHandled: handled });
      await until(() => note("isn't for sale") !== undefined, "the note");
      expect(text(note("isn't for sale")!)).toBe("That product isn't for sale.");
      expect(isNeutral(note("isn't for sale")!)).toBe(true);
      noDialogs();
      expect(handled).toHaveBeenCalledTimes(1);
      await cleanup();
    }
  });

  test("a Member is told to ask an Admin or Owner, by the product's name when the catalog is read, else 'licenses'", async () => {
    const none = rig({ role: "member", licenses: [] });
    const handled = onBuyHandled();
    await mountView(none, { buyProduct: EXAMPLE, offer: { catalog: true, manage: false }, onBuyHandled: handled });
    await until(() => note("Ask one of them") !== undefined, "the note");
    expect(text(note("Ask one of them")!)).toBe(`Only Admins and Owners of ${WORKSPACE_NAME} can buy licenses. Ask one of them.`);
    expect(isNeutral(note("Ask one of them")!)).toBe(true);
    noDialogs();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(none.purchase).not.toHaveBeenCalled();
    await cleanup();

    const named = rig({ role: "member", licenses: [callLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })] });
    await mountView(named, { buyProduct: CALL, offer: { catalog: true, manage: false }, onBuyHandled: onBuyHandled() });
    await until(() => note("Ask one of them") !== undefined, "the note");
    expect(text(note("Ask one of them")!)).toBe(`Only Admins and Owners of ${WORKSPACE_NAME} can buy Mentra Call Unlimited. Ask one of them.`);
  });

  test("a manager who isn't offered billing is told licenses can't be bought here", async () => {
    const r = rig();
    const handled = onBuyHandled();
    await mountView(r, { buyProduct: EXAMPLE, offer: { catalog: true, manage: false }, onBuyHandled: handled });
    await until(() => note("can't be bought here") !== undefined, "the note");
    expect(text(note("can't be bought here")!)).toBe("Licenses can't be bought here.");
    noDialogs();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(r.status).not.toHaveBeenCalled();
  });

  test("it waits for the page's reads, and acts once however often the page reads again", async () => {
    const r = rig();
    const handled = onBuyHandled();
    const { client } = await mountView(r, { buyProduct: EXAMPLE, onBuyHandled: handled });
    await until(() => openDialogs().length === 1, "the Buy dialog");
    await act(async () => void (await client.invalidateQueries()));
    await delay(30);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(openDialogs()).toHaveLength(1);
  });

  test("a note stays after the host removes ?buy=", async () => {
    const r = rig();
    const handled = onBuyHandled();
    const { rerender, client } = await mountView(r, { buyProduct: CALL, onBuyHandled: handled });
    await until(() => note("already has") !== undefined, "the note");
    await rerender(
      <QueryClientProvider client={client}>
        <WorkspaceLicensesView {...viewProps(r, { buyProduct: null, onBuyHandled: handled })} />
      </QueryClientProvider>,
    );
    expect(note("already has")).toBeDefined();
    expect(handled).toHaveBeenCalledTimes(1);
  });
});

describe("the purchase banner when the viewer was given a license", () => {
  const POLL = { pollMs: 15, timeoutMs: 400 };
  const bought = (quantity: number, paid: boolean) => statusFor({ purchase: purchaseOf({ status: "ready", licenseId: "lic_call", quantity, paid }) });
  const withViewer = (quantity: number) => [callLicense({ quantity, seatsUsed: 1, seats: seatsOf([SELF]) })];

  test("one license, paid: 'Your Mentra Call Unlimited license is ready' and 'Payment received, and it's assigned to you.'", async () => {
    const r = rig({ licenses: withViewer(1), status: bought(1, true) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Your Mentra Call Unlimited license is ready");
    expect(text()).toContain("Payment received, and it's assigned to you.");
    expect(text()).not.toContain("Assign the licenses to members below");
  });

  test("one license, not paid: 'Purchase complete' and 'Mentra Call Unlimited is active, and it's assigned to you.'", async () => {
    const r = rig({ licenses: withViewer(1), status: bought(1, false) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Purchase complete");
    expect(text()).toContain("Mentra Call Unlimited is active, and it's assigned to you.");
    expect(text()).not.toContain("Payment received");
  });

  test("five licenses, paid: 'Your 5 Mentra Call Unlimited licenses are ready' and one is assigned to you, the rest below", async () => {
    const r = rig({ licenses: withViewer(5), status: bought(5, true) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Your 5 Mentra Call Unlimited licenses are ready");
    expect(text()).toContain("Payment received, and one is assigned to you. Assign the rest to members below.");
  });

  test("five licenses, not paid", async () => {
    const r = rig({ licenses: withViewer(5), status: bought(5, false) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Your 5 Mentra Call Unlimited licenses are ready");
    expect(text()).toContain("Mentra Call Unlimited is active, and one is assigned to you. Assign the rest to members below.");
    expect(text()).not.toContain("Payment received");
  });

  test("without the viewer's seat on the new license the copy is the existing copy", async () => {
    const r = rig({ status: bought(5, true) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).toContain("Payment received, and Mentra Call Unlimited is active. Assign the licenses to members below.");
    expect(text()).not.toContain("assigned to you");
  });

  test("a seat on another license of the workspace doesn't count", async () => {
    const r = rig({ licenses: [callLicense({ seatsUsed: 0, seats: [] }), fleetLicense({ seatsUsed: 1, seats: seatsOf([SELF]) })], status: bought(5, true) });
    await mountView(r, { purchaseId: "pur_1", ...POLL });
    expect(text()).not.toContain("assigned to you");
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

  describe("hiding it", () => {
    const HIDE = '[role="note"] button[aria-label="Hide the test mode notice"]';
    // The session's storage outlives a test's DOM, as it outlives a page: each test starts a new session.
    afterEach(() => window.sessionStorage.clear());

    test("× hides the banner and changes nothing else: the cards, the total, the buttons and the buy dialog are as they were", async () => {
      const r = rig({ status: statusFor({ testMode }) });
      await mountHeader(r);
      const before = { buttons: buttons(), words: text() };
      await cleanup();
      await mountView(r);
      const cards = cardNames();
      const summary = text();
      const asked = r.status.mock.calls.length;
      await click(find(HIDE));
      expect(findAll('[role="note"]')).toHaveLength(0);
      expect(cardNames()).toEqual(cards);
      expect(text()).toBe(summary.replace(/Test mode · Staging.*?Copy card number/, ""));
      // Test mode itself is unchanged: billing is not asked again for it, and its status still says so.
      expect(r.status.mock.calls.length).toBe(asked);
      expect(before.buttons).toEqual(["Billing & invoices", "Buy licenses"]);
      await cleanup();
      await mountHeader(r);
      await click(buttonNamed("Buy licenses"));
      expect(text()).toContain("Products for your workspace. For one you have, add licenses instead.");
    });

    test("it stays hidden for the page's remount, and a new session shows it again", async () => {
      await mountView(rig({ status: statusFor({ testMode }) }));
      await click(find(HIDE));
      await cleanup();
      await mountView(rig({ status: statusFor({ testMode }) }));
      expect(findAll('[role="note"]')).toHaveLength(0);
      await cleanup();
      window.sessionStorage.clear();
      await mountView(rig({ status: statusFor({ testMode }) }));
      expect(findAll('[role="note"]')).toHaveLength(1);
    });
  });
});

// ---- the header actions -------------------------------------------------------------------------------------------

describe("the Licenses page's header actions", () => {
  test("a manager offered billing, with licenses, has 'Billing & invoices ↗' and 'Buy licenses'", async () => {
    const r = rig();
    await mountHeader(r);
    expect(buttons()).toEqual(["Billing & invoices", "Buy licenses"]);
    // Only the first leaves the portal.
    expect(buttonNamed("Billing & invoices").hasAttribute("data-hosted-page")).toBe(true);
    expect(buttonNamed("Buy licenses").hasAttribute("data-hosted-page")).toBe(false);
    // It reads what the page reads, under the same keys, and no more.
    expect(r.status.mock.calls[0]).toEqual([workspaceScope(WS), { purchase: null }]);
    expect(r.catalog).toHaveBeenCalledTimes(1);
  });

  test("an Organization Admin who is no member has them: the capabilities decide", async () => {
    await mountHeader(rig({ detail: { ...detailFor("owner"), membership: null } }));
    expect(buttons()).toEqual(["Billing & invoices", "Buy licenses"]);
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
    expect(buttons()).toEqual(["Buy licenses"]);
  });

  test("'Buy licenses' is there only where billing offers workspaces something (an entry with an offer)", async () => {
    await mountHeader(rig({ catalog: catalogOf([callEntry({ offer: undefined }), fleetEntry({ offer: undefined })]) }));
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
    // Neutral: amber on these pages is for a failed or incomplete payment, and over-assignment.
    expect(findAll('[role="alert"]').map(isNeutral)).toEqual([true]);
  });

  test("'Buy licenses' owns its dialog: a held product offers Add licenses, any other its price and Buy", async () => {
    const r = rig();
    await mountHeader(r);
    expect(openDialogs()).toHaveLength(0);
    await click(buttonNamed("Buy licenses"));
    const dialog = openDialogs()[0]!;
    expect(text(dialog)).toContain("Products for your workspace. For one you have, add licenses instead.");
    const row = (product: string) => find(`[data-product="${product}"]`, dialog);
    expect(text(row(CALL))).toContain("You have 5 licenses");
    expect(hasButton("Add licenses", row(CALL))).toBe(true);
    expect(text(row(FLEET))).toContain("You have 10 licenses");
    expect(text(row("mentra.example"))).toContain("$9 per user a month");
    expect(hasButton("Buy", row("mentra.example"))).toBe(true);
    // Buy's seats step is told how many people the workspace has.
    await click(buttonNamed("Buy", row("mentra.example")));
    expect(openDialogs().map((open) => text(open)).join(" ")).toContain(`Your workspace has ${PEOPLE.length} members.`);
  });

  test("a new-tab Add licenses from that dialog reads Core's licenses again when the person comes back", async () => {
    const detached = { kind: "add_seats", fallbackLabel: "Add licenses", returns: false };
    const r = rig({ status: statusFor({ licenses: [callBilling({ actions: [detached] }), fleetBilling()] }) });
    await mountHeader(r);
    await click(buttonNamed("Buy licenses"));
    const row = find(`[data-product="${CALL}"]`, openDialogs()[0]!);
    await click(buttonNamed("Add licenses", row));
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
    expect(buttons()).toEqual(["Billing & invoices", "Buy licenses"]);
  });
});

describe("switching workspace on a mounted view", () => {
  const OTHER = "ws_other";

  test("never carries one workspace's billing into another while the other's status is on its way", async () => {
    // Workspace A: two licenses, a total, an invoices action and the test-mode banner.
    const r = rig({ status: statusFor({ testMode: { cardNumber: "4242424242424242", environment: "Staging" } }) });
    const client = newClient();
    const both = (workspaceId: string) => (
      <QueryClientProvider client={client}>
        <WorkspaceLicensesHeaderActions {...headerProps(r, { workspaceId })} />
        <WorkspaceLicensesView {...viewProps(r, { workspaceId })} />
      </QueryClientProvider>
    );
    const { rerender } = await render(both(WS));
    await loaded();
    await idle(client);
    expect(cardNames()).toEqual(["Fleet", "Mentra Call Unlimited"]);
    expect(buttons().filter((name) => name === "Billing & invoices" || name === "Buy licenses")).toHaveLength(2);

    // Workspace B: one smaller license, no total, no actions, no test mode. Its billing status is held back.
    r.answers.licenses = [callLicense({ licenseId: "lic_b", quantity: 2, seatsUsed: 0, seats: [] })];
    r.answers.status = statusFor({
      licenses: [callBilling({ licenseId: "lic_b", quantity: 2, total: usd(5800) })],
      total: { ...TOTAL, amount: usd(5800), licenseCount: 1 },
      actions: [],
      testMode: null,
    });
    const hold = deferred();
    r.gates.status = hold.promise;
    const statusCalls = r.status.mock.calls.length;
    await rerender(both(OTHER));
    await until(() => r.status.mock.calls.length > statusCalls && r.listLicenses.mock.calls.length > 1, "B's reads");
    await flush();
    expect(r.status.mock.calls.at(-1)![0]).toEqual(workspaceScope(OTHER));

    // B's licenses and detail are here, its status isn't: none of A's billing is on the page.
    const during = text();
    for (const aOnly of ["Fleet", "$145", "$150", "$295", "products ·", "Test mode", "Staging", "4242", "lic_fleet"]) {
      expect([aOnly, during.includes(aOnly)]).toEqual([aOnly, false]);
    }
    expect(buttons()).toEqual([]);
    expect(cardNames()).toEqual([]);
    expect(during).toContain("Loading licenses…");

    // B's status arrives: B's billing, and only B's.
    r.gates.status = null;
    await act(async () => hold.resolve());
    await until(() => cardNames().length === 1, "B's card");
    const after = text();
    expect(cardNames()).toEqual(["Mentra Call Unlimited"]);
    expect(after).toContain("$58 a month");
    expect(after).toContain("1 product · $58 a month in total");
    for (const aOnly of ["Fleet", "$145", "$150", "$295", "Test mode", "Staging"]) expect([aOnly, after.includes(aOnly)]).toEqual([aOnly, false]);
    // B listed no billing_and_invoices, so there is no such button, and nothing A offered is asked of B.
    expect(hasButton("Billing & invoices")).toBe(false);
    expect(r.session).not.toHaveBeenCalled();
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
    expect(buttons().filter((name) => name === "Billing & invoices" || name === "Buy licenses")).toEqual(["Billing & invoices", "Buy licenses"]);
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
    expect(hasButton("Buy licenses")).toBe(true);
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
    ["a member with no license", () => mountView(rig({ role: "member", licenses: [] }), { offer: { catalog: true, manage: false } })],
    ["the unavailable page", () => mountView(rig({ status: new Error("down") }))],
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
    expect(hasButton("Billing & invoices") && hasButton("Buy licenses")).toBe(true);
    expect(text()).not.toMatch(LEAK);
    await click(buttonNamed("Buy licenses"));
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
    expect(text(call)).toContain("3 of 6 assigned");

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
    await until(() => text(cardNamed("Mentra Call Unlimited")).includes("3 of 5 assigned"), "the license from Core");
    expect(cardNamed("Mentra Call Unlimited") === call).toBe(true);
  });
});

// ---- the package --------------------------------------------------------------------------------------------------

describe("the package", () => {
  test("exports the view and its header actions, and no personal page, account scope or owner-type helper, nor the older panel or its product labels", () => {
    expect(pkg.WorkspaceLicensesView).toBe(WorkspaceLicensesView);
    expect(pkg.WorkspaceLicensesHeaderActions).toBe(WorkspaceLicensesHeaderActions);
    for (const gone of ["PersonalBillingView", "PersonalBillingHeaderActions", "ACCOUNT_SCOPE", "ownerTypeOf", "catalogForOwner"]) {
      expect(pkg).not.toHaveProperty(gone);
    }
    // Names come from billing's catalog; Core has no table of them, and no older panel to draw licenses with them.
    expect(pkg).not.toHaveProperty("WorkspaceLicensesPanel");
    expect(pkg).not.toHaveProperty("productLabel");
  });
});
