import { describe, expect, test } from "bun:test";
import type { BillingTotal, LicenseBilling, Price } from "@mentra/workspace-contract/portal-billing";
import {
  costFact,
  fitNote,
  formatDay,
  formatDayShort,
  formatMoney,
  formatRecurrence,
  groupCardNumber,
  holderNames,
  nameList,
  priceLine,
  taxNote,
  totalSummary,
} from "./billing-format";
import { formatDate } from "./format";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const perSeat = (amountMinor = 2900): Price => ({
  scheme: "per_seat",
  unit: usd(amountMinor),
  recurrence: { interval: "month", count: 1 },
});

const license = (overrides: Partial<LicenseBilling> = {}): Pick<LicenseBilling, "price" | "quantity" | "total" | "tax"> => ({
  price: perSeat(),
  quantity: 5,
  total: usd(14500),
  tax: "excluded",
  ...overrides,
});

describe("formatMoney", () => {
  test("a whole amount drops its zero decimals, in the portal's locale", () => {
    expect(formatMoney(usd(2900), "en-US")).toBe("$29");
    expect(formatMoney(usd(14500), "en-US")).toBe("$145");
    expect(formatMoney({ amountMinor: 2900, currency: "EUR" }, "de-DE")).toBe("29 €");
  });

  test("an amount with cents keeps both digits", () => {
    expect(formatMoney(usd(1450), "en-US")).toBe("$14.50");
    expect(formatMoney(usd(5), "en-US")).toBe("$0.05");
    expect(formatMoney({ amountMinor: 1450, currency: "EUR" }, "de-DE")).toBe("14,50 €");
  });

  test("minor units follow the currency's own digits: none for yen, three for dinar", () => {
    expect(formatMoney({ amountMinor: 2900, currency: "JPY" }, "en-US")).toBe("¥2,900");
    expect(formatMoney({ amountMinor: 1500, currency: "KWD" }, "en-US")).toBe("KWD 1.500");
    expect(formatMoney({ amountMinor: 1000, currency: "KWD" }, "en-US")).toBe("KWD 1");
  });

  test("a locale that isn't a language tag falls back to en-US instead of throwing", () => {
    expect(formatMoney(usd(2900), "not a locale!")).toBe("$29");
  });
});

describe("formatRecurrence", () => {
  test("one interval is 'a month', several are 'every 3 months'", () => {
    expect(formatRecurrence({ interval: "month", count: 1 }, "en-US")).toBe("a month");
    expect(formatRecurrence({ interval: "month", count: 3 }, "en-US")).toBe("every 3 months");
    expect(formatRecurrence({ interval: "day", count: 1 }, "en-US")).toBe("a day");
    expect(formatRecurrence({ interval: "week", count: 2 }, "en-US")).toBe("every 2 weeks");
    expect(formatRecurrence({ interval: "year", count: 1 }, "en-US")).toBe("a year");
  });
});

describe("dates", () => {
  const instant = "2026-11-20T02:00:00.000Z";

  // Bun follows `process.env.TZ` as it changes, but not its deletion: put the zone back by assigning it.
  const systemZone = process.env.TZ ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;

  function inTimeZone<T>(timeZone: string, run: () => T): T {
    process.env.TZ = timeZone;
    try {
      return run();
    } finally {
      process.env.TZ = systemZone;
    }
  }

  test("formatDay is the day in the viewer's time zone, not UTC's", () => {
    expect(inTimeZone("America/Los_Angeles", () => formatDay(instant, "en-US"))).toBe("Nov 19, 2026");
    expect(inTimeZone("Asia/Tokyo", () => formatDay(instant, "en-US"))).toBe("Nov 20, 2026");
    expect(inTimeZone("UTC", () => formatDay(instant, "en-US"))).toBe("Nov 20, 2026");
  });

  test("formatDayShort leaves the year out, in the same zone", () => {
    expect(inTimeZone("America/Los_Angeles", () => formatDayShort(instant, "en-US"))).toBe("Nov 19");
    expect(inTimeZone("Asia/Tokyo", () => formatDayShort(instant, "en-US"))).toBe("Nov 20");
  });

  test("the portal's locale decides the order and the words", () => {
    expect(inTimeZone("UTC", () => formatDay(instant, "en-GB"))).toBe("20 Nov 2026");
    expect(inTimeZone("UTC", () => formatDay(instant, "de-DE"))).toBe("20.11.2026");
  });

  test("something that is not a date comes back as it was sent", () => {
    expect(formatDay("not a date", "en-US")).toBe("not a date");
    expect(formatDayShort("not a date", "en-US")).toBe("not a date");
  });

  test("formatDate takes an optional locale and defaults to en-US", () => {
    expect(inTimeZone("UTC", () => formatDate(instant))).toBe("Nov 20, 2026");
    expect(inTimeZone("UTC", () => formatDate(instant, "en-GB"))).toBe("20 Nov 2026");
  });
});

