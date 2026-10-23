/**
 * The Licenses page's cards: Core's licenses (who holds the seats), billing's status (what each costs and what
 * can be done about it) and billing's catalog (what each is called and looks like), joined into one list in the
 * order the page draws it. Also what the seat dialogs ask of a license: how many seats are free, who holds one,
 * and whether the people chosen fit.
 *
 * Pure values in, pure values out: it holds no words (those are `strings/licenses.ts`) and no formatting (that
 * is `billing-format.ts`), and it imports only types, so a screen that lists licenses (the Members list's
 * chips) carries none of the contract's schemas.
 */

import type { LicenseView } from "@mentra/workspace-contract";
import type {
  BillingAction,
  CatalogEntry,
  CatalogFeature,
  LicenseBilling,
  PurchaseStatus,
} from "@mentra/workspace-contract/portal-billing";
import { DEFAULT_LOCALE, usableLocale } from "./format";

/** A license's seats as Core counts them. `free` and `over` are never negative: at most one of them is above zero. */
export interface SeatCounts {
  quantity: number;
  /** How many seats are assigned. It may exceed `quantity`: lowering the quantity frees no seat. */
  used: number;
  free: number;
  /** How many seats are assigned beyond the quantity. */
  over: number;
}

/** A license's seat counts, from Core's `quantity` and `seatsUsed`. */
export function seatCounts(license: Pick<LicenseView, "quantity" | "seatsUsed">): SeatCounts {
  const { quantity, seatsUsed: used } = license;
  return { quantity, used, free: Math.max(0, quantity - used), over: Math.max(0, used - quantity) };
}

/** Whether `membershipId` holds one of the license's seats. Where Core lists no seats, nobody is known to. */
export function holdsSeat(license: Pick<LicenseView, "seats">, membershipId: string): boolean {
  return license.seats?.some((seat) => seat.membershipId === membershipId) ?? false;
}

/**
 * The action billing lists under `kind` for a license (or, given the status itself, for the account), or null
 * when it lists none. Core shows a billing button only where billing lists the action, and words a sentence by
 * whether it does ("Unassign someone to free their seat." where there is no `add_seats`).
 */
export function listedAction(source: { actions: readonly BillingAction[] } | null | undefined, kind: string): BillingAction | null {
  return source?.actions.find((action) => action.kind === kind) ?? null;
}

/** What needs the viewer first: a failed payment, a first payment that isn't finished, or more seats given out than bought. */
export type LicenseProblem = "past_due" | "incomplete" | "over";

/**
 * One card. The product's name, icon and features sit on the card itself, so a card can be handed straight to
 * `ProductIcon`, `ProductChip` and `FeatureChips`, as a catalog entry can.
 */
export interface JoinedLicense {
  /** Core's and billing's id for the license: the same for both. */
  licenseId: string;
  /** The product's key. */
  product: string;
  /** The catalog's name, or the product's key when the catalog lacks it. */
  name: string;
  /** The catalog's short name, or `name`. */
  shortName: string;
  /** The catalog's description; empty when the catalog lacks the product. */
  description: string;
  /** The catalog's icon path, or null (a letter tile). */
  icon: string | null;
  features: readonly CatalogFeature[];
  /** The catalog's entry, null when the catalog has none for this product. */
  catalog: CatalogEntry | null;
  /** Core's license. Null for a billing entry Core hasn't received yet (being set up, or its payment isn't finished). */
  license: LicenseView | null;
  /** Billing's entry. Null where the viewer isn't offered billing, or billing lists none for it. */
  billing: LicenseBilling | null;
  /** Core's seat counts; null exactly when `license` is. */
  seats: SeatCounts | null;
  /** The first problem that applies, in the order the page sorts them. `seats.over` says whether it is over as well. */
  problem: LicenseProblem | null;
  /** The license the viewer just bought, or one billing is still setting up. */
  justBought: boolean;
}

/** Everything the join reads. */
export interface JoinInput {
  /** Core's licenses for the owner, as listed. A license that has ended is no card. */
  licenses: readonly LicenseView[];
  /** Billing's licenses (`status.licenses`); null or absent where the viewer isn't offered billing. */
  billing?: readonly LicenseBilling[] | null;
  /** Billing's catalog (`catalog.products`), all of it: it names what is held, not what is offered. */
  catalog: readonly CatalogEntry[];
  /** The purchase the page was opened with (`status.purchase`): its license is the one just bought. */
  purchase?: Pick<PurchaseStatus, "licenseId"> | null;
  /** For sorting names; the portal's locale. */
  locale?: string;
}

/** Where a card sorts: the problems in their order, then what was just bought, then the rest. */
function rank(card: JoinedLicense): number {
  switch (card.problem) {
    case "past_due":
      return 0;
    case "incomplete":
      return 1;
    case "over":
      return 2;
    default:
      return card.justBought ? 3 : 4;
  }
}

