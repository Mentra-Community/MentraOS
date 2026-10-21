/**
 * Billing's typed values as text: money with the currency's own digits, recurrences, dates in the viewer's time
 * zone, and the lines a license card and the catalog are made of. Every function takes the portal's `locale` (the
 * tag it renders in, which it also sends billing) and puts the words in `strings/licenses.ts`, so this file
 * decides how a value is formatted and that file decides what is said.
 *
 * Core adds no amounts. A total on a page is billing's, and the one product shown (seats × unit, in the Buy
 * dialog) is the caller's.
 */

import {
  isPerSeat,
  type BillingTotal,
  type LicenseBilling,
  type Money,
  type Price,
  type Recurrence,
  type Tax,
} from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t, type LicenseScope } from "../strings/licenses";
import { formatDate, usableLocale } from "./format";

/**
 * An amount, in `locale`, with the currency's own digits: `amountMinor` is in its minor unit, so 2900 is $29 and
 * ¥2,900, and 1500 dinars is 1.500. A whole amount drops its decimals ("$29", "29 €"); one with a remainder
 * keeps them all ("$14.50").
 */
export function formatMoney(money: Money, locale: string): string {
  const usable = usableLocale(locale);
  const digits = new Intl.NumberFormat(usable, { style: "currency", currency: money.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const factor = 10 ** digits;
  const whole = money.amountMinor % factor === 0;
  return new Intl.NumberFormat(usable, {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(money.amountMinor / factor);
}

/** "a month" for one interval, "every 3 months" for several: what follows an amount. */
export function formatRecurrence(recurrence: Recurrence, locale: string): string {
  return t.recurrence.rate(recurrence.interval, recurrence.count, new Intl.NumberFormat(usableLocale(locale)).format(recurrence.count));
}

/** What follows "Renews every": "month", "3 months". */
function recurrenceCadence(recurrence: Recurrence, locale: string): string {
  return t.recurrence.cadence(recurrence.interval, recurrence.count, new Intl.NumberFormat(usableLocale(locale)).format(recurrence.count));
}

/** The day an instant falls on in the viewer's time zone, in `locale`: "Nov 20, 2026"; what was sent when it isn't a date. */
export function formatDay(iso: string, locale: string): string {
  return formatDate(iso, locale);
}

/** The same without the year, for a badge: "Nov 20". */
export function formatDayShort(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(usableLocale(locale), { month: "short", day: "numeric" }).format(date);
}

/** "Renews every month": the words after "every" for a price's recurrence. */
export function renewalCadence(price: Price, locale: string): string | null {
  return isPerSeat(price) ? recurrenceCadence(price.recurrence, locale) : null;
}

/** "before tax" for `excluded`, "including tax" for `included`, and nothing for `none` or a value Core doesn't know. */
export function taxNote(tax: Tax): string | null {
  switch (tax) {
    case "excluded":
      return t.tax.excluded;
    case "included":
      return t.tax.included;
    default:
      return null;
  }
}

/**
 * A price as the catalog shows it: "$15 per user a month" for a workspace, "$29 a month" for a person. A price of
 * a scheme Core doesn't know is billing's own `fallbackLabel`.
 */
export function priceLine(price: Price, scope: LicenseScope, locale: string): string {
  if (!isPerSeat(price)) return price.fallbackLabel;
  const unit = formatMoney(price.unit, locale);
  const rate = formatRecurrence(price.recurrence, locale);
  return scope === "workspace" ? t.price.perSeat(unit, rate) : t.price.perPerson(unit, rate);
}

/** A card's Cost fact: the value, and the line under it (null when there is none). */
export interface CostFact {
  value: string;
  foot: string | null;
}

/**
 * A license's Cost fact. For a per-user price, billing's `total` with the recurrence ("$145 a month"), and under it
 * "Before tax" where billing says tax is excluded: that is the only sub-line, and with any other tax value there is
 * none (no quantity × unit either: the count is in the Licenses fact). An unknown scheme is billing's
 * `fallbackLabel` and nothing under it. A per-user price that arrives with no total shows its unit price instead,
 * and adds nothing up.
 */
export function costFact(
  license: Pick<LicenseBilling, "price" | "total" | "tax">,
  locale: string,
  scope: LicenseScope = "workspace",
): CostFact {
  const { price } = license;
  if (!isPerSeat(price)) return { value: price.fallbackLabel, foot: null };
  const foot = license.tax === "excluded" ? t.facts.cost.beforeTax : null;
  if (license.total === null) return { value: priceLine(price, scope, locale), foot };
  return {
    value: t.facts.cost.value(formatMoney(license.total, locale), formatRecurrence(price.recurrence, locale)),
    foot,
  };
}

/** The line above the cards: "2 products" (for bold) and "$295 a month in total", from billing's own total. */
export function totalSummary(total: BillingTotal, locale: string): { lead: string; rest: string } {
  return t.summary({
    count: total.licenseCount,
    amount: formatMoney(total.amount, locale),
    rate: formatRecurrence(total.recurrence, locale),
  });
}

/** Who holds the seats, for a strip: "Dana Reyes, Priya Natarajan and 8 others", or "No one has a license yet". */
export function holderNames(names: readonly string[]): string {
  return t.names.holders(names);
}

/** The people an action is for: "Luis Ortega and Amara Okafor", "Luis Ortega, Amara Okafor and 3 others". */
export function nameList(names: readonly string[]): string {
  return t.names.list(names);
}

/**
 * How many of the people chosen fit in the free seats: "3 of 4 fit: remove one or add licenses.", or, where billing
 * lists no `add_seats`, "3 of 4 fit: remove one."
 */
export function fitNote(args: { fit: number; needed: number; canAddSeats: boolean }): string {
  return t.fit.note(args);
}

/** A card number in groups of four, for the test card: "4242 4242 4242 4242". */
export function groupCardNumber(digits: string): string {
  return digits
    .replace(/\s+/g, "")
    .replace(/(.{4})(?=.)/g, "$1 ");
}
