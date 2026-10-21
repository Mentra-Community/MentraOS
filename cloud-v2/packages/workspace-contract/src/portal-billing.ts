/**
 * What the billing module sends the portal's Licenses and Billing pages, as typed values: the catalog of
 * products, and a workspace's or person's billing status. Billing builds its answers with these schemas
 * and the portal parses them with the same ones; the types are inferred from them. Core formats the values
 * in the portal's locale and the viewer's time zone and words them with its own strings. Billing localizes
 * only its own content (names, descriptions, feature and miniapp names, and every `fallback*` label).
 *
 * The routes, under `/api/portal/billing/workspaces/<workspaceId>/` and `/api/portal/billing/account/`:
 * `GET catalog?locale=` ({@link BillingCatalog}), `GET status?locale=&purchase=` ({@link BillingStatus}),
 * `POST purchase` ({@link PurchaseRequest} to {@link PurchaseAnswer}), `POST session` ({@link SessionRequest}
 * to {@link SessionAnswer}) and `GET ui/icons/<file>`. A refusal is `{error}` with one of
 * {@link BILLING_ERROR_CODES}.
 *
 * Values the portal doesn't know don't break a page. A status, an action kind and a tax value are plain
 * strings, with `KNOWN_*` lists to narrow them by; a price of a scheme the portal doesn't know carries a
 * `fallbackLabel`; an owner type it doesn't know is dropped from an entry's `ownerTypes`; an unknown field is
 * stripped. A value that is malformed is another matter: a response that doesn't match is the portal's
 * "unavailable" state, so the schemas are strict about what the portal acts on (amounts, dates, addresses it
 * follows) and `icon` is the one value that degrades instead (to null).
 *
 * Import it from `@mentra/workspace-contract/portal-billing`, not the package root.
 */

import {z} from "zod"

import {LICENSE_OWNER_TYPES} from "./licenses"
import {BILLING_ICON_FILE, BILLING_ICON_PATH_PREFIX, billingIconPath} from "./portal-billing-icons"

/** Where billing serves its own files from, behind Core's portal proxy. */
export const BILLING_UI_PATH_PREFIX = "/api/portal/billing/ui/"

/**
 * The icon rule lives in `portal-billing-icons`, which has no zod, so a screen that only draws an icon can import it
 * without the schemas. It is re-exported here, so every import from this module keeps working.
 */
export {BILLING_ICON_FILE, BILLING_ICON_PATH_PREFIX, billingIconPath}

/**
 * The canonical address of `value` (`new URL(value).href`) when the portal may send the browser to it, or null:
 * `https:`, or `http:` to `localhost` or `127.0.0.1` for local development, with no credentials in it. The
 * browser's own URL parser reads it, and its result is what is returned, so what is checked is exactly what is
 * followed: padding, tabs and newlines the parser ignores are gone from it.
 */
function hostedUrlHref(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username !== "" || url.password !== "") return null
  if (url.protocol === "https:") return url.href
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") ? url.href : null
}

/**
 * A purchase's or a session's `url`: the hosted page the portal sends the browser to, as its canonical address.
 * See {@link hostedUrlHref}.
 */
export const HostedUrlSchema = z.string().transform((value, ctx) => {
  const href = hostedUrlHref(value)
  if (href === null) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: "not an https: address (or http: to localhost)"})
    return z.NEVER
  }
  return href
})

/** ISO 8601 with an offset (`Z` or `+01:00`): a time that means one instant wherever it is read. */
const DateTimeSchema = z.string().datetime({offset: true})

/** A whole number of at least one: seats, and the count of a recurrence. */
const PositiveIntSchema = z.number().int().positive().safe()

/** A whole number of at least zero: a quantity, and how many licenses are in a total. */
const CountSchema = z.number().int().nonnegative().safe()

/** An amount in the currency's minor unit (cents for USD), never fractional or negative, in ISO 4217 upper case. */
export const MoneySchema = z.object({
  amountMinor: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/, "three uppercase letters"),
})
export type Money = z.infer<typeof MoneySchema>

/** How often a price is charged: every `count` of the `interval`. */
export const RecurrenceSchema = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  count: PositiveIntSchema,
})
export type Recurrence = z.infer<typeof RecurrenceSchema>

/** A price per seat, per recurrence. */
export const PerSeatPriceSchema = z.object({
  scheme: z.literal("per_seat"),
  unit: MoneySchema,
  recurrence: RecurrenceSchema,
})
export type PerSeatPrice = z.infer<typeof PerSeatPriceSchema>

/**
 * A scheme the portal doesn't know, or a `per_seat` price that is malformed but carries its label. It is
 * shown by `fallbackLabel`, in place of the price or the cost line.
 */
export const FallbackPriceSchema = z.object({
  scheme: z.string(),
  fallbackLabel: z.string(),
})
export type FallbackPrice = z.infer<typeof FallbackPriceSchema>

