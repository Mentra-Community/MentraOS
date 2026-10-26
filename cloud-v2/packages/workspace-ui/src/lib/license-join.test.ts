import { describe, expect, test } from "bun:test";
import type { LicenseView } from "@mentra/workspace-contract";
import { runtimeImports, SCHEMA_SPECIFIER } from "../test-imports";
import { catalogEntryFor, fleetEntryFor, licenseBillingFor } from "../test-billing-fixtures";
import { licenseFor } from "../test-fixtures";
import { licenseStrings as t } from "../strings/licenses";
import {
  fitFor,
  holdsSeat,
  joinLicenses,
  listedAction,
  seatCounts,
  type LicenseFit,
} from "./license-join";

/** A Core license with `holders` seats taken (by wm_h1, wm_h2, …) of `quantity`. */
function core(licenseId: string, product: string, quantity: number, holders: number | string[], extra: Partial<LicenseView> = {}): LicenseView {
  const ids = typeof holders === "number" ? Array.from({ length: holders }, (_, index) => `wm_h${index + 1}`) : holders;
  return licenseFor({
    licenseId,
    product,
    quantity,
    seatsUsed: ids.length,
    seats: ids.map((membershipId) => ({ membershipId, mentraUserId: `u_${membershipId}`, assignedAt: "2026-09-01T10:00:00.000Z" })),
    ...extra,
  });
}

const CALL = "mentra.call.unlimited";
const FLEET = "mentra.fleet";
const CATALOG = [catalogEntryFor(), fleetEntryFor()];

describe("seatCounts", () => {
  test("free is what is left, and over is how far past the quantity the seats are", () => {
    expect(seatCounts({ quantity: 5, seatsUsed: 3 })).toEqual({ quantity: 5, used: 3, free: 2, over: 0 });
    expect(seatCounts({ quantity: 5, seatsUsed: 5 })).toEqual({ quantity: 5, used: 5, free: 0, over: 0 });
    expect(seatCounts({ quantity: 5, seatsUsed: 7 })).toEqual({ quantity: 5, used: 7, free: 0, over: 2 });
  });
});

describe("holdsSeat", () => {
  test("is true for a membership in the license's seats, and false where Core lists none", () => {
    const license = core("lic_call", CALL, 5, ["wm_a", "wm_b"]);
    expect(holdsSeat(license, "wm_a")).toBe(true);
    expect(holdsSeat(license, "wm_c")).toBe(false);
    expect(holdsSeat({ seats: undefined }, "wm_a")).toBe(false);
  });
});

describe("listedAction", () => {
  test("finds the action billing lists by kind, and is null for one it doesn't or when there is no billing", () => {
    const billing = licenseBillingFor({ actions: [{ kind: "cancel", fallbackLabel: "Cancel" }, { kind: "pause", fallbackLabel: "Pause", returns: false }] });
    expect(listedAction(billing, "cancel")).toEqual({ kind: "cancel", fallbackLabel: "Cancel" });
    expect(listedAction(billing, "pause")).toEqual({ kind: "pause", fallbackLabel: "Pause", returns: false });
    expect(listedAction(billing, "add_seats")).toBeNull();
    expect(listedAction(null, "add_seats")).toBeNull();
    expect(listedAction(undefined, "add_seats")).toBeNull();
  });
});

