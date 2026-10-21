import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import type { CatalogEntry, LicenseBilling, Offer, Price } from "@mentra/workspace-contract/portal-billing";
import { createBillingApi, type BillingApi } from "./billing-api";
import { ACCOUNT_SCOPE, workspaceScope, type BillingScope } from "./billing-scope";
import { BillingRefusedError } from "./billing-errors";
import { BuyDialog, canBuy, CatalogCard, CatalogDialog, CatalogGrid } from "./components/licenses/catalog";
import { billingKeys } from "./queries";
import { licenseStrings as t } from "./strings/licenses";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor, perSeat } from "./test-billing-fixtures";
import { byText, cleanup, click, find, findAll, press, render, setupDom, teardownDom } from "./test-dom";
import { runtimeImports } from "./test-imports";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

/** The processor's name, which no page says (spelled in two halves, as the strings' own scan does, so this file doesn't name it either), and "Paid through". */
const NAMES_THE_PROCESSOR = new RegExp(`${["str", "ipe"].join("")}|paid through`, "i");

const WS = workspaceScope("ws_acme");
const PAY = "https://pay.example.test/c/cs_1";

// ---- what billing sends -------------------------------------------------------------------------------------------

/** A workspace's offer: per seat, before tax, ten seats to start with. */
const workspaceOffer = (unit = 1500, overrides: Partial<Offer> = {}): Offer => ({
  price: perSeat(unit),
  tax: "excluded",
  buy: { minSeats: 1, maxSeats: 500, defaultSeats: 10 },
  ...overrides,
});

/** A person's offer: one seat. */
const personOffer = (unit = 2900, overrides: Partial<Offer> = {}): Offer => ({
  price: perSeat(unit),
  tax: "excluded",
  buy: { minSeats: 1, maxSeats: 1, defaultSeats: 1 },
  ...overrides,
});

const callFor = (overrides: Partial<CatalogEntry> = {}) => catalogEntryFor({ offer: workspaceOffer(2900), ...overrides });
const fleet = (overrides: Partial<CatalogEntry> = {}) => fleetEntryFor({ offer: workspaceOffer(1500), ...overrides });
const addOn = (overrides: Partial<CatalogEntry> = {}) =>
  catalogEntryFor({
    product: "mentra.example",
    name: "Example Add-on",
    shortName: undefined,
    description: "A placeholder for the next product.",
    icon: null,
    features: [
      { key: "example.one", name: "Feature one", appName: "Mentra Call" },
      { key: "example.two", name: "Feature two" },
    ],
    ownerTypes: ["workspace", "person"],
    offer: workspaceOffer(900),
    ...overrides,
  });

const WORKSPACE_CATALOG = [callFor(), fleet(), addOn()];

/** A fallback price: a scheme the portal doesn't know, in billing's own words. */
const tiered: Price = { scheme: "tiered", fallbackLabel: "From $10 per seat a month, less in bulk" };

// ---- billing, and the page around it ------------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** The real client over a recorded fetch, so the contract's parsing (and its refusal of unsafe addresses) is what runs. */
function realBilling(respond: (request: Recorded) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const requests: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      path: new URL(String(input), "https://portal.example.test").pathname,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    requests.push(request);
    const answer = await respond(request);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { billing: createBillingApi({ locale: "en-US", fetch }), requests };
}

/** Billing that answers a purchase and a session with `url`. */
const payingAt = (url: string) => realBilling(() => ({ body: { url } }));

