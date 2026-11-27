/**
 * License grants: licenses given to a workspace without a sale through the workspace portal, for one made some other
 * way (by a reseller, for a pilot, prepaid by invoice), whose money is collected outside billing. Whoever holds the
 * organization capability `organization.licenses.grant` (an Organization Admin, or an operator key that carries it)
 * asks Core:
 *
 *     POST /api/organization/workspaces/<workspaceId>/license-grants
 *     Idempotency-Key: <a key of the caller's own>
 *     {"product": "mentra.call.unlimited", "seats": 2, "endsAt": "2027-11-17T00:00:00Z", "note": "..."}
 *
 * Core checks the request's shape with {@link checkLicenseGrantRequest}, refuses an end no grant could have
 * ({@link licenseGrantEndProblem}, `too_late`) and checks that the workspace is active, then forwards it to billing's
 * `POST /v1/portal/workspaces/<workspaceId>/license-grants` as a {@link LicenseGrantRequest}, signed with the caller as
 * its principal (a person, or a key) and the workspace as its scope. Billing answers a repeat of the key with the grant
 * it made; a new grant must end at least an hour and at most 730 days away ({@link licenseGrantEndProblem}), and billing
 * makes it a subscription of the product, at its catalog price, in a free trial that ends at `endsAt` and is cancelled
 * then, so nothing is ever charged; its license sync writes the license into Core as it does for any subscription. It
 * answers a {@link LicenseGrant}, which Core checks with {@link parseLicenseGrant} and relays. See Core's
 * `docs/licenses.md`.
 *
 * The same caller ends a grant before its date:
 *
 *     POST /api/organization/workspaces/<workspaceId>/license-grants/<product>/end
 *     {"note": "..."}
 *
 * The body is optional. Core checks the product key ({@link isLicenseGrantProduct}), the note
 * ({@link checkLicenseGrantNote}, which Core keeps in its admin action log) and that the workspace is active, and asks
 * billing's `POST /v1/portal/workspaces/<workspaceId>/license-grants/<product>/end`, signed the same way, with no body.
 * Billing cancels the grant's subscription at once and answers a {@link LicenseGrantEnded}, which Core checks with
 * {@link parseLicenseGrantEnded} and relays. The license ends with it, and everyone assigned it loses it. Billing ends
 * only a grant that is still as it was made: not a purchase, and not a grant the workspace has renewed.
 *
 * The checks live here so Core and billing make the same ones; billing makes them again, on its own clock. Nothing
 * here imports a Node built-in, so the package root may export it.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** What a grant may ask for. */
export const LICENSE_GRANT_LIMITS = {
  /** The fewest licenses one grant gives. */
  minSeats: 1,
  /** The most licenses one grant gives: as many as one purchase buys. */
  maxSeats: 1000,
  /** The latest `endsAt`, in days from now: a free trial lasts at most two years, so 730 days. */
  maxDays: 730,
  /** The earliest `endsAt`, in milliseconds from now: an hour, so the end is still ahead when billing makes it. */
  minLeadMs: 60 * 60 * 1000,
  /** The longest note, in characters: it is kept where a value holds at most 500. */
  maxNoteLength: 500,
  /** The longest idempotency key, in characters. */
  maxIdempotencyKeyLength: 200,
} as const

/** The header that carries the caller's idempotency key on Core's route. */
export const LICENSE_GRANT_IDEMPOTENCY_HEADER = "Idempotency-Key"

/** A product key, as billing's catalog names products: `mentra.call.unlimited`. */
const PRODUCT_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/
/** An idempotency key: 1 to 200 visible ASCII characters, no spaces. */
const IDEMPOTENCY_KEY = new RegExp(`^[\\x21-\\x7e]{1,${LICENSE_GRANT_LIMITS.maxIdempotencyKeyLength}}$`)
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/

/** A grant as Core forwards it to billing: the caller's request, as Core checked it. */
export interface LicenseGrantRequest {
  /** The product's key, such as `mentra.call.unlimited`. */
  product: string
  /** How many licenses: {@link LICENSE_GRANT_LIMITS} `minSeats` to `maxSeats`. */
  seats: number
  /** When the licenses end: RFC 3339 in UTC, in whole seconds (`2027-11-17T00:00:00Z`). */
  endsAt: string
  /** Why the grant was made, for whoever reads it later; null when the caller gave none. */
  note: string | null
  /** The caller's idempotency key: a repeat with the same key asks for the same grant, and makes nothing new. */
  idempotencyKey: string
}