describe("joinLicenses: a card per license", () => {
  test("joins a Core license to billing by its id and to the catalog by its product", () => {
    const license = core("lic_call", CALL, 5, 3);
    const billing = licenseBillingFor();
    const [card, ...rest] = joinLicenses({ licenses: [license], billing: [billing], catalog: CATALOG });
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      licenseId: "lic_call",
      product: CALL,
      name: "Mentra Call Unlimited",
      shortName: "Call Unlimited",
      icon: "/api/portal/billing/ui/icons/mentra-call.png",
      seats: { quantity: 5, used: 3, free: 2, over: 0 },
      problem: null,
      justBought: false,
    });
    expect(card!.license).toBe(license);
    expect(card!.billing).toBe(billing);
    expect(card!.catalog).toBe(CATALOG[0]);
    expect(card!.features).toEqual([{ key: "call.unlimited", name: "Unlimited Teams calls", appName: "Mentra Call" }]);
  });

  test("matches billing by licenseId, not by product", () => {
    const cards = joinLicenses({
      licenses: [core("lic_a", CALL, 5, 0)],
      billing: [licenseBillingFor({ licenseId: "lic_other", status: "past_due", fallbackStatusLabel: "Payment failed" })],
      catalog: CATALOG,
    });
    // Same product, different id: Core's license takes none of billing's entry, which is a card of its own.
    const mine = cards.find((card) => card.licenseId === "lic_a")!;
    expect(mine.billing).toBeNull();
    expect(mine.problem).toBeNull();
    expect(cards.find((card) => card.licenseId === "lic_other")).toMatchObject({ license: null, problem: "past_due" });
  });

  test("the short name is the name when the catalog sends none", () => {
    const [card] = joinLicenses({ licenses: [core("lic_fleet", FLEET, 10, 0)], catalog: CATALOG });
    expect(card).toMatchObject({ name: "Fleet", shortName: "Fleet", icon: null });
  });

  test("a product the catalog lacks is shown by its key, with no icon or features", () => {
    const [card] = joinLicenses({ licenses: [core("lic_x", "acme.secret", 2, 0)], catalog: CATALOG });
    expect(card).toMatchObject({ name: "acme.secret", shortName: "acme.secret", icon: null, features: [], catalog: null });
  });

  test("a held product the catalog no longer offers is still named: it has its name, icon and features", () => {
    // Billing sends every product the owner holds, even one it has stopped selling, so that its card has a name.
    const personOnly = fleetEntryFor({ offer: undefined, icon: "/api/portal/billing/ui/icons/fleet.png" });
    const [card] = joinLicenses({ licenses: [core("lic_fleet", FLEET, 10, 0)], catalog: [personOnly] });
    expect(card).toMatchObject({ name: "Fleet", icon: "/api/portal/billing/ui/icons/fleet.png" });
    expect(card!.catalog).toBe(personOnly);
    expect(card!.features.map((feature) => feature.key)).toEqual(["fleet.managed", "fleet.assignments", "fleet.usage"]);
  });

  test("a product listed twice is named by its first entry", () => {
    const first = catalogEntryFor({ name: "Call (first)", shortName: "First" });
    const second = catalogEntryFor({ name: "Call (second)", shortName: "Second" });
    const [card] = joinLicenses({ licenses: [core("lic_call", CALL, 5, 0)], catalog: [first, second] });
    expect(card).toMatchObject({ name: "Call (first)", shortName: "First" });
    expect(card!.catalog).toBe(first);
  });

  test("a license billing lists twice is joined to its first entry", () => {
    const first = licenseBillingFor({ status: "past_due", fallbackStatusLabel: "first" });
    const second = licenseBillingFor({ status: "active", fallbackStatusLabel: "second" });
    const cards = joinLicenses({ licenses: [core("lic_call", CALL, 5, 0)], billing: [first, second], catalog: CATALOG });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.billing).toBe(first);
    expect(cards[0]!.problem).toBe("past_due");
    // Two entries for an id Core lacks are one card, not two.
    const billingOnly = joinLicenses({
      licenses: [],
      billing: [licenseBillingFor({ licenseId: "lic_new", status: "processing", fallbackStatusLabel: "first" }), licenseBillingFor({ licenseId: "lic_new", status: "incomplete", fallbackStatusLabel: "second" })],
      catalog: CATALOG,
    });
    expect(billingOnly).toHaveLength(1);
    expect(billingOnly[0]!.billing!.fallbackStatusLabel).toBe("first");
  });

  test("a license that has ended is no card, and neither is billing's entry for it", () => {
    const ended = core("lic_old", CALL, 5, 0, { endedAt: "2026-10-01T00:00:00.000Z" });
    expect(joinLicenses({ licenses: [ended], billing: [licenseBillingFor({ licenseId: "lic_old" })], catalog: CATALOG })).toEqual([]);
  });

  test("a billing entry with no Core license yet is a card of its own, with no seats", () => {
    const processing = licenseBillingFor({ licenseId: "lic_new", status: "processing", fallbackStatusLabel: "Setting up" });
    const incomplete = licenseBillingFor({ licenseId: "lic_half", product: FLEET, status: "incomplete", fallbackStatusLabel: "Incomplete" });
    const cards = joinLicenses({ licenses: [core("lic_call", CALL, 5, 1)], billing: [licenseBillingFor(), processing, incomplete], catalog: CATALOG });
    const byId = Object.fromEntries(cards.map((card) => [card.licenseId, card]));
    expect(Object.keys(byId).sort()).toEqual(["lic_call", "lic_half", "lic_new"]);
    expect(byId.lic_new).toMatchObject({ license: null, seats: null, name: "Mentra Call Unlimited", justBought: true, problem: null });
    expect(byId.lic_new!.billing).toBe(processing);
    expect(byId.lic_half).toMatchObject({ license: null, seats: null, name: "Fleet", problem: "incomplete" });
  });

  test("with no Core licenses at all, every billing entry is a card", () => {
    const cards = joinLicenses({ licenses: [], billing: [licenseBillingFor({ licenseId: "lic_me" })], catalog: CATALOG });
    expect(cards.map((card) => [card.licenseId, card.license, card.seats])).toEqual([["lic_me", null, null]]);
  });

  test("without billing's status there is a card per Core license, with Core's seats and no money", () => {
    const cards = joinLicenses({ licenses: [core("lic_call", CALL, 5, 7)], billing: null, catalog: CATALOG });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ billing: null, seats: { used: 7, over: 2, free: 0 }, problem: "over" });
  });

  test("an unknown status is a card like any other: no problem, no special rank", () => {
    const [card] = joinLicenses({
      licenses: [core("lic_call", CALL, 5, 1)],
      billing: [licenseBillingFor({ status: "paused", fallbackStatusLabel: "Paused" })],
      catalog: CATALOG,
    });
    expect(card).toMatchObject({ problem: null, justBought: false });
    expect(card!.billing!.status).toBe("paused");
  });
});