describe("taxNote", () => {
  test("says 'before tax' for excluded, 'including tax' for included, and nothing for the rest", () => {
    expect(taxNote("excluded")).toBe("before tax");
    expect(taxNote("included")).toBe("including tax");
    expect(taxNote("none")).toBeNull();
    expect(taxNote("reverse_charge")).toBeNull();
  });
});

describe("priceLine", () => {
  test("a workspace pays per user, a person doesn't", () => {
    expect(priceLine(perSeat(1500), "workspace", "en-US")).toBe("$15 per user a month");
    expect(priceLine(perSeat(2900), "person", "en-US")).toBe("$29 a month");
  });

  test("a longer recurrence reads as 'every 3 months'", () => {
    const quarterly: Price = { scheme: "per_seat", unit: usd(2900), recurrence: { interval: "month", count: 3 } };
    expect(priceLine(quarterly, "workspace", "en-US")).toBe("$29 per user every 3 months");
    expect(priceLine(quarterly, "person", "en-US")).toBe("$29 every 3 months");
  });

  test("an unknown scheme shows billing's own label", () => {
    const tiered: Price = { scheme: "tiered", fallbackLabel: "From $10 per user a month" };
    expect(priceLine(tiered, "workspace", "en-US")).toBe("From $10 per user a month");
    expect(priceLine(tiered, "person", "en-US")).toBe("From $10 per user a month");
  });
});

describe("costFact", () => {
  test("is billing's total with its recurrence, and 'Before tax' under it: no quantity × unit", () => {
    expect(costFact(license(), "en-US")).toEqual({ value: "$145 a month", foot: "Before tax" });
  });

  test("formats in the portal's locale and the currency's own digits", () => {
    const euro: Price = { scheme: "per_seat", unit: { amountMinor: 2900, currency: "EUR" }, recurrence: { interval: "month", count: 1 } };
    const german = costFact(license({ price: euro, total: { amountMinor: 14500, currency: "EUR" } }), "de-DE");
    expect(german.value).toBe("145 € a month");
    expect(german.foot).toBe("Before tax");

    const yen: Price = { scheme: "per_seat", unit: { amountMinor: 2900, currency: "JPY" }, recurrence: { interval: "month", count: 1 } };
    expect(costFact(license({ price: yen, total: { amountMinor: 14500, currency: "JPY" } }), "en-US")).toEqual({ value: "¥14,500 a month", foot: "Before tax" });
  });

  test("a three-month recurrence is 'every 3 months'", () => {
    const quarterly: Price = { scheme: "per_seat", unit: usd(2900), recurrence: { interval: "month", count: 3 } };
    expect(costFact(license({ price: quarterly, total: usd(14500) }), "en-US").value).toBe("$145 every 3 months");
  });

  test("only 'excluded' has a sub-line: 'included', 'none' and an unknown value say nothing", () => {
    expect(costFact(license({ tax: "excluded" }), "en-US").foot).toBe("Before tax");
    expect(costFact(license({ tax: "included" }), "en-US").foot).toBeNull();
    expect(costFact(license({ tax: "none" }), "en-US").foot).toBeNull();
    expect(costFact(license({ tax: "something_new" }), "en-US").foot).toBeNull();
  });

  test("a person's cost is the same: '$29 a month' over 'Before tax'", () => {
    const personal = license({ quantity: 1, total: usd(2900) });
    expect(costFact(personal, "en-US", "person")).toEqual({ value: "$29 a month", foot: "Before tax" });
    expect(costFact({ ...personal, tax: "none" }, "en-US", "person")).toEqual({ value: "$29 a month", foot: null });
  });

  test("an unknown scheme is billing's label with no foot, whatever its total", () => {
    const tiered: Price = { scheme: "tiered", fallbackLabel: "From $10 per user a month" };
    expect(costFact(license({ price: tiered, total: null }), "en-US")).toEqual({ value: "From $10 per user a month", foot: null });
    expect(costFact(license({ price: tiered, total: usd(100) }), "en-US")).toEqual({ value: "From $10 per user a month", foot: null });
  });

  test("a per-user price with no total from billing shows the unit price, and adds nothing up", () => {
    expect(costFact(license({ total: null }), "en-US")).toEqual({ value: "$29 per user a month", foot: "Before tax" });
  });
});

