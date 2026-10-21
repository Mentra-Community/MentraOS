/**
 * The Members list's Licenses column and selection, the Assign licenses dialog and the member panel, driven in a
 * DOM against an in-memory Core: every request the screens make is answered from `World`, so a seat that is
 * assigned is a seat the next read lists. Synthetic data only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAX_SEAT_ASSIGNMENTS, type LicenseView, type MemberView, type WorkspaceDetail, type WorkspaceRole } from "@mentra/workspace-contract";
import type { CatalogEntry, LicenseBilling } from "@mentra/workspace-contract/portal-billing";
import { act } from "react";
import { createWorkspaceApi, type FetchLike, type WorkspaceApi } from "./api";
import { BillingRefusedError } from "./billing-errors";
import { workspaceScope } from "./billing-scope";
import type { HostedBilling } from "./components/licenses/hosted-action";
import { MemberPanel } from "./components/member-panel";
import { WorkspaceMembersPanel, type MembersLicenses } from "./components/members-panel";
import { formatDate } from "./lib/format";
import { billingKeys } from "./queries";
import { ROLE_LABELS } from "./roles";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor } from "./test-billing-fixtures";
import { byText, cleanup, click, find, findAll, flush, isNeutral, press, render, setupDom, teardownDom, until } from "./test-dom";
import { runtimeImports, SCHEMA_SPECIFIER } from "./test-imports";
import { detailFor, licenseFor, seedClient, START, WORKSPACE_ID } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
let assignmentLimitBody: Promise<void> | undefined;
afterEach(async () => {
  // A timed-out test leaves React's original act scope running. Settle that body
  // before unmounting so it cannot keep the next test's render inside its scope.
  const original = assignmentLimitBody;
  assignmentLimitBody = undefined;
  if (original) await original.catch(() => {});
  await cleanup();
});

const BASE = "/api/portal/workspaces";
const JOINED_LATER = "2026-10-19T10:00:00.000Z";

const member = (membershipId: string, email: string | null, name: string | null, role: WorkspaceRole = "member", extra: Partial<MemberView> = {}): MemberView => ({
  membershipId,
  mentraUserId: `u_${membershipId.slice(3)}`,
  email,
  name,
  role,
  startedAt: JOINED_LATER,
  pending: false,
  ...extra,
});

const SAM = member("wm_self", "sam@acme.test", "Sam Carter", "owner", { startedAt: START });
const ADAM = member("wm_adam", "adam@acme.test", "Adam Park", "admin", { startedAt: START });
const DANA = member("wm_dana", "dana@acme.test", "Dana Reyes", "developer", { startedAt: START });
const LUIS = member("wm_luis", "luis@acme.test", "Luis Ortega");
const AMARA = member("wm_amara", "amara@acme.test", "Amara Okafor");
const ZED = member("wm_zed", "zed@acme.test", "Zed Young");
const MAX = member("wm_max", "max@acme.test", null, "member", { startedAt: START });
const GRACE = member("wm_grace", "grace@acme.test", null, "member", { mentraUserId: null, pending: true });
const MEMBERS = [SAM, ADAM, DANA, LUIS, AMARA, ZED, MAX, GRACE];

const seat = (membershipId: string) => ({ membershipId, mentraUserId: `u_${membershipId.slice(3)}`, assignedAt: START });

/** A license of this workspace holding seats for `holders`; `quantity` seats bought. */
function license(licenseId: string, product: string, quantity: number, holders: string[]): LicenseView {
  return licenseFor({ licenseId, product, quantity, seatsUsed: holders.length, seats: holders.map(seat) });
}

const CALL = () => license("lic_call", "mentra.call.unlimited", 5, ["wm_dana", "wm_max", "wm_adam"]);
const FLEET = () => license("lic_fleet", "mentra.fleet", 10, Array.from({ length: 10 }, (_, i) => `wm_f${i}`));
const EXAMPLE = () => license("lic_example", "mentra.example", 3, ["wm_amara", "wm_dana"]);
const BOTH = () => license("lic_both", "mentra.both", 4, ["wm_luis", "wm_amara"]);

/** What a host reads from `status.licenses` for a viewer who is offered billing: each license lists add_seats. */
const BILLING: LicenseBilling[] = [
  ["lic_call", "mentra.call.unlimited"],
  ["lic_fleet", "mentra.fleet"],
  ["lic_example", "mentra.example"],
  ["lic_both", "mentra.both"],
].map(([licenseId, product]) => licenseBillingFor({ licenseId: licenseId!, product: product! }));

const exampleEntry = (product = "mentra.example", name = "Example Add-on") =>
  catalogEntryFor({ product, name, shortName: undefined, icon: null, features: [], description: "An example add-on." });
const CATALOG: CatalogEntry[] = [catalogEntryFor(), fleetEntryFor(), exampleEntry(), exampleEntry("mentra.both", "Both Add-on")];

const PAGE = "https://pay.example.test/session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** How many times Core's licenses for the workspace have been read: what a return to the window reads again. */
const licenseReads = (calls: readonly { method: string; path: string }[]) =>
  calls.filter((call) => call.method === "GET" && call.path === `/${WORKSPACE_ID}/licenses`).length;
/** The person comes back to this window, from the page billing opened in a tab of its own. */
const comeBack = () => act(async () => void window.dispatchEvent(new Event("focus")));

/**
 * The host's side of "Add seats ↗": billing's client (answering each session from `answer`, which a test may swap) and
 * the two ways out of the portal, recording what happens to them in order.
 */
function hostRig(answer: (request: Record<string, unknown>) => Promise<{ url: string }> = async () => ({ url: PAGE })) {
  const events: string[] = [];
  const tab = {
    go: mock((url: string) => void events.push(`go:${url}`)),
    close: mock(() => void events.push("close")),
  };
  const openTab = mock(() => {
    events.push("openTab");
    return tab as typeof tab | null;
  });
  const leave = mock((url: string) => void events.push(`leave:${url}`));
  const session = mock(async (_scope: unknown, request: Record<string, unknown>) => {
    events.push(`session:${String(request.action)}`);
    return answer(request);
  });
  const purchase = mock(async (_scope: unknown, _request: { product: string; seats: number }) => ({ url: PAGE }));
  return { events, tab, openTab, leave, session, purchase, billingApi: { session, purchase } as unknown as HostedBilling, navigateOut: { leave, openTab } };
}
type HostRig = ReturnType<typeof hostRig>;

/** Billing lists `add_seats` for these two as an action that opens its page in a tab of its own. */
const NEW_TAB_BILLING: LicenseBilling[] = BILLING.map((entry) => ({
  ...entry,
  actions: entry.actions.map((action) => (action.kind === "add_seats" ? { ...action, returns: false } : action)),
}));