/**
 * A list price. `per_seat` is the one scheme the portal can compute with; any other scheme, which billing may
 * add without a portal release, comes with the words to show. A `per_seat` price that is malformed and has no
 * `fallbackLabel` fails.
 */
export const PriceSchema = z.union([PerSeatPriceSchema, FallbackPriceSchema])
export type Price = z.infer<typeof PriceSchema>

/** Whether `price` is a `per_seat` one, with a unit amount and a recurrence the portal can compute with. */
export function isPerSeat(price: Price): price is PerSeatPrice {
  return price.scheme === "per_seat" && "unit" in price && "recurrence" in price
}

/** How tax relates to an amount. A value the portal doesn't know adds no words. */
export const KNOWN_TAX = ["excluded", "included", "none"] as const
export type KnownTax = (typeof KNOWN_TAX)[number]
/** One of {@link KNOWN_TAX}, or a value the portal doesn't know. */
export const TaxSchema = z.string()
export type Tax = z.infer<typeof TaxSchema>

/** The states of a license the portal words. An unknown status gets a grey badge with `fallbackStatusLabel`. */
export const KNOWN_LICENSE_STATUSES = ["active", "ending", "past_due", "processing", "incomplete"] as const
export type KnownLicenseStatus = (typeof KNOWN_LICENSE_STATUSES)[number]

/** The billing actions the portal words. An unknown kind is a "…" menu item with its `fallbackLabel`. */
export const KNOWN_ACTION_KINDS = [
  "add_seats",
  "change_seats",
  "cancel",
  "renew",
  "update_payment",
  "complete_payment",
  "billing_and_invoices",
] as const
export type KnownActionKind = (typeof KNOWN_ACTION_KINDS)[number]

/**
 * Something billing can do for a license or the account, as a hosted page (`POST session`). Billing lists
 * only actions it can serve. `returns: false` means its hosted page doesn't come back to the portal (an
 * invoice's payment page), so the portal opens a tab for it in the click itself; absent means it returns.
 */
export const BillingActionSchema = z.object({
  kind: z.string(),
  fallbackLabel: z.string(),
  returns: z.boolean().optional(),
})
export type BillingAction = z.infer<typeof BillingActionSchema>

/** A product's feature: its key, its name, and the miniapp it is for when there is one. */
export const CatalogFeatureSchema = z.object({
  key: z.string(),
  name: z.string(),
  appName: z.string().optional(),
})
export type CatalogFeature = z.infer<typeof CatalogFeatureSchema>

/** What buying a product allows: the seats within `minSeats` and `maxSeats` (unbounded when absent). */
export const BuySchema = z.object({
  minSeats: PositiveIntSchema,
  maxSeats: PositiveIntSchema.optional(),
  defaultSeats: PositiveIntSchema,
})
export type Buy = z.infer<typeof BuySchema>

/**
 * What a viewer who may manage the owner's billing sees beside a product: its price and tax treatment, and
 * what buying allows. `buy` is null where billing won't sell the product to this owner now (they hold it, or
 * a purchase of it is in progress).
 */
export const OfferSchema = z.object({
  price: PriceSchema,
  tax: TaxSchema,
  buy: BuySchema.nullable(),
})
export type Offer = z.infer<typeof OfferSchema>

/** The owner types the portal has pages for. An entry's other owner types are dropped, so a new one never fails a catalog. */
export const KNOWN_OWNER_TYPES = LICENSE_OWNER_TYPES
export type KnownOwnerType = (typeof KNOWN_OWNER_TYPES)[number]

/**
 * The owner types of an entry that the portal knows: any strings parse, and those not in {@link KNOWN_OWNER_TYPES}
 * are dropped.
 */
const OwnerTypesSchema = z.array(z.string()).transform((types) => types.filter(isKnownOwnerType))

function isKnownOwnerType(value: string): value is KnownOwnerType {
  return (KNOWN_OWNER_TYPES as readonly string[]).includes(value)
}

/**
 * One product. `offer` is there only for a viewer who may manage the owner's billing; for anyone else the
 * entry is display content only, the same for every owner of the type, and reveals no price.
 *
 * `icon` is a path under {@link BILLING_ICON_PATH_PREFIX} or null: any other address parses to null.
 */
export const CatalogEntrySchema = z.object({
  /** The license's product key, such as `mentra.call.unlimited`. */
  product: z.string(),
  name: z.string(),
  /** For chips and counts; the name when absent. */
  shortName: z.string().optional(),
  description: z.string(),
  icon: z
    .string()
    .nullable()
    .transform((value) => billingIconPath(value)),
  features: z.array(CatalogFeatureSchema),
  /** The owners it is for; only the types in {@link KNOWN_OWNER_TYPES} are kept. */
  ownerTypes: OwnerTypesSchema,
  offer: OfferSchema.optional(),
})
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

/** `GET catalog`: the products for the scope's owner type, in the locale billing chose (`locale`). */
export const BillingCatalogSchema = z.object({
  locale: z.string().min(1),
  products: z.array(CatalogEntrySchema),
})
export type BillingCatalog = z.infer<typeof BillingCatalogSchema>

