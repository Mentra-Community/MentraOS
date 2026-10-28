/**
 * A fake Core for the portal's page tests: Core's workspace API and billing's routes, answered in memory from a
 * scenario, so a page can be mounted over the real clients (the workspace API, billing's contract-checked client,
 * the portal's own navigation) without a network. The scenarios are the approved design's: Acme Field Services, its
 * fourteen people, the viewer Dana Reyes (its Owner), and three products (Mentra Call Unlimited, Fleet and Example
 * Add-on). Synthetic data only; the app does not import this file.
 *
 * `fakeCore(scenario).fetch` is a `fetch` replacement and `requests` records what the page asked.
 */

import { capabilitiesForRole, type LicenseView, type MemberView, type WorkspaceDetail, type WorkspaceRole } from "@mentra/workspace-contract";
import type {
  BillingAction,
  BillingCatalog,
  BillingStatus,
  CatalogEntry,
  LicenseBilling,
  Money,
  Offer,
  Price,
  PurchaseStatus,
  TestMode,
} from "@mentra/workspace-contract/portal-billing";

export const ACME = "ws_acme";
export const ACME_NAME = "Acme Field Services";
export const CALL = "mentra.call.unlimited";
export const FLEET = "mentra.fleet";
export const EXAMPLE = "example.addon";

const usd = (amountMinor: number): Money => ({ amountMinor, currency: "USD" });
const perSeat = (amountMinor: number): Price => ({ scheme: "per_seat", unit: usd(amountMinor), recurrence: { interval: "month", count: 1 } });
const MONTHLY = { interval: "month" as const, count: 1 };

/** The processor-hosted pages billing sends the browser to. */
export const HOSTED = {
  invoices: "https://billing.example.test/home",
  payment: "https://billing.example.test/pay",
  seats: "https://billing.example.test/seats",
  checkout: "https://billing.example.test/checkout",
  invoice: "https://billing.example.test/invoice/in_1",
};

// ---- people and licenses (Core's) ---------------------------------------------------------------------------------

const person = (key: string, name: string | null, role: WorkspaceRole = "member", extra: Partial<MemberView> = {}): MemberView => ({
  membershipId: `wm_${key}`,
  mentraUserId: `u_${key}`,
  email: `${key.replace("_", ".")}@example.com`,
  name,
  role,
  startedAt: "2026-09-01T12:00:00.000Z",
  pending: false,
  ...extra,
});

export const PEOPLE: MemberView[] = [
  person("dana", "Dana Reyes", "owner"),
  person("priya", "Priya Natarajan", "admin"),
  person("marcus", "Marcus Chen", "admin"),
  person("sofia", "Sofia Alvarez", "developer"),
  person("jamal", "Jamal Wright", "developer"),
  person("hannah", "Hannah Kim"),
  person("tom", "Tom Becker"),
  person("noah", "Noah Fischer"),
  person("ines", "Ines Moreau"),
  person("omar", "Omar Haddad"),
  person("kevin", null),
  person("luis", "Luis Ortega", "member", { startedAt: "2026-10-19T12:00:00.000Z" }),
  person("amara", "Amara Okafor", "member", { startedAt: "2026-10-19T12:00:00.000Z" }),
  person("grace", "Grace Oduya", "member", { pending: true, mentraUserId: null }),
];

const seats = (...keys: string[]) =>
  keys.map(key => ({ membershipId: `wm_${key}`, mentraUserId: `u_${key}`, assignedAt: "2026-10-20T12:00:00.000Z" }));

const coreLicense = (licenseId: string, product: string, feature: string, quantity: number, holders: string[]): LicenseView => ({
  licenseId,
  revision: 1,
  owner: { type: "workspace", workspaceId: ACME },
  product,
  features: [{ key: feature, packages: [] }],
  quantity,
  validFrom: "2026-09-01T12:00:00.000Z",
  paidThrough: "2099-06-15T12:00:00.000Z",
  seatsUsed: holders.length,
  endedAt: null,
  seats: seats(...holders),
});

export const CALL_LICENSE = coreLicense("lic_call", CALL, "call.unlimited", 5, ["hannah", "tom", "noah"]);
export const FLEET_LICENSE = coreLicense("lic_fleet", FLEET, "fleet.managed", 10, [
  "dana",
  "priya",
  "marcus",
  "sofia",
  "jamal",
  "tom",
  "noah",
  "ines",
  "omar",
  "kevin",
]);
export const EXAMPLE_LICENSE = coreLicense("lic_example", EXAMPLE, "example.one", 3, ["dana", "amara"]);