describe("joinLicenses: the order", () => {
  const license = (id: string, product: string, quantity = 5, holders: number | string[] = 1) => core(id, product, quantity, holders);
  const catalog = [
    catalogEntryFor(),
    fleetEntryFor(),
    catalogEntryFor({ product: "example.addon", name: "Example Add-on", shortName: "Example Add-on" }),
    catalogEntryFor({ product: "acme.zed", name: "zed tools", shortName: undefined }),
  ];

  test("payment failed, payment incomplete, over-assigned, then the license just bought, then by name", () => {
    const licenses = [
      license("lic_plain_b", "example.addon"),
      license("lic_over", FLEET, 3, 5),
      license("lic_plain_a", "acme.zed"),
      license("lic_bought", CALL),
      license("lic_past_due", CALL),
      license("lic_incomplete", FLEET),
    ];
    const billing = [
      licenseBillingFor({ licenseId: "lic_past_due", status: "past_due", fallbackStatusLabel: "Payment failed" }),
      licenseBillingFor({ licenseId: "lic_incomplete", product: FLEET, status: "incomplete", fallbackStatusLabel: "Incomplete" }),
    ];
    const cards = joinLicenses({ licenses, billing, catalog, purchase: { licenseId: "lic_bought" } });
    expect(cards.map((card) => card.licenseId)).toEqual([
      "lic_past_due",
      "lic_incomplete",
      "lic_over",
      "lic_bought",
      "lic_plain_b",
      "lic_plain_a",
    ]);
    expect(cards.map((card) => card.problem)).toEqual(["past_due", "incomplete", "over", null, null, null]);
    expect(cards.map((card) => card.justBought)).toEqual([false, false, false, true, false, false]);
  });

  test("the input's order doesn't matter", () => {
    const licenses = [license("lic_a", CALL), license("lic_b", FLEET), license("lic_c", "example.addon")];
    const billing = [licenseBillingFor({ licenseId: "lic_c", product: "example.addon", status: "past_due", fallbackStatusLabel: "x" })];
    const forward = joinLicenses({ licenses, billing, catalog }).map((card) => card.licenseId);
    const backward = joinLicenses({ licenses: [...licenses].reverse(), billing, catalog }).map((card) => card.licenseId);
    expect(backward).toEqual(forward);
    expect(forward).toEqual(["lic_c", "lic_b", "lic_a"]);
  });

  test("by name ignores case, and a number sorts as a number", () => {
    const cards = joinLicenses({
      licenses: [license("lic_1", "acme.zed"), license("lic_2", "p.ten"), license("lic_3", "p.nine"), license("lic_4", FLEET)],
      catalog: [...catalog, catalogEntryFor({ product: "p.ten", name: "Plan 10" }), catalogEntryFor({ product: "p.nine", name: "Plan 9" })],
    });
    expect(cards.map((card) => card.name)).toEqual(["Fleet", "Plan 9", "Plan 10", "zed tools"]);
  });

  test("names sort in the locale given: a letter with a mark sorts where that language puts it", () => {
    const catalog = [catalogEntryFor({ product: "p.zebra", name: "Zebra" }), catalogEntryFor({ product: "p.apfel", name: "Äpfel" })];
    const licenses = [license("lic_1", "p.zebra"), license("lic_2", "p.apfel")];
    // German files Ä with A, Swedish after Z.
    expect(joinLicenses({ licenses, catalog, locale: "de" }).map((card) => card.name)).toEqual(["Äpfel", "Zebra"]);
    expect(joinLicenses({ licenses, catalog, locale: "sv" }).map((card) => card.name)).toEqual(["Zebra", "Äpfel"]);
    // A tag Intl can't use falls back to the default locale instead of throwing.
    expect(joinLicenses({ licenses, catalog, locale: "not a locale!" }).map((card) => card.name)).toEqual(["Äpfel", "Zebra"]);
  });

  test("licenses of the same name keep a fixed order, by id", () => {
    const cards = joinLicenses({ licenses: [license("lic_b", CALL), license("lic_a", CALL)], catalog });
    expect(cards.map((card) => card.licenseId)).toEqual(["lic_a", "lic_b"]);
  });

  test("a card that is both payment failed and over-assigned ranks as payment failed, and says it is over", () => {
    const cards = joinLicenses({
      licenses: [license("lic_over", FLEET, 3, 5), license("lic_both", CALL, 3, 5)],
      billing: [licenseBillingFor({ licenseId: "lic_both", status: "past_due", fallbackStatusLabel: "x" })],
      catalog,
    });
    expect(cards.map((card) => [card.licenseId, card.problem, card.seats!.over])).toEqual([
      ["lic_both", "past_due", 2],
      ["lic_over", "over", 2],
    ]);
  });

  test("a license being set up ranks with the one just bought, ahead of the rest", () => {
    const cards = joinLicenses({
      licenses: [license("lic_a", "acme.zed")],
      billing: [licenseBillingFor({ licenseId: "lic_new", status: "processing", fallbackStatusLabel: "Setting up" })],
      catalog,
    });
    expect(cards.map((card) => card.licenseId)).toEqual(["lic_new", "lic_a"]);
  });

  test("a purchase that isn't in Core yet, or names no license, marks no card", () => {
    const licenses = [license("lic_a", CALL)];
    expect(joinLicenses({ licenses, catalog, purchase: { licenseId: null } })[0]!.justBought).toBe(false);
    expect(joinLicenses({ licenses, catalog, purchase: { licenseId: "lic_not_here" } })[0]!.justBought).toBe(false);
    expect(joinLicenses({ licenses, catalog, purchase: null })[0]!.justBought).toBe(false);
  });
});

