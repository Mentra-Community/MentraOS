/**
 * Billing's typed values for the package's tests: a catalog entry and a license as billing reads it, with the
 * numbers of the approved design (Mentra Call Unlimited, five seats at $29). Synthetic data only; not exported
 * from the package. `overrides` change what a test is about.
 */

import type { CatalogEntry, LicenseBilling, Money, Price } from "@mentra/workspace-contract/portal-billing";

export const usd = (amountMinor: number): Money => ({ amountMinor, currency: "USD" });

export const perSeat = (amountMinor = 2900): Price => ({
  scheme: "per_seat",
  unit: usd(amountMinor),
  recurrence: { interval: "month", count: 1 },
});

/** Mentra Call Unlimited as the catalog sends it: with its icon. */
export function catalogEntryFor(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    product: "mentra.call.unlimited",
    name: "Mentra Call Unlimited",
    shortName: "Call Unlimited",
    description: "Unlimited Teams calls in Mentra Call.",
    icon: "/api/portal/billing/ui/icons/mentra-call.png",
    features: [{ key: "call.unlimited", name: "Unlimited Teams calls", appName: "Mentra Call" }],
    ...overrides,
  };
}

/** Fleet: a product with several features and no icon (a letter tile). */
export function fleetEntryFor(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return catalogEntryFor({
    product: "mentra.fleet",
    name: "Fleet",
    shortName: undefined,
    description: "Manage your members' phones and glasses, and the miniapps on them.",
    icon: null,
    features: [
      { key: "fleet.managed", name: "Managed phones and glasses" },
      { key: "fleet.assignments", name: "Miniapp assignments" },
      { key: "fleet.usage", name: "Usage reports" },
    ],
    ...overrides,
  });
}

/** An active Call Unlimited license as billing reads it: five seats, $145 a month before tax, billing's own actions. */
export function licenseBillingFor(overrides: Partial<LicenseBilling> = {}): LicenseBilling {
  return {
    licenseId: "lic_call",
    product: "mentra.call.unlimited",
    status: "active",
    fallbackStatusLabel: "Active",
    renewsAt: "2026-11-20T12:00:00.000Z",
    price: perSeat(),
    quantity: 5,
    total: usd(14500),
    tax: "excluded",
    actions: [
      { kind: "add_seats", fallbackLabel: "Add licenses" },
      { kind: "change_seats", fallbackLabel: "Change license count" },
      { kind: "cancel", fallbackLabel: "Cancel" },
    ],
    ...overrides,
  };
}
