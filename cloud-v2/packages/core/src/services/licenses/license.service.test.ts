/**
 * The license service's checks that need no database: what a license write must look like, and why a
 * seat is released when its membership ends. Everything that reads or writes licenses and seats is in
 * `cloud-v2/tests/licenses.integration.test.ts`, against a local replica set.
 */
import {describe, expect, test} from "bun:test"
import type {LicenseWrite} from "@mentra/workspace-contract"
import {WorkspaceError} from "../workspaces/workspace-error"
import {parseLicenseWrite, seatReleaseReasonFor} from "./license.service"

const LICENSE_ID = "01JZWY3V8N0F2E9GQ4T6KXH5RD"

const workspaceWrite = (): LicenseWrite => ({
  licenseId: LICENSE_ID,
  revision: 1,
  owner: {type: "workspace", workspaceId: "ws_1"},
  product: "mentra.call.unlimited",
  features: [{key: "call.unlimited", packages: ["com.mentra.call"]}],
  quantity: 5,
  validFrom: "2026-10-01T00:00:00.000Z",
  paidThrough: "2026-11-04T00:00:00Z",
})

const personWrite = (): LicenseWrite => ({
  ...workspaceWrite(),
  owner: {type: "person", mentraUserId: "mu_1"},
  quantity: 1,
})

/** The 400 a malformed write gets: `invalid_request`, saying what is wrong. */
function refused(body: unknown, licenseId = LICENSE_ID): WorkspaceError {
  try {
    parseLicenseWrite(body, licenseId)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError)
    expect((error as WorkspaceError).code).toBe("invalid_request")
    expect((error as WorkspaceError).status).toBe(400)
    return error as WorkspaceError
  }
  throw new Error(`accepted ${JSON.stringify(body)}`)
}

describe("parseLicenseWrite", () => {
  test("accepts a workspace and a personal license, keeping only the write's own fields", () => {
    expect(parseLicenseWrite({...workspaceWrite(), extra: "ignored"}, LICENSE_ID)).toEqual(workspaceWrite())
    expect(parseLicenseWrite(personWrite(), LICENSE_ID)).toEqual(personWrite())
    // A feature for no package is a service's feature.
    const service = {...workspaceWrite(), features: [{key: "fleet.managed", packages: []}]}
    expect(parseLicenseWrite(service, LICENSE_ID)).toEqual(service)
    // A workspace license may have no seats to give (a subscription item of quantity 0).
    expect(parseLicenseWrite({...workspaceWrite(), quantity: 0}, LICENSE_ID).quantity).toBe(0)
  })

  test("a person holds exactly one seat: a personal write with quantity 2 is refused", () => {
    expect(refused({...personWrite(), quantity: 2}).message).toContain("quantity")
    refused({...personWrite(), quantity: 0})
  })

  test("the license id is the path's, a ULID", () => {
    refused({...workspaceWrite(), licenseId: "01JZWY3V8N0F2E9GQ4T6KXH5RE"})
    refused({...workspaceWrite(), licenseId: "lic_1"}, "lic_1")
    refused({...workspaceWrite(), licenseId: LICENSE_ID.toLowerCase()}, LICENSE_ID.toLowerCase())
    refused({...workspaceWrite(), licenseId: undefined})
  })

  test("the revision is a whole number above zero", () => {
    for (const revision of [0, -1, 1.5, "2", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      refused({...workspaceWrite(), revision})
    }
  })

  test("the owner is a workspace or a person, named by a non-blank id", () => {
    for (const owner of [
      undefined,
      null,
      "ws_1",
      {type: "workspace"},
      {type: "workspace", workspaceId: "  "},
      {type: "workspace", mentraUserId: "mu_1"},
      {type: "person"},
      {type: "person", workspaceId: "ws_1"},
      {type: "organization", organizationId: "org_1"},
    ]) {
      refused({...workspaceWrite(), owner})
    }
  })

  test("the product is named, and every feature has a key and a list of packages", () => {
    refused({...workspaceWrite(), product: ""})
    refused({...workspaceWrite(), product: 5})
    for (const features of [
      undefined,
      {},
      [{}],
      [{key: ""}],
      [{key: "call.unlimited"}],
      [{key: "call.unlimited", packages: [5]}],
      [{key: "call.unlimited", packages: [""]}],
    ]) {
      refused({...workspaceWrite(), features})
    }
  })

  test("quantity is a whole number of zero or more", () => {
    for (const quantity of [-1, 1.5, "5", undefined]) refused({...workspaceWrite(), quantity})
  })

  test("the term's times are RFC 3339 instants in UTC that exist on the calendar", () => {
    for (const time of [
      "2026-10-01",
      "2026-10-01T00:00:00",
      "2026-10-01T00:00:00+02:00",
      "2026-10-01 00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-10-01T24:00:00Z",
      "1730000000",
      1730000000,
    ]) {
      refused({...workspaceWrite(), validFrom: time})
      refused({...workspaceWrite(), paidThrough: time})
    }
  })

  test("a body that is not an object is refused", () => {
    for (const body of [null, [], "license", 5]) refused(body)
  })
})

describe("seatReleaseReasonFor", () => {
  test("names why a membership's seats are freed: removed, left or its account deleted", () => {
    expect(seatReleaseReasonFor("removed")).toBe("member_removed")
    expect(seatReleaseReasonFor("left")).toBe("member_left")
    expect(seatReleaseReasonFor("account_deleted")).toBe("account_deleted")
  })
})