/**
 * One license as billing reads it. `renewsAt` is the next renewal (for `past_due`, the one not paid), `endsAt`
 * an end scheduled for an `ending` license or for an `active` or `past_due` one, and `seatsStopAt` when a
 * `past_due` license's seats stop. `total` is quantity × unit, before tax, discounts and prorations: null for
 * a scheme with no total per period.
 */
export const LicenseBillingSchema = z.object({
  licenseId: z.string(),
  product: z.string(),
  /** One of {@link KNOWN_LICENSE_STATUSES}, or a status the portal doesn't know. */
  status: z.string(),
  fallbackStatusLabel: z.string(),
  renewsAt: DateTimeSchema.optional(),
  endsAt: DateTimeSchema.optional(),
  seatsStopAt: DateTimeSchema.optional(),
  price: PriceSchema,
  quantity: CountSchema,
  total: MoneySchema.nullable(),
  tax: TaxSchema,
  actions: z.array(BillingActionSchema),
})
export type LicenseBilling = z.infer<typeof LicenseBillingSchema>

/** The page's total of the licenses billing will charge again; `licenseCount` says how many are in it. */
export const BillingTotalSchema = z.object({
  amount: MoneySchema,
  recurrence: RecurrenceSchema,
  tax: TaxSchema,
  licenseCount: CountSchema,
})
export type BillingTotal = z.infer<typeof BillingTotalSchema>

/** Test mode: the card to pay with, and the environment the purchase works in. */
export const TestModeSchema = z.object({
  cardNumber: z.string(),
  environment: z.string(),
})
export type TestMode = z.infer<typeof TestModeSchema>

/**
 * A purchase that a checkout returned to the portal with (`?purchase=<purchaseId>`). `status` is `processing`
 * until Core has accepted the license, then `ready` with its `licenseId`. `paid` is whether the checkout
 * collected a payment: false for a trial.
 */
export const PurchaseStatusSchema = z.object({
  purchaseId: z.string(),
  /** `processing` or `ready`, or a status the portal doesn't know. */
  status: z.string(),
  product: z.string(),
  quantity: CountSchema,
  paid: z.boolean(),
  licenseId: z.string().nullable(),
})
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>

/** `GET status`: an owner's licenses as billing reads them, with the owner's total, actions and purchase. */
export const BillingStatusSchema = z.object({
  locale: z.string().min(1),
  licenses: z.array(LicenseBillingSchema),
  /** Null unless the licenses in it share one currency, one recurrence and one tax treatment. */
  total: BillingTotalSchema.nullable(),
  /** The account's: `billing_and_invoices`. */
  actions: z.array(BillingActionSchema),
  testMode: TestModeSchema.nullable(),
  purchase: PurchaseStatusSchema.nullable(),
})
export type BillingStatus = z.infer<typeof BillingStatusSchema>

/** `POST purchase`: one checkout for one product. Billing refuses seats outside `buy`'s limits (`invalid_seats`). */
export const PurchaseRequestSchema = z.object({
  product: z.string(),
  seats: z.number().int().safe(),
  locale: z.string().min(1),
})
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>

/**
 * `POST session`: the hosted page for an action. `licenseId` names the license it is for (none for the
 * account's actions); `seats` is how many to add, for `add_seats`. An `action` that isn't offered gets
 * 400 `unknown_action` from billing, so it stays a plain string here.
 */
export const SessionRequestSchema = z.object({
  action: z.string(),
  licenseId: z.string().optional(),
  seats: z.number().int().safe().optional(),
  locale: z.string().min(1),
})
export type SessionRequest = z.infer<typeof SessionRequestSchema>

/** The answer to `POST purchase`: the hosted checkout to send the browser to. */
export const PurchaseAnswerSchema = z.object({url: HostedUrlSchema})
export type PurchaseAnswer = z.infer<typeof PurchaseAnswerSchema>

/** The answer to `POST session`: the hosted page to send the browser to. */
export const SessionAnswerSchema = z.object({url: HostedUrlSchema})
export type SessionAnswer = z.infer<typeof SessionAnswerSchema>

/**
 * The `error` of a refusal from billing (`{error}`): 400 `invalid_request`, `not_for_sale`, `invalid_seats` or
 * `unknown_action`; 403 `forbidden` or `billing_staff_only`; 404 `license_not_found` or `no_billing_account`;
 * 409 `already_licensed`, `checkout_in_progress` or `owner_ended`; 503 `billing_unavailable` or
 * `core_unavailable`. Core words the ones it knows, and any other gets its generic "try again".
 */
export const BILLING_ERROR_CODES = [
  "invalid_request",
  "not_for_sale",
  "invalid_seats",
  "unknown_action",
  "forbidden",
  "billing_staff_only",
  "license_not_found",
  "no_billing_account",
  "already_licensed",
  "checkout_in_progress",
  "owner_ended",
  "billing_unavailable",
  "core_unavailable",
] as const
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number]