/** Billing's answer to a grant: what it made, or what an earlier request with the same idempotency key made. */
export interface LicenseGrant {
  workspaceId: string
  product: string
  seats: number
  /** RFC 3339 in UTC: when the licenses end. Core keeps them working for 3 days more, as for any license. */
  endsAt: string
  /** The state of the grant's subscription at the payment processor: `trialing` while the grant runs. */
  status: string
  /** The payment processor's ID of the grant's subscription, for staff who need to find it there. */
  subscriptionId: string
  /** The license in Core, once billing has made it; null until then, which is seconds. */
  licenseId: string | null
  /** True when an earlier request with the same idempotency key made the grant, and this one made nothing. */
  replayed: boolean
}

/**
 * Billing's answer to ending a grant before its date: the grant's subscription is cancelled, and its license ends with
 * it. Nothing was charged for the grant, so nothing is refunded.
 */
export interface LicenseGrantEnded {
  workspaceId: string
  product: string
  /** The payment processor's ID of the grant's subscription, now cancelled. */
  subscriptionId: string
  /** The license in Core that ends with it; null when billing never made one of the subscription. */
  licenseId: string | null
  /** RFC 3339 in UTC, in whole seconds: when the payment processor cancelled it. The license is paid through this, and no later. */
  endedAt: string
}

/** What {@link checkLicenseGrantRequest} says: the request as it is to be forwarded, or why it is refused. */
export type LicenseGrantCheck = {ok: true; request: LicenseGrantRequest} | {ok: false; description: string}

/**
 * Whether `value` is a product key, as a grant names its product and as the route that ends one carries it in its
 * path: a lowercase letter or digit, then up to 99 more of those, dots, underscores and hyphens
 * (`mentra.call.unlimited`). Whether billing has such a product is billing's to say.
 */
export function isLicenseGrantProduct(value: unknown): value is string {
  return typeof value === "string" && PRODUCT_KEY.test(value)
}

/** What {@link checkLicenseGrantNote} says: the note as it is kept (null for none), or why it is refused. */
export type LicenseGrantNoteCheck = {ok: true; note: string | null} | {ok: false; description: string}

/**
 * The note `value` gives, for a grant or for ending one, as it is kept: trimmed, at most `maxNoteLength` (500)
 * characters, and null when it is absent, null or blank. Anything that is not a string is refused.
 */
export function checkLicenseGrantNote(value: unknown): LicenseGrantNoteCheck {
  if (value !== undefined && value !== null && typeof value !== "string") return {ok: false, description: "note must be a string"}
  const note = typeof value === "string" ? value.trim() : ""
  const {maxNoteLength} = LICENSE_GRANT_LIMITS
  if (note.length > maxNoteLength) return {ok: false, description: `note must be at most ${maxNoteLength} characters`}
  return {ok: true, note: note || null}
}

/** Whether `value` is an idempotency key a grant takes: 1 to 200 visible ASCII characters. */
export function isLicenseGrantIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value)
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * `value` as milliseconds since the epoch, or null: an RFC 3339 date-time with its offset (`Z` or `±hh:mm`), or a date
 * alone, which is the start of that day in UTC. A day that is not in its month is refused, not rolled over.
 */
export function parseLicenseGrantEnd(value: unknown): number | null {
  if (typeof value !== "string") return null
  const date = DATE_ONLY.exec(value)
  const dateTime = date ? null : DATE_TIME.exec(value)
  const parts = date ?? dateTime
  if (!parts) return null
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null
  if (!dateTime) return Date.UTC(year, month - 1, day)
  const [hour, minute, second] = [Number(dateTime[4]), Number(dateTime[5]), Number(dateTime[6] ?? 0)]
  if (hour > 23 || minute > 59 || second > 59) return null
  const fractionMs = Math.floor(Number(`0.${dateTime[7] ?? "0"}`) * 1000)
  const zone = dateTime[8]!
  let offsetMinutes = 0
  if (zone !== "Z") {
    const [hours, minutes] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))]
    if (hours > 23 || minutes > 59) return null
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (hours * 60 + minutes)
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, fractionMs) - offsetMinutes * 60_000
}

/** `ms` as RFC 3339 in UTC, in whole seconds: `2027-11-17T00:00:00Z`. */
export function licenseGrantTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * The grant `value` asks for, as it is to be forwarded; or why it is refused, in a sentence for the caller. `value` is
 * the request's body with its `idempotencyKey` beside the other fields. It needs:
 * - `product`: a product key (`mentra.call.unlimited`). Whether billing sells it is billing's to say;
 * - `seats`: a whole number from `minSeats` to `maxSeats` (1 to 1000);
 * - `endsAt`: an RFC 3339 date-time with its offset, or a date (the start of that day in UTC). It is forwarded in UTC,
 *   cut to whole seconds. When it may be is {@link licenseGrantEndProblem}'s to say, not this check's: a repeat of a
 *   grant already made answers that grant however near or past its end;
 * - `note` (optional): a string of at most `maxNoteLength` (500) characters once trimmed; blank is no note;
 * - `idempotencyKey`: 1 to 200 visible ASCII characters.
 * Other fields are not read.
 */
