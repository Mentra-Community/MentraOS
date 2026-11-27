import {describe, expect, test} from "bun:test"
import {
  checkLicenseGrantNote,
  checkLicenseGrantRequest,
  isLicenseGrantIdempotencyKey,
  isLicenseGrantProduct,
  LICENSE_GRANT_LIMITS,
  licenseGrantEndProblem,
  licenseGrantTime,
  parseLicenseGrant,
  parseLicenseGrantEnd,
  parseLicenseGrantEnded,
  type LicenseGrant,
  type LicenseGrantEnded,
  type LicenseGrantEndProblem,
} from "./license-grants"

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const valid = {product: "mentra.call.unlimited", seats: 2, endsAt: "2027-11-17T00:00:00Z", note: " pilot ", idempotencyKey: "grant-1"}

const refused = (value: unknown) => {
  const check = checkLicenseGrantRequest(value)
  return check.ok ? null : check.description
}

describe("checkLicenseGrantRequest", () => {
  test("answers the request as it is forwarded: trimmed, the end in UTC whole seconds, a blank note as none", () => {
    expect(checkLicenseGrantRequest(valid)).toEqual({
      ok: true,
      request: {product: "mentra.call.unlimited", seats: 2, endsAt: "2027-11-17T00:00:00Z", note: "pilot", idempotencyKey: "grant-1"},
    })
    const offset = checkLicenseGrantRequest({...valid, endsAt: "2027-11-17T01:30:15.987+01:00", note: "  "})
    expect(offset).toEqual({ok: true, request: expect.objectContaining({endsAt: "2027-11-17T00:30:15Z", note: null})})
    // A date alone is the start of that day in UTC.
    expect(checkLicenseGrantRequest({...valid, endsAt: "2027-11-17", note: undefined})).toEqual({
      ok: true,
      request: expect.objectContaining({endsAt: "2027-11-17T00:00:00Z", note: null}),
    })
  })

  test("seats are a whole number from 1 to 1000", () => {
    for (const seats of [0, -1, 1.5, 1001, "2", null, undefined, Number.NaN]) expect(refused({...valid, seats})).toContain("seats")
    for (const seats of [LICENSE_GRANT_LIMITS.minSeats, LICENSE_GRANT_LIMITS.maxSeats]) expect(refused({...valid, seats})).toBeNull()
  })

  test("says nothing of when the end is: a repeat of a grant answers it however near or past its end", () => {
    for (const endsAt of [new Date(NOW - 365 * DAY).toISOString(), new Date(NOW + 60_000).toISOString(), "2031-01-01"]) {
      expect(refused({...valid, endsAt})).toBeNull()
    }
  })

  test("the end is a real time with its offset, or a date: never a guess", () => {
    for (const endsAt of ["2027-02-29", "2027-02-31T00:00:00Z", "2027-11-17T24:00:00Z", "2027-11-17T00:00:00", "17/11/2027", "next year", 1826496000, null]) {
      expect(refused({...valid, endsAt})).toContain("endsAt must be")
    }
    expect(refused({...valid, endsAt: "2028-02-29"})).toBeNull()
  })

  test("the product is a product key, the note at most 500 characters, and the idempotency key required", () => {
    for (const product of ["", " ", "Mentra Call", "../x", 7, undefined]) expect(refused({...valid, product})).toContain("product")
    expect(refused({...valid, note: 5})).toBe("note must be a string")
    expect(refused({...valid, note: "x".repeat(501)})).toBe("note must be at most 500 characters")
    expect(refused({...valid, note: `  ${"x".repeat(500)}  `})).toBeNull()
    for (const idempotencyKey of [undefined, "", "has space", "é", "x".repeat(201)]) {
      expect(refused({...valid, idempotencyKey})).toContain("idempotency key")
    }
    for (const value of [null, [], "grant"]) expect(refused(value)).toBe("the request must be a JSON object")
  })

  test("other fields are not forwarded", () => {
    const check = checkLicenseGrantRequest({...valid, grantedBy: "someone else", customer: "cus_x"})
    expect(check.ok && Object.keys(check.request).sort()).toEqual(["endsAt", "idempotencyKey", "note", "product", "seats"])
  })
})

describe("licenseGrantEndProblem", () => {
  test("a new grant ends at least an hour and at most 730 days away", () => {
    const tooSoon: LicenseGrantEndProblem = {kind: "too_soon", description: "endsAt must be at least an hour from now"}
    expect(licenseGrantEndProblem(NOW - 1000, NOW)).toEqual(tooSoon)
    expect(licenseGrantEndProblem(NOW + 59 * 60_000, NOW)).toEqual(tooSoon)
    expect(licenseGrantEndProblem(NOW + 60 * 60_000, NOW)).toBeNull()
    expect(licenseGrantEndProblem(NOW + 730 * DAY, NOW)).toBeNull()
    expect(licenseGrantEndProblem(NOW + 730 * DAY + 1000, NOW)).toEqual({kind: "too_late", description: "endsAt must be at most 730 days from now"})
  })
})