/**
 * The cards of the Licenses page, in order: payment failed, payment incomplete, over-assigned, then the license
 * just bought (or being set up), then by name; the license's id settles a tie.
 *
 * - A card is a Core license that hasn't ended, joined to billing's entry by `licenseId` and to the catalog by
 *   `product`. The whole catalog names what is held: billing sends every product the owner holds, even one it no
 *   longer sells, so that its card has a name. (What is *offered* is a different matter: an entry's `offer`.) When a product is listed twice the first entry wins. A product the catalog lacks
 *   keeps its key as its name.
 * - A billing entry with no Core license yet (`processing`, `incomplete`) is a card of its own, with no seats.
 *   An entry for a Core license that has ended is not.
 */
export function joinLicenses({ licenses, billing, catalog, purchase, locale = DEFAULT_LOCALE }: JoinInput): JoinedLicense[] {
  const entries = new Map<string, CatalogEntry>();
  for (const entry of catalog) if (!entries.has(entry.product)) entries.set(entry.product, entry);

  const billed = new Map<string, LicenseBilling>();
  for (const license of billing ?? []) if (!billed.has(license.licenseId)) billed.set(license.licenseId, license);

  const boughtId = purchase?.licenseId ?? null;
  const card = (licenseId: string, product: string, license: LicenseView | null, billingEntry: LicenseBilling | null): JoinedLicense => {
    const entry = entries.get(product) ?? null;
    const seats = license ? seatCounts(license) : null;
    const problem: LicenseProblem | null =
      billingEntry?.status === "past_due"
        ? "past_due"
        : billingEntry?.status === "incomplete"
          ? "incomplete"
          : seats !== null && seats.over > 0
            ? "over"
            : null;
    return {
      licenseId,
      product,
      name: entry?.name ?? product,
      shortName: entry?.shortName ?? entry?.name ?? product,
      description: entry?.description ?? "",
      icon: entry?.icon ?? null,
      features: entry?.features ?? [],
      catalog: entry,
      license,
      billing: billingEntry,
      seats,
      problem,
      justBought: (boughtId !== null && licenseId === boughtId) || billingEntry?.status === "processing",
    };
  };

  const cards: JoinedLicense[] = [];
  const knownToCore = new Set<string>();
  for (const license of licenses) {
    knownToCore.add(license.licenseId);
    if (license.endedAt) continue;
    cards.push(card(license.licenseId, license.product, license, billed.get(license.licenseId) ?? null));
  }
  for (const entry of billed.values()) {
    if (!knownToCore.has(entry.licenseId)) cards.push(card(entry.licenseId, entry.product, null, entry));
  }

  const collator = new Intl.Collator(usableLocale(locale), { sensitivity: "base", numeric: true });
  return cards.sort(
    (a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.licenseId < b.licenseId ? -1 : a.licenseId > b.licenseId ? 1 : 0),
  );
}

/**
 * What a seat dialog says about the people chosen for one license:
 * - `enough`: everyone chosen needs a seat and there are enough ("2 of 5 seats free: enough for both.");
 * - `some_hold`: some already hold one, and the seats left cover the rest ("Amara Okafor has one. 1 of 3 seats free, for Luis Ortega.");
 * - `all_hold`: everyone chosen already holds one ("Everyone you chose has one.");
 * - `short`: fewer seats are free than people need one ("2 of 3 fit: remove one or add licenses.");
 * - `full`: nobody can get a seat because none is free ("All 10 seats are in use."), `over` saying by how many it is over-assigned;
 * - `nobody`: no one is chosen.
 */
export type FitKind = "enough" | "some_hold" | "all_hold" | "short" | "full" | "nobody";

/** The people chosen for one license, sorted into who needs a seat and who has one, and whether they fit. */
export interface LicenseFit<P> {
  kind: FitKind;
  /** The people chosen who already hold one of the license's seats. */
  holders: P[];
  /** The people chosen who would take a new seat. Each person once. */
  recipients: P[];
  quantity: number;
  /** Seats left. */
  free: number;
  /** Seats assigned beyond the quantity. */
  over: number;
  /** How many of the `recipients` the free seats cover. */
  fit: number;
  /** How many seats the `recipients` need: `recipients.length`. */
  needed: number;
  /** Whether the recipients can be assigned now: there is at least one and every one fits (`enough` or `some_hold`). */
  ok: boolean;
}

/**
 * How `people` fit in `license`'s free seats. `people` are those who can be given a seat (members who have
 * signed in); who already holds one is read from the license's `seats`, which Core lists for those who assign
 * them. The sentence for the result is `licenseStrings.fit.line`.
 */
export function fitFor<P extends { membershipId: string }>(
  license: Pick<LicenseView, "quantity" | "seatsUsed" | "seats">,
  people: readonly P[],
): LicenseFit<P> {
  const { quantity, free, over } = seatCounts(license);
  const holders: P[] = [];
  const recipients: P[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.membershipId)) continue;
    seen.add(person.membershipId);
    (holdsSeat(license, person.membershipId) ? holders : recipients).push(person);
  }
  const needed = recipients.length;
  const kind: FitKind =
    seen.size === 0
      ? "nobody"
      : needed === 0
        ? "all_hold"
        : free === 0
          ? "full"
          : needed > free
            ? "short"
            : holders.length > 0
              ? "some_hold"
              : "enough";
  return {
    kind,
    holders,
    recipients,
    quantity,
    free,
    over,
    fit: Math.min(needed, free),
    needed,
    ok: kind === "enough" || kind === "some_hold",
  };
}