// ---- billing's catalog and status ---------------------------------------------------------------------------------

const workspaceOffer = (unit: number): Offer => ({ price: perSeat(unit), tax: "excluded", buy: { minSeats: 1, maxSeats: 500 } });

const CALL_ENTRY = {
  product: CALL,
  name: "Mentra Call Unlimited",
  shortName: "Call Unlimited",
  description: "Unlimited Teams calls in Mentra Call.",
  icon: "/api/portal/billing/ui/icons/mentra-call.png",
  features: [{ key: "call.unlimited", name: "Unlimited Teams calls", appName: "Mentra Call" }],
} satisfies CatalogEntry;
const FLEET_ENTRY = {
  product: FLEET,
  name: "Fleet",
  description: "Manage your members' phones and glasses, and the miniapps on them.",
  icon: null,
  features: [
    { key: "fleet.managed", name: "Managed phones and glasses" },
    { key: "fleet.assignments", name: "Miniapp assignments" },
    { key: "fleet.usage", name: "Usage reports" },
  ],
} satisfies CatalogEntry;
const EXAMPLE_ENTRY = {
  product: EXAMPLE,
  name: "Example Add-on",
  description: "A placeholder for the next product. Its name, icon, features and price come from the catalog.",
  icon: null,
  features: [
    { key: "example.one", name: "Feature one" },
    { key: "example.two", name: "Feature two" },
  ],
} satisfies CatalogEntry;

/** The workspace catalog. `offers` false is display content only, as a viewer not offered billing gets it. */
export function workspaceCatalog(offers = true): BillingCatalog {
  const entries: CatalogEntry[] = [
    { ...CALL_ENTRY, ...(offers ? { offer: workspaceOffer(2900) } : {}) },
    { ...FLEET_ENTRY, ...(offers ? { offer: workspaceOffer(1500) } : {}) },
    { ...EXAMPLE_ENTRY, ...(offers ? { offer: workspaceOffer(900) } : {}) },
  ];
  return { locale: "en-US", products: entries };
}

const action = (kind: string, fallbackLabel: string, returns?: boolean): BillingAction => ({ kind, fallbackLabel, ...(returns === false ? { returns } : {}) });
const SEAT_ACTIONS = [action("add_seats", "Buy more seats"), action("change_seats", "Change subscription count"), action("cancel", "Cancel")];
export const INVOICES = action("billing_and_invoices", "Billing");

const licenseBilling = (licenseId: string, product: string, unit: number, quantity: number, renewsAt: string, extra: Partial<LicenseBilling> = {}): LicenseBilling => ({
  licenseId,
  product,
  status: "active",
  fallbackStatusLabel: "Active",
  renewsAt,
  price: perSeat(unit),
  quantity,
  total: usd(unit * quantity),
  tax: "excluded",
  actions: SEAT_ACTIONS,
  ...extra,
});

export const CALL_BILLING = licenseBilling("lic_call", CALL, 2900, 5, "2026-11-20T12:00:00.000Z");
export const FLEET_BILLING = licenseBilling("lic_fleet", FLEET, 1500, 10, "2026-11-02T12:00:00.000Z");
export const EXAMPLE_BILLING = licenseBilling("lic_example", EXAMPLE, 900, 3, "2026-11-03T12:00:00.000Z");

/** Fleet's payment failed on Nov 2: its seats keep working until Nov 5. */
export const FLEET_PAST_DUE = licenseBilling("lic_fleet", FLEET, 1500, 10, "2026-11-02T12:00:00.000Z", {
  status: "past_due",
  fallbackStatusLabel: "Payment failed",
  seatsStopAt: "2026-11-05T12:00:00.000Z",
  actions: [action("update_payment", "Update payment method"), ...SEAT_ACTIONS.filter(entry => entry.kind !== "add_seats")],
});

const total = (amountMinor: number, licenseCount: number): BillingStatus["total"] => ({ amount: usd(amountMinor), recurrence: MONTHLY, tax: "excluded", licenseCount });

export const TEST_MODE: TestMode = { cardNumber: "4242424242424242", environment: "Staging" };