/** A client of billing whose calls are `mock`s, for what a test only needs to see called. */
function stubBilling(answers: { purchase?: () => Promise<{ url: string }>; session?: () => Promise<{ url: string }> } = {}) {
  const purchase = mock(async (_scope: BillingScope, _request: { product: string; seats: number }) => (answers.purchase ?? (async () => ({ url: PAY })))());
  const session = mock(
    async (_scope: BillingScope, _request: { action: string; licenseId?: string; seats?: number }) => (answers.session ?? (async () => ({ url: PAY })))(),
  );
  const billing = { locale: "en-US", purchase, session } as unknown as BillingApi;
  return { billing, purchase, session };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets a request and the render it causes finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function mount(ui: ReactElement, client = new QueryClient()) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const text = () => document.body.textContent ?? "";
const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter((dialog) => dialog.open);
const topDialog = () => openDialogs().at(-1)!;
const card = (product: string) => find(`[data-product="${product}"]`);
const buttons = (within: ParentNode = document) => findAll<HTMLButtonElement>("button", within);
const buttonNamed = (label: string, within: ParentNode = document) => byText<HTMLButtonElement>(label, "button", within);
const stepper = (within: ParentNode = document) => find<HTMLInputElement>('[role="spinbutton"]', within);
interface GridOptions {
  products?: readonly CatalogEntry[];
  licenses?: readonly LicenseBilling[];
  scope?: BillingScope;
  billing?: BillingApi;
  memberCount?: number;
}

/** The host's two ways out, recording what is done with them: `leave` sends this tab on, `openTab` opens another in the click. */
function ways(options: { blocked?: boolean } = {}) {
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
  return { events, tab, leave, openTab, navigateOut: { leave, openTab } };
}

function grid(options: GridOptions = {}) {
  const out = ways();
  const stub = stubBilling();
  const ui = (
    <CatalogGrid
      products={options.products ?? WORKSPACE_CATALOG}
      licenses={options.licenses}
      scope={options.scope ?? WS}
      billing={options.billing ?? stub.billing}
      navigateOut={out.navigateOut}
      memberCount={options.memberCount}
    />
  );
  return { ui, ...out, ...stub };
}

// ---- the catalog grid ---------------------------------------------------------------------------------------------

describe("the catalog grid", () => {
  test("a workspace's reads 'Buy a license for your members', with one card per product, its price and Buy", async () => {
    const { ui } = grid();
    await mount(ui);
    expect(find("h2").textContent).toBe("Buy a license for your members");
    expect(text()).toContain("You'll pay by card on a secure payment page, then come back here to give out the seats.");
    expect(findAll("[data-product]").map((element) => element.getAttribute("data-product"))).toEqual([
      "mentra.call.unlimited",
      "mentra.fleet",
      "mentra.example",
    ]);
    expect(find("h3", card("mentra.call.unlimited")).textContent).toBe("Mentra Call Unlimited");
    expect(card("mentra.call.unlimited").textContent).toContain("Unlimited Teams calls in Mentra Call.");
    expect(byText("$29 per seat a month", "p", card("mentra.call.unlimited"))).toBeTruthy();
    expect(byText("$15 per seat a month", "p", card("mentra.fleet"))).toBeTruthy();
    expect(byText("$9 per seat a month", "p", card("mentra.example"))).toBeTruthy();
    for (const element of findAll("[data-product]")) expect(buttons(element).map((button) => button.textContent)).toEqual(["Buy"]);
  });

  test("a person's reads 'Buy a license for yourself', with a price that has no seats in it", async () => {
    const { ui } = grid({ scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer(2900) }), addOn({ offer: personOffer(900) })] });
    await mount(ui);
    expect(find("h2").textContent).toBe("Buy a license for yourself");
    expect(text()).toContain("You'll pay by card on a secure payment page, then come back here.");
    expect(text()).not.toContain("give out the seats");
    expect(byText("$29 a month", "p", card("mentra.call.unlimited"))).toBeTruthy();
    expect(byText("$9 a month", "p", card("mentra.example"))).toBeTruthy();
    expect(text()).not.toContain("per seat");
  });

  test("features are a list only with more than one, each with the miniapp it works in", async () => {
    const { ui } = grid();
    await mount(ui);
    // One feature is the product: no list.
    expect(findAll("ul", card("mentra.call.unlimited"))).toHaveLength(0);
    expect(findAll("li", card("mentra.fleet")).map((item) => item.textContent)).toEqual([
      "Managed phones and glasses",
      "Miniapp assignments",
      "Usage reports",
    ]);
    expect(findAll("li", card("mentra.example")).map((item) => item.textContent)).toEqual(["Feature one in Mentra Call", "Feature two"]);
  });

  test("a product with no icon draws a letter tile, and one with an icon draws billing's image", async () => {
    const { ui } = grid();
    await mount(ui);
    expect(find<HTMLImageElement>("img", card("mentra.call.unlimited")).getAttribute("src")).toBe("/api/portal/billing/ui/icons/mentra-call.png");
    expect(findAll("img", card("mentra.fleet"))).toHaveLength(0);
  });

  test("an entry whose ownerTypes lack the scope's type isn't shown", async () => {
    const workspaceOnly = fleet();
    const personOnly = addOn({ ownerTypes: ["person"], offer: personOffer(900) });
    await mount(grid({ products: [callFor(), workspaceOnly, personOnly] }).ui);
    expect(findAll("[data-product]").map((element) => element.getAttribute("data-product"))).toEqual(["mentra.call.unlimited", "mentra.fleet"]);
    await cleanup();
    await mount(grid({ scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer() }), workspaceOnly, personOnly] }).ui);
    expect(findAll("[data-product]").map((element) => element.getAttribute("data-product"))).toEqual(["mentra.call.unlimited", "mentra.example"]);
  });

  test("with nothing to show it draws nothing, not a heading over no cards", async () => {
    const { container } = await mount(grid({ products: [fleet({ ownerTypes: ["person"] })] }).ui);
    expect(container.textContent).toBe("");
  });

  test("an entry without an offer shows no price and no Buy, and the rest of the card as it is", async () => {
    const { ui } = grid({ products: [callFor({ offer: undefined }), fleet()] });
    await mount(ui);
    const bare = card("mentra.call.unlimited");
    expect(find("h3", bare).textContent).toBe("Mentra Call Unlimited");
    expect(bare.textContent).toContain("Unlimited Teams calls in Mentra Call.");
    expect(bare.textContent).not.toContain("$");
    expect(buttons(bare)).toHaveLength(0);
    expect(buttons(card("mentra.fleet")).map((button) => button.textContent)).toEqual(["Buy"]);
  });

  test("Buy is named for its product to a screen reader, without changing its label", async () => {
    await mount(grid().ui);
    for (const product of ["mentra.call.unlimited", "mentra.fleet"]) {
      const buy = buttonNamed("Buy", card(product));
      const described = buy.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
      expect(described).toContain(find("h3", card(product)).textContent!);
    }
  });

  test("there is no native select, and nothing names the payment processor", async () => {
    await mount(grid().ui);
    expect(findAll("select")).toHaveLength(0);
    expect(text()).not.toMatch(NAMES_THE_PROCESSOR);
  });
});

// ---- what the owner already holds ---------------------------------------------------------------------------------