describe("fitFor", () => {
  const luis = { membershipId: "wm_luis", name: "Luis Ortega" };
  const amara = { membershipId: "wm_amara", name: "Amara Okafor" };
  const sofia = { membershipId: "wm_sofia", name: "Sofia Alvarez" };
  const nameOf = (person: { name: string }) => person.name;
  const line = (fit: LicenseFit<{ name: string }>, canAddSeats = true) => t.fit.line(fit, { nameOf, canAddSeats });

  test("enough for both: '2 of 5 licenses available: enough for both.'", () => {
    const fit = fitFor(core("lic_call", CALL, 5, 3), [luis, amara]);
    expect(fit).toMatchObject({ kind: "enough", ok: true, free: 2, quantity: 5, over: 0, fit: 2, needed: 2, holders: [] });
    expect(fit.recipients).toEqual([luis, amara]);
    expect(line(fit)).toBe("2 of 5 licenses available: enough for both.");
  });

  test("enough for one, and for all of several", () => {
    expect(line(fitFor(core("lic_call", CALL, 5, 3), [luis]))).toBe("2 of 5 licenses available.");
    expect(line(fitFor(core("lic_call", CALL, 5, 1), [luis, amara, sofia]))).toBe("4 of 5 licenses available: enough for all 3.");
  });

  test("some already hold one: 'Amara Okafor has one. 1 of 3 licenses available, for Luis Ortega.'", () => {
    const fit = fitFor(core("lic_call", CALL, 3, ["wm_amara", "wm_other"]), [luis, amara]);
    expect(fit).toMatchObject({ kind: "some_hold", ok: true, free: 1, quantity: 3, fit: 1, needed: 1 });
    expect(fit.holders).toEqual([amara]);
    expect(fit.recipients).toEqual([luis]);
    expect(line(fit)).toBe("Amara Okafor has one. 1 of 3 licenses available, for Luis Ortega.");
  });

  test("several hold one: 'have one'", () => {
    const fit = fitFor(core("lic_call", CALL, 5, ["wm_amara", "wm_luis"]), [luis, amara, sofia]);
    expect(fit.kind).toBe("some_hold");
    expect(line(fit)).toBe("Luis Ortega and Amara Okafor have one. 3 of 5 licenses available, for Sofia Alvarez.");
  });

  test("everyone already holds one: 'Everyone you chose has one.', and nothing can be assigned", () => {
    const fit = fitFor(core("lic_call", CALL, 5, ["wm_luis", "wm_amara"]), [luis, amara]);
    expect(fit).toMatchObject({ kind: "all_hold", ok: false, needed: 0, fit: 0 });
    expect(fit.holders).toEqual([luis, amara]);
    expect(fit.recipients).toEqual([]);
    expect(line(fit)).toBe("Everyone you chose has one.");
  });

  test("everyone holds one even when the license is full", () => {
    const fit = fitFor(core("lic_call", CALL, 2, ["wm_luis", "wm_amara"]), [luis, amara]);
    expect(fit.kind).toBe("all_hold");
  });

  test("not enough: '2 of 3 fit: remove one or add licenses.', or without 'add seats' where billing lists none", () => {
    const fit = fitFor(core("lic_call", CALL, 3, 1), [luis, amara, sofia]);
    expect(fit).toMatchObject({ kind: "short", ok: false, free: 2, fit: 2, needed: 3 });
    expect(line(fit)).toBe("2 of 3 fit: remove one or add licenses.");
    expect(line(fit, false)).toBe("2 of 3 fit: remove one.");
  });

  test("three chosen with one free asks to remove two", () => {
    const fit = fitFor(core("lic_call", CALL, 3, 2), [luis, amara, sofia]);
    expect(line(fit)).toBe("1 of 3 fit: remove 2 or add licenses.");
  });

  test("the picker's case: four chosen with three free is '3 of 4 fit: remove one or add licenses.'", () => {
    const four = [luis, amara, sofia, { membershipId: "wm_four", name: "Noah Fischer" }];
    const fit = fitFor(core("lic_call", CALL, 5, 2), four);
    expect(fit).toMatchObject({ kind: "short", ok: false, fit: 3, needed: 4 });
    expect(line(fit)).toBe("3 of 4 fit: remove one or add licenses.");
    expect(line(fit, false)).toBe("3 of 4 fit: remove one.");
  });

  test("the people who hold one are not counted against the free seats", () => {
    const fit = fitFor(core("lic_call", CALL, 3, ["wm_amara", "wm_h2"]), [luis, amara, sofia]);
    expect(fit).toMatchObject({ kind: "short", needed: 2, fit: 1 });
    expect(fit.holders).toEqual([amara]);
    expect(line(fit)).toBe("1 of 2 fit: remove one or add licenses.");
  });

  test("none free: 'All 10 licenses are assigned.'", () => {
    const fit = fitFor(core("lic_fleet", FLEET, 10, 10), [luis]);
    expect(fit).toMatchObject({ kind: "full", ok: false, free: 0, over: 0, quantity: 10, fit: 0, needed: 1 });
    expect(line(fit)).toBe("All 10 licenses are assigned.");
  });

  test("an over-assigned license is full, and says by how much", () => {
    const fit = fitFor(core("lic_fleet", FLEET, 5, 7), [luis, amara]);
    expect(fit).toMatchObject({ kind: "full", ok: false, free: 0, over: 2, quantity: 5 });
    expect(line(fit)).toBe("All 5 licenses are assigned.");
  });

  test("nobody chosen is its own state, with no sentence", () => {
    const fit = fitFor(core("lic_call", CALL, 5, 1), []);
    expect(fit).toMatchObject({ kind: "nobody", ok: false, needed: 0, fit: 0, free: 4 });
    expect(line(fit)).toBeNull();
  });

  test("a person chosen twice counts once", () => {
    const fit = fitFor(core("lic_call", CALL, 3, 1), [luis, luis, amara, { ...amara }]);
    expect(fit.recipients).toEqual([luis, amara]);
    expect(fit).toMatchObject({ kind: "enough", needed: 2 });
  });

  test("where Core lists no seats, nobody is known to hold one", () => {
    const license = core("lic_call", CALL, 5, 1, { seats: undefined });
    expect(fitFor(license, [luis]).kind).toBe("enough");
  });

  test("only enough and some-hold can go ahead", () => {
    const kinds = {
      enough: fitFor(core("l", CALL, 5, 0), [luis]),
      some_hold: fitFor(core("l", CALL, 5, ["wm_luis"]), [luis, amara]),
      all_hold: fitFor(core("l", CALL, 5, ["wm_luis"]), [luis]),
      short: fitFor(core("l", CALL, 5, 4), [luis, amara]),
      full: fitFor(core("l", CALL, 5, 5), [luis]),
      nobody: fitFor(core("l", CALL, 5, 0), []),
    };
    for (const [kind, fit] of Object.entries(kinds)) {
      expect(fit.kind).toBe(kind as LicenseFit<unknown>["kind"]);
      expect(fit.ok).toBe(kind === "enough" || kind === "some_hold");
    }
  });
});

describe("what the join pulls in", () => {
  test("it reaches neither the contract's schemas nor zod, so a screen that only lists licenses doesn't carry them", () => {
    expect(runtimeImports("lib/license-join.ts").specifiers.filter((specifier) => SCHEMA_SPECIFIER.test(specifier))).toEqual([]);
  });
});