export function statusOf(licenses: LicenseBilling[], extra: Partial<BillingStatus> = {}): BillingStatus {
  const charged = licenses.filter(entry => entry.total !== null);
  return {
    locale: "en-US",
    licenses,
    total: licenses.length === 0 ? null : total(charged.reduce((sum, entry) => sum + (entry.total?.amountMinor ?? 0), 0), licenses.length),
    actions: licenses.length === 0 ? [] : [INVOICES],
    testMode: null,
    purchase: null,
    ...extra,
  };
}

export const purchaseOf = (extra: Partial<PurchaseStatus> = {}): PurchaseStatus => ({
  purchaseId: "pur_1",
  status: "processing",
  product: FLEET,
  quantity: 10,
  paid: true,
  licenseId: null,
  ...extra,
});

// ---- the fake ----------------------------------------------------------------------------------------------------

export interface Scenario {
  /** The viewer's role in Acme (Dana is its Owner). */
  role?: WorkspaceRole;
  /** Which of the people is the viewer (`dana`, `hannah`, ...): their membership is the one in the viewer's detail. */
  viewer?: string;
  /** Core's subscriptions for Acme, as the viewer's listing answers them. */
  licenses: LicenseView[];
  members?: MemberView[];
  workspaceCatalog?: BillingCatalog;
  /** Billing's status for Acme; a function sees the `purchase` the page asked about. */
  workspaceStatus?: BillingStatus | ((query: { purchase: string | null }) => BillingStatus);
  /** The answer to `POST session` and `POST purchase`: a URL, or a refusal's status and body. */
  hosted?: (request: { route: "session" | "purchase"; body: Record<string, unknown> }) => { url: string } | { status: number; body: unknown };
}

/** One request the page made. */
export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

/** The viewer's detail in Acme. */
export function acmeDetail(role: WorkspaceRole = "owner", viewer = "dana"): WorkspaceDetail {
  return {
    workspaceId: ACME,
    name: ACME_NAME,
    status: "active",
    authorizationRevision: 3,
    membership: { membershipId: `wm_${viewer}`, role },
    capabilities: [...capabilitiesForRole(role)],
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A fake Core over `scenario`: a `fetch` that answers the workspace API and billing's routes, and records each request. */
export function fakeCore(scenario: Scenario) {
  const role = scenario.role ?? "owner";
  const viewer = scenario.viewer ?? "dana";
  const requests: Recorded[] = [];
  // Copies: a role change or a removal is this fake's own, and no other test's.
  const members = (scenario.members ?? PEOPLE).map(person => ({ ...person }));
  const licenses = [...scenario.licenses];

  const pick = <T,>(value: T | ((query: { purchase: string | null }) => T), query: URLSearchParams): T =>
    typeof value === "function" ? (value as (q: { purchase: string | null }) => T)({ purchase: query.get("purchase") }) : value;

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), "https://portal.example.test");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ method, path: url.pathname, query: url.searchParams, body });
    const path = url.pathname;

    const workspaces = "/api/portal/workspaces";
    if (path === workspaces) return json({ items: [acmeDetail(role, viewer)] });
    if (path === `${workspaces}/invitations/mine`) return json({ items: [] });
    if (path === `${workspaces}/${ACME}` && method === "GET") return json(acmeDetail(role, viewer));
    if (path === `${workspaces}/${ACME}/members`) return json({ items: members });
    const memberRoute = new RegExp(`^${workspaces}/${ACME}/members/([^/]+)$`).exec(path);
    if (memberRoute && method === "PATCH") {
      const target = members.find(person => person.membershipId === memberRoute[1]);
      if (!target) return json({ error: "not_found" }, 404);
      target.role = (body as { role: WorkspaceRole }).role;
      return json({ workspaceId: ACME, name: ACME_NAME, status: "active", authorizationRevision: 4 });
    }
    if (memberRoute && method === "DELETE") {
      const at = members.findIndex(person => person.membershipId === memberRoute[1]);
      if (at < 0) return json({ error: "not_found" }, 404);
      members.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    if (path === `${workspaces}/${ACME}/invitations`) return json({ items: [] });
    if (path === `${workspaces}/${ACME}/licenses`) return json({ items: licenses });
    // Core's ordinary assignment: the seat is the member's, and the next read of the licenses lists it.
    const seatRoute = new RegExp(`^${workspaces}/${ACME}/licenses/([^/]+)/seats/([^/]+)$`).exec(path);
    if (seatRoute && method === "PUT") {
      const at = licenses.findIndex(license => license.licenseId === seatRoute[1]);
      if (at < 0) return json({ error: "license_not_found" }, 404);
      const license = licenses[at]!;
      if (!license.seats?.some(seat => seat.membershipId === seatRoute[2])) {
        licenses[at] = {
          ...license,
          seatsUsed: license.seatsUsed + 1,
          seats: [...(license.seats ?? []), { membershipId: seatRoute[2]!, mentraUserId: seatRoute[2]!.replace(/^wm_/, "u_"), assignedAt: "2026-10-21T12:00:00.000Z" }],
        };
      }
      return json(licenses[at]);
    }

    const billing = "/api/portal/billing";
    const prefix = `${billing}/workspaces/${ACME}`;
    if (path === `${prefix}/catalog` && method === "GET") return json(scenario.workspaceCatalog ?? workspaceCatalog());
    if (path === `${prefix}/status` && method === "GET") return json(pick(scenario.workspaceStatus ?? statusOf([]), url.searchParams));
    if ((path === `${prefix}/session` || path === `${prefix}/purchase`) && method === "POST") {
      const route = path.endsWith("session") ? "session" : "purchase";
      const answer = scenario.hosted?.({ route, body: body ?? {} }) ?? { url: HOSTED.checkout };
      return "url" in answer ? json(answer) : json(answer.body, answer.status);
    }
    return json({ error: "not_found", error_description: `the fake Core has no ${method} ${path}` }, 404);
  }

  return { fetch: handle as unknown as typeof fetch, requests };
}