/** Core's side: the data the screens read, and what they write. */
interface World {
  detail: WorkspaceDetail;
  members: MemberView[];
  licenses: LicenseView[];
  /** Answers a request with this instead of serving it, when it returns a response. */
  fail?: (call: Call) => Response | undefined;
  /** Holds every change (PATCH) back until it is released, so a test can have one in flight. */
  gate?: Promise<void>;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const reply = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

function giveSeat(world: World, licenseId: string, membershipId: string) {
  const target = world.licenses.find((candidate) => candidate.licenseId === licenseId)!;
  if (target.seats!.some((held) => held.membershipId === membershipId)) return target;
  target.seats = [...target.seats!, seat(membershipId)];
  target.seatsUsed = target.seats.length;
  return target;
}

function takeSeat(world: World, licenseId: string, membershipId: string) {
  const target = world.licenses.find((candidate) => candidate.licenseId === licenseId)!;
  target.seats = target.seats!.filter((held) => held.membershipId !== membershipId);
  target.seatsUsed = target.seats.length;
}

function serve(world: World, calls: Call[], basePath: string): FetchLike {
  return async (input, init) => {
    const path = String(input).slice(basePath.length);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path, body };
    calls.push(call);
    if (world.gate && method === "PATCH") await world.gate;
    const forced = world.fail?.(call);
    if (forced) return forced;
    const ws = `/${WORKSPACE_ID}`;
    if (method === "GET" && path === ws) return reply(200, world.detail);
    if (method === "GET" && path === `${ws}/members`) return reply(200, { items: world.members });
    if (method === "GET" && path === `${ws}/licenses`) return reply(200, { items: world.licenses });
    const seatRoute = new RegExp(`^${ws}/licenses/([^/]+)/seats/([^/]+)$`).exec(path);
    if (seatRoute && method === "PUT") {
      const target = world.licenses.find((candidate) => candidate.licenseId === seatRoute[1])!;
      const held = target.seats!.some((candidateSeat) => candidateSeat.membershipId === seatRoute[2]);
      if (!held && target.seatsUsed >= target.quantity) return reply(409, { error: "no_seats_available", error_description: "every seat is assigned" });
      return reply(200, giveSeat(world, seatRoute[1]!, seatRoute[2]!));
    }
    if (seatRoute && method === "DELETE") {
      takeSeat(world, seatRoute[1]!, seatRoute[2]!);
      return reply(204);
    }
    if (method === "POST" && path === `${ws}/seat-assignments`) {
      const pairs = (body as { assignments: { licenseId: string; membershipId: string }[] }).assignments;
      const short = world.licenses
        .map((candidate) => {
          const needed = new Set(
            pairs.filter((pair) => pair.licenseId === candidate.licenseId && !candidate.seats!.some((held) => held.membershipId === pair.membershipId)).map((pair) => pair.membershipId),
          ).size;
          return { licenseId: candidate.licenseId, needed, free: Math.max(0, candidate.quantity - candidate.seatsUsed) };
        })
        .filter((row) => row.needed > row.free);
      if (short.length > 0) return reply(409, { error: "no_seats_available", error_description: "not enough seats", licenses: short });
      const touched = new Set<LicenseView>();
      for (const pair of pairs) touched.add(giveSeat(world, pair.licenseId, pair.membershipId));
      return reply(200, { licenses: [...touched] });
    }
    const memberRoute = new RegExp(`^${ws}/members/([^/]+)$`).exec(path);
    if (memberRoute && method === "PATCH") {
      const target = world.members.find((candidate) => candidate.membershipId === memberRoute[1])!;
      target.role = (body as { role: WorkspaceRole }).role;
      return reply(200, { workspaceId: WORKSPACE_ID, name: world.detail.name, status: "active", authorizationRevision: world.detail.authorizationRevision + 1 });
    }
    if (memberRoute && method === "DELETE") {
      world.members = world.members.filter((candidate) => candidate.membershipId !== memberRoute[1]);
      return reply(204);
    }
    return reply(404, { error: "not_found" });
  };
}

interface MountOptions {
  viewer?: WorkspaceDetail;
  role?: WorkspaceRole;
  members?: MemberView[];
  licenses?: LicenseView[];
  /** What the host hands over; `false` is a host with no licenses source (the admin portal). */
  source?: MembersLicenses | false;
  catalog?: MembersLicenses["catalog"];
  billing?: MembersLicenses["billing"];
  /** The host's billing client and ways out; a fresh one that succeeds unless given. */
  host?: HostRig;
  basePath?: string;
  showUserIds?: boolean;
  locale?: string;
  member?: string | null;
  onMemberChange?: (membershipId: string | null) => void;
}

async function mount(options: MountOptions = {}) {
  const detail = options.viewer ?? detailFor(options.role ?? "owner");
  const world: World = { detail, members: structuredClone(options.members ?? MEMBERS), licenses: structuredClone(options.licenses ?? [CALL(), FLEET(), EXAMPLE(), BOTH()]) };
  const calls: Call[] = [];
  const basePath = options.basePath ?? BASE;
  const api: WorkspaceApi = createWorkspaceApi({ basePath, fetch: serve(world, calls, basePath) });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  seedClient(api, structuredClone({ detail, members: world.members, licenses: world.licenses }), client);
  const host = options.host ?? hostRig();
  const source: MembersLicenses | undefined =
    options.source === false
      ? undefined
      : (options.source ?? {
          catalog: "catalog" in options ? options.catalog : CATALOG,
          billing: options.billing,
          billingApi: host.billingApi,
          navigateOut: host.navigateOut,
        });
  const props = {
    api,
    workspaceId: WORKSPACE_ID,
    showUserIds: options.showUserIds,
    locale: options.locale,
    licenses: source,
    ...("member" in options ? { member: options.member } : {}),
    ...(options.onMemberChange ? { onMemberChange: options.onMemberChange } : {}),
  };
  const element = (extra: { member?: string | null } = {}) => (
    <QueryClientProvider client={client}>
      <WorkspaceMembersPanel {...props} {...extra} />
    </QueryClientProvider>
  );
  const mounted = await render(element());
  await flush();
  return {
    world,
    calls,
    api,
    client,
    host,
    writes: () => calls.filter((call) => call.method !== "GET"),
    /** A controlled host moves to another member without closing the panel. */
    setMember: (membershipId: string | null) => mounted.rerender(element({ member: membershipId })),
  };
}

/** The Members page with billing listing `add_seats` as `billing` says, and a host that succeeds unless given another. */
const mountWith = (billing: MembersLicenses["billing"], host: HostRig = hostRig()) => mount({ host, billing });

