/**
 * The Members list: its read-only Licenses column, and the row's "…" menu (Change role, Remove from workspace, which
 * asks first in a dialog), driven in a DOM against an in-memory Core: every request the screens make is answered from
 * `World`. The list assigns nothing: licenses are assigned from the Licenses page. Synthetic data only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type LicenseView, type MemberView, type WorkspaceDetail, type WorkspaceRole } from "@mentra/workspace-contract";
import type { CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import { createWorkspaceApi, type FetchLike, type WorkspaceApi } from "./api";
import { ConfirmDialog } from "./components/confirm-dialog";
import { WorkspaceMembersPanel, type MembersLicenses } from "./components/members-panel";
import { formatDate } from "./lib/format";
import { billingKeys } from "./queries";
import { catalogEntryFor, fleetEntryFor } from "./test-billing-fixtures";
import { byText, cleanup, click, find, findAll, flush, isNeutral, press, render, setupDom, teardownDom, until } from "./test-dom";
import { runtimeImports, SCHEMA_SPECIFIER } from "./test-imports";
import { detailFor, licenseFor, seedClient, START, WORKSPACE_ID } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

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

/** A license of this workspace holding seats for `holders`; `quantity` licenses bought. */
function license(licenseId: string, product: string, quantity: number, holders: string[]): LicenseView {
  return licenseFor({ licenseId, product, quantity, seatsUsed: holders.length, seats: holders.map(seat) });
}

const CALL = () => license("lic_call", "mentra.call.unlimited", 5, ["wm_dana", "wm_max", "wm_adam"]);
const FLEET = () => license("lic_fleet", "mentra.fleet", 10, Array.from({ length: 10 }, (_, i) => `wm_f${i}`));
const EXAMPLE = () => license("lic_example", "mentra.example", 3, ["wm_amara", "wm_dana"]);
const BOTH = () => license("lic_both", "mentra.both", 4, ["wm_luis", "wm_amara"]);

const exampleEntry = (product = "mentra.example", name = "Example Add-on") =>
  catalogEntryFor({ product, name, shortName: undefined, icon: null, features: [], description: "An example add-on." });