/** The scenarios of the approved design, by the screen they draw. */
export const SCENARIOS = {
  /** v2-01: no licenses; the catalog. */
  catalog: (): Scenario => ({ licenses: [], workspaceStatus: statusOf([]) }),
  /** v2-02: Call and Fleet. */
  twoActive: (): Scenario => ({
    licenses: [CALL_LICENSE, FLEET_LICENSE],
    workspaceStatus: statusOf([CALL_BILLING, FLEET_BILLING]),
  }),
  /** v2-03: Fleet's payment failed; Call and Example Add-on are active. */
  paymentFailed: (): Scenario => ({
    licenses: [CALL_LICENSE, FLEET_LICENSE, EXAMPLE_LICENSE],
    workspaceStatus: statusOf([CALL_BILLING, FLEET_PAST_DUE, EXAMPLE_BILLING]),
  }),
  /** v2-08: Fleet just bought. Billing says the purchase is ready once asked about it; Core lists the license. */
  purchased: (): Scenario => ({
    licenses: [CALL_LICENSE, FLEET_LICENSE],
    workspaceStatus: ({ purchase }) =>
      statusOf([CALL_BILLING, FLEET_BILLING], { purchase: purchase === "pur_1" ? purchaseOf({ status: "ready", licenseId: "lic_fleet" }) : null }),
  }),
  /** Buying in a workspace of one person (Dana alone): the Buy dialog has no number to choose. */
  solo: (): Scenario => ({ licenses: [], members: [PEOPLE[0]!], workspaceStatus: statusOf([]) }),
  /** After checkout, when Core gave the buyer the one license she bought. */
  purchasedForYou: (): Scenario => {
    const mine = coreLicense("lic_me", CALL, "call.unlimited", 1, ["dana"]);
    return {
      licenses: [mine],
      workspaceStatus: ({ purchase }) =>
        statusOf([licenseBilling("lic_me", CALL, 2900, 1, "2026-11-20T12:00:00.000Z")], {
          purchase: purchase === "pur_1" ? purchaseOf({ status: "ready", product: CALL, quantity: 1, licenseId: "lic_me" }) : null,
        }),
    };
  },
  /** v2-04 to v2-06: three licenses, for the Members list. */
  threeActive: (): Scenario => ({
    licenses: [CALL_LICENSE, FLEET_LICENSE, EXAMPLE_LICENSE],
    workspaceStatus: statusOf([CALL_BILLING, FLEET_BILLING, EXAMPLE_BILLING]),
  }),
  /** v2-09: test mode, the catalog. */
  testMode: (): Scenario => ({ licenses: [], workspaceStatus: statusOf([], { testMode: TEST_MODE }) }),
} as const;