export function checkLicenseGrantRequest(value: unknown): LicenseGrantCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {ok: false, description: "the request must be a JSON object"}
  const body = value as Record<string, unknown>
  const product = typeof body.product === "string" ? body.product.trim() : ""
  if (!PRODUCT_KEY.test(product)) return {ok: false, description: "product must be a product key, such as mentra.call.unlimited"}
  const {minSeats, maxSeats} = LICENSE_GRANT_LIMITS
  const seats = body.seats
  if (typeof seats !== "number" || !Number.isSafeInteger(seats) || seats < minSeats || seats > maxSeats) {
    return {ok: false, description: `seats must be a whole number from ${minSeats} to ${maxSeats}`}
  }
  const endsAtMs = parseLicenseGrantEnd(body.endsAt)
  if (endsAtMs === null) {
    return {ok: false, description: "endsAt must be an RFC 3339 date-time with its offset (2027-11-17T00:00:00Z) or a date (2027-11-17)"}
  }
  const note = checkLicenseGrantNote(body.note)
  if (!note.ok) return note
  if (!isLicenseGrantIdempotencyKey(body.idempotencyKey)) {
    return {ok: false, description: `an idempotency key of 1 to ${LICENSE_GRANT_LIMITS.maxIdempotencyKeyLength} visible ASCII characters is required`}
  }
  return {
    ok: true,
    request: {product, seats, endsAt: licenseGrantTime(endsAtMs), note: note.note, idempotencyKey: body.idempotencyKey},
  }
}

/** Why a new grant may not end when it asks to: `too_soon` or `too_late`, with a sentence for the caller. */
export interface LicenseGrantEndProblem {
  kind: "too_soon" | "too_late"
  description: string
}

/**
 * Why a new grant may not end at `endsAtMs` when asked for at `nowMs`, or null: it ends at least `minLeadMs` (an hour)
 * and at most `maxDays` (730 days) after `nowMs`. Only a new grant is held to it. A repeat of a grant already made
 * answers that grant, however near or past its end, so billing asks this only once it knows the key has made none. An
 * end that is `too_late` is never a repeat's (a grant made earlier ends sooner than that), so Core refuses it at once;
 * one that is `too_soon` may be a repeat's, so Core leaves it to billing.
 */
export function licenseGrantEndProblem(endsAtMs: number, nowMs: number): LicenseGrantEndProblem | null {
  const {maxDays, minLeadMs} = LICENSE_GRANT_LIMITS
  if (endsAtMs > nowMs + maxDays * DAY_MS) return {kind: "too_late", description: `endsAt must be at most ${maxDays} days from now`}
  if (endsAtMs < nowMs + minLeadMs) return {kind: "too_soon", description: "endsAt must be at least an hour from now"}
  return null
}

/** `value` as a {@link LicenseGrant}, holding only its documented fields, or null when it is not one. */
export function parseLicenseGrant(value: unknown): LicenseGrant | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const text = (field: unknown): field is string => typeof field === "string" && field.trim().length > 0
  if (!text(v.workspaceId) || !text(v.product) || !text(v.status) || !text(v.subscriptionId)) return null
  if (typeof v.seats !== "number" || !Number.isSafeInteger(v.seats) || v.seats < 0) return null
  if (typeof v.endsAt !== "string" || parseLicenseGrantEnd(v.endsAt) === null) return null
  const licenseId = v.licenseId === null ? null : text(v.licenseId) ? v.licenseId : undefined
  if (licenseId === undefined || typeof v.replayed !== "boolean") return null
  return {
    workspaceId: v.workspaceId,
    product: v.product,
    seats: v.seats,
    endsAt: v.endsAt,
    status: v.status,
    subscriptionId: v.subscriptionId,
    licenseId,
    replayed: v.replayed,
  }
}

/** `value` as a {@link LicenseGrantEnded}, holding only its documented fields, or null when it is not one. */
export function parseLicenseGrantEnded(value: unknown): LicenseGrantEnded | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const text = (field: unknown): field is string => typeof field === "string" && field.trim().length > 0
  if (!text(v.workspaceId) || !isLicenseGrantProduct(v.product) || !text(v.subscriptionId)) return null
  if (typeof v.endedAt !== "string" || parseLicenseGrantEnd(v.endedAt) === null) return null
  const licenseId = v.licenseId === null ? null : text(v.licenseId) ? v.licenseId : undefined
  if (licenseId === undefined) return null
  return {workspaceId: v.workspaceId, product: v.product, subscriptionId: v.subscriptionId, licenseId, endedAt: v.endedAt}
}