describe("a product the owner holds", () => {
  const held = [licenseBillingFor({ quantity: 5 })];

  test("a workspace sees 'You have 5 seats' and 'Add seats', and no Buy for it", async () => {
    await mount(grid({ licenses: held }).ui);
    const mine = card("mentra.call.unlimited");
    expect(mine.textContent).toContain("You have 5 seats");
    expect(buttons(mine).map((button) => button.textContent)).toEqual(["Add seats"]);
    expect(mine.textContent).not.toContain("$29");
    // The others are still for sale.
    expect(buttons(card("mentra.fleet")).map((button) => button.textContent)).toEqual(["Buy"]);
  });

  test("one seat is 'You have 1 seat'", async () => {
    await mount(grid({ licenses: [licenseBillingFor({ quantity: 1 })] }).ui);
    expect(card("mentra.call.unlimited").textContent).toContain("You have 1 seat");
    expect(card("mentra.call.unlimited").textContent).not.toContain("1 seats");
  });

  test("a person sees 'You have it', and neither Buy nor Add seats, even if billing listed add_seats", async () => {
    const { ui } = grid({
      scope: ACCOUNT_SCOPE,
      products: [callFor({ offer: personOffer() }), addOn({ offer: personOffer(900) })],
      licenses: [licenseBillingFor({ quantity: 1 })],
    });
    await mount(ui);
    const mine = card("mentra.call.unlimited");
    expect(mine.textContent).toContain("You have it");
    expect(mine.textContent).not.toContain("seat");
    expect(buttons(mine)).toHaveLength(0);
    expect(buttons(card("mentra.example")).map((button) => button.textContent)).toEqual(["Buy"]);
  });

  test("Add seats is offered only when billing lists it for that license", async () => {
    const noAddSeats = licenseBillingFor({ quantity: 5, actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] });
    await mount(grid({ licenses: [noAddSeats] }).ui);
    expect(card("mentra.call.unlimited").textContent).toContain("You have 5 seats");
    expect(buttons(card("mentra.call.unlimited"))).toHaveLength(0);
  });

  test("a product billing won't sell now (buy is null) has no Buy, and keeps its price", async () => {
    const inProgress = callFor({ offer: workspaceOffer(2900, { buy: null }) });
    await mount(grid({ products: [inProgress, fleet()] }).ui);
    const bare = card("mentra.call.unlimited");
    expect(buttons(bare)).toHaveLength(0);
    expect(bare.textContent).toContain("$29 per seat a month");
    expect(bare.textContent).not.toContain("You have");
  });

  test("Add seats asks billing for add_seats on that license and goes to its page", async () => {
    const { ui, session, leave, openTab } = grid({ licenses: [licenseBillingFor({ licenseId: "lic_call_9", quantity: 5 })] });
    await mount(ui);
    await click(buttonNamed("Add seats"));
    await settle();
    expect(session).toHaveBeenCalledTimes(1);
    expect(session.mock.calls[0]).toEqual([WS, { action: "add_seats", licenseId: "lic_call_9" }]);
    expect(leave).toHaveBeenCalledWith(PAY);
    // It returns to the portal, so no other tab is opened for it.
    expect(openTab).not.toHaveBeenCalled();
  });

  test("only the button that was pressed waits, when several products are held", async () => {
    const pending = deferred<{ url: string }>();
    const both = [licenseBillingFor({ quantity: 5 }), licenseBillingFor({ licenseId: "lic_fleet", product: "mentra.fleet", quantity: 10 })];
    const { ui, session } = grid({ licenses: both });
    session.mockImplementation(() => pending.promise);
    await mount(ui);
    await click(buttonNamed("Add seats", card("mentra.fleet")));
    await settle();
    expect(session.mock.calls).toEqual([[WS, { action: "add_seats", licenseId: "lic_fleet" }]]);
    expect(buttonNamed("Add seats", card("mentra.fleet")).getAttribute("aria-busy")).toBe("true");
    const other = buttonNamed("Add seats", card("mentra.call.unlimited"));
    expect(other.disabled).toBe(true);
    expect(other.hasAttribute("aria-busy")).toBe(false);
    await act(async () => pending.reject(new BillingRefusedError("unknown_action", {}, 400)));
    await settle();
  });

  test("while Add seats is being requested nothing else can be bought, and a refusal is worded", async () => {
    const pending = deferred<{ url: string }>();
    const { ui, session, leave } = grid({ licenses: held });
    session.mockImplementation(() => pending.promise);
    await mount(ui);
    await click(buttonNamed("Add seats"));
    await settle();
    expect(session).toHaveBeenCalledTimes(1);
    expect(buttonNamed("Add seats").disabled).toBe(true);
    expect(buttonNamed("Add seats").getAttribute("aria-busy")).toBe("true");
    expect(buttons(card("mentra.fleet"))[0]!.disabled).toBe(true);
    await act(async () => pending.reject(new BillingRefusedError("unknown_action", {}, 400)));
    await settle();
    expect(find('[role="alert"]').textContent).toBe("That isn't available for this license any more. Reload the page and try again.");
    expect(leave).not.toHaveBeenCalled();
    expect(buttonNamed("Add seats").disabled).toBe(false);
  });
});

// ---- Add seats on a page that doesn't return ---------------------------------------------------------------------