describe("the parts", () => {
  test("parseLicenseGrantEnd reads offsets both ways and refuses impossible clocks", () => {
    expect(parseLicenseGrantEnd("2027-11-17T00:00:00-05:30")).toBe(Date.UTC(2027, 10, 17, 5, 30))
    expect(parseLicenseGrantEnd("2027-11-17T00:00Z")).toBe(Date.UTC(2027, 10, 17))
    expect(parseLicenseGrantEnd("2027-11-17T23:60:00Z")).toBeNull()
    expect(parseLicenseGrantEnd("2027-11-17T00:00:00+24:00")).toBeNull()
  })

  test("licenseGrantTime is UTC in whole seconds", () => {
    expect(licenseGrantTime(Date.UTC(2027, 10, 17, 0, 0, 0, 999))).toBe("2027-11-17T00:00:00Z")
  })

  test("isLicenseGrantIdempotencyKey takes visible ASCII only", () => {
    expect(isLicenseGrantIdempotencyKey("pilot-2026-11-17_a:b")).toBe(true)
    expect(isLicenseGrantIdempotencyKey("tab\there")).toBe(false)
  })

  test("isLicenseGrantProduct takes a product key as a grant checks it, and nothing a path could misread", () => {
    for (const product of ["mentra.call.unlimited", "a", "9lives", "mentra_call-2", `m${"x".repeat(99)}`]) {
      expect(isLicenseGrantProduct(product)).toBe(true)
      expect(checkLicenseGrantRequest({...valid, product}).ok).toBe(true)
    }
    for (const product of ["", " ", ".", "..", ".hidden", "-x", "Mentra.Call", "mentra call", "mentra/call", "mentra%2Ecall", " mentra.call.unlimited", `m${"x".repeat(100)}`, 7, null, undefined]) {
      expect(isLicenseGrantProduct(product)).toBe(false)
    }
  })

  test("checkLicenseGrantNote trims, takes at most 500 characters, and reads a blank or missing note as none", () => {
    expect(checkLicenseGrantNote("  Sold to another reseller  ")).toEqual({ok: true, note: "Sold to another reseller"})
    for (const none of [undefined, null, "", "   "]) expect(checkLicenseGrantNote(none)).toEqual({ok: true, note: null})
    expect(checkLicenseGrantNote(`  ${"x".repeat(500)}  `)).toEqual({ok: true, note: "x".repeat(500)})
    expect(checkLicenseGrantNote("x".repeat(501))).toEqual({ok: false, description: "note must be at most 500 characters"})
    for (const value of [5, {}, ["note"], true]) expect(checkLicenseGrantNote(value)).toEqual({ok: false, description: "note must be a string"})
  })
})

describe("parseLicenseGrant", () => {
  const grant: LicenseGrant = {
    workspaceId: "ws_1",
    product: "mentra.call.unlimited",
    seats: 2,
    endsAt: "2027-11-17T00:00:00Z",
    status: "trialing",
    subscriptionId: "sub_1",
    licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
    replayed: false,
  }

  test("keeps the documented fields only", () => {
    expect(parseLicenseGrant({...grant, extra: 1})).toEqual(grant)
    expect(parseLicenseGrant({...grant, licenseId: null})).toEqual({...grant, licenseId: null})
  })

  test("refuses a grant that is missing a field or has one of the wrong type", () => {
    for (const broken of [
      {...grant, workspaceId: ""},
      {...grant, seats: "2"},
      {...grant, endsAt: "soon"},
      {...grant, licenseId: undefined},
      {...grant, replayed: "no"},
      {...grant, subscriptionId: null},
      null,
      [grant],
    ]) {
      expect(parseLicenseGrant(broken)).toBeNull()
    }
  })
})

describe("parseLicenseGrantEnded", () => {
  const ended: LicenseGrantEnded = {
    workspaceId: "ws_1",
    product: "mentra.call.unlimited",
    subscriptionId: "sub_1",
    licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RD",
    endedAt: "2026-11-17T12:00:00Z",
  }

  test("keeps the documented fields only", () => {
    expect(parseLicenseGrantEnded({...ended, seats: 2, status: "canceled"})).toEqual(ended)
    expect(parseLicenseGrantEnded({...ended, licenseId: null})).toEqual({...ended, licenseId: null})
  })

  test("refuses an answer that is missing a field or has one of the wrong type", () => {
    for (const broken of [
      {...ended, workspaceId: ""},
      {...ended, product: "Mentra Call"},
      {...ended, product: undefined},
      {...ended, subscriptionId: null},
      {...ended, licenseId: undefined},
      {...ended, licenseId: ""},
      {...ended, endedAt: "just now"},
      {...ended, endedAt: 1794916800},
      {error: "grant_not_found"},
      null,
      [ended],
    ]) {
      expect(parseLicenseGrantEnded(broken)).toBeNull()
    }
  })
})