const rowOf = (text: string) => {
  const row = findAll<HTMLTableRowElement>("tbody tr").find((candidate) => candidate.textContent?.includes(text));
  if (!row) throw new Error(`no member row with ${text}`);
  return row;
};
/** What a screen reader would read: the element's text without anything hidden from it (a chip's letter tile). */
function readText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if ((node as Element).getAttribute?.("aria-hidden") === "true") return "";
  return [...node.childNodes].map(readText).join("");
}
const chipsOf = (row: HTMLElement) => findAll("li", row).map((chip) => readText(chip).trim());
const tick = (name: string) => find<HTMLInputElement>(`input[type="checkbox"][aria-label="Select ${name}"]`);
const panelEl = () => find<HTMLDialogElement>('dialog[data-slot="side-panel"]');
const panelIsOpen = () => panelEl().querySelector("h2") !== null;
/** The Assign licenses dialog's element: it is always in the page, and has content only while it is open. */
const assignEl = () => find<HTMLDialogElement>('dialog:not([data-slot="side-panel"])');
const assignIsOpen = () => assignEl().querySelector("h2") !== null;
const assignDialog = () => {
  if (!assignIsOpen()) throw new Error("the Assign licenses dialog is closed");
  return assignEl();
};
const assignRow = (name: string, within: HTMLElement = assignDialog()) => {
  const found = findAll("li", within).find((candidate) => candidate.textContent?.includes(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};
/** The text of the panel's Licenses row for `product`. */
const rowText = (product: string) => {
  const found = findAll("li", panelEl()).find((li) => li.textContent?.includes(product));
  if (!found) throw new Error(`no licenses row for ${product}`);
  return found.textContent!;
};
const rowCheckbox = (row: HTMLElement) => find<HTMLInputElement>('input[type="checkbox"]', row);
const footerText = () => find("[data-slot='assign-footer']", assignDialog()).textContent!.trim();

async function choose(...names: string[]) {
  for (const name of names) await click(tick(name));
}
async function openAssign() {
  await click(byText("Assign licenses", "button"));
}
async function openPanel(label: string) {
  await click(find(`button[aria-label="Open ${label}"]`));
}

describe("the Licenses column", () => {
  test("shows a chip for each license held, 'None', and 'After first sign-in'", async () => {
    await mount();
    expect(chipsOf(rowOf("Dana Reyes"))).toEqual(["Call Unlimited", "Example Add-on"]);
    expect(chipsOf(rowOf("Amara Okafor"))).toEqual(["Example Add-on", "Both Add-on"]);
    expect(rowOf("Luis Ortega").textContent).toContain("Both Add-on");
    expect(rowOf("Zed Young").textContent).toContain("None");
    expect(rowOf("Zed Young").querySelectorAll("li")).toHaveLength(0);
    // Someone who hasn't signed in can hold no seat, and says when they can.
    expect(rowOf("grace@acme.test").textContent).toContain("After first sign-in");
    expect(rowOf("grace@acme.test").textContent).not.toContain("None");
    expect(findAll("thead th").map((th) => th.textContent!.trim())).toContain("Licenses");
  });

  test("draws the chip from billing's catalog: the short name, else the name", async () => {
    await mount();
    expect(chipsOf(rowOf("max@acme.test"))).toEqual(["Call Unlimited"]);
    expect(chipsOf(rowOf("Dana Reyes"))[1]).toBe("Example Add-on");
  });

  test("shows all four chips for four licenses held", async () => {
    const keys = ["a", "b", "c", "d"];
    const held = keys.map((key) => license(`lic_${key}`, `mentra.${key}`, 5, ["wm_luis"]));
    await mount({ licenses: held, catalog: keys.map((key) => exampleEntry(`mentra.${key}`, `Extra ${key.toUpperCase()}`)) });
    expect(chipsOf(rowOf("Luis Ortega"))).toEqual(["Extra A", "Extra B", "Extra C", "Extra D"]);
  });

  test("past four it shows three chips and '+n': five held is '+2'", async () => {
    const keys = ["a", "b", "c", "d", "e"];
    const held = keys.map((key) => license(`lic_${key}`, `mentra.${key}`, 5, ["wm_luis"]));
    await mount({ licenses: held, catalog: keys.map((key) => exampleEntry(`mentra.${key}`, `Extra ${key.toUpperCase()}`)) });
    expect(chipsOf(rowOf("Luis Ortega"))).toEqual(["Extra A", "Extra B", "Extra C", "+2"]);
  });

  test("is absent without workspace.licenses.read, without licenses, or without a licenses source", async () => {
    const noRead = { ...detailFor("admin"), capabilities: detailFor("admin").capabilities.filter((capability) => !capability.startsWith("workspace.licenses.")) };
    await mount({ viewer: noRead });
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    expect(rowOf("Dana Reyes").textContent).not.toContain("None");
    await cleanup();

    await mount({ licenses: [] });
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    await cleanup();

    await mount({ source: false });
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
  });

  test("a license that has ended is not a chip, and a workspace with only ended licenses has no column", async () => {
    const ended = { ...BOTH(), endedAt: "2026-10-01T00:00:00.000Z" };
    await mount({ licenses: [ended] });
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
  });

  test("when the catalog can't be read, the column and selection are gone and the rest works", async () => {
    await mount({ catalog: undefined });
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Assign licenses");
    // The list, its roles and the panel are all still there.
    expect(rowOf("Dana Reyes").textContent).toContain("Developer");
    await openPanel("Dana Reyes");
    expect(panelIsOpen()).toBe(true);
    expect(panelEl().textContent).toContain("Change role");
    expect(panelEl().textContent).not.toContain("Licenses");
    expect(panelEl().textContent).toContain("Remove from workspace");
  });
});

describe("the Members list's rows", () => {
  test("show the name over the email, or the email alone where Core has no name", async () => {
    await mount();
    const named = rowOf("Dana Reyes");
    const name = find("[data-slot='member-name']", named);
    const email = find("[data-slot='member-email']", named);
    expect(name.textContent).toBe("Dana Reyes");
    expect(email.textContent).toBe("dana@acme.test");
    expect(name.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const bare = rowOf("max@acme.test");
    expect(find("[data-slot='member-name']", bare).textContent).toBe("max@acme.test");
    expect(bare.querySelector("[data-slot='member-email']")).toBeNull();
    expect(bare.textContent!.match(/max@acme\.test/g)).toHaveLength(1);
  });

  test("show the role as a badge and when they joined, with 'You' on the viewer's own row", async () => {
    await mount();
    const row = rowOf("Luis Ortega");
    expect(row.textContent).toContain("Member");
    expect(row.textContent).toContain(formatDate(JOINED_LATER));
    expect(rowOf("Sam Carter").textContent).toContain("You");
    expect(rowOf("Dana Reyes").textContent).not.toContain("You");
  });

  test("write the joining date in the portal's locale, in the row and in the panel", async () => {
    await mount({ locale: "en-GB" });
    expect(formatDate(JOINED_LATER, "en-GB")).not.toBe(formatDate(JOINED_LATER));
    expect(rowOf("Luis Ortega").textContent).toContain(formatDate(JOINED_LATER, "en-GB"));
    await openPanel("Luis Ortega");
    expect(panelEl().textContent).toContain(formatDate(JOINED_LATER, "en-GB"));
  });

  test("have no native <select>: a role is changed in the panel", async () => {
    await mount();
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });

  test("the pending badge and the imported-member label stay", async () => {
    const imported = member("wm_imp", null, null, "owner", { mentraUserId: null, pending: true });
    await mount({ members: [SAM, GRACE, imported] });
    expect(rowOf("grace@acme.test").textContent).toContain("Pending first sign-in");
    expect(findAll("tbody tr").some((row) => row.textContent?.includes("Imported member") && row.textContent.includes("Pending first sign-in"))).toBe(true);
    expect(document.body.textContent).not.toContain("null");
  });
});

describe("selecting members", () => {
  test("a checkbox per member who has signed in; members who haven't are disabled", async () => {
    await mount();
    const boxes = findAll<HTMLInputElement>("tbody input[type=checkbox]");
    expect(boxes).toHaveLength(MEMBERS.length);
    expect(tick("Dana Reyes").disabled).toBe(false);
    expect(tick("grace@acme.test").disabled).toBe(true);
    expect(tick("max@acme.test").disabled).toBe(false);
  });

  test("checkboxes appear only with workspace.licenses.assign", async () => {
    const readOnly = { ...detailFor("admin"), capabilities: detailFor("admin").capabilities.filter((capability) => capability !== "workspace.licenses.assign") };
    await mount({ viewer: readOnly });
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    // They still see who holds what.
    expect(chipsOf(rowOf("Dana Reyes"))).toEqual(["Call Unlimited", "Example Add-on"]);
    expect(document.body.textContent).not.toContain("Assign licenses");
  });

  test("the bar says '2 selected' with Assign licenses and a clear button", async () => {
    await mount();
    expect(document.body.textContent).not.toContain("selected");
    await choose("Luis Ortega");
    expect(byText("1 selected", "span")).toBeTruthy();
    await choose("Amara Okafor");
    const bar = find("[data-slot='selection-bar']");
    expect(bar.textContent).toContain("2 selected");
    expect(bar.querySelector("button")!.textContent).toBe("Assign licenses");
    expect(find("button[aria-label='Clear selection']", bar)).toBeTruthy();
    expect(rowOf("Luis Ortega").getAttribute("data-selected")).toBe("true");
    await click(find("button[aria-label='Clear selection']"));
    expect(document.querySelector("[data-slot='selection-bar']")).toBeNull();
    expect(tick("Luis Ortega").checked).toBe(false);
  });

  test("choosing a member does not open their panel", async () => {
    await mount();
    await choose("Luis Ortega");
    expect(panelIsOpen()).toBe(false);
  });
});

describe("Assign licenses", () => {
  test("names the people chosen, in the list's order, and counts past three", async () => {
    await mount();
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    expect(assignDialog().querySelector("h2")!.textContent).toBe("Assign licenses");
    expect(assignDialog().textContent).toContain("Luis Ortega and Amara Okafor");
    await click(find("button[aria-label='Close']", assignDialog()));
    await choose("Zed Young");
    await openAssign();
    expect(assignDialog().textContent).toContain("Luis Ortega, Amara Okafor and Zed Young");
    await click(find("button[aria-label='Close']", assignDialog()));
    await choose("Dana Reyes");
    await openAssign();
    expect(assignDialog().textContent).toContain("Dana Reyes, Luis Ortega and 2 others");
  });

  test("each license says what fits, as the spec words it", async () => {
    await mount();
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    expect(assignRow("Mentra Call Unlimited").textContent).toContain("2 of 5 seats free: enough for both.");
    expect(assignRow("Example Add-on").textContent).toContain("Amara Okafor has one. 1 of 3 seats free, for Luis Ortega.");
    expect(assignRow("Both Add-on").textContent).toContain("Everyone you chose has one.");
    expect(assignRow("Fleet").textContent).toContain("All 10 seats are in use.");
  });

  test("says '2 of 3 fit: remove one or add seats.' when too many are chosen, with Add seats where billing offers it", async () => {
    await mount({ billing: BILLING });
    await choose("Luis Ortega", "Amara Okafor", "Zed Young");
    await openAssign();
    const call = assignRow("Mentra Call Unlimited");
    expect(call.textContent).toContain("2 of 3 fit: remove one or add seats.");
    expect(rowCheckbox(call).disabled).toBe(true);
    expect(rowCheckbox(call).checked).toBe(false);
    expect(byText("Add seats", "button", call)).toBeTruthy();
    // Four need a seat against two free: "remove 2".
    await click(find("button[aria-label='Close']", assignDialog()));
    await choose("Sam Carter");
    await openAssign();
    expect(assignRow("Mentra Call Unlimited").textContent).toContain("2 of 4 fit: remove 2 or add seats.");
  });

  test("the sentences drop 'add seats' where billing lists no add_seats for the license", async () => {
    const billing: LicenseBilling[] = [
      licenseBillingFor({ licenseId: "lic_call", actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] }),
      licenseBillingFor({ licenseId: "lic_fleet", product: "mentra.fleet" }),
    ];
    await mount({ billing });
    await choose("Luis Ortega", "Amara Okafor", "Zed Young");
    await openAssign();
    const call = assignRow("Mentra Call Unlimited");
    expect(call.textContent).toContain("2 of 3 fit: remove one.");
    expect(call.textContent).not.toContain("add seats");
    expect(findAll("button", call).some((button) => button.textContent === "Add seats")).toBe(false);
    // Fleet's billing lists it, so its row keeps the button.
    expect(byText("Add seats", "button", assignRow("Fleet"))).toBeTruthy();
  });

  test("fails closed: without billing's list nothing offers Add seats, however the host could start it", async () => {
    const host = hostRig();
    // Not offered billing, billing still loading or failed, and billing listing nothing: none of them offers it.
    for (const billing of [undefined, null, [] as LicenseBilling[]]) {
      await mount({ host, billing });
      await choose("Luis Ortega", "Amara Okafor", "Zed Young");
      await openAssign();
      const call = assignRow("Mentra Call Unlimited");
      expect(call.textContent).toContain("2 of 3 fit: remove one.");
      expect(call.textContent).not.toContain("add seats");
      expect(assignRow("Fleet").textContent).toContain("All 10 seats are in use.");
      expect(findAll("button", assignDialog()).some((button) => button.textContent === "Add seats")).toBe(false);
      await cleanup();

      await mount({ host, billing });
      await openPanel("Luis Ortega");
      expect(rowText("Fleet")).toContain("All 10 seats are in use");
      expect(findAll("button", panelEl()).some((button) => button.textContent === "Add seats")).toBe(false);
      await cleanup();
    }
    expect([host.session.mock.calls.length, host.openTab.mock.calls.length, host.leave.mock.calls.length]).toEqual([0, 0, 0]);
  });

  test("a blocked row can't be checked, and a row that fits starts checked", async () => {
    await mount({ billing: BILLING });
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    for (const name of ["Mentra Call Unlimited", "Example Add-on"]) {
      expect(rowCheckbox(assignRow(name)).checked).toBe(true);
      expect(rowCheckbox(assignRow(name)).disabled).toBe(false);
    }
    for (const name of ["Both Add-on", "Fleet"]) {
      expect(rowCheckbox(assignRow(name)).checked).toBe(false);
      expect(rowCheckbox(assignRow(name)).disabled).toBe(true);
    }
    // Everyone already holds the Both add-on: adding seats wouldn't help, so it has no button.
    expect(findAll("button", assignRow("Both Add-on")).some((button) => button.textContent === "Add seats")).toBe(false);
    expect(byText("Add seats", "button", assignRow("Fleet"))).toBeTruthy();
  });

  describe("Add seats ↗ here is the same way out as every other ↗ button", () => {
    test("it asks billing for this license's add_seats session, shows it pending, and leaves this tab for the page", async () => {
      const hold = deferred<{ url: string }>();
      const host = hostRig(() => hold.promise);
      await mount({ host, billing: BILLING });
      await choose("Luis Ortega");
      await openAssign();
      const button = byText("Add seats", "button", assignRow("Fleet"));
      await click(button);
      expect(host.session.mock.calls).toEqual([[workspaceScope(WORKSPACE_ID), { action: "add_seats", licenseId: "lic_fleet" }]]);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(true);
      await act(async () => hold.resolve({ url: PAGE }));
      await flush();
      // An action that returns leaves this tab, and opens no other.
      expect(host.events).toEqual(["session:add_seats", `leave:${PAGE}`]);
      expect(host.openTab).not.toHaveBeenCalled();
      expect(button.hasAttribute("disabled")).toBe(false);
    });

    test("a refusal comes back in words, where the person is looking", async () => {
      const host = hostRig(async () => {
        throw new BillingRefusedError("forbidden", {}, 403);
      });
      await mount({ host, billing: BILLING });
      await choose("Luis Ortega");
      await openAssign();
      const button = byText("Add seats", "button", assignRow("Fleet"));
      await click(button);
      await flush();
      expect(assignDialog().textContent).toContain("You don't have permission to manage billing here.");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(host.leave).not.toHaveBeenCalled();
      expect(findAll('[role="alert"]', assignDialog()).map(isNeutral)).toEqual([true]);
    });

    test("an action billing lists with returns: false opens its tab in the click, and the tab gets the page", async () => {
      const hold = deferred<{ url: string }>();
      const host = hostRig(() => hold.promise);
      await mount({ host, billing: NEW_TAB_BILLING });
      await choose("Luis Ortega");
      await openAssign();
      await click(byText("Add seats", "button", assignRow("Fleet")));
      // The tab was opened before billing was asked: a browser allows that only while the click is being handled.
      expect(host.events).toEqual(["openTab", "session:add_seats"]);
      await act(async () => hold.resolve({ url: PAGE }));
      await flush();
      expect(host.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
      expect(host.leave).not.toHaveBeenCalled();
    });

    test("a tab that billing's refusal leaves empty is closed again", async () => {
      const host = hostRig(async () => {
        throw new BillingRefusedError("forbidden", {}, 403);
      });
      await mount({ host, billing: NEW_TAB_BILLING });
      await choose("Luis Ortega");
      await openAssign();
      await click(byText("Add seats", "button", assignRow("Fleet")));
      await flush();
      expect(host.events).toEqual(["openTab", "session:add_seats", "close"]);
      expect(assignDialog().textContent).toContain("You don't have permission to manage billing here.");
    });

    test("a tab the browser blocked leaves the page as a link, in the dialog", async () => {
      const host = hostRig();
      host.openTab.mockImplementation(() => null);
      await mount({ host, billing: NEW_TAB_BILLING });
      await choose("Luis Ortega");
      await openAssign();
      await click(byText("Add seats", "button", assignRow("Fleet")));
      await flush();
      const link = findAll<HTMLAnchorElement>("a[data-hosted-page]", assignDialog())[0]!;
      expect(link.textContent).toContain("Open the payment page");
      expect(link.getAttribute("href")).toBe(PAGE);
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(host.leave).not.toHaveBeenCalled();
    });

    describe("the return to this window outlives the dialog that asked for it", () => {
      test("closing the dialog once the tab has its page still reads Core's licenses again on return", async () => {
        const { host, calls } = await mountWith(NEW_TAB_BILLING);
        await choose("Luis Ortega");
        await openAssign();
        await click(byText("Add seats", "button", assignRow("Fleet")));
        await flush();
        expect(host.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
        await click(find("button[aria-label='Close']", assignDialog()));
        expect(assignIsOpen()).toBe(false);
        const before = licenseReads(calls);
        await comeBack();
        await until(() => licenseReads(calls) > before, "Core's licenses to be read again");
      });

      test("closing it before billing answers still sends the tab on, and still reads on return", async () => {
        const hold = deferred<{ url: string }>();
        const { host, calls } = await mountWith(NEW_TAB_BILLING, hostRig(() => hold.promise));
        await choose("Luis Ortega");
        await openAssign();
        await click(byText("Add seats", "button", assignRow("Fleet")));
        await click(find("button[aria-label='Close']", assignDialog()));
        expect(assignIsOpen()).toBe(false);
        await act(async () => hold.resolve({ url: PAGE }));
        await flush();
        expect(host.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
        const before = licenseReads(calls);
        await comeBack();
        await until(() => licenseReads(calls) > before, "Core's licenses to be read again");
      });

      test("it ends at the first return after the Members page is gone, and reads nothing then", async () => {
        const added = spyOn(window, "addEventListener");
        const removed = spyOn(window, "removeEventListener");
        try {
          const { calls } = await mountWith(NEW_TAB_BILLING);
          await choose("Luis Ortega");
          await openAssign();
          added.mockClear();
          await click(byText("Add seats", "button", assignRow("Fleet")));
          await flush();
          const listener = added.mock.calls.find(([type]) => type === "focus")?.[1];
          expect(listener).toBeDefined();
          // The page is still up: a return does not take it away.
          await comeBack();
          expect(removed.mock.calls.some(([type, fn]) => type === "focus" && fn === listener)).toBe(false);
          await cleanup();
          const before = licenseReads(calls);
          await comeBack();
          expect(removed.mock.calls.some(([type, fn]) => type === "focus" && fn === listener)).toBe(true);
          expect(licenseReads(calls)).toBe(before);
        } finally {
          added.mockRestore();
          removed.mockRestore();
        }
      });
    });

    test("the purchase route is never used for it", async () => {
      const host = hostRig();
      await mount({ host, billing: BILLING });
      await choose("Luis Ortega");
      await openAssign();
      await click(byText("Add seats", "button", assignRow("Fleet")));
      await flush();
      expect(host.purchase).not.toHaveBeenCalled();
    });
  });

  test("the footer counts seats per product and 'Assign 3 seats' makes one request with three pairs", async () => {
    const { world, writes, client, api } = await mount();
    // Billing's status for the workspace is cached by a page that reads it: assigning must mark it stale.
    const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
    const catalogKey = billingKeys.catalog({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
    client.setQueryData(statusKey, { licenses: [] });
    client.setQueryData(catalogKey, { products: [] });

    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    expect(footerText()).toBe("2 Call Unlimited · 1 Example Add-on");
    const confirm = byText("Assign 3 seats", "button", assignDialog());
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await click(confirm);
    await until(() => writes().length > 0, "the assignment");
    await until(() => !assignIsOpen(), "the dialog to close");

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.method).toBe("POST");
    expect(writes()[0]!.path).toBe(`/${WORKSPACE_ID}/seat-assignments`);
    const pairs = (writes()[0]!.body as { assignments: { licenseId: string; membershipId: string }[] }).assignments;
    expect(pairs.map((pair) => `${pair.licenseId}:${pair.membershipId}`).sort()).toEqual(["lic_call:wm_amara", "lic_call:wm_luis", "lic_example:wm_luis"]);
    expect(world.licenses.find((candidate) => candidate.licenseId === "lic_call")!.seatsUsed).toBe(5);
    // The list now shows them, and the selection is spent.
    await until(() => chipsOf(rowOf("Luis Ortega")).includes("Call Unlimited"), "Luis Ortega's new chips");
    expect(chipsOf(rowOf("Luis Ortega"))).toEqual(["Call Unlimited", "Example Add-on", "Both Add-on"]);
    expect(document.querySelector("[data-slot='selection-bar']")).toBeNull();
    // Billing's status is stale, so the Licenses page reads its seats again; the catalog is left alone.
    expect(client.getQueryState(statusKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(false);
    expect(api.basePath).toBe(BASE);
  });

  test("a license you uncheck is left out of the request and the footer", async () => {
    const { writes } = await mount();
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    await click(rowCheckbox(assignRow("Example Add-on")));
    expect(footerText()).toBe("2 Call Unlimited");
    await click(byText("Assign 2 seats", "button", assignDialog()));
    await until(() => writes().length === 1, "the assignment");
    const pairs = (writes()[0]!.body as { assignments: { licenseId: string }[] }).assignments;
    expect(pairs.map((pair) => pair.licenseId)).toEqual(["lic_call", "lic_call"]);
  });

  test("with nothing checked Assign is off", async () => {
    await mount();
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    await click(rowCheckbox(assignRow("Mentra Call Unlimited")));
    await click(rowCheckbox(assignRow("Example Add-on")));
    const confirm = byText("Assign", "button", assignDialog());
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(footerText()).toBe("");
  });

  test("a 409 assigns nothing, shows the new counts and says so", async () => {
    const { world, writes } = await mount();
    await choose("Luis Ortega", "Amara Okafor");
    await openAssign();
    expect(assignRow("Mentra Call Unlimited").textContent).toContain("2 of 5 seats free: enough for both.");
    // Another admin takes the two free seats while the dialog is open.
    giveSeat(world, "lic_call", "wm_zed");
    giveSeat(world, "lic_call", "wm_grace");
    const before = structuredClone(world.licenses);
    await click(byText("Assign 3 seats", "button", assignDialog()));
    await until(() => assignDialog().textContent!.includes("Seats changed while you were choosing."), "the conflict notice");

    expect(assignDialog().textContent).toContain("Seats changed while you were choosing. Nothing was assigned. Check the counts and try again.");
    expect(findAll('[role="alert"]', assignDialog()).map(isNeutral)).toEqual([true]);
    expect(writes()).toHaveLength(1);
    expect(world.licenses).toEqual(before);
    // The new counts: Call is full now, and so can't be checked; Example still fits.
    await until(() => assignRow("Mentra Call Unlimited").textContent!.includes("All 5 seats are in use."), "the new counts");
    expect(rowCheckbox(assignRow("Mentra Call Unlimited")).checked).toBe(false);
    expect(rowCheckbox(assignRow("Mentra Call Unlimited")).disabled).toBe(true);
    expect(footerText()).toBe("1 Example Add-on");
    // The dialog stays for another try; nothing was chosen for the list.
    expect(byText("Assign 1 seat", "button", assignDialog())).toBeTruthy();
  });

  test("Cancel and × close it without a request, and keep the selection", async () => {
    const { writes } = await mount();
    await choose("Luis Ortega");
    await openAssign();
    await click(byText("Cancel", "button", assignDialog()));
    expect(assignIsOpen()).toBe(false);
    expect(writes()).toHaveLength(0);
    expect(tick("Luis Ortega").checked).toBe(true);
    await openAssign();
    await click(find("button[aria-label='Close']", assignDialog()));
    expect(assignIsOpen()).toBe(false);
  });

  test("Assign is off above one request's most, and says so under the button", () => {
    assignmentLimitBody = (async () => {
      // 126 members × 4 licenses = 504 pairs; 125 × 4 = 500 is the most one request takes.
      const many = Array.from({ length: 126 }, (_, i) => member(`wm_m${i}`, `m${i}@acme.test`, null));
      const keys = ["a", "b", "c", "d"];
      const licenses = keys.map((key) => license(`lic_${key}`, `mentra.${key}`, 1000, []));
      const catalog = keys.map((key) => exampleEntry(`mentra.${key}`, `Product ${key.toUpperCase()}`));
      await mount({ members: [SAM, ...many], licenses, catalog });
      await act(async () => {
        for (const person of many) tick(person.email!).click();
      });
      expect(MAX_SEAT_ASSIGNMENTS).toBe(500);
      await openAssign();
      const confirm = byText("Assign 504 seats", "button", assignDialog());
      expect(confirm.hasAttribute("disabled")).toBe(true);
      const reason = byText("You can assign up to 500 seats at a time.", "p", assignDialog());
      expect(confirm.getAttribute("aria-describedby")).toBe(reason.id);
      // One fewer person is exactly 500 pairs: it is on, and the reason is gone.
      await click(find("button[aria-label='Close']", assignDialog()));
      await click(tick(many[0]!.email!));
      await openAssign();
      expect(byText("Assign 500 seats", "button", assignDialog()).hasAttribute("disabled")).toBe(false);
      expect(assignDialog().textContent).not.toContain("You can assign up to");
    })();
    return assignmentLimitBody;
  });

  test("has no native <select>", async () => {
    await mount();
    await choose("Luis Ortega");
    await openAssign();
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("the member panel", () => {
  test("opens from a row's name, shows the member, their role and when they joined", async () => {
    await mount();
    expect(panelIsOpen()).toBe(false);
    await openPanel("Dana Reyes");
    const panel = panelEl();
    expect(panelIsOpen()).toBe(true);
    expect(panel.querySelector("h2")!.textContent).toBe("Dana Reyes");
    expect(panel.textContent).toContain("dana@acme.test");
    const facts = Object.fromEntries(findAll("dt", panel).map((dt) => [dt.textContent!.trim(), dt.nextElementSibling!.textContent!.trim()]));
    expect(facts).toEqual({ Role: ROLE_LABELS.developer, Joined: formatDate(START) });
  });

  test("a click on the row opens it too, but not a click on its checkbox", async () => {
    await mount();
    await click(tick("Luis Ortega"));
    expect(panelIsOpen()).toBe(false);
    await click([...rowOf("Zed Young").querySelectorAll("td")].at(-1)!);
    expect(panelIsOpen()).toBe(true);
    expect(panelEl().querySelector("h2")!.textContent).toBe("Zed Young");
  });

  test("is controlled by member and onMemberChange when the host passes them", async () => {
    const onMemberChange = mock((_membershipId: string | null) => {});
    await mount({ member: "wm_luis", onMemberChange });
    expect(panelIsOpen()).toBe(true);
    expect(panelEl().querySelector("h2")!.textContent).toBe("Luis Ortega");
    // Opening another asks the host; nothing moves until it answers.
    await click(find("button[aria-label='Open Dana Reyes']"));
    expect(onMemberChange.mock.calls.at(-1)).toEqual(["wm_dana"]);
    expect(panelEl().querySelector("h2")!.textContent).toBe("Luis Ortega");
    await click(find("button[aria-label='Close']", panelEl()));
    expect(onMemberChange.mock.calls.at(-1)).toEqual([null]);
    expect(panelIsOpen()).toBe(true);
  });

  test("a host that passes member: null has it closed, and a member who isn't listed opens nothing", async () => {
    const onMemberChange = mock((_membershipId: string | null) => {});
    await mount({ member: null, onMemberChange });
    expect(panelIsOpen()).toBe(false);
    await cleanup();
    await mount({ member: "wm_nobody", onMemberChange });
    expect(panelIsOpen()).toBe(false);
  });

  test("Escape and × close it", async () => {
    await mount();
    await openPanel("Dana Reyes");
    await press(panelEl(), "Escape");
    expect(panelIsOpen()).toBe(false);
    await openPanel("Dana Reyes");
    await click(find("button[aria-label='Close']", panelEl()));
    expect(panelIsOpen()).toBe(false);
  });

  test("has no device, usage or miniapp text", async () => {
    await mount();
    await openPanel("Dana Reyes");
    const text = panelEl().textContent!;
    expect(text).not.toMatch(/devices?|usage|miniapps?|glasses|phones?/i);
    expect(text).toContain("Licenses");
    expect(text).toContain("Role");
    expect(text).toContain("Joined");
    expect(text).toContain("Remove from workspace");
  });

  describe("Change role", () => {
    const itemsOf = async () => {
      await click(find("button[aria-label='Change role']", panelEl()));
      return findAll('[role="menuitem"]').map((item) => item.textContent!.trim());
    };

    test("offers only the roles roleOptions allows: an admin, for a developer, member and developer", async () => {
      await mount({ role: "admin" });
      await openPanel("Dana Reyes");
      expect(await itemsOf()).toEqual(["Member", "Developer"]);
      // The role they hold is marked and can't be chosen again.
      expect(findAll<HTMLButtonElement>('[role="menuitem"]').find((item) => item.textContent === "Developer")!.disabled).toBe(true);
    });

    test("an owner may move anyone but themselves between all four", async () => {
      await mount({ role: "owner" });
      await openPanel("Adam Park");
      expect(await itemsOf()).toEqual(["Member", "Developer", "Admin", "Owner"]);
    });

    test("nothing for an admin's or owner's row when the viewer is an admin, and nothing on one's own row", async () => {
      await mount({ role: "admin" });
      await openPanel("Adam Park");
      expect(document.querySelector("button[aria-label='Change role']")).toBeNull();
      expect(panelEl().textContent).not.toContain("Remove from workspace");
      await press(panelEl(), "Escape");
      await openPanel("Sam Carter");
      expect(document.querySelector("button[aria-label='Change role']")).toBeNull();
      await press(panelEl(), "Escape");
      // The viewer's own row, as an owner.
      await cleanup();
      await mount({ role: "owner" });
      await openPanel("Sam Carter");
      expect(document.querySelector("button[aria-label='Change role']")).toBeNull();
      expect(panelEl().textContent).not.toContain("Remove from workspace");
      expect(panelEl().textContent).toContain(ROLE_LABELS.owner);
    });

    test("an organization admin with no membership acts as an owner", async () => {
      await mount({ viewer: { ...detailFor("owner"), membership: null, organizationAdmin: true } });
      await openPanel("Sam Carter");
      expect(await itemsOf()).toEqual(["Member", "Developer", "Admin", "Owner"]);
    });

    test("choosing one changes the role with the revision the viewer last saw", async () => {
      const { world, writes } = await mount({ role: "admin" });
      await openPanel("Dana Reyes");
      await itemsOf();
      await click(byText("Member", '[role="menuitem"]'));
      await until(() => writes().length === 1, "the role change");
      expect(writes()[0]).toEqual({ method: "PATCH", path: `/${WORKSPACE_ID}/members/wm_dana`, body: { role: "member", expectedRevision: 7 } });
      expect(world.members.find((candidate) => candidate.membershipId === "wm_dana")!.role).toBe("member");
      await until(() => panelEl().textContent!.includes(ROLE_LABELS.member) && !panelEl().textContent!.includes(ROLE_LABELS.developer), "the new role");
      expect(panelIsOpen()).toBe(true);
    });

    test("a role change that fails says why, inside the panel", async () => {
      const { world } = await mount({ role: "admin" });
      world.fail = (call) => (call.method === "PATCH" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
      await openPanel("Dana Reyes");
      await itemsOf();
      await click(byText("Member", '[role="menuitem"]'));
      await until(() => panelEl().textContent!.includes("This workspace changed. Review and try again."), "the refusal");
      expect(find('[role="alert"]', panelEl()).textContent).toBe("This workspace changed. Review and try again.");
      expect(panelEl().textContent).toContain(ROLE_LABELS.developer);
    });

    test("and says it in the neutral notice style: amber is for payments", async () => {
      const { world } = await mount({ role: "admin" });
      world.fail = (call) => (call.method === "PATCH" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
      await openPanel("Dana Reyes");
      await itemsOf();
      await click(byText("Member", '[role="menuitem"]'));
      await until(() => findAll('[role="alert"]', panelEl()).length === 1, "the refusal");
      expect(findAll('[role="alert"]', panelEl()).map(isNeutral)).toEqual([true]);
    });
  });

  test("a members list that can't be read says so in the neutral style, with Try again", async () => {
    const detail = detailFor("admin");
    const world: World = { detail, members: [], licenses: [] };
    world.fail = (call) => (call.method === "GET" && call.path.endsWith("/members") ? reply(403, { error: "forbidden" }) : undefined);
    const api = createWorkspaceApi({ basePath: BASE, fetch: serve(world, [], BASE) });
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
    seedClient(api, { detail }, client);
    await render(
      <QueryClientProvider client={client}>
        <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} />
      </QueryClientProvider>,
    );
    await until(() => findAll('[role="alert"]').length === 1, "the members list to fail");
    expect(findAll('[role="alert"]').map(isNeutral)).toEqual([true]);
    expect(byText("Try again", "button")).toBeTruthy();
  });

  describe("a failure that outlives its panel", () => {
    test("belongs to no panel: a role change that fails after its panel was closed shows nothing anywhere", async () => {
      const hold = deferred<void>();
      const { world, writes } = await mount({ role: "admin" });
      world.gate = hold.promise;
      world.fail = (call) => (call.method === "PATCH" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
      await openPanel("Dana Reyes");
      await click(find("button[aria-label='Change role']", panelEl()));
      await click(byText("Member", '[role="menuitem"]'));
      await until(() => writes().length === 1, "the role change to be out");
      await press(panelEl(), "Escape");
      expect(panelIsOpen()).toBe(false);
      await act(async () => hold.resolve());
      await flush();
      expect(findAll('[role="alert"]')).toHaveLength(0);
    });
  });

  describe("Remove from workspace", () => {
    test("asks first, and removes only on the second step, with the revision", async () => {
      const { world, writes } = await mount({ role: "admin" });
      await openPanel("max@acme.test");
      await click(byText("Remove from workspace", "button", panelEl()));
      expect(panelEl().textContent).toContain("Remove max@acme.test from this workspace?");
      expect(writes()).toHaveLength(0);
      await click(byText("Confirm remove", "button", panelEl()));
      await until(() => writes().length === 1, "the removal");
      expect(writes()[0]).toEqual({ method: "DELETE", path: `/${WORKSPACE_ID}/members/wm_max`, body: { expectedRevision: 7 } });
      expect(world.members.some((candidate) => candidate.membershipId === "wm_max")).toBe(false);
      // The member is gone, so the panel is too, and so is their row.
      await until(() => !panelIsOpen(), "the panel to close");
      await until(() => findAll("tbody tr").every((row) => !row.textContent!.includes("max@acme.test")), "the row to go");
    });

    test("removing a member frees their seats, so billing's status is marked stale", async () => {
      const { client, writes } = await mount({ role: "admin" });
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      const catalogKey = billingKeys.catalog({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      client.setQueryData(catalogKey, { products: [] });
      await openPanel("max@acme.test");
      await click(byText("Remove from workspace", "button", panelEl()));
      await click(byText("Confirm remove", "button", panelEl()));
      await until(() => writes().length === 1, "the removal");
      await until(() => client.getQueryState(statusKey)?.isInvalidated === true, "billing's status to be marked stale");
      expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(false);
    });

    test("a role change leaves billing alone", async () => {
      const { client, writes } = await mount({ role: "admin" });
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      await openPanel("Dana Reyes");
      await click(find("button[aria-label='Change role']", panelEl()));
      await click(byText("Member", '[role="menuitem"]'));
      await until(() => writes().length === 1, "the role change");
      await flush();
      expect(client.getQueryState(statusKey)?.isInvalidated).toBe(false);
    });

    test("asks a host that controls the panel to close it once the member is gone", async () => {
      const onMemberChange = mock((_membershipId: string | null) => {});
      const { writes } = await mount({ role: "admin", member: "wm_dana", onMemberChange });
      await click(byText("Remove from workspace", "button", panelEl()));
      await click(byText("Confirm remove", "button", panelEl()));
      await until(() => writes().length === 1, "the removal");
      await until(() => onMemberChange.mock.calls.length > 0, "the host to be asked");
      expect(onMemberChange.mock.calls).toEqual([[null]]);
    });

    test("Cancel backs out and nothing is sent", async () => {
      const { writes } = await mount({ role: "admin" });
      await openPanel("max@acme.test");
      await click(byText("Remove from workspace", "button", panelEl()));
      await click(byText("Cancel", "button", panelEl()));
      expect(writes()).toHaveLength(0);
      expect(byText("Remove from workspace", "button", panelEl())).toBeTruthy();
    });

    test("is offered only where the viewer may remove them", async () => {
      await mount({ role: "admin" });
      await openPanel("Dana Reyes");
      expect(byText("Remove from workspace", "button", panelEl())).toBeTruthy();
      await press(panelEl(), "Escape");
      await openPanel("Adam Park");
      expect(findAll("button", panelEl()).some((button) => button.textContent === "Remove from workspace")).toBe(false);
    });
  });

  describe("Licenses", () => {
    const switches = () => findAll<HTMLInputElement>('input[role="switch"]', panelEl());
    const switchFor = (product: string, name: string) => find<HTMLInputElement>(`input[role="switch"][aria-label="${product} seat for ${name}"]`, panelEl());
    const rowFor = (product: string) => {
      const found = findAll("li", panelEl()).find((li) => li.textContent?.includes(product));
      if (!found) throw new Error(`no licenses row for ${product}`);
      return found;
    };

    test("says what a switch does, and lists one row per license with the seats left", async () => {
      await mount();
      await openPanel("Luis Ortega");
      const panel = panelEl();
      expect(panel.textContent).toContain("Turn one on to give Luis Ortega a seat. Changes apply right away.");
      expect(findAll("li", panel).map((li) => li.querySelector("[data-slot='license-name']")?.textContent)).toEqual([
        "Mentra Call Unlimited",
        "Fleet",
        "Example Add-on",
        "Both Add-on",
      ]);
      expect(rowFor("Mentra Call Unlimited").textContent).toContain("2 of 5 seats free");
      expect(rowFor("Example Add-on").textContent).toContain("1 of 3 seats free");
      // Luis holds the Both add-on: on, and with the seats left after his.
      expect(rowFor("Both Add-on").textContent).toContain("Has a seat · 2 of 4 free");
      expect(switchFor("Both Add-on", "Luis Ortega").checked).toBe(true);
      expect(switchFor("Mentra Call Unlimited", "Luis Ortega").checked).toBe(false);
    });

    test("a switch assigns with PUT and releases with DELETE, at once", async () => {
      const { world, writes, client } = await mount();
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      await openPanel("Luis Ortega");
      await click(switchFor("Mentra Call Unlimited", "Luis Ortega"));
      await until(() => writes().length === 1, "the assignment");
      expect(writes()[0]).toEqual({ method: "PUT", path: `/${WORKSPACE_ID}/licenses/lic_call/seats/wm_luis`, body: undefined });
      expect(world.licenses.find((candidate) => candidate.licenseId === "lic_call")!.seats!.some((held) => held.membershipId === "wm_luis")).toBe(true);
      await until(() => switchFor("Mentra Call Unlimited", "Luis Ortega").checked && rowFor("Mentra Call Unlimited").textContent!.includes("Has a seat · 1 of 5 free"), "the new state");
      // Billing's status is stale after a seat change, so the Licenses page reads it again.
      expect(client.getQueryState(statusKey)?.isInvalidated).toBe(true);

      await click(switchFor("Both Add-on", "Luis Ortega"));
      await until(() => writes().length === 2, "the release");
      expect(writes()[1]).toEqual({ method: "DELETE", path: `/${WORKSPACE_ID}/licenses/lic_both/seats/wm_luis`, body: undefined });
      await until(() => !switchFor("Both Add-on", "Luis Ortega").checked, "the switch to turn off");
      expect(rowFor("Both Add-on").textContent).toContain("3 of 4 seats free");
    });

    test("giving up a seat marks billing's status stale too", async () => {
      const { client, writes } = await mount();
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      await openPanel("Luis Ortega");
      await click(switchFor("Both Add-on", "Luis Ortega"));
      await until(() => writes().length === 1, "the release");
      await until(() => !switchFor("Both Add-on", "Luis Ortega").checked, "the switch to turn off");
      expect(client.getQueryState(statusKey)?.isInvalidated).toBe(true);
    });

    test("a full license's switch is off and disabled, in amber, with Add seats", async () => {
      const { host } = await mount({ billing: BILLING });
      await openPanel("Luis Ortega");
      const fleet = rowFor("Fleet");
      expect(fleet.textContent).toContain("All 10 seats are in use");
      expect(switchFor("Fleet", "Luis Ortega").disabled).toBe(true);
      expect(switchFor("Fleet", "Luis Ortega").checked).toBe(false);
      expect(fleet.querySelector("[data-tone='warn']")?.textContent).toContain("All 10 seats are in use");
      const add = byText("Add seats", "button", fleet);
      await click(add);
      await flush();
      expect(host.session.mock.calls).toEqual([[workspaceScope(WORKSPACE_ID), { action: "add_seats", licenseId: "lic_fleet" }]]);
      expect(host.events).toEqual(["session:add_seats", `leave:${PAGE}`]);
    });

    test("Add seats in the panel is the same way out: refusals in words, a tab for returns: false, a link when it is blocked", async () => {
      // A refusal.
      const refusing = hostRig(async () => {
        throw new BillingRefusedError("forbidden", {}, 403);
      });
      await mount({ host: refusing, billing: BILLING });
      await openPanel("Luis Ortega");
      await click(byText("Add seats", "button", rowFor("Fleet")));
      await flush();
      expect(panelEl().textContent).toContain("You don't have permission to manage billing here.");
      expect(findAll('[role="alert"]', panelEl()).map(isNeutral)).toEqual([true]);
      expect(refusing.leave).not.toHaveBeenCalled();
      await cleanup();

      // A page with no way back: the tab opens in the click.
      const newTab = hostRig();
      await mount({ host: newTab, billing: NEW_TAB_BILLING });
      await openPanel("Luis Ortega");
      await click(byText("Add seats", "button", rowFor("Fleet")));
      await flush();
      expect(newTab.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
      expect(newTab.leave).not.toHaveBeenCalled();
      await cleanup();

      // The browser blocked the tab: the page comes back as a link.
      const blocked = hostRig();
      blocked.openTab.mockImplementation(() => null);
      await mount({ host: blocked, billing: NEW_TAB_BILLING });
      await openPanel("Luis Ortega");
      await click(byText("Add seats", "button", rowFor("Fleet")));
      await flush();
      const link = findAll<HTMLAnchorElement>("a[data-hosted-page]", panelEl())[0]!;
      expect(link.getAttribute("href")).toBe(PAGE);
      expect(link.textContent).toContain("Open the payment page");
    });

    test("closing the panel after Add seats opened a tab still reads Core's licenses again on return", async () => {
      const { host, calls } = await mountWith(NEW_TAB_BILLING);
      await openPanel("Luis Ortega");
      await click(byText("Add seats", "button", rowFor("Fleet")));
      await flush();
      expect(host.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
      await click(find("button[aria-label='Close']", panelEl()));
      expect(panelIsOpen()).toBe(false);
      const before = licenseReads(calls);
      await comeBack();
      await until(() => licenseReads(calls) > before, "Core's licenses to be read again");
    });

    test("closing the panel before billing answers still sends the tab on, and still reads on return", async () => {
      const hold = deferred<{ url: string }>();
      const { host, calls } = await mountWith(NEW_TAB_BILLING, hostRig(() => hold.promise));
      await openPanel("Luis Ortega");
      await click(byText("Add seats", "button", rowFor("Fleet")));
      await click(find("button[aria-label='Close']", panelEl()));
      expect(panelIsOpen()).toBe(false);
      await act(async () => hold.resolve({ url: PAGE }));
      await flush();
      expect(host.events).toEqual(["openTab", "session:add_seats", `go:${PAGE}`]);
      const before = licenseReads(calls);
      await comeBack();
      await until(() => licenseReads(calls) > before, "Core's licenses to be read again");
    });

    test("Add seats is left out where billing lists no add_seats (or nothing at all)", async () => {
      await mount();
      await openPanel("Luis Ortega");
      expect(findAll("button", rowFor("Fleet")).some((button) => button.textContent === "Add seats")).toBe(false);
      await cleanup();
      await mount({ billing: [licenseBillingFor({ licenseId: "lic_fleet", product: "mentra.fleet", actions: [{ kind: "cancel", fallbackLabel: "Cancel" }] })] });
      await openPanel("Luis Ortega");
      expect(findAll("button", rowFor("Fleet")).some((button) => button.textContent === "Add seats")).toBe(false);
    });

    test("an over-assigned license says by how many, and its switch is off and disabled", async () => {
      const over = license("lic_over", "mentra.example", 2, ["wm_dana", "wm_max", "wm_adam"]);
      await mount({ licenses: [over] });
      await openPanel("Luis Ortega");
      const row = rowFor("Example Add-on");
      expect(row.textContent).toContain("1 more assigned than covered");
      expect(switchFor("Example Add-on", "Luis Ortega").disabled).toBe(true);
      // Someone who holds one can still give it up.
      await press(panelEl(), "Escape");
      await openPanel("Dana Reyes");
      expect(switchFor("Example Add-on", "Dana Reyes").disabled).toBe(false);
      expect(switchFor("Example Add-on", "Dana Reyes").checked).toBe(true);
    });

    test("a member who hasn't signed in is told when they can get seats, with no switches", async () => {
      await mount();
      await openPanel("grace@acme.test");
      expect(panelEl().textContent).toContain("grace@acme.test can get seats after their first sign-in.");
      expect(switches()).toHaveLength(0);
      expect(panelEl().textContent).not.toContain("Turn one on");
    });

    test("without workspace.licenses.assign the switches only show the state", async () => {
      const readOnly = { ...detailFor("admin"), capabilities: detailFor("admin").capabilities.filter((capability) => capability !== "workspace.licenses.assign") };
      const { writes } = await mount({ viewer: readOnly });
      await openPanel("Dana Reyes");
      expect(switches().length).toBeGreaterThan(0);
      for (const toggle of switches()) expect(toggle.disabled).toBe(true);
      expect(switchFor("Mentra Call Unlimited", "Dana Reyes").checked).toBe(true);
      expect(panelEl().textContent).not.toContain("Turn one on");
      await click(switchFor("Mentra Call Unlimited", "Dana Reyes"));
      expect(writes()).toHaveLength(0);
    });

    test("without the read capability, a licenses source or the catalog the panel has no Licenses section", async () => {
      const noRead = { ...detailFor("admin"), capabilities: detailFor("admin").capabilities.filter((capability) => !capability.startsWith("workspace.licenses.")) };
      await mount({ viewer: noRead });
      await openPanel("Dana Reyes");
      expect(switches()).toHaveLength(0);
      expect(panelEl().textContent).not.toContain("Licenses");
      await cleanup();
      await mount({ source: false });
      await openPanel("Dana Reyes");
      expect(switches()).toHaveLength(0);
      expect(panelEl().textContent).not.toContain("Licenses");
    });

    test("a seat taken by someone else in the meantime is a conflict in words, and the counts are fresh", async () => {
      const { world, writes } = await mount();
      await openPanel("Zed Young");
      // The example add-on had one free seat; another admin takes it first.
      giveSeat(world, "lic_example", "wm_luis");
      await click(switchFor("Example Add-on", "Zed Young"));
      await until(() => panelEl().textContent!.includes("Seats changed while you were choosing."), "the conflict notice");
      expect(findAll('[role="alert"]', panelEl()).map(isNeutral)).toEqual([true]);
      expect(writes().filter((call) => call.method === "PUT")).toHaveLength(1);
      await until(() => switchFor("Example Add-on", "Zed Young").disabled, "the new counts");
      expect(switchFor("Example Add-on", "Zed Young").checked).toBe(false);
      expect(rowFor("Example Add-on").textContent).toContain("All 3 seats are in use");
    });

    test("a new member starts without the failure of the last one's seat change", async () => {
      const onMemberChange = mock((_membershipId: string | null) => {});
      const { world, setMember } = await mount({ member: "wm_zed", onMemberChange });
      giveSeat(world, "lic_example", "wm_luis");
      await click(switchFor("Example Add-on", "Zed Young"));
      await until(() => panelEl().textContent!.includes("Seats changed while you were choosing."), "the conflict notice");
      // The host moves to another member without closing the panel.
      await setMember("wm_amara");
      expect(panelEl().querySelector("h2")!.textContent).toBe("Amara Okafor");
      expect(panelEl().textContent).not.toContain("Seats changed while you were choosing.");
    });

    test("has no native <select>", async () => {
      await mount();
      await openPanel("Dana Reyes");
      await click(find("button[aria-label='Change role']", panelEl()));
      expect(document.querySelectorAll("select")).toHaveLength(0);
    });
  });
});

describe("the admin portal's Members list", () => {
  const admin = () => ({ viewer: { ...detailFor("owner"), membership: null, organizationAdmin: true } as WorkspaceDetail, basePath: "/api/admin/workspaces", source: false as const });

  test("still shows user IDs in the row, with copy buttons", async () => {
    await mount({ ...admin(), showUserIds: true });
    expect(rowOf("Dana Reyes").textContent).toContain("u_dana");
    expect(findAll("button[aria-label^='Copy the Mentra user id of']")).toHaveLength(MEMBERS.length - 1);
    expect(find("button[aria-label='Copy the Mentra user id of Dana Reyes']")).toBeTruthy();
    // A member who hasn't signed in has no ID to copy.
    expect(rowOf("grace@acme.test").textContent).not.toContain("u_");
    // No licenses column, no checkboxes.
    expect(findAll("thead th").map((th) => th.textContent!.trim())).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
  });

  test("hides user IDs when asked not to", async () => {
    await mount({ ...admin() });
    expect(document.body.textContent).not.toContain("u_dana");
  });

  test("changes a role and removes a member through the panel", async () => {
    const { writes } = await mount({ ...admin(), showUserIds: true });
    await openPanel("Dana Reyes");
    expect(panelEl().textContent).not.toContain("Licenses");
    await click(find("button[aria-label='Change role']", panelEl()));
    expect(findAll('[role="menuitem"]').map((item) => item.textContent!.trim())).toEqual(["Member", "Developer", "Admin", "Owner"]);
    await click(byText("Admin", '[role="menuitem"]'));
    await until(() => writes().length === 1, "the role change");
    expect(writes()[0]).toMatchObject({ method: "PATCH", path: `/${WORKSPACE_ID}/members/wm_dana`, body: { role: "admin" } });
    await click(byText("Remove from workspace", "button", panelEl()));
    await click(byText("Confirm remove", "button", panelEl()));
    await until(() => writes().length === 2, "the removal");
    expect(writes()[1]).toMatchObject({ method: "DELETE", path: `/${WORKSPACE_ID}/members/wm_dana` });
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("MemberPanel on its own", () => {
  test("shows nothing while closed", async () => {
    await render(<MemberPanel member={null} onClose={() => {}} roleOptions={[]} canRemove={false} busy={false} onChangeRole={() => {}} onRemove={() => {}} error={null} />);
    expect(find('dialog[data-slot="side-panel"]').querySelector("h2")).toBeNull();
  });
});

describe("what the Members screens carry", () => {
  test("they don't reach the contract's billing schemas or zod, which the admin portal would ship", () => {
    for (const entry of ["components/members-panel.tsx", "components/member-panel.tsx", "components/licenses/assign-licenses.tsx"]) {
      const { files, specifiers } = runtimeImports(entry);
      expect(specifiers.filter((specifier) => SCHEMA_SPECIFIER.test(specifier))).toEqual([]);
      expect(files.filter((file) => file.endsWith("billing-api.ts"))).toEqual([]);
    }
  });
});

describe("what the package exports for a host that mounts the Members screens itself", () => {
  test("HeldLicense and isHeldLicense, which PersonLicensesProps and AssignLicensesDialogProps are written in", async () => {
    const pkg = await import("./index");
    const cards = pkg.joinLicenses({
      licenses: [CALL()],
      // Billing has a second license that Core hasn't received yet: it has no seats to hold.
      billing: [licenseBillingFor({ licenseId: "lic_call" }), licenseBillingFor({ licenseId: "lic_new" })],
      catalog: [catalogEntryFor()],
    });
    expect(cards).toHaveLength(2);
    const held: Array<import("./index").HeldLicense> = cards.filter(pkg.isHeldLicense);
    expect(held.map((card) => card.licenseId)).toEqual(["lic_call"]);
    expect(held[0]!.seats.used).toBe(3);
  });
});