describe("totalSummary", () => {
  const total = (overrides: Partial<BillingTotal> = {}): BillingTotal => ({
    amount: usd(29500),
    recurrence: { interval: "month", count: 1 },
    tax: "excluded",
    licenseCount: 2,
    ...overrides,
  });

  test("reads '2 products · $295 a month in total'", () => {
    expect(totalSummary(total(), "en-US")).toEqual({ lead: "2 products", rest: "$295 a month in total" });
  });

  test("one product is singular, and a longer recurrence is spelled out", () => {
    expect(totalSummary(total({ licenseCount: 1 }), "en-US").lead).toBe("1 product");
    expect(totalSummary(total({ recurrence: { interval: "year", count: 1 } }), "en-US").rest).toBe("$295 a year in total");
  });
});

describe("holderNames and nameList", () => {
  test("lists up to three, then the first two and a count", () => {
    expect(holderNames([])).toBe("No one has a license yet");
    expect(holderNames(["Dana Reyes"])).toBe("Dana Reyes");
    expect(holderNames(["Dana Reyes", "Priya Natarajan"])).toBe("Dana Reyes and Priya Natarajan");
    expect(holderNames(["A", "B", "C"])).toBe("A, B and C");
    expect(holderNames(["Dana Reyes", "Priya Natarajan", "C", "D", "E", "F", "G", "H", "I", "J"])).toBe(
      "Dana Reyes, Priya Natarajan and 8 others",
    );
    expect(holderNames(["A", "B", "C", "D"])).toBe("A, B and 2 others");
  });

  test("nameList is the same without the empty case, for the people an action is for", () => {
    expect(nameList(["Luis Ortega", "Amara Okafor"])).toBe("Luis Ortega and Amara Okafor");
    expect(nameList(["Luis Ortega", "Amara Okafor", "C", "D", "E"])).toBe("Luis Ortega, Amara Okafor and 3 others");
    expect(nameList([])).toBe("");
  });
});

describe("fitNote", () => {
  test("says how many fit and what to do about the rest", () => {
    expect(fitNote({ fit: 3, needed: 4, canAddSeats: true })).toBe("3 of 4 fit: remove one or add licenses.");
    expect(fitNote({ fit: 2, needed: 5, canAddSeats: true })).toBe("2 of 5 fit: remove 3 or add licenses.");
  });

  test("drops the 'add seats' half where billing lists no add_seats", () => {
    expect(fitNote({ fit: 3, needed: 4, canAddSeats: false })).toBe("3 of 4 fit: remove one.");
    expect(fitNote({ fit: 2, needed: 5, canAddSeats: false })).toBe("2 of 5 fit: remove 3.");
  });
});

describe("groupCardNumber", () => {
  test("groups digits in fours", () => {
    expect(groupCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(groupCardNumber("378282246310005")).toBe("3782 8224 6310 005");
  });
});