describe("Add seats when billing lists it with returns: false", () => {
  const detached = () => [
    licenseBillingFor({
      licenseId: "lic_call_9",
      quantity: 5,
      actions: [{ kind: "add_seats", fallbackLabel: "Add seats", returns: false }],
    }),
  ];
  const INVOICE = "https://invoice.example.test/i/9";

  test("opens a tab in the click itself, asks for the session, then sends that tab there", async () => {
    const pending = deferred<{ url: string }>();
    const { ui, session, events, leave, tab, openTab } = grid({ licenses: detached() });
    session.mockImplementation(() => pending.promise);
    await mount(ui);
    const button = buttonNamed("Add seats");
    let openedInTheClick = -1;
    // Only the synchronous part of the click runs inside this callback: a browser allows the tab only there.
    act(() => {
      button.click();
      openedInTheClick = openTab.mock.calls.length;
    });
    expect(openedInTheClick).toBe(1);
    expect(events).toEqual(["openTab"]);
    await settle();
    expect(session.mock.calls).toEqual([[WS, { action: "add_seats", licenseId: "lic_call_9" }]]);
    await act(async () => pending.resolve({ url: INVOICE }));
    await settle();
    expect(events).toEqual(["openTab", `go:${INVOICE}`]);
    expect(leave).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
  });

  test("says to a screen reader that it opens in a new tab", async () => {
    await mount(grid({ licenses: detached() }).ui);
    const hint = document.getElementById(buttonNamed("Add seats").getAttribute("aria-describedby")!.split(" ").at(-1)!);
    expect(hint?.textContent).toBe("Opens a secure billing page in a new tab");
  });

  test("a session that fails closes the tab and says why", async () => {
    const { ui, session, events, leave } = grid({ licenses: detached() });
    session.mockImplementation(async () => {
      throw new BillingRefusedError("unknown_action", {}, 400);
    });
    await mount(ui);
    await click(buttonNamed("Add seats"));
    await settle();
    expect(events).toEqual(["openTab", "close"]);
    expect(leave).not.toHaveBeenCalled();
    expect(find('[role="alert"]').textContent).toBe("That isn't available for this license any more. Reload the page and try again.");
  });

  test("a blocked tab gives the page back as a link for a second click", async () => {
    const out = ways({ blocked: true });
    const stub = stubBilling();
    await mount(<CatalogGrid products={WORKSPACE_CATALOG} licenses={detached()} scope={WS} billing={stub.billing} navigateOut={out.navigateOut} />);
    await click(buttonNamed("Add seats"));
    await settle();
    expect(out.leave).not.toHaveBeenCalled();
    const link = find<HTMLAnchorElement>("a[data-hosted-page]");
    expect(link.textContent).toBe("Open the payment page");
    expect(link.getAttribute("href")).toBe(PAY);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("a row in the Buy a license dialog does the same", async () => {
    const out = ways();
    const stub = stubBilling();
    await mount(
      <CatalogDialog open onClose={() => {}} products={WORKSPACE_CATALOG} licenses={detached()} scope={WS} billing={stub.billing} navigateOut={out.navigateOut} />,
    );
    await click(buttonNamed("Add seats", find('[data-product="mentra.call.unlimited"]', topDialog())));
    await settle();
    expect(out.events).toEqual(["openTab", `go:${PAY}`]);
    expect(out.leave).not.toHaveBeenCalled();
  });
});

// ---- the seats step -----------------------------------------------------------------------------------------------

describe("the seats step", () => {
  async function openBuyFleet(options: GridOptions = {}) {
    const setup = grid({ memberCount: 14, ...options });
    await mount(setup.ui);
    await click(buttonNamed("Buy", card("mentra.fleet")));
    return setup;
  }

  test("Buy opens 'Buy <product>' with its description, its terms, a stepper at the default, and the member count", async () => {
    await openBuyFleet();
    const dialog = topDialog();
    expect(find("h2", dialog).textContent).toBe("Buy Fleet");
    expect(dialog.textContent).toContain("Manage your members' phones and glasses, and the miniapps on them.");
    expect(dialog.textContent).toContain("$15 per seat a month · Renews every month. Change the seats or cancel at any time.");
    expect(stepper(dialog).getAttribute("aria-valuenow")).toBe("10");
    expect(stepper(dialog).value).toBe("10");
    expect(dialog.textContent).toContain("Your workspace has 14 members.");
    expect(dialog.textContent).toContain("You'll pay by card on a secure payment page.");
    expect(buttons(dialog).map((button) => button.textContent)).toContain("Cancel");
    expect(buttonNamed("Continue to payment", dialog)).toBeTruthy();
    expect(findAll("select", dialog)).toHaveLength(0);
  });

  test("it shows '10 seats × $15 · $150 a month · before tax', and follows the stepper", async () => {
    await openBuyFleet();
    const dialog = topDialog();
    expect(byText("10 seats × $15 · $150 a month · before tax", "p", dialog)).toBeTruthy();
    await click(find('[aria-label="One seat more"]', dialog));
    expect(stepper(dialog).value).toBe("11");
    expect(byText("11 seats × $15 · $165 a month · before tax", "p", dialog)).toBeTruthy();
    await click(find('[aria-label="One seat fewer"]', dialog));
    await click(find('[aria-label="One seat fewer"]', dialog));
    expect(byText("9 seats × $15 · $135 a month · before tax", "p", dialog)).toBeTruthy();
  });

  test("one seat is '1 seat × $15'", async () => {
    await openBuyFleet({ products: [fleet({ offer: workspaceOffer(1500, { buy: { minSeats: 1, maxSeats: 5, defaultSeats: 1 } }) })] });
    expect(byText("1 seat × $15 · $15 a month · before tax", "p", topDialog())).toBeTruthy();
  });

  test("the stepper is bounded by minSeats and maxSeats, and the sum follows the bound", async () => {
    await openBuyFleet({ products: [fleet({ offer: workspaceOffer(1500, { buy: { minSeats: 2, maxSeats: 12, defaultSeats: 11 } }) })] });
    const dialog = topDialog();
    const more = find<HTMLButtonElement>('[aria-label="One seat more"]', dialog);
    const fewer = find<HTMLButtonElement>('[aria-label="One seat fewer"]', dialog);
    expect(stepper(dialog).getAttribute("aria-valuemin")).toBe("2");
    expect(stepper(dialog).getAttribute("aria-valuemax")).toBe("12");
    await click(more);
    expect(stepper(dialog).value).toBe("12");
    expect(more.disabled).toBe(true);
    await press(stepper(dialog), "ArrowUp");
    expect(stepper(dialog).value).toBe("12");
    for (let step = 0; step < 12; step += 1) if (!fewer.disabled) await click(fewer);
    expect(stepper(dialog).value).toBe("2");
    expect(fewer.disabled).toBe(true);
    expect(byText("2 seats × $15 · $30 a month · before tax", "p", dialog)).toBeTruthy();
  });

  test("a default outside the bounds starts at the nearest bound", async () => {
    await openBuyFleet({ products: [fleet({ offer: workspaceOffer(1500, { buy: { minSeats: 3, maxSeats: 8, defaultSeats: 50 } }) })] });
    expect(stepper(topDialog()).value).toBe("8");
    await cleanup();
    await openBuyFleet({ products: [fleet({ offer: workspaceOffer(1500, { buy: { minSeats: 3, maxSeats: 8, defaultSeats: 1 } }) })] });
    expect(stepper(topDialog()).value).toBe("3");
  });

  test("with no maxSeats the sum still never leaves the safe integers", async () => {
    // $10 billion a seat: 9,007 seats is the most whose total a number can hold exactly.
    const huge = fleet({ offer: workspaceOffer(1_000_000_000_000, { buy: { minSeats: 1, defaultSeats: 9000 } }) });
    await openBuyFleet({ products: [huge] });
    const dialog = topDialog();
    expect(stepper(dialog).getAttribute("aria-valuemax")).toBe("9007");
    for (let step = 0; step < 10; step += 1) await press(stepper(dialog), "ArrowUp");
    expect(stepper(dialog).value).toBe("9007");
    expect(find<HTMLButtonElement>('[aria-label="One seat more"]', dialog).disabled).toBe(true);
  });

  test("'before tax' appears only when tax is excluded", async () => {
    const withTax = (tax: string) => [fleet({ offer: workspaceOffer(1500, { tax }) })];
    await openBuyFleet({ products: withTax("included") });
    expect(byText("10 seats × $15 · $150 a month · including tax", "p", topDialog())).toBeTruthy();
    expect(topDialog().textContent).not.toContain("before tax");
    await cleanup();
    await openBuyFleet({ products: withTax("none") });
    expect(byText("10 seats × $15 · $150 a month", "p", topDialog())).toBeTruthy();
    await cleanup();
    await openBuyFleet({ products: withTax("reverse_charge") });
    expect(byText("10 seats × $15 · $150 a month", "p", topDialog())).toBeTruthy();
  });

  test("the sum is in the price's currency and recurrence", async () => {
    const yearly: Price = { scheme: "per_seat", unit: { amountMinor: 14000, currency: "EUR" }, recurrence: { interval: "year", count: 1 } };
    await openBuyFleet({ products: [fleet({ offer: workspaceOffer(0, { price: yearly, tax: "included" }) })] });
    const dialog = topDialog();
    expect(dialog.textContent).toContain("€140 per seat a year · Renews every year.");
    expect(byText("10 seats × €140 · €1,400 a year · including tax", "p", dialog)).toBeTruthy();
  });

  test("Continue to payment calls purchase({product, seats}) and goes to the page it answers", async () => {
    const { billing, requests } = payingAt(PAY);
    const { leave } = await openBuyFleet({ billing });
    const dialog = topDialog();
    await click(find('[aria-label="One seat more"]', dialog));
    await click(buttonNamed("Continue to payment", dialog));
    await settle();
    expect(requests).toEqual([
      { method: "POST", path: "/api/portal/billing/workspaces/ws_acme/purchase", body: { product: "mentra.fleet", seats: 11, locale: "en-US" } },
    ]);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("a purchase always returns to the portal, so it opens no other tab", async () => {
    const { leave, openTab } = await openBuyFleet();
    await click(buttonNamed("Continue to payment", topDialog()));
    await settle();
    expect(leave).toHaveBeenCalledWith(PAY);
    expect(openTab).not.toHaveBeenCalled();
  });

  test("it hands the client the workspace's scope and exactly {product, seats}", async () => {
    const { purchase, leave } = await openBuyFleet();
    await click(buttonNamed("Continue to payment", topDialog()));
    await settle();
    expect(purchase.mock.calls).toEqual([[WS, { product: "mentra.fleet", seats: 10 }]]);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("Continue is a button that leaves the portal: its label stays the label, and it can't be pressed twice", async () => {
    const pending = deferred<{ url: string }>();
    const setup = grid({ memberCount: 14 });
    setup.purchase.mockImplementation(() => pending.promise);
    await mount(setup.ui);
    await click(buttonNamed("Buy", card("mentra.fleet")));
    const dialog = topDialog();
    const go = buttonNamed("Continue to payment", dialog);
    expect(go.hasAttribute("data-hosted-page")).toBe(true);
    expect(document.getElementById(go.getAttribute("aria-describedby")!)!.textContent).toBe("Opens a secure billing page");
    // Two presses before anything has re-rendered, and one after: a single checkout.
    await click(go);
    await click(go);
    await settle();
    await click(go);
    expect(setup.purchase).toHaveBeenCalledTimes(1);
    expect(go.disabled).toBe(true);
    expect(go.getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.resolve({ url: PAY }));
    await settle();
    expect(setup.leave).toHaveBeenCalledTimes(1);
  });

  test("Cancel and Escape close it without buying, and reopening starts fresh", async () => {
    const { purchase, leave } = await openBuyFleet();
    await click(find('[aria-label="One seat more"]', topDialog()));
    expect(stepper(topDialog()).value).toBe("11");
    await click(buttonNamed("Cancel", topDialog()));
    expect(openDialogs()).toHaveLength(0);
    await click(buttonNamed("Buy", card("mentra.fleet")));
    expect(stepper(topDialog()).value).toBe("10");
    await press(topDialog(), "Escape");
    await act(async () => topDialog()?.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(purchase).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  test("closing it while the request is out doesn't send the browser away afterwards", async () => {
    const pending = deferred<{ url: string }>();
    const setup = grid();
    setup.purchase.mockImplementation(() => pending.promise);
    await mount(setup.ui);
    await click(buttonNamed("Buy", card("mentra.fleet")));
    await click(buttonNamed("Continue to payment", topDialog()));
    await click(find('[aria-label="Close"]', topDialog()));
    expect(openDialogs()).toHaveLength(0);
    await act(async () => pending.resolve({ url: PAY }));
    await settle();
    expect(setup.leave).not.toHaveBeenCalled();
  });

  test("without a member count the sentence is left out", async () => {
    await openBuyFleet({ memberCount: undefined });
    expect(topDialog().textContent).not.toContain("members.");
    expect(topDialog().textContent).not.toContain("undefined");
  });

  test("one member is 'Your workspace has 1 member.'", async () => {
    await openBuyFleet({ memberCount: 1 });
    expect(topDialog().textContent).toContain("Your workspace has 1 member.");
  });
});

// ---- people -------------------------------------------------------------------------------------------------------

describe("a person's Buy", () => {
  const personal = () => [callFor({ offer: personOffer() }), addOn({ offer: personOffer(900) })];

  test("skips the seats step: it buys one seat and goes to payment", async () => {
    const { billing, requests } = payingAt(PAY);
    const { ui, leave } = grid({ scope: ACCOUNT_SCOPE, products: personal(), billing });
    await mount(ui);
    await click(buttonNamed("Buy", card("mentra.call.unlimited")));
    expect(openDialogs()).toHaveLength(0);
    expect(findAll('[role="spinbutton"]')).toHaveLength(0);
    await settle();
    expect(requests).toEqual([
      { method: "POST", path: "/api/portal/billing/account/purchase", body: { product: "mentra.call.unlimited", seats: 1, locale: "en-US" } },
    ]);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("buys the offer's seat even if its default is not one", async () => {
    const odd = callFor({ offer: personOffer(2900, { buy: { minSeats: 1, maxSeats: 1, defaultSeats: 4 } }) });
    const { ui, purchase } = grid({ scope: ACCOUNT_SCOPE, products: [odd] });
    await mount(ui);
    await click(buttonNamed("Buy"));
    await settle();
    expect(purchase.mock.calls).toEqual([[ACCOUNT_SCOPE, { product: "mentra.call.unlimited", seats: 1 }]]);
  });

  test("while it is being requested the Buy buttons can't be pressed again", async () => {
    const pending = deferred<{ url: string }>();
    const { ui, purchase } = grid({ scope: ACCOUNT_SCOPE, products: personal() });
    purchase.mockImplementation(() => pending.promise);
    await mount(ui);
    await click(buttonNamed("Buy", card("mentra.call.unlimited")));
    await click(buttonNamed("Buy", card("mentra.example")));
    await settle();
    await click(buttonNamed("Buy", card("mentra.call.unlimited")));
    await click(buttonNamed("Buy", card("mentra.example")));
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(buttonNamed("Buy", card("mentra.example")).disabled).toBe(true);
    expect(buttonNamed("Buy", card("mentra.call.unlimited")).getAttribute("aria-busy")).toBe("true");
    await act(async () => pending.reject(new BillingRefusedError("not_for_sale", {}, 400)));
    await settle();
    expect(find('[role="alert"]').textContent).toBe("Mentra Call Unlimited isn't for sale right now.");
    expect(buttonNamed("Buy", card("mentra.example")).disabled).toBe(false);
  });

  test("BuyDialog is the workspace's step: given a person it draws no seats step at all", async () => {
    const { billing } = stubBilling();
    await mount(
      <BuyDialog open product={callFor({ offer: personOffer() })} billing={billing} scope={ACCOUNT_SCOPE} navigateOut={ways().navigateOut} onClose={() => {}} />,
    );
    expect(openDialogs()).toHaveLength(0);
    expect(findAll('[role="spinbutton"]')).toHaveLength(0);
  });
});

// ---- schemes billing added after this release ---------------------------------------------------------------------

describe("a price of a scheme the portal doesn't know", () => {
  const unknown = () => fleet({ offer: workspaceOffer(1500, { price: tiered }) });

  test("the card shows billing's label exactly, with no arithmetic", async () => {
    await mount(grid({ products: [unknown(), callFor()] }).ui);
    const priced = card("mentra.fleet");
    expect(byText("From $10 per seat a month, less in bulk", "p", priced)).toBeTruthy();
    // None of the offer's numbers is read: the label is all there is.
    expect(priced.textContent).not.toContain("$15");
    // The known price beside it is still Core's.
    expect(byText("$29 per seat a month", "p", card("mentra.call.unlimited"))).toBeTruthy();
  });

  test("a per_seat price that arrives without its numbers is read as its label too", async () => {
    const malformed = fleet({ offer: workspaceOffer(1500, { price: { scheme: "per_seat", fallbackLabel: "About $15 per seat" } }) });
    await mount(grid({ products: [malformed] }).ui);
    expect(byText("About $15 per seat", "p", card("mentra.fleet"))).toBeTruthy();
  });

  test("the seats step shows the label, and no sum, no renewal claim and no tax note", async () => {
    await mount(grid({ products: [unknown()], memberCount: 14 }).ui);
    await click(buttonNamed("Buy"));
    const dialog = topDialog();
    expect(dialog.textContent).toContain("From $10 per seat a month, less in bulk");
    expect(dialog.textContent).not.toContain("×");
    expect(dialog.textContent).not.toContain("Renews every");
    expect(dialog.textContent).not.toContain("before tax");
    expect(dialog.textContent).not.toContain("a month ·");
    // Seats are still asked for, since billing asked for a seat count.
    expect(stepper(dialog).value).toBe("10");
    expect(dialog.textContent).toContain("Your workspace has 14 members.");
  });

  test("it can still be bought: Continue sends the seats chosen", async () => {
    const { ui, purchase, leave } = grid({ products: [unknown()] });
    await mount(ui);
    await click(buttonNamed("Buy"));
    await click(find('[aria-label="One seat fewer"]', topDialog()));
    await click(buttonNamed("Continue to payment", topDialog()));
    await settle();
    expect(purchase.mock.calls).toEqual([[WS, { product: "mentra.fleet", seats: 9 }]]);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("a person's card shows the label too", async () => {
    const entry = callFor({ offer: personOffer(2900, { price: tiered }) });
    await mount(grid({ scope: ACCOUNT_SCOPE, products: [entry] }).ui);
    expect(byText("From $10 per seat a month, less in bulk", "p", card("mentra.call.unlimited"))).toBeTruthy();
  });
});

// ---- addresses the portal won't follow ----------------------------------------------------------------------------

describe("unsafe purchase addresses", () => {
  const refused = t.refusal.generic;

  for (const unsafe of [
    "javascript:alert(document.cookie)",
    "http://pay.example.test/c/cs_1",
    "data:text/html,<script>alert(1)</script>",
    "https://user:secret@pay.example.test/c/cs_1",
    "//pay.example.test/c/cs_1",
  ]) {
    test(`a workspace's purchase answered with ${unsafe.slice(0, 28)} goes nowhere and says so`, async () => {
      const { billing } = payingAt(unsafe);
      const { ui, leave } = grid({ billing, memberCount: 14 });
      await mount(ui);
      await click(buttonNamed("Buy", card("mentra.fleet")));
      await click(buttonNamed("Continue to payment", topDialog()));
      await settle();
      expect(leave).not.toHaveBeenCalled();
      expect(find('[role="alert"]', topDialog()).textContent).toBe(refused);
      // The dialog stays, ready to try again.
      expect(buttonNamed("Continue to payment", topDialog()).disabled).toBe(false);
    });

    test(`a person's purchase answered with ${unsafe.slice(0, 28)} goes nowhere and says so`, async () => {
      const { billing } = payingAt(unsafe);
      const { ui, leave } = grid({ billing, scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer() })] });
      await mount(ui);
      await click(buttonNamed("Buy"));
      await settle();
      expect(leave).not.toHaveBeenCalled();
      expect(find('[role="alert"]').textContent).toBe(refused);
    });
  }

  test("an Add seats session answered with an address the portal won't follow goes nowhere either", async () => {
    const { billing } = payingAt("javascript:alert(1)");
    const { ui, leave } = grid({ billing, licenses: [licenseBillingFor()] });
    await mount(ui);
    await click(buttonNamed("Add seats"));
    await settle();
    expect(leave).not.toHaveBeenCalled();
    expect(find('[role="alert"]').textContent).toBe(refused);
  });

  test("https, and http to localhost or 127.0.0.1, are followed (as the canonical address)", async () => {
    for (const [sent, followed] of [
      ["https://pay.example.test/c/cs_1", "https://pay.example.test/c/cs_1"],
      ["http://localhost:4242/pay", "http://localhost:4242/pay"],
      ["http://127.0.0.1:4242/pay", "http://127.0.0.1:4242/pay"],
      ["  https://pay.example.test/a b", "https://pay.example.test/a%20b"],
    ] as const) {
      const { billing } = payingAt(sent);
      const { ui, leave } = grid({ billing, scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer() })] });
      await mount(ui);
      await click(buttonNamed("Buy"));
      await settle();
      expect(leave).toHaveBeenCalledWith(followed);
      await cleanup();
    }
  });

  test("billing being unreachable is the same generic line", async () => {
    const billing = createBillingApi({ locale: "en-US", fetch: (async () => Promise.reject(new TypeError("offline"))) as never });
    const { ui, leave } = grid({ billing, scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer() })] });
    await mount(ui);
    await click(buttonNamed("Buy"));
    await settle();
    expect(leave).not.toHaveBeenCalled();
    expect(find('[role="alert"]').textContent).toBe(refused);
  });
});

// ---- refusals -----------------------------------------------------------------------------------------------------

describe("refusals", () => {
  const refusing = (status: number, error: string, details: Record<string, unknown> = {}) => realBilling(() => ({ status, body: { error, ...details } }));

  async function buyFleet(billing: BillingApi, client = new QueryClient()) {
    const setup = grid({ billing, memberCount: 14 });
    await mount(setup.ui, client);
    await click(buttonNamed("Buy", card("mentra.fleet")));
    await click(buttonNamed("Continue to payment", topDialog()));
    await settle();
    return setup;
  }

  test("already_licensed says 'You already have <product>. Add seats instead.', refetches billing, and stops the purchase", async () => {
    const client = new QueryClient();
    const invalidate = spyOn(client, "invalidateQueries");
    const { leave } = await buyFleet(refusing(409, "already_licensed", { licenseId: "lic_fleet" }).billing, client);
    expect(find('[role="alert"]', topDialog()).textContent).toBe("You already have Fleet. Add seats instead.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.owner(WS) });
    expect(leave).not.toHaveBeenCalled();
    // It is held now: another try would only be refused again.
    expect(buttonNamed("Continue to payment", topDialog()).disabled).toBe(true);
    expect(buttonNamed("Cancel", topDialog()).disabled).toBe(false);
  });

  test("for a person it is 'You already have <product>.' and nothing about seats", async () => {
    const client = new QueryClient();
    const invalidate = spyOn(client, "invalidateQueries");
    const { billing } = refusing(409, "already_licensed", { licenseId: "lic_call" });
    const { ui } = grid({ billing, scope: ACCOUNT_SCOPE, products: [callFor({ offer: personOffer() })] });
    await mount(ui, client);
    await click(buttonNamed("Buy"));
    await settle();
    expect(find('[role="alert"]').textContent).toBe("You already have Mentra Call Unlimited.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.owner(ACCOUNT_SCOPE) });
  });

  test("checkout_in_progress says a purchase is under way, and leaves the button for another try", async () => {
    const client = new QueryClient();
    const invalidate = spyOn(client, "invalidateQueries");
    await buyFleet(refusing(409, "checkout_in_progress").billing, client);
    expect(find('[role="alert"]', topDialog()).textContent).toBe(
      "A purchase of Fleet is already under way. Finish it, or try again in a minute.",
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(buttonNamed("Continue to payment", topDialog()).disabled).toBe(false);
  });

  test("not_for_sale, invalid_seats and a code Core doesn't know are worded, and the generic line covers the rest", async () => {
    await buyFleet(refusing(400, "not_for_sale").billing);
    expect(find('[role="alert"]', topDialog()).textContent).toBe("Fleet isn't for sale right now.");
    await cleanup();
    await buyFleet(refusing(400, "invalid_seats").billing);
    expect(find('[role="alert"]', topDialog()).textContent).toBe("That number of seats isn't available. Choose a different number.");
    await cleanup();
    await buyFleet(refusing(418, "teapot").billing);
    expect(find('[role="alert"]', topDialog()).textContent).toBe(t.refusal.generic);
    await cleanup();
    await buyFleet(realBilling(() => ({ status: 502, body: "<html>bad gateway</html>" })).billing);
    expect(find('[role="alert"]', topDialog()).textContent).toBe(t.refusal.generic);
  });

  test("a new attempt clears the last refusal", async () => {
    let attempt = 0;
    const { billing } = realBilling(() => (attempt++ === 0 ? { status: 409, body: { error: "checkout_in_progress" } } : { body: { url: PAY } }));
    const { leave } = await buyFleet(billing);
    expect(findAll('[role="alert"]', topDialog())).toHaveLength(1);
    await click(buttonNamed("Continue to payment", topDialog()));
    await settle();
    expect(leave).toHaveBeenCalledWith(PAY);
    expect(findAll('[role="alert"]')).toHaveLength(0);
  });
});

// ---- Buy a license, as a dialog -----------------------------------------------------------------------------------

describe("the catalog dialog", () => {
  const dialogFor = (options: GridOptions & { open?: boolean } = {}) => {
    const out = ways();
    const onClose = mock(() => {});
    const stub = stubBilling();
    const ui = (
      <CatalogDialog
        open={options.open ?? true}
        onClose={onClose}
        products={options.products ?? WORKSPACE_CATALOG}
        licenses={options.licenses}
        scope={options.scope ?? WS}
        billing={options.billing ?? stub.billing}
        navigateOut={out.navigateOut}
        memberCount={options.memberCount}
      />
    );
    return { ui, ...out, onClose, ...stub };
  };
  const row = (product: string) => find(`[data-product="${product}"]`, topDialog());
  const held = [licenseBillingFor({ quantity: 5 }), licenseBillingFor({ licenseId: "lic_fleet", product: "mentra.fleet", quantity: 10 })];

  test("is 'Buy a license', with what to do for a product you have", async () => {
    await mount(dialogFor({ licenses: held }).ui);
    expect(find("h2", topDialog()).textContent).toBe("Buy a license");
    expect(topDialog().textContent).toContain("Products for your workspace. For one you have, add seats instead.");
  });

  test("a held product shows 'You have <n> seats' and Add seats; any other shows its price and Buy", async () => {
    await mount(dialogFor({ licenses: held }).ui);
    expect(row("mentra.call.unlimited").textContent).toContain("You have 5 seats");
    expect(buttons(row("mentra.call.unlimited")).map((button) => button.textContent)).toEqual(["Add seats"]);
    expect(row("mentra.fleet").textContent).toContain("You have 10 seats");
    expect(buttons(row("mentra.fleet")).map((button) => button.textContent)).toEqual(["Add seats"]);
    expect(row("mentra.example").textContent).toContain("Example Add-on");
    expect(row("mentra.example").textContent).toContain("$9 per seat a month");
    expect(buttons(row("mentra.example")).map((button) => button.textContent)).toEqual(["Buy"]);
  });

  test("a row shows the product's icon beside its name, and no feature list or description", async () => {
    await mount(dialogFor({ licenses: held }).ui);
    expect(find<HTMLImageElement>("img", row("mentra.call.unlimited")).getAttribute("src")).toBe("/api/portal/billing/ui/icons/mentra-call.png");
    expect(findAll("ul", row("mentra.fleet"))).toHaveLength(0);
    expect(row("mentra.fleet").textContent).not.toContain("Manage your members");
  });

  test("Buy on a row opens the seats step over the list, and Cancel returns to the list", async () => {
    await mount(dialogFor({ licenses: held, memberCount: 14 }).ui);
    await click(buttonNamed("Buy", row("mentra.example")));
    expect(openDialogs()).toHaveLength(2);
    expect(find("h2", topDialog()).textContent).toBe("Buy Example Add-on");
    expect(byText("10 seats × $9 · $90 a month · before tax", "p", topDialog())).toBeTruthy();
    await click(buttonNamed("Cancel", topDialog()));
    expect(openDialogs()).toHaveLength(1);
    expect(find("h2", topDialog()).textContent).toBe("Buy a license");
  });

  test("Add seats on a row asks for add_seats and goes to the page", async () => {
    const { ui, session, leave } = dialogFor({ licenses: held });
    await mount(ui);
    await click(buttonNamed("Add seats", row("mentra.fleet")));
    await settle();
    expect(session.mock.calls).toEqual([[WS, { action: "add_seats", licenseId: "lic_fleet" }]]);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("for a person a row's Buy skips the seats step, and a held product says 'You have it'", async () => {
    const products = [callFor({ offer: personOffer() }), addOn({ offer: personOffer(900) })];
    const { ui, purchase, leave } = dialogFor({ scope: ACCOUNT_SCOPE, products, licenses: [licenseBillingFor({ quantity: 1 })] });
    await mount(ui);
    expect(topDialog().textContent).toContain("Products you can buy for yourself.");
    expect(topDialog().textContent).not.toContain("workspace");
    expect(row("mentra.call.unlimited").textContent).toContain("You have it");
    expect(buttons(row("mentra.call.unlimited"))).toHaveLength(0);
    expect(row("mentra.example").textContent).toContain("$9 a month");
    await click(buttonNamed("Buy", row("mentra.example")));
    await settle();
    expect(openDialogs()).toHaveLength(1);
    expect(purchase.mock.calls).toEqual([[ACCOUNT_SCOPE, { product: "mentra.example", seats: 1 }]]);
    expect(leave).toHaveBeenCalledWith(PAY);
  });

  test("a refusal on a row is shown in the list, and already_licensed refetches", async () => {
    const client = new QueryClient();
    const invalidate = spyOn(client, "invalidateQueries");
    const { billing } = realBilling(() => ({ status: 409, body: { error: "already_licensed", licenseId: "lic_call" } }));
    const products = [callFor({ offer: personOffer() }), addOn({ offer: personOffer(900) })];
    await mount(dialogFor({ billing, scope: ACCOUNT_SCOPE, products }).ui, client);
    await click(buttonNamed("Buy", row("mentra.example")));
    await settle();
    expect(find('[role="alert"]', topDialog()).textContent).toBe("You already have Example Add-on.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingKeys.owner(ACCOUNT_SCOPE) });
  });

  test("closing it (Escape, ×, the backdrop) asks the host to, and reopening starts without the old refusal", async () => {
    const { billing } = realBilling(() => ({ status: 400, body: { error: "not_for_sale" } }));
    const products = [callFor({ offer: personOffer() })];
    const setup = dialogFor({ billing, scope: ACCOUNT_SCOPE, products });
    const { rerender } = await mount(setup.ui);
    await click(buttonNamed("Buy"));
    await settle();
    expect(findAll('[role="alert"]')).toHaveLength(1);
    await click(find('[aria-label="Close"]', topDialog()));
    expect(setup.onClose).toHaveBeenCalled();
    await rerender(
      <QueryClientProvider client={new QueryClient()}>
        {dialogFor({ billing, scope: ACCOUNT_SCOPE, products, open: false }).ui}
      </QueryClientProvider>,
    );
    expect(openDialogs()).toHaveLength(0);
    await rerender(<QueryClientProvider client={new QueryClient()}>{dialogFor({ billing, scope: ACCOUNT_SCOPE, products }).ui}</QueryClientProvider>);
    expect(findAll('[role="alert"]')).toHaveLength(0);
  });

  test("closed, it draws nothing", async () => {
    await mount(dialogFor({ open: false }).ui);
    expect(openDialogs()).toHaveLength(0);
    expect(findAll("button", find("dialog"))).toHaveLength(0);
  });

  test("the owner-type rule holds here too, and an entry without an offer is a row with no price and no Buy", async () => {
    const products = [callFor({ offer: undefined }), fleet({ ownerTypes: ["person"] }), addOn()];
    await mount(dialogFor({ products }).ui);
    expect(findAll("[data-product]", topDialog()).map((element) => element.getAttribute("data-product"))).toEqual([
      "mentra.call.unlimited",
      "mentra.example",
    ]);
    expect(row("mentra.call.unlimited").textContent).toBe("Mentra Call Unlimited");
    expect(buttons(row("mentra.call.unlimited"))).toHaveLength(0);
  });

  test("a product billing won't sell now has no Buy and no Add seats", async () => {
    const products = [callFor({ offer: workspaceOffer(2900, { buy: null }) })];
    await mount(dialogFor({ products }).ui);
    expect(buttons(row("mentra.call.unlimited"))).toHaveLength(0);
    expect(row("mentra.call.unlimited").textContent).toContain("$29 per seat a month");
  });

  test("a screen reader hears whose button it is, there is no native select, and nothing names the processor", async () => {
    await mount(dialogFor({ licenses: held }).ui);
    const buy = buttonNamed("Buy", row("mentra.example"));
    const describedBy = buy.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(describedBy).toContain("Example Add-on");
    const add = buttonNamed("Add seats", row("mentra.fleet"));
    expect(add.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain("Fleet");
    expect(findAll("select")).toHaveLength(0);
    expect(text()).not.toMatch(NAMES_THE_PROCESSOR);
  });
});

// ---- the pieces ---------------------------------------------------------------------------------------------------

describe("canBuy", () => {
  test("is true only for an entry with an offer whose buy isn't null", () => {
    expect(canBuy(callFor())).toBe(true);
    expect(canBuy(callFor({ offer: undefined }))).toBe(false);
    expect(canBuy(callFor({ offer: workspaceOffer(2900, { buy: null }) }))).toBe(false);
  });
});

describe("CatalogCard", () => {
  test("is the card the grid is made of: a held product with its own handlers", async () => {
    const onBuy = mock(() => {});
    await mount(
      <CatalogCard entry={callFor()} scope="workspace" locale="en-US" held={null} busy={false} pending={false} onBuy={onBuy} onAddSeats={() => {}} />,
    );
    await click(buttonNamed("Buy"));
    expect(onBuy).toHaveBeenCalledTimes(1);
  });

  test("prices in the locale it is given", async () => {
    const entry = callFor({ offer: workspaceOffer(2900, { price: { scheme: "per_seat", unit: { amountMinor: 1450, currency: "USD" }, recurrence: { interval: "month", count: 3 } } }) });
    await mount(
      <CatalogCard entry={entry} scope="workspace" locale="en-US" held={null} busy={false} pending={false} onBuy={() => {}} onAddSeats={() => {}} />,
    );
    expect(byText("$14.50 per seat every 3 months", "p")).toBeTruthy();
  });
});

describe("what the buying components import", () => {
  test("the contract's schemas are reached through billing-format's isPerSeat only, never the client", () => {
    const { files } = runtimeImports("components/licenses/catalog.tsx");
    // The client (and with it the schemas for every answer) is the host's to bring; the dialogs take it as a prop.
    expect(files.some((file) => file.endsWith("billing-api.ts"))).toBe(false);
  });
});