const CATALOG: CatalogEntry[] = [catalogEntryFor(), fleetEntryFor(), exampleEntry(), exampleEntry("mentra.both", "Both Add-on")];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Core's side: the data the screens read, and what they write. */
interface World {
  detail: WorkspaceDetail;
  members: MemberView[];
  licenses: LicenseView[];
  /** Answers a request with this instead of serving it, when it returns a response. */
  fail?: (call: Call) => Response | undefined;
  /** Holds every change (PATCH, DELETE) back until it is released, so a test can have one in flight. */
  gate?: Promise<void>;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const reply = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

function serve(world: World, calls: Call[], basePath: string): FetchLike {
  return async (input, init) => {
    const path = String(input).slice(basePath.length);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path, body };
    calls.push(call);
    if (world.gate && method !== "GET") await world.gate;
    const forced = world.fail?.(call);
    if (forced) return forced;
    const ws = `/${WORKSPACE_ID}`;
    if (method === "GET" && path === ws) return reply(200, world.detail);
    if (method === "GET" && path === `${ws}/members`) return reply(200, { items: world.members });
    if (method === "GET" && path === `${ws}/licenses`) return reply(200, { items: world.licenses });
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
  basePath?: string;
  showUserIds?: boolean;
  locale?: string;
}

async function mount(options: MountOptions = {}) {
  const detail = options.viewer ?? detailFor(options.role ?? "owner");
  const world: World = { detail, members: structuredClone(options.members ?? MEMBERS), licenses: structuredClone(options.licenses ?? [CALL(), FLEET(), EXAMPLE(), BOTH()]) };
  const calls: Call[] = [];
  const basePath = options.basePath ?? BASE;
  const api: WorkspaceApi = createWorkspaceApi({ basePath, fetch: serve(world, calls, basePath) });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  seedClient(api, structuredClone({ detail, members: world.members, licenses: world.licenses }), client);
  const source: MembersLicenses | undefined = options.source === false ? undefined : (options.source ?? { catalog: "catalog" in options ? options.catalog : CATALOG });
  await render(
    <QueryClientProvider client={client}>
      <WorkspaceMembersPanel api={api} workspaceId={WORKSPACE_ID} showUserIds={options.showUserIds} locale={options.locale} licenses={source} />
    </QueryClientProvider>,
  );
  await flush();
  return { world, calls, api, client, writes: () => calls.filter((call) => call.method !== "GET") };
}

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
const columns = () => findAll("thead th").map((th) => th.textContent!.trim());

/** A row's "…" menu button, named for the member it is on. */
const menuFor = (label: string) => find<HTMLButtonElement>(`button[aria-label="More for ${label}"]`);
const hasMenu = (label: string) => document.querySelector(`button[aria-label="More for ${label}"]`) !== null;
const menuItems = () => findAll<HTMLButtonElement>('[role="menuitem"]');
const menuTexts = () => menuItems().map((item) => item.textContent!.trim());
/** Opens the row's menu and says what it offers. */
async function offered(label: string): Promise<string[]> {
  await click(menuFor(label));
  return menuTexts();
}
const item = (text: string) => {
  const found = menuItems().find((candidate) => candidate.textContent!.trim() === text);
  if (!found) throw new Error(`no menu item ${text} among ${JSON.stringify(menuTexts())}`);
  return found;
};
const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter((dialog) => dialog.open);
const removeDialog = () => {
  const [dialog, ...others] = openDialogs();
  if (!dialog || others.length > 0) throw new Error(`expected one open dialog, found ${openDialogs().length}`);
  return dialog;
};
/** Escape on the open dialog, as the platform does it: the dialog is asked to cancel and, unless that is prevented, closes. */
async function escape() {
  await act(async () => {
    const dialog = removeDialog();
    if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  });
}

describe("the Licenses column", () => {
  test("shows a chip for each license held, 'None', and 'After first sign-in'", async () => {
    await mount();
    expect(chipsOf(rowOf("Dana Reyes"))).toEqual(["Call Unlimited", "Example Add-on"]);
    expect(chipsOf(rowOf("Amara Okafor"))).toEqual(["Example Add-on", "Both Add-on"]);
    expect(rowOf("Luis Ortega").textContent).toContain("Both Add-on");
    expect(rowOf("Zed Young").textContent).toContain("None");
    expect(rowOf("Zed Young").querySelectorAll("li")).toHaveLength(0);
    // Someone who hasn't signed in can hold no license, and says when they can.
    expect(rowOf("grace@acme.test").textContent).toContain("After first sign-in");
    expect(rowOf("grace@acme.test").textContent).not.toContain("None");
    expect(columns()).toContain("Licenses");
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
    expect(columns()).not.toContain("Licenses");
    expect(rowOf("Dana Reyes").textContent).not.toContain("None");
    await cleanup();

    await mount({ licenses: [] });
    expect(columns()).not.toContain("Licenses");
    await cleanup();

    await mount({ source: false });
    expect(columns()).not.toContain("Licenses");
  });

  test("a license that has ended is not a chip, and a workspace with only ended licenses has no column", async () => {
    const ended = { ...BOTH(), endedAt: "2026-10-01T00:00:00.000Z" };
    await mount({ licenses: [ended] });
    expect(columns()).not.toContain("Licenses");
  });

  test("when the catalog can't be read, the column is gone and the rest of the list works", async () => {
    await mount({ catalog: undefined });
    expect(columns()).not.toContain("Licenses");
    expect(document.body.textContent).not.toContain("Assign licenses");
    // The list, its roles and the row's menu are all still there.
    expect(rowOf("Dana Reyes").textContent).toContain("Developer");
    expect(await offered("Dana Reyes")).toContain("Remove from workspace");
  });

  test("the chips only show: nothing in them is a button, a link or a field, and no row opens anything", async () => {
    await mount();
    for (const label of ["Dana Reyes", "Amara Okafor", "Luis Ortega"]) {
      expect(findAll("button, a, input, [role=button]", find("ul[aria-label='Licenses']", rowOf(label)))).toHaveLength(0);
    }
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

  test("write the joining date in the portal's locale", async () => {
    await mount({ locale: "en-GB" });
    expect(formatDate(JOINED_LATER, "en-GB")).not.toBe(formatDate(JOINED_LATER));
    expect(rowOf("Luis Ortega").textContent).toContain(formatDate(JOINED_LATER, "en-GB"));
  });

  test("have no native <select>: a role is changed in the row's menu", async () => {
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

describe("the list is simple: no selection, no bulk Assign licenses and no side panel", () => {
  test("an owner who may assign licenses still sees no checkbox, no selection bar and no Assign licenses", async () => {
    await mount({ role: "owner" });
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
    expect(findAll("[data-slot='selection-bar']")).toHaveLength(0);
    expect(findAll("button").filter((button) => /Assign licenses|Clear selection/.test(button.textContent ?? button.getAttribute("aria-label") ?? ""))).toHaveLength(0);
    expect(document.body.textContent).not.toContain("selected");
    // The column that held the checkboxes is gone, not empty.
    expect(findAll("thead th[aria-hidden='true']")).toHaveLength(1);
  });

  test("a click on a row opens nothing: no panel, no dialog, no request", async () => {
    const { calls } = await mount({ role: "owner" });
    const requests = calls.length;
    await click(rowOf("Luis Ortega"));
    await click(find("[data-slot='member-name']", rowOf("Luis Ortega")));
    expect(document.querySelectorAll('dialog[data-slot="side-panel"]')).toHaveLength(0);
    expect(openDialogs()).toHaveLength(0);
    expect(findAll("button").filter((button) => button.getAttribute("aria-label")?.startsWith("Open "))).toHaveLength(0);
    expect(calls).toHaveLength(requests);
  });

  test("the only dialog the list can open is Remove's, and it has no dialog of its own until asked", async () => {
    await mount({ role: "owner" });
    expect(document.querySelectorAll("dialog")).toHaveLength(0);
  });
});

describe("the row's menu: Change role and Remove from workspace", () => {
  test("is named for the member, and has a ghost '…' button on every row the viewer may manage", async () => {
    await mount({ role: "owner" });
    expect(menuFor("Dana Reyes").getAttribute("aria-haspopup")).toBe("menu");
    expect(menuFor("Dana Reyes").getAttribute("aria-expanded")).toBe("false");
    expect(findAll("button[aria-label^='More for ']").map((button) => button.getAttribute("aria-label"))).toEqual([
      "More for Adam Park",
      "More for Dana Reyes",
      "More for Luis Ortega",
      "More for Amara Okafor",
      "More for Zed Young",
      "More for max@acme.test",
      "More for grace@acme.test",
    ]);
    // The viewer's own row has none.
    expect(hasMenu("Sam Carter")).toBe(false);
  });

  test("offers only the roles roleOptions allows, other than the one held: an admin, for a developer or a member", async () => {
    await mount({ role: "admin" });
    expect(await offered("Dana Reyes")).toEqual(["Change role to Member", "Remove from workspace"]);
    await press(menuFor("Dana Reyes"), "Escape");
    expect(await offered("max@acme.test")).toEqual(["Change role to Developer", "Remove from workspace"]);
  });

  test("an owner may move anyone but themselves between all four", async () => {
    await mount({ role: "owner" });
    expect(await offered("Adam Park")).toEqual(["Change role to Member", "Change role to Developer", "Change role to Owner", "Remove from workspace"]);
    await press(menuFor("Adam Park"), "Escape");
    expect(await offered("Luis Ortega")).toEqual(["Change role to Developer", "Change role to Admin", "Change role to Owner", "Remove from workspace"]);
  });

  test("nothing on an admin's or owner's row when the viewer is an admin, and nothing on one's own row", async () => {
    await mount({ role: "admin" });
    expect(hasMenu("Adam Park")).toBe(false);
    expect(hasMenu("Sam Carter")).toBe(false);
    await cleanup();
    await mount({ role: "owner" });
    expect(hasMenu("Sam Carter")).toBe(false);
    expect(rowOf("Sam Carter").textContent).toContain("Owner");
  });

  test("an organization admin with no membership acts as an owner on every row", async () => {
    await mount({ viewer: { ...detailFor("owner"), membership: null, organizationAdmin: true } });
    expect(await offered("Sam Carter")).toEqual(["Change role to Member", "Change role to Developer", "Change role to Admin", "Remove from workspace"]);
  });

  test("the menu opens over the list: nothing around the table clips it at any width", async () => {
    await mount({ role: "owner" });
    const wrapper = find("table").parentElement!;
    // No overflow of any kind on the wrapper: an `overflow-x-auto` there would clip the absolutely positioned menu on a
    // tablet. (The rendered check at 800px is in the report; class names are all a DOM without layout can say.)
    expect(wrapper.className).not.toMatch(/overflow/);
    expect(wrapper.getAttribute("data-slot")).toBe("members-list");
    // Rows stack below a desktop (the table needs about 620px, more than a tablet beside the sidebar leaves) and are a table from `lg`.
    expect(find("table").className).toContain("max-lg:block");
    expect(find("thead").className).toContain("max-lg:hidden");
    expect(wrapper.className).not.toContain("max-sm:");
    // One direction only: at exactly 1024px a browser matches `max-lg:` and `lg:` together, which would show a hybrid row.
    const classes = [...findAll("table, table *")].map((element) => element.getAttribute("class") ?? "").join(" ");
    expect(classes).not.toMatch(/(^|\s)(sm|md|lg|xl):/);
  });

  test("without workspace.members.manage the list only shows: no menu, no actions column", async () => {
    const detail = detailFor("developer", ["workspace.members.read"]);
    await mount({ viewer: detail });
    expect(findAll("button[aria-label^='More for ']")).toHaveLength(0);
    expect(findAll("thead th[aria-hidden='true']")).toHaveLength(0);
    expect(rowOf("Dana Reyes").textContent).toContain("Developer");
    expect(document.body.textContent).not.toContain("Remove from workspace");
  });

  test("a member who hasn't signed in is managed like anyone else", async () => {
    await mount({ role: "owner" });
    expect(await offered("grace@acme.test")).toContain("Remove from workspace");
  });

  describe("Change role", () => {
    test("choosing one changes the role with the revision the viewer last saw, and the row shows it", async () => {
      const { world, writes } = await mount({ role: "admin" });
      await offered("Dana Reyes");
      await click(item("Change role to Member"));
      await until(() => writes().length === 1, "the role change");
      expect(writes()[0]).toEqual({ method: "PATCH", path: `/${WORKSPACE_ID}/members/wm_dana`, body: { role: "member", expectedRevision: 7 } });
      expect(world.members.find((candidate) => candidate.membershipId === "wm_dana")!.role).toBe("member");
      await until(() => !rowOf("dana@acme.test").textContent!.includes("Developer"), "the new role");
      expect(rowOf("dana@acme.test").textContent).toContain("Member");
      // The menu closed, and no dialog was needed.
      expect(menuItems()).toHaveLength(0);
      expect(openDialogs()).toHaveLength(0);
    });

    test("a role change that fails says why in the neutral style, above the list: amber is for payments", async () => {
      const { world } = await mount({ role: "admin" });
      world.fail = (call) => (call.method === "PATCH" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
      await offered("Dana Reyes");
      await click(item("Change role to Member"));
      await until(() => findAll('[role="alert"]').length === 1, "the refusal");
      expect(find('[role="alert"]').textContent).toBe("This workspace changed. Review and try again.");
      expect(findAll('[role="alert"]').map(isNeutral)).toEqual([true]);
      // The row still shows the role it had.
      expect(rowOf("Dana Reyes").textContent).toContain("Developer");
    });

    test("while a request is out the menus wait", async () => {
      const hold = deferred<void>();
      const { world, writes } = await mount({ role: "admin" });
      world.gate = hold.promise;
      await offered("Dana Reyes");
      await click(item("Change role to Member"));
      await until(() => writes().length === 1, "the role change to be out");
      expect(findAll<HTMLButtonElement>("button[aria-label^='More for ']").every((button) => button.disabled)).toBe(true);
      await act(async () => hold.resolve());
      await flush();
      expect(findAll<HTMLButtonElement>("button[aria-label^='More for ']").some((button) => button.disabled)).toBe(false);
    });

    test("leaves billing alone", async () => {
      const { client, writes } = await mount({ role: "admin" });
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      await offered("Dana Reyes");
      await click(item("Change role to Member"));
      await until(() => writes().length === 1, "the role change");
      await flush();
      expect(client.getQueryState(statusKey)?.isInvalidated).toBe(false);
    });
  });

  describe("Remove from workspace", () => {
    test("asks first, in a dialog: 'Remove <name> from this workspace?', Cancel and a destructive Remove", async () => {
      const { writes } = await mount({ role: "admin" });
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      const dialog = removeDialog();
      expect(find("h2", dialog).textContent).toBe("Remove max@acme.test from this workspace?");
      expect(dialog.textContent).toContain("They lose access to this workspace, and any licenses assigned to them are freed.");
      expect(findAll("button", dialog).map((button) => button.getAttribute("aria-label") ?? button.textContent!.trim())).toEqual(["Close", "Cancel", "Remove"]);
      expect(byText("Remove", "button", dialog).className).toContain("bg-destructive");
      // Nothing is sent until the second step, and the row is still there.
      expect(writes()).toHaveLength(0);
      expect(rowOf("max@acme.test")).toBeTruthy();
    });

    test("removes only on the second step, with the revision, and the row goes", async () => {
      const { world, writes } = await mount({ role: "admin" });
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      await click(byText("Remove", "button", removeDialog()));
      await until(() => writes().length === 1, "the removal");
      expect(writes()[0]).toEqual({ method: "DELETE", path: `/${WORKSPACE_ID}/members/wm_max`, body: { expectedRevision: 7 } });
      expect(world.members.some((candidate) => candidate.membershipId === "wm_max")).toBe(false);
      await until(() => openDialogs().length === 0, "the dialog to close");
      await until(() => findAll("tbody tr").every((row) => !row.textContent!.includes("max@acme.test")), "the row to go");
    });

    test("removing a member frees their licenses, so billing's status is marked stale", async () => {
      const { client, writes } = await mount({ role: "admin" });
      const statusKey = billingKeys.status({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      const catalogKey = billingKeys.catalog({ base: "/api/portal/billing", locale: "en-US" }, { kind: "workspace", workspaceId: WORKSPACE_ID });
      client.setQueryData(statusKey, { licenses: [] });
      client.setQueryData(catalogKey, { products: [] });
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      await click(byText("Remove", "button", removeDialog()));
      await until(() => writes().length === 1, "the removal");
      await until(() => client.getQueryState(statusKey)?.isInvalidated === true, "billing's status to be marked stale");
      expect(client.getQueryState(catalogKey)?.isInvalidated).toBe(false);
    });

    test("Cancel closes it with nothing sent, and focus goes back to the row's menu button", async () => {
      const { writes } = await mount({ role: "admin" });
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      await click(byText("Cancel", "button", removeDialog()));
      expect(openDialogs()).toHaveLength(0);
      expect(writes()).toHaveLength(0);
      expect(document.activeElement).toBe(menuFor("max@acme.test"));
    });

    test("Escape and the × close it the same way", async () => {
      const { writes } = await mount({ role: "admin" });
      for (const close of [escape, () => click(find("button[aria-label='Close']", removeDialog()))]) {
        await offered("max@acme.test");
        await click(item("Remove from workspace"));
        expect(find("h2", removeDialog()).textContent).toBe("Remove max@acme.test from this workspace?");
        await close();
        expect(openDialogs()).toHaveLength(0);
        expect(writes()).toHaveLength(0);
        expect(document.activeElement).toBe(menuFor("max@acme.test"));
      }
    });

    test("a refusal is shown inside the dialog, in the neutral style, which stays open for another try", async () => {
      const { world, writes } = await mount({ role: "admin" });
      world.fail = (call) => (call.method === "DELETE" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      await click(byText("Remove", "button", removeDialog()));
      await until(() => findAll('[role="alert"]', removeDialog()).length === 1, "the refusal");
      expect(find('[role="alert"]', removeDialog()).textContent).toBe("This workspace changed. Review and try again.");
      expect(findAll('[role="alert"]').map(isNeutral)).toEqual([true]);
      expect(byText("Remove", "button", removeDialog()).hasAttribute("disabled")).toBe(false);
      // Another try, once Core agrees.
      world.fail = undefined;
      await click(byText("Remove", "button", removeDialog()));
      await until(() => writes().length === 2, "the second try");
      await until(() => openDialogs().length === 0, "the dialog to close");
    });

    test("while the request is out the dialog is busy and can't be dismissed", async () => {
      const hold = deferred<void>();
      const { world, writes } = await mount({ role: "admin" });
      world.gate = hold.promise;
      await offered("max@acme.test");
      await click(item("Remove from workspace"));
      await click(byText("Remove", "button", removeDialog()));
      await until(() => writes().length === 1, "the removal to be out");
      const dialog = removeDialog();
      expect(byText("Remove", "button", dialog).getAttribute("aria-busy")).toBe("true");
      expect(byText("Remove", "button", dialog).hasAttribute("disabled")).toBe(true);
      expect(byText("Cancel", "button", dialog).hasAttribute("disabled")).toBe(true);
      const cancel = new Event("cancel", { cancelable: true });
      await act(async () => void dialog.dispatchEvent(cancel));
      expect(cancel.defaultPrevented).toBe(true);
      await act(async () => hold.resolve());
      await until(() => openDialogs().length === 0, "the dialog to close");
    });

    test("is offered only where the viewer may remove them", async () => {
      await mount({ role: "admin" });
      expect(await offered("Dana Reyes")).toContain("Remove from workspace");
      expect(hasMenu("Adam Park")).toBe(false);
    });
  });
});

describe("the confirm dialog", () => {
  const closes: boolean[] = [];
  const mountDialog = (onConfirm: () => Promise<string | null>) =>
    render(
      <ConfirmDialog
        title="Remove Dana Reyes from this workspace?"
        description="They lose access."
        cancelLabel="Cancel"
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onClose={(done) => void closes.push(done)}
      />,
    );
  afterEach(() => void (closes.length = 0));

  test("an onConfirm that rejects says so in words and leaves the dialog usable: Remove again, Cancel, Escape and the × all work", async () => {
    let attempts = 0;
    await mountDialog(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("the connection dropped");
      return null;
    });
    const dialog = removeDialog();
    await click(byText("Remove", "button", dialog));
    await flush();
    // The throw became the generic refusal, shown inside the dialog, in the neutral style; the dialog is not locked.
    expect(find('[role="alert"]', dialog).textContent).toBe("Something went wrong. Try again.");
    expect(findAll('[role="alert"]').map(isNeutral)).toEqual([true]);
    const names = (button: HTMLElement) => button.getAttribute("aria-label") ?? button.textContent!.trim();
    const dialogButtons = findAll<HTMLButtonElement>("button", dialog);
    expect(dialogButtons.map(names)).toEqual(["Close", "Cancel", "Remove"]);
    for (const button of dialogButtons) {
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-busy")).toBeNull();
    }
    const cancel = new Event("cancel", { cancelable: true });
    await act(async () => void dialog.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(false);
    expect(closes).toEqual([]);
    // Another try runs, and the next throw replaces the words rather than stacking them.
    await click(byText("Remove", "button", dialog));
    await flush();
    expect(attempts).toBe(2);
    expect(findAll('[role="alert"]', dialog)).toHaveLength(1);
    // Once it goes through the dialog is over, and it says it was done.
    await click(byText("Remove", "button", dialog));
    await flush();
    expect(attempts).toBe(3);
    expect(closes).toEqual([true]);
  });

  test("after a throw Cancel still backs out with no request", async () => {
    await mountDialog(async () => {
      throw new Error("boom");
    });
    await click(byText("Remove", "button", removeDialog()));
    await flush();
    await click(byText("Cancel", "button", removeDialog()));
    expect(closes).toEqual([false]);
  });
});

describe("where focus goes after a confirmed Remove", () => {
  /** Opens the row's menu, chooses Remove from workspace and confirms it. */
  async function remove(label: string, writes: () => unknown[], count: number) {
    await click(menuFor(label));
    await click(item("Remove from workspace"));
    await click(byText("Remove", "button", removeDialog()));
    await until(() => writes().length === count, "the removal");
    await until(() => openDialogs().length === 0, "the dialog to close");
    await flush();
  }

  test("on the next row's menu button", async () => {
    const { writes } = await mount({ role: "admin" });
    await remove("Luis Ortega", writes, 1);
    await until(() => !hasMenu("Luis Ortega"), "the row to go");
    expect(document.activeElement).toBe(menuFor("Amara Okafor"));
  });

  test("on the previous row's menu button when it was the last row", async () => {
    const { writes } = await mount({ role: "admin" });
    await remove("grace@acme.test", writes, 1);
    await until(() => !hasMenu("grace@acme.test"), "the row to go");
    expect(document.activeElement).toBe(menuFor("max@acme.test"));
  });

  test("past a row that has no menu (an Admin can't manage an Admin)", async () => {
    const { writes } = await mount({ role: "admin", members: [DANA, ADAM, LUIS] });
    await remove("Dana Reyes", writes, 1);
    await until(() => !hasMenu("Dana Reyes"), "the row to go");
    expect(hasMenu("Adam Park")).toBe(false);
    expect(document.activeElement).toBe(menuFor("Luis Ortega"));
  });

  test("on the list itself when no row with a menu is left", async () => {
    const { writes } = await mount({ role: "admin", members: [SAM, DANA] });
    await remove("Dana Reyes", writes, 1);
    await until(() => !hasMenu("Dana Reyes"), "the row to go");
    const list = find("[data-slot='members-list']");
    expect(list.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(list);
  });

  test("a refused removal leaves focus where it was: nothing moves while the dialog stays open", async () => {
    const { world, writes } = await mount({ role: "admin" });
    world.fail = (call) => (call.method === "DELETE" ? reply(409, { error: "membership_changed", error_description: "changed" }) : undefined);
    await click(menuFor("Luis Ortega"));
    await click(item("Remove from workspace"));
    await click(byText("Remove", "button", removeDialog()));
    await until(() => findAll('[role="alert"]', removeDialog()).length === 1, "the refusal");
    expect(writes()).toHaveLength(1);
    expect(openDialogs()).toHaveLength(1);
    expect(document.activeElement).not.toBe(menuFor("Amara Okafor"));
  });
});

describe("a members list that can't be read", () => {
  test("says so in the neutral style, with Try again", async () => {
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
    expect(columns()).not.toContain("Licenses");
    expect(findAll("input[type=checkbox]")).toHaveLength(0);
  });

  test("hides user IDs when asked not to", async () => {
    await mount({ ...admin() });
    expect(document.body.textContent).not.toContain("u_dana");
  });

  test("changes a role and removes a member through the row's menu", async () => {
    const { writes } = await mount({ ...admin(), showUserIds: true });
    expect(await offered("Dana Reyes")).toEqual(["Change role to Member", "Change role to Admin", "Change role to Owner", "Remove from workspace"]);
    await click(item("Change role to Admin"));
    await until(() => writes().length === 1, "the role change");
    expect(writes()[0]).toMatchObject({ method: "PATCH", path: `/${WORKSPACE_ID}/members/wm_dana`, body: { role: "admin" } });
    await until(() => !menuItems().length, "the menu to close");
    await click(menuFor("Dana Reyes"));
    await click(item("Remove from workspace"));
    await click(byText("Remove", "button", removeDialog()));
    await until(() => writes().length === 2, "the removal");
    expect(writes()[1]).toMatchObject({ method: "DELETE", path: `/${WORKSPACE_ID}/members/wm_dana` });
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });
});

describe("what the Members screens carry", () => {
  test("they don't reach the contract's billing schemas or zod, which the admin portal would ship", () => {
    for (const entry of ["components/members-panel.tsx", "components/confirm-dialog.tsx"]) {
      const { files, specifiers } = runtimeImports(entry);
      expect(specifiers.filter((specifier) => SCHEMA_SPECIFIER.test(specifier))).toEqual([]);
      expect(files.filter((file) => file.endsWith("billing-api.ts"))).toEqual([]);
    }
  });

  test("the list needs only the catalog from a host: no billing client, no ways out", async () => {
    const source: MembersLicenses = { catalog: CATALOG };
    await mount({ source });
    expect(chipsOf(rowOf("Dana Reyes"))).toEqual(["Call Unlimited", "Example Add-on"]);
  });
});
