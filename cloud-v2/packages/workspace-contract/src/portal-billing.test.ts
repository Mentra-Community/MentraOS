import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"
import * as root from "./index"
import * as portalBilling from "./portal-billing"
import type {MemberView} from "./index"
import {
  BILLING_ERROR_CODES,
  BillingActionSchema,
  BillingCatalogSchema,
  BillingStatusSchema,
  BillingTotalSchema,
  BuySchema,
  CatalogEntrySchema,
  CatalogFeatureSchema,
  FallbackPriceSchema,
  HostedUrlSchema,
  KNOWN_ACTION_KINDS,
  KNOWN_LICENSE_STATUSES,
  KNOWN_TAX,
  LicenseBillingSchema,
  MoneySchema,
  OfferSchema,
  PerSeatPriceSchema,
  PriceSchema,
  PurchaseAnswerSchema,
  PurchaseRequestSchema,
  PublicProductSchema,
  PurchaseStatusSchema,
  SessionAnswerSchema,
  SessionRequestSchema,
  TestModeSchema,
  billingIconPath,
  isPerSeat,
  type BillingCatalog,
  type BillingStatus,
  type BillingTotal,
  type Buy,
  type CatalogFeature,
  type FallbackPrice,
  type Offer,
  type PerSeatPrice,
  type Price,
  type PurchaseStatus,
  type TestMode,
} from "./portal-billing"

const callUnlimited = {
  product: "mentra.call.unlimited",
  name: "Mentra Call Unlimited",
  shortName: "Call Unlimited",
  description: "Unlimited calls and call summaries in Mentra Call.",
  icon: "/api/portal/billing/ui/icons/mentra.call.unlimited.png",
  features: [{key: "call.unlimited", name: "Unlimited calls", appName: "Mentra Call"}],
  offer: {
    price: {
      scheme: "per_seat",
      unit: {amountMinor: 2900, currency: "USD"},
      recurrence: {interval: "month", count: 1},
    },
    tax: "excluded",
    buy: {minSeats: 1, maxSeats: 500},
  },
}

const notesPro = {
  product: "mentra.notes.pro",
  name: "Mentra Notes Pro",
  description: "Searchable notes and summaries across everything you say.",
  icon: null,
  features: [
    {key: "notes.pro", name: "Pro notes", appName: "Mentra Notes"},
    {key: "notes.export", name: "Export"},
  ],
  offer: {
    price: {
      scheme: "per_seat",
      unit: {amountMinor: 1500, currency: "USD"},
      recurrence: {interval: "month", count: 1},
    },
    tax: "excluded",
    buy: null,
  },
}

const fleetSuite = {
  product: "mentra.fleet.suite",
  name: "Fleet Suite",
  description: "Device management for a fleet of glasses.",
  icon: "/api/portal/billing/ui/icons/mentra.fleet.suite.svg",
  features: [],
  offer: {
    price: {scheme: "tiered", fallbackLabel: "From $10 per seat a month"},
    tax: "none",
    buy: {minSeats: 1},
  },
}

const catalogDocument = {
  locale: "en",
  products: [callUnlimited, notesPro, fleetSuite],
}

const addSeats = {kind: "add_seats", fallbackLabel: "Add seats"}
const changeSeats = {kind: "change_seats", fallbackLabel: "Change seats"}
const cancel = {kind: "cancel", fallbackLabel: "Cancel"}
const renew = {kind: "renew", fallbackLabel: "Renew"}
const updatePayment = {kind: "update_payment", fallbackLabel: "Update payment method"}
const completePayment = {kind: "complete_payment", fallbackLabel: "Complete payment", returns: false}
const billingAndInvoices = {kind: "billing_and_invoices", fallbackLabel: "Billing & invoices"}

const perSeat = {
  scheme: "per_seat",
  unit: {amountMinor: 2900, currency: "USD"},
  recurrence: {interval: "month", count: 1},
}

const activeLicense = {
  licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
  product: "mentra.call.unlimited",
  status: "active",
  fallbackStatusLabel: "Active",
  renewsAt: "2026-11-01T00:00:00Z",
  price: perSeat,
  quantity: 5,
  total: {amountMinor: 14500, currency: "USD"},
  tax: "excluded",
  actions: [addSeats, changeSeats, cancel],
}

const endingLicense = {
  licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RE",
  product: "mentra.notes.pro",
  status: "ending",
  fallbackStatusLabel: "Ending",
  endsAt: "2026-11-15T09:30:00+01:00",
  price: {...perSeat, unit: {amountMinor: 1500, currency: "USD"}},
  quantity: 3,
  total: {amountMinor: 4500, currency: "USD"},
  tax: "excluded",
  actions: [renew],
}

const pastDueLicense = {
  licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RF",
  product: "mentra.fleet.suite",
  status: "past_due",
  fallbackStatusLabel: "Payment failed",
  renewsAt: "2026-10-18T00:00:00.000Z",
  seatsStopAt: "2026-10-25T00:00:00Z",
  price: {scheme: "tiered", fallbackLabel: "From $10 per seat a month"},
  quantity: 8,
  total: null,
  tax: "none",
  actions: [addSeats, changeSeats, updatePayment, completePayment],
}

const statusDocument = {
  locale: "en",
  licenses: [activeLicense, endingLicense, pastDueLicense],
  total: {
    amount: {amountMinor: 14500, currency: "USD"},
    recurrence: {interval: "month", count: 1},
    tax: "excluded",
    licenseCount: 1,
  },
  actions: [billingAndInvoices],
  testMode: {cardNumber: "4242424242424242", environment: "STAGING"},
  purchase: {
    purchaseId: "pur_01JZWY3V8N0F2E9GQ4T6KXH5RG",
    status: "ready",
    product: "mentra.call.unlimited",
    quantity: 5,
    paid: true,
    licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
  },
}

/** A deep copy that a test can edit without touching the shared documents. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("the spec's example documents", () => {
  test("a catalog with three products parses and keeps its values", () => {
    const parsed: BillingCatalog = BillingCatalogSchema.parse(catalogDocument)
    expect(parsed).toEqual(catalogDocument as unknown as BillingCatalog)
    expect(parsed.products.map((product) => product.product)).toEqual([
      "mentra.call.unlimited",
      "mentra.notes.pro",
      "mentra.fleet.suite",
    ])
  })

  test("a status with active, ending and past_due licenses, a total, test mode and a purchase parses", () => {
    const parsed: BillingStatus = BillingStatusSchema.parse(statusDocument)
    expect(parsed).toEqual(statusDocument as unknown as BillingStatus)
    expect(parsed.licenses.map((license) => license.status)).toEqual(["active", "ending", "past_due"])
    expect(parsed.total?.licenseCount).toBe(1)
    expect(parsed.testMode?.cardNumber).toBe("4242424242424242")
    expect(parsed.purchase?.status).toBe("ready")
  })

  test("a status with nothing in it parses: no licenses, total, test mode or purchase", () => {
    const parsed = BillingStatusSchema.parse({
      locale: "en-GB",
      licenses: [],
      total: null,
      actions: [],
      testMode: null,
      purchase: null,
    })
    expect(parsed.licenses).toEqual([])
    expect(parsed.total).toBeNull()
    expect(parsed.purchase).toBeNull()
  })

  test("a purchase that is still processing has no license yet", () => {
    const document = copy(statusDocument)
    document.purchase = {...document.purchase, status: "processing", paid: false, licenseId: null as unknown as string}
    const parsed = BillingStatusSchema.parse(document)
    expect(parsed.purchase).toMatchObject({status: "processing", paid: false, licenseId: null})
  })

  test("an unknown purchase status parses and keeps its value", () => {
    const document = copy(statusDocument)
    document.purchase.status = "refunded"
    const parsed = BillingStatusSchema.parse(document)
    expect(parsed.purchase).toMatchObject({status: "refunded", licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD"})
  })

  test("every known action kind parses, with returns only when billing sends it", () => {
    for (const action of [addSeats, changeSeats, cancel, renew, updatePayment, completePayment, billingAndInvoices]) {
      expect(BillingActionSchema.parse(action)).toEqual(action)
    }
    expect(BillingActionSchema.parse(completePayment).returns).toBe(false)
    expect("returns" in BillingActionSchema.parse(cancel)).toBe(false)
  })
})

describe("values the contract does not know", () => {
  test("an unknown license status parses and keeps its value", () => {
    const document = copy(statusDocument)
    document.licenses[0]!.status = "paused"
    document.licenses[0]!.fallbackStatusLabel = "Paused"
    const parsed = BillingStatusSchema.parse(document)
    expect(parsed.licenses[0]).toMatchObject({status: "paused", fallbackStatusLabel: "Paused"})
    expect(KNOWN_LICENSE_STATUSES as readonly string[]).not.toContain("paused")
  })

  test("an unknown action kind parses and keeps its value, on a license and on the account", () => {
    const document = copy(statusDocument)
    const transfer = {kind: "transfer_ownership", fallbackLabel: "Transfer ownership"}
    document.licenses[0]!.actions.push(transfer as never)
    document.actions.push(transfer as never)
    const parsed = BillingStatusSchema.parse(document)
    expect(parsed.licenses[0]!.actions.at(-1)).toEqual(transfer)
    expect(parsed.actions.at(-1)).toEqual(transfer)
    expect(KNOWN_ACTION_KINDS as readonly string[]).not.toContain("transfer_ownership")
  })

  test("an unknown tax value parses and keeps its value, on a license, the total and an offer", () => {
    const status = copy(statusDocument)
    status.licenses[0]!.tax = "reverse_charge"
    status.total.tax = "reverse_charge"
    const parsedStatus = BillingStatusSchema.parse(status)
    expect(parsedStatus.licenses[0]!.tax).toBe("reverse_charge")
    expect(parsedStatus.total!.tax).toBe("reverse_charge")

    const catalog = copy(catalogDocument)
    catalog.products[0]!.offer!.tax = "reverse_charge"
    expect(BillingCatalogSchema.parse(catalog).products[0]!.offer!.tax).toBe("reverse_charge")
    expect(KNOWN_TAX as readonly string[]).not.toContain("reverse_charge")
  })

  test("an unknown price scheme with a fallbackLabel parses and keeps its value", () => {
    const price = {scheme: "metered", fallbackLabel: "$0.02 per minute"}
    expect(PriceSchema.parse(price)).toEqual(price)
    const document = copy(statusDocument)
    document.licenses[0]!.price = price as never
    document.licenses[0]!.total = null as never
    expect(BillingStatusSchema.parse(document).licenses[0]!.price).toEqual(price)
  })

  test("a per_seat price that is malformed but has a fallbackLabel falls back to its label", () => {
    const price = {scheme: "per_seat", fallbackLabel: "$29 per seat a month", unit: {amountMinor: -1, currency: "USD"}}
    const parsed = PriceSchema.parse(price)
    expect(parsed).toEqual({scheme: "per_seat", fallbackLabel: "$29 per seat a month"})
    expect(isPerSeat(parsed)).toBe(false)
  })

  test("the known constants list what the spec names", () => {
    expect(KNOWN_LICENSE_STATUSES).toEqual(["active", "ending", "past_due", "processing", "incomplete"])
    expect(KNOWN_ACTION_KINDS).toEqual([
      "add_seats",
      "change_seats",
      "cancel",
      "renew",
      "update_payment",
      "complete_payment",
      "billing_and_invoices",
    ])
    expect(KNOWN_TAX).toEqual(["excluded", "included", "none"])
  })

  test("an unknown field is stripped, at every level", () => {
    const catalog = copy(catalogDocument) as Record<string, unknown> & {products: Record<string, any>[]}
    catalog.futureField = "x"
    catalog.products[0]!.futureField = "x"
    catalog.products[0]!.features[0].futureField = "x"
    catalog.products[0]!.offer.futureField = "x"
    catalog.products[0]!.offer.price.futureField = "x"
    catalog.products[0]!.offer.price.unit.futureField = "x"
    catalog.products[0]!.offer.price.recurrence.futureField = "x"
    catalog.products[0]!.offer.buy.futureField = "x"
    expect(BillingCatalogSchema.parse(catalog)).toEqual(catalogDocument as unknown as BillingCatalog)

    const status = copy(statusDocument) as Record<string, any>
    status.futureField = "x"
    status.licenses[0].futureField = "x"
    status.licenses[0].actions[0].futureField = "x"
    status.total.futureField = "x"
    status.testMode.futureField = "x"
    status.purchase.futureField = "x"
    expect(BillingStatusSchema.parse(status)).toEqual(statusDocument as unknown as BillingStatus)
  })
})

describe("a catalog entry", () => {
  test("without an offer, display content only, parses and has none", () => {
    const {offer: _offer, ...display} = callUnlimited
    const parsed = CatalogEntrySchema.parse(display)
    expect(parsed).toEqual(display as never)
    expect("offer" in parsed).toBe(false)
  })

  test("without a shortName or an appName parses", () => {
    const parsed = CatalogEntrySchema.parse(notesPro)
    expect(parsed.shortName).toBeUndefined()
    expect(parsed.features[1]!.appName).toBeUndefined()
  })

  test("an offer's buy is null where the owner can't buy now, and maxSeats is optional", () => {
    expect(CatalogEntrySchema.parse(notesPro).offer!.buy).toBeNull()
    expect(CatalogEntrySchema.parse(fleetSuite).offer!.buy).toEqual({minSeats: 1})
  })

  test("an owner type list from an older Store is stripped, and never fails the entry", () => {
    for (const ownerTypes of [["workspace", "person"], ["team"], [], [3], "workspace"]) {
      const parsed = CatalogEntrySchema.parse({...callUnlimited, ownerTypes})
      expect("ownerTypes" in parsed).toBe(false)
      expect(parsed).toEqual(callUnlimited as never)
    }
  })

  test("a catalog whose entries still carry ownerTypes parses, and keeps the rest", () => {
    const catalog = copy(catalogDocument)
    for (const product of catalog.products) (product as Record<string, unknown>).ownerTypes = ["workspace", "person"]
    const parsed = BillingCatalogSchema.parse(catalog)
    expect(parsed.products.map((product) => "ownerTypes" in product)).toEqual([false, false, false])
    expect(parsed.products.map((product) => product.product)).toEqual(catalog.products.map((product) => product.product))
  })

  test("a buy from an older Store with defaultSeats is stripped to its limits", () => {
    const old = {...callUnlimited, offer: {...callUnlimited.offer, buy: {minSeats: 1, maxSeats: 500, defaultSeats: 5}}}
    const parsed = CatalogEntrySchema.parse(old)
    expect(parsed.offer!.buy).toEqual({minSeats: 1, maxSeats: 500})
    expect(BuySchema.parse({minSeats: 2, defaultSeats: 9})).toEqual({minSeats: 2})
  })

  test("the owner-type helpers are gone: a workspace is the only owner", () => {
    expect("KNOWN_OWNER_TYPES" in portalBilling).toBe(false)
    expect("isKnownOwnerType" in portalBilling).toBe(false)
  })
})

describe("prices and money", () => {
  test("a per_seat price without a unit and without a fallbackLabel fails", () => {
    expect(PriceSchema.safeParse({scheme: "per_seat", recurrence: {interval: "month", count: 1}}).success).toBe(false)
    expect(PriceSchema.safeParse({scheme: "per_seat"}).success).toBe(false)
    const document = copy(statusDocument)
    delete (document.licenses[0]!.price as any).unit
    expect(BillingStatusSchema.safeParse(document).success).toBe(false)
  })

  test("a per_seat price without a recurrence and without a fallbackLabel fails", () => {
    expect(PriceSchema.safeParse({scheme: "per_seat", unit: {amountMinor: 2900, currency: "USD"}}).success).toBe(false)
  })

  test("a price with neither a unit nor a fallbackLabel, whatever its scheme, fails", () => {
    expect(PriceSchema.safeParse({scheme: "metered"}).success).toBe(false)
    expect(PriceSchema.safeParse({fallbackLabel: "From $10"}).success).toBe(false)
  })

  test("a recurrence needs a known interval and a count of at least one", () => {
    const base = {scheme: "per_seat", unit: {amountMinor: 100, currency: "EUR"}}
    expect(PriceSchema.safeParse({...base, recurrence: {interval: "year", count: 1}}).success).toBe(true)
    expect(PriceSchema.safeParse({...base, recurrence: {interval: "fortnight", count: 1}}).success).toBe(false)
    expect(PriceSchema.safeParse({...base, recurrence: {interval: "month", count: 0}}).success).toBe(false)
    expect(PriceSchema.safeParse({...base, recurrence: {interval: "month", count: 1.5}}).success).toBe(false)
  })

  test("amountMinor -1 or 1.5 fails, and zero and a large whole number pass", () => {
    expect(MoneySchema.safeParse({amountMinor: -1, currency: "USD"}).success).toBe(false)
    expect(MoneySchema.safeParse({amountMinor: 1.5, currency: "USD"}).success).toBe(false)
    expect(MoneySchema.safeParse({amountMinor: Number.NaN, currency: "USD"}).success).toBe(false)
    expect(MoneySchema.safeParse({amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "USD"}).success).toBe(false)
    expect(MoneySchema.safeParse({amountMinor: "100", currency: "USD"}).success).toBe(false)
    expect(MoneySchema.parse({amountMinor: 0, currency: "USD"})).toEqual({amountMinor: 0, currency: "USD"})
    expect(MoneySchema.safeParse({amountMinor: Number.MAX_SAFE_INTEGER, currency: "JPY"}).success).toBe(true)
  })

  test("a currency other than three uppercase letters fails, such as usd", () => {
    for (const currency of ["usd", "Usd", "US", "USDD", "U$D", "US1", " USD", ""]) {
      expect(MoneySchema.safeParse({amountMinor: 100, currency}).success).toBe(false)
    }
    expect(MoneySchema.safeParse({amountMinor: 100, currency: "USD"}).success).toBe(true)
  })

  test("a bad amount anywhere fails the whole document", () => {
    const status = copy(statusDocument)
    status.licenses[0]!.total!.amountMinor = -1
    expect(BillingStatusSchema.safeParse(status).success).toBe(false)
    const catalog = copy(catalogDocument) as {products: {offer: {price: {unit: {currency: string}}}}[]}
    catalog.products[0]!.offer.price.unit.currency = "usd"
    expect(BillingCatalogSchema.safeParse(catalog).success).toBe(false)
  })

  test("isPerSeat narrows a per_seat price and nothing else", () => {
    const seat: Price = PriceSchema.parse(perSeat)
    expect(isPerSeat(seat)).toBe(true)
    if (isPerSeat(seat)) {
      expect(seat.unit.amountMinor).toBe(2900)
      expect(seat.recurrence.interval).toBe("month")
    }
    expect(isPerSeat(PriceSchema.parse({scheme: "tiered", fallbackLabel: "From $10"}))).toBe(false)
    expect(isPerSeat(PriceSchema.parse({scheme: "per_seat", fallbackLabel: "$29 a seat"}))).toBe(false)
  })
})

describe("dates", () => {
  const withDate = (field: "renewsAt" | "endsAt" | "seatsStopAt", value: unknown) => {
    const document = copy(statusDocument) as Record<string, any>
    document.licenses[0][field] = value
    return BillingStatusSchema.safeParse(document)
  }

  test("a date without an offset fails", () => {
    expect(withDate("renewsAt", "2026-11-01T00:00:00").success).toBe(false)
    expect(withDate("endsAt", "2026-11-01T00:00:00.000").success).toBe(false)
    expect(withDate("seatsStopAt", "2026-11-01").success).toBe(false)
    expect(withDate("renewsAt", "tomorrow").success).toBe(false)
    expect(withDate("renewsAt", "").success).toBe(false)
    expect(withDate("renewsAt", 1_790_000_000_000).success).toBe(false)
  })

  test("a date with Z or an offset passes, with or without fractional seconds", () => {
    for (const value of [
      "2026-11-01T00:00:00Z",
      "2026-11-01T00:00:00.123Z",
      "2026-11-01T09:30:00+01:00",
      "2026-11-01T09:30:00-07:00",
      "2026-11-01T09:30:00.5+05:30",
    ]) {
      expect(withDate("renewsAt", value).success).toBe(true)
    }
  })

  test("a date that is not on the calendar fails", () => {
    expect(withDate("renewsAt", "2026-02-30T00:00:00Z").success).toBe(false)
    expect(withDate("renewsAt", "2026-13-01T00:00:00Z").success).toBe(false)
  })
})

describe("billingIconPath", () => {
  const icons = "/api/portal/billing/ui/icons/"

  test("keeps /api/portal/billing/ui/icons/<file> for a file of letters, digits, dots, underscores and hyphens", () => {
    expect(billingIconPath("/api/portal/billing/ui/icons/mentra.call.unlimited.png")).toBe(
      "/api/portal/billing/ui/icons/mentra.call.unlimited.png",
    )
    for (const file of ["mentra.fleet.suite.svg", "Call_Unlimited-2.PNG", "x", "a-b_c.1.2.webp", ".hidden", "x..png"]) {
      expect([file, billingIconPath(`${icons}${file}`)]).toEqual([file, `${icons}${file}`])
    }
    expect(billingIconPath(`${icons}${"a".repeat(255)}`)).toBe(`${icons}${"a".repeat(255)}`)
  })

  test("is null for an address that is not billing's own icon path", () => {
    for (const value of [
      "https://files.example.com/x.png",
      "http://localhost:3000/api/portal/billing/ui/icons/x.png",
      "//host/x.png",
      "//host/api/portal/billing/ui/icons/x.png",
      "/api/portal/other/ui/x.png",
      "/api/portal/other/ui/icons/x.png",
      "/api/portal/billing/uix/icons/x.png",
      "/api/portal/billing/ui/icon/x.png",
      "/API/PORTAL/BILLING/UI/ICONS/x.png",
      "icons/x.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "",
    ]) {
      expect([value, billingIconPath(value)]).toEqual([value, null])
    }
  })

  test("is null for the rest of ui/, the legacy entry.js included, and for ui/icons/ with no file", () => {
    for (const value of [
      "/api/portal/billing/ui",
      "/api/portal/billing/ui/",
      "/api/portal/billing/ui/entry.js",
      "/api/portal/billing/ui/entry.js?v=1",
      "/api/portal/billing/ui/x.png",
      "/api/portal/billing/ui/icons",
      "/api/portal/billing/ui/icons/",
      "/api/portal/billing/ui/icons/?x.png",
    ]) {
      expect([value, billingIconPath(value)]).toEqual([value, null])
    }
  })

  test("is null for a file with a character outside letters, digits, dots, underscores and hyphens", () => {
    for (const file of [
      'a"b.png',
      "a'b.png",
      "a(1).png",
      "a)b.png",
      "a b.png",
      "a\tb.png",
      "a\nb.png",
      "a\u0000b.png",
      "a\\b.png",
      "a;b.png",
      "a,b.png",
      "a&b.png",
      "a=b.png",
      "a+b.png",
      "a@b.png",
      "a<b>.png",
      "a{b}.png",
      "a:b.png",
      "é.png",
      "x.png?v=2",
      "x.png#frag",
      "%2e%2e",
      "%2e%2e%2fme",
      "x%2epng",
      "a%20b.png",
      "sub/x.png",
      "sub/../x.png",
      "../x.png",
      "../../me",
      "..",
      ".",
      "...",
      "x.png/",
      "/x.png",
      "x.png\n",
      "a".repeat(256),
    ]) {
      expect([file, billingIconPath(`${icons}${file}`)]).toEqual([file, null])
    }
  })

  test("is null for a value that is not a string", () => {
    for (const value of [null, undefined, 3, {}, []]) {
      expect(billingIconPath(value)).toBeNull()
    }
  })

  test("applies in a catalog entry: another address parses to null and does not fail the entry", () => {
    for (const icon of [
      "https://files.example.com/x.png",
      "//host/x.png",
      "/api/portal/other/ui/x.png",
      "/api/portal/billing/ui/entry.js",
      "/api/portal/billing/ui/icons/",
      "/api/portal/billing/ui/icons/a b.png",
    ]) {
      const parsed = CatalogEntrySchema.parse({...callUnlimited, icon})
      expect([icon, parsed.icon]).toEqual([icon, null])
      expect(parsed.name).toBe(callUnlimited.name)
    }
    expect(CatalogEntrySchema.parse(callUnlimited).icon).toBe("/api/portal/billing/ui/icons/mentra.call.unlimited.png")
    expect(CatalogEntrySchema.parse({...callUnlimited, icon: null}).icon).toBeNull()
  })
})

describe("hosted URLs", () => {
  const accepted = [
    "https://billing.example.com/p/session/x",
    "https://checkout.example.com/c/pay/a1B2c3#fragment",
    "https://billing.example.com:8443/x?y=1",
    "HTTPS://billing.example.com/x",
    "http://localhost:4010/x",
    "http://localhost/x",
    "http://127.0.0.1:4010/x?session=1",
    "http://127.0.0.1/x",
  ]
  const refused = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\nscript:alert(1)",
    "http://example.com",
    "http://example.com/x",
    "http://localhost.evil.com/x",
    "http://127.0.0.1.evil.com/x",
    "http://evil.com@localhost/x",
    "http://localhost@evil.com/x",
    "https://user:pass@billing.example.com/x",
    "http://[::1]:4010/x",
    "http://0.0.0.0/x",
    "http://127.0.0.2/x",
    "data:text/html,<script>alert(1)</script>",
    "data:text/plain;base64,AAAA",
    "blob:https://billing.example.com/3b3f",
    "file:///etc/passwd",
    "ftp://billing.example.com/x",
    "//billing.example.com/x",
    "/p/session/x",
    "billing.example.com/x",
    "https://",
    "",
  ]

  test("https passes, and http passes only to localhost or 127.0.0.1", () => {
    for (const url of accepted) {
      expect([url, HostedUrlSchema.safeParse(url).success]).toEqual([url, true])
    }
  })

  test("javascript:, data: and other http or non-web addresses fail", () => {
    for (const url of refused) {
      expect([url, HostedUrlSchema.safeParse(url).success]).toEqual([url, false])
    }
  })

  test("a value that is not a string fails", () => {
    for (const value of [null, undefined, 3, {}, ["https://billing.example.com/x"]]) {
      expect(HostedUrlSchema.safeParse(value).success).toBe(false)
    }
  })

  test("returns the canonical address, the one the browser follows", () => {
    for (const url of accepted) {
      expect([url, HostedUrlSchema.parse(url)]).toEqual([url, new URL(url).href])
    }
    expect(HostedUrlSchema.parse("https://billing.example.com")).toBe("https://billing.example.com/")
    expect(HostedUrlSchema.parse("HTTPS://Billing.Example.COM/Path")).toBe("https://billing.example.com/Path")
    expect(HostedUrlSchema.parse("https://billing.example.com:443/x")).toBe("https://billing.example.com/x")
    expect(HostedUrlSchema.parse("https://billing.example.com/p/session/x?a=1#frag")).toBe(
      "https://billing.example.com/p/session/x?a=1#frag",
    )
  })

  test("padding the browser ignores is gone from what is returned", () => {
    for (const padded of [
      " https://billing.example.com/p/session/x",
      "https://billing.example.com/p/session/x ",
      "  https://billing.example.com/p/session/x  ",
      "\thttps://billing.example.com/p/session/x\n",
      "\n\r https://billing.example.com/p/session/x \r\n",
      "\u0001https://billing.example.com/p/session/x\u0001",
    ]) {
      expect([padded, HostedUrlSchema.parse(padded)]).toEqual([padded, "https://billing.example.com/p/session/x"])
    }
    expect(HostedUrlSchema.parse(" http://localhost:4010/x ")).toBe("http://localhost:4010/x")
  })

  test("tabs and newlines inside the address, which the browser drops, are gone from what is returned", () => {
    for (const [input, expected] of [
      ["https://billing.example.com/p/ses\tsion/x", "https://billing.example.com/p/session/x"],
      ["ht\ttps://billing.example.com/x", "https://billing.example.com/x"],
      ["https://billing.exa\nmple.com/x", "https://billing.example.com/x"],
      ["https://billing.example.com/x?a=\r\n1", "https://billing.example.com/x?a=1"],
      ["http://local\thost:4010/x", "http://localhost:4010/x"],
      ["http://127.0.\t0.1/x", "http://127.0.0.1/x"],
    ] as const) {
      expect([input, HostedUrlSchema.parse(input)]).toEqual([input, expected])
    }
  })

  test("a tab or padding cannot turn a refused address into an accepted one, nor the other way", () => {
    for (const input of [
      " javascript:alert(1)",
      "\tjava\tscript:alert(1)",
      " http://example.com/x ",
      "http://local\thost.evil.com/x",
      "http://127.0.0.\t1.evil.com/x",
      "https://user:pass@billing.example.com/x ",
      " data:text/html,x",
    ]) {
      expect([input, HostedUrlSchema.safeParse(input).success]).toEqual([input, false])
    }
  })

  test("the session answer and the purchase answer check the url the same way", () => {
    for (const schema of [SessionAnswerSchema, PurchaseAnswerSchema]) {
      expect(schema.parse({url: "https://billing.example.com/p/session/x"})).toEqual({
        url: "https://billing.example.com/p/session/x",
      })
      expect(schema.parse({url: "http://localhost:4010/x"})).toEqual({url: "http://localhost:4010/x"})
      expect(schema.parse({url: " https://billing.example.com/p/session/x "})).toEqual({
        url: "https://billing.example.com/p/session/x",
      })
      expect(schema.safeParse({url: "javascript:alert(1)"}).success).toBe(false)
      expect(schema.safeParse({url: "http://example.com"}).success).toBe(false)
      expect(schema.safeParse({url: "data:text/html,x"}).success).toBe(false)
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.parse({url: "https://billing.example.com/x", futureField: "x"})).toEqual({
        url: "https://billing.example.com/x",
      })
    }
  })
})

describe("requests", () => {
  test("a purchase request names a product, seats and a locale", () => {
    const body = {product: "mentra.call.unlimited", seats: 5, locale: "en-US"}
    expect(PurchaseRequestSchema.parse(body)).toEqual(body)
    expect(PurchaseRequestSchema.safeParse({...body, seats: 2.5}).success).toBe(false)
    expect(PurchaseRequestSchema.safeParse({...body, seats: "5"}).success).toBe(false)
    expect(PurchaseRequestSchema.safeParse({...body, product: undefined}).success).toBe(false)
    expect(PurchaseRequestSchema.safeParse({...body, locale: undefined}).success).toBe(false)
  })

  test("a session request names an action and a locale, and may name a license and seats", () => {
    expect(SessionRequestSchema.parse({action: "billing_and_invoices", locale: "en"})).toEqual({
      action: "billing_and_invoices",
      locale: "en",
    })
    const full = {action: "add_seats", licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD", seats: 3, locale: "en-GB"}
    expect(SessionRequestSchema.parse(full)).toEqual(full)
    // An action Core doesn't know is still a string: billing answers 400 unknown_action.
    expect(SessionRequestSchema.parse({action: "transfer_ownership", locale: "en"}).action).toBe("transfer_ownership")
    expect(SessionRequestSchema.safeParse({action: "add_seats", seats: 1.5, locale: "en"}).success).toBe(false)
    expect(SessionRequestSchema.safeParse({locale: "en"}).success).toBe(false)
  })

  test("a session request may ask for the one license it adds to be the asker's (forMe: true only)", () => {
    const forMe = {action: "add_seats", licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD", seats: 1, forMe: true as const, locale: "en"}
    expect(SessionRequestSchema.parse(forMe)).toEqual(forMe)
    expect(SessionRequestSchema.safeParse({...forMe, forMe: false}).success).toBe(false)
    expect(SessionRequestSchema.safeParse({...forMe, forMe: "yes"}).success).toBe(false)
    const {forMe: _forMe, ...without} = forMe
    expect(SessionRequestSchema.parse(without)).toEqual(without)
    expect(SessionRequestSchema.parse(without).forMe).toBeUndefined()
  })

  test("an unknown field of a request is stripped", () => {
    expect(SessionRequestSchema.parse({action: "cancel", locale: "en", futureField: "x"})).toEqual({
      action: "cancel",
      locale: "en",
    })
  })
})

describe("a product's public name", () => {
  test("is a name and nothing else: a price, an id or an offer beside it is stripped", () => {
    expect(PublicProductSchema.parse({name: "Mentra Call Unlimited"})).toEqual({name: "Mentra Call Unlimited"})
    const parsed = PublicProductSchema.parse({
      name: "Mentra Call Unlimited",
      product: "mentra.call.unlimited",
      priceId: "price_123",
      offer: {price: {scheme: "per_seat"}},
    })
    expect(parsed).toEqual({name: "Mentra Call Unlimited"})
    expect(Object.keys(parsed)).toEqual(["name"])
  })

  test("needs a non-empty string name", () => {
    for (const value of [{}, {name: ""}, {name: null}, {name: 7}, {name: ["x"]}, null, "Mentra Call", []]) {
      expect([value, PublicProductSchema.safeParse(value).success]).toEqual([value, false])
    }
  })
})

describe("the license billing document alone", () => {
  test("a license needs its licenseId, product, status, label, price, quantity, total, tax and actions", () => {
    expect(LicenseBillingSchema.safeParse(activeLicense).success).toBe(true)
    for (const field of [
      "licenseId",
      "product",
      "status",
      "fallbackStatusLabel",
      "price",
      "quantity",
      "total",
      "tax",
      "actions",
    ]) {
      const license = copy(activeLicense) as Record<string, unknown>
      delete license[field]
      expect([field, LicenseBillingSchema.safeParse(license).success]).toEqual([field, false])
    }
  })

  test("the dates are optional", () => {
    const parsed = LicenseBillingSchema.parse({
      ...activeLicense,
      status: "processing",
      renewsAt: undefined,
    })
    expect(parsed.renewsAt).toBeUndefined()
    expect(parsed.endsAt).toBeUndefined()
    expect(parsed.seatsStopAt).toBeUndefined()
  })

  test("a quantity that is not a whole number fails", () => {
    expect(LicenseBillingSchema.safeParse({...activeLicense, quantity: 2.5}).success).toBe(false)
    expect(LicenseBillingSchema.safeParse({...activeLicense, quantity: -1}).success).toBe(false)
  })
})

describe("billing's error codes", () => {
  test("list the refusals the spec names", () => {
    expect(BILLING_ERROR_CODES).toEqual([
      "invalid_request",
      "not_for_sale",
      "invalid_seats",
      "unknown_action",
      "forbidden",
      "license_not_found",
      "no_billing_account",
      "already_licensed",
      "checkout_in_progress",
      "seat_request_pending",
      "owner_ended",
      "billing_unavailable",
      "core_unavailable",
    ])
  })
})

describe("seat assignments and member names", () => {
  test("MemberView without a name still type-checks, and one with a name or null does too", () => {
    const base = {
      membershipId: "mem_1",
      mentraUserId: "mu_1",
      email: "dana@example.test",
      role: "member" as const,
      startedAt: "2026-10-01T00:00:00Z",
      pending: false,
    }
    const without: MemberView = base
    const named: MemberView = {...base, name: "Dana Reyes"}
    const unnamed: MemberView = {...base, name: null}
    expect([without.name, named.name, unnamed.name]).toEqual([undefined, "Dana Reyes", null])
  })

  test("the bulk assignment contract is in the package root", () => {
    expect(root.MAX_SEAT_ASSIGNMENTS).toBe(500)
    expect(root.NO_SEATS_AVAILABLE_ERROR).toBe("no_seats_available")
    const request: root.SeatAssignmentsRequest = {assignments: [{licenseId: "lic_1", membershipId: "mem_1"}]}
    const shortfall: root.SeatShortfall = {licenseId: "lic_1", needed: 3, free: 1}
    const response: root.SeatAssignmentsResponse = {licenses: []}
    expect([request.assignments.length, shortfall.needed - shortfall.free, response.licenses.length]).toEqual([1, 2, 0])
  })
})

describe("the parts of the contract are exported by name", () => {
  test("the catalog's and the status's inner objects parse and keep their values", () => {
    const feature: CatalogFeature = CatalogFeatureSchema.parse({key: "call.unlimited", name: "Unlimited calls"})
    const buy: Buy = BuySchema.parse({minSeats: 1, maxSeats: 500})
    const offer: Offer = OfferSchema.parse(callUnlimited.offer)
    const total: BillingTotal = BillingTotalSchema.parse(statusDocument.total)
    const testMode: TestMode = TestModeSchema.parse(statusDocument.testMode)
    const purchase: PurchaseStatus = PurchaseStatusSchema.parse(statusDocument.purchase)
    expect(feature).toEqual({key: "call.unlimited", name: "Unlimited calls"})
    expect(buy).toEqual({minSeats: 1, maxSeats: 500})
    expect(offer).toEqual(callUnlimited.offer as unknown as Offer)
    expect(total).toEqual(statusDocument.total as unknown as BillingTotal)
    expect(testMode).toEqual(statusDocument.testMode)
    expect(purchase).toEqual(statusDocument.purchase)
  })

  test("the two price shapes parse apart", () => {
    const seat: PerSeatPrice = PerSeatPriceSchema.parse(perSeat)
    const fallback: FallbackPrice = FallbackPriceSchema.parse({scheme: "tiered", fallbackLabel: "From $10"})
    expect(seat).toEqual(perSeat as unknown as PerSeatPrice)
    expect(fallback).toEqual({scheme: "tiered", fallbackLabel: "From $10"})
    expect(PerSeatPriceSchema.safeParse({scheme: "tiered", fallbackLabel: "From $10"}).success).toBe(false)
    expect(FallbackPriceSchema.safeParse(perSeat).success).toBe(false)
  })

  test("each part rejects what the whole rejects", () => {
    expect(BuySchema.safeParse({minSeats: 0}).success).toBe(false)
    expect(BillingTotalSchema.safeParse({...statusDocument.total, licenseCount: -1}).success).toBe(false)
    expect(PurchaseStatusSchema.safeParse({...statusDocument.purchase, paid: "yes"}).success).toBe(false)
    expect(TestModeSchema.safeParse({cardNumber: "4242424242424242"}).success).toBe(false)
    expect(OfferSchema.safeParse({...callUnlimited.offer, price: {scheme: "per_seat"}}).success).toBe(false)
    expect(CatalogFeatureSchema.safeParse({key: "call.unlimited"}).success).toBe(false)
  })
})

describe("the package entry points", () => {
  test("portal-billing is a subpath of the package, not part of the root", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    expect(manifest.exports["./portal-billing"]).toBe("./src/portal-billing.ts")
    expect(manifest.dependencies.zod).toBe("^3.24.1")
    expect(Object.keys(root)).not.toContain("BillingStatusSchema")
    expect(Object.keys(root)).not.toContain("billingIconPath")
  })

  test("portal-billing bundles for the browser", () => {
    // Resolved rather than hard-coded so the compiled copy under dist/ finds its own portal-billing.js.
    // Bundled by a separate `bun build`: a second in-process Bun.build of a package that imports zod fails
    // with EISDIR once zod is loaded, which is what running this file and its dist copy together does.
    const entrypoint = Bun.resolveSync("./portal-billing", import.meta.dir)
    const result = Bun.spawnSync([process.execPath, "build", entrypoint, "--target=browser"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.stderr.toString()).not.toContain("error")
    expect(result.exitCode).toBe(0)
    const bundle = result.stdout.toString()
    expect(bundle).toContain("billingIconPath")
    // zod is inlined: a browser that loads the bundle has nothing else to resolve.
    expect(bundle).toContain("ZodError")
    expect(bundle).not.toMatch(/\bfrom\s*["']zod["']|\brequire\(\s*["']zod["']\s*\)/)
  })
})
