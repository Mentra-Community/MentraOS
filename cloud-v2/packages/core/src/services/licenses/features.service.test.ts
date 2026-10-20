import {afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"

import {LicenseSeatModel} from "../../models/license-seat.model"
import {LicenseModel} from "../../models/license.model"
import {featuresFor} from "./features.service"

/**
 * The query logic with the collections stubbed: which licenses are asked for, how their features are
 * filtered by package and combined. The real collections, the term rules and the token are in
 * `tests/license-features.integration.test.ts`.
 */

const CALL = "com.mentra.call"
const NOW = new Date("2026-10-20T12:00:00.000Z")

interface Stubbed {
  /** The personal licenses `find` answers for the person. */
  personal: Array<{features: Array<{key: string; packages: string[]}>}>
  /** The ids of the licenses the person holds a seat in. */
  seatLicenseIds: string[]
  /** The licenses `find` answers for those ids. */
  seated: Array<{features: Array<{key: string; packages: string[]}>}>
}

let licenseFilters: Array<Record<string, unknown>> = []
let seatFilters: Array<Record<string, unknown>> = []
const mocks: Array<{mockRestore(): void}> = []
const savedFeatures = process.env.CLOUD_CORE_ENABLED_FEATURES

function stub(rows: Partial<Stubbed> = {}) {
  const {personal = [], seatLicenseIds = [], seated = []} = rows
  mocks.push(
    spyOn(LicenseModel, "find").mockImplementation(((filter: Record<string, unknown>) => {
      licenseFilters.push(filter)
      return {lean: async () => ("_id" in filter ? seated : personal)}
    }) as never),
    spyOn(LicenseSeatModel, "find").mockImplementation(((filter: Record<string, unknown>) => {
      seatFilters.push(filter)
      return {lean: async () => seatLicenseIds.map((licenseId) => ({licenseId}))}
    }) as never),
  )
}

beforeEach(() => {
  licenseFilters = []
  seatFilters = []
  delete process.env.CLOUD_CORE_ENABLED_FEATURES
})

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
  if (savedFeatures === undefined) delete process.env.CLOUD_CORE_ENABLED_FEATURES
  else process.env.CLOUD_CORE_ENABLED_FEATURES = savedFeatures
})

const lookup = (packageName = CALL) => featuresFor({mentraUserId: "mu_01TEST", packageName, now: NOW})

describe("featuresFor", () => {
  test("a person with no license and no setting has no feature", async () => {
    stub()
    expect(await lookup()).toEqual([])
  })

  test("returns the sorted, unique keys of a person's own licenses and seats for the package", async () => {
    stub({
      personal: [
        {features: [{key: "call.unlimited", packages: [CALL]}]},
        {
          features: [
            {key: "call.transcripts", packages: [CALL]},
            {key: "call.unlimited", packages: [CALL]},
          ],
        },
      ],
      seatLicenseIds: ["01LICENSEAAAAAAAAAAAAAAAAA"],
      seated: [{features: [{key: "call.recording", packages: [CALL, "com.example.dialer"]}]}],
    })
    expect(await lookup()).toEqual(["call.recording", "call.transcripts", "call.unlimited"])
  })

  test("a feature reaches a package's token only when it lists that package", async () => {
    stub({
      personal: [
        {
          features: [
            {key: "call.unlimited", packages: [CALL]},
            {key: "notes.pro", packages: ["com.mentra.notes"]},
            {key: "service.only", packages: []},
          ],
        },
      ],
      seatLicenseIds: ["01LICENSEAAAAAAAAAAAAAAAAA"],
      seated: [{features: [{key: "seat.feature", packages: ["com.mentra.notes"]}]}],
    })
    expect(await lookup(CALL)).toEqual(["call.unlimited"])
    expect(await lookup("com.mentra.notes")).toEqual(["notes.pro", "seat.feature"])
    expect(await lookup("com.example.other")).toEqual([])
  })

  test("asks for personal licenses by owner and seats by person, in term and not ended", async () => {
    stub({seatLicenseIds: ["01LICENSEAAAAAAAAAAAAAAAAA", "01LICENSEBBBBBBBBBBBBBBBBB"]})
    await lookup()

    const inTerm = {endedAt: null, validFrom: {$lte: NOW}, paidThrough: {$gt: NOW}}
    expect(seatFilters).toEqual([{mentraUserId: "mu_01TEST"}])
    expect(licenseFilters).toContainEqual({
      "owner.type": "person",
      "owner.mentraUserId": "mu_01TEST",
      ...inTerm,
    })
    expect(licenseFilters).toContainEqual({
      _id: {$in: ["01LICENSEAAAAAAAAAAAAAAAAA", "01LICENSEBBBBBBBBBBBBBBBBB"]},
      ...inTerm,
    })
    expect(licenseFilters).toHaveLength(2)
  })

  test("a person with no seat costs no query for seated licenses", async () => {
    stub()
    await lookup()
    expect(licenseFilters).toHaveLength(1)
    expect(licenseFilters[0]!["owner.type"]).toBe("person")
  })

  describe("CLOUD_CORE_ENABLED_FEATURES", () => {
    test("grants an entry's feature in the listed packages' tokens only, with no license", async () => {
      process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited:com.mentra.call"
      stub()
      expect(await lookup(CALL)).toEqual(["call.unlimited"])
      expect(await lookup("com.example.other")).toEqual([])
    })

    test("an entry without packages reaches no token", async () => {
      process.env.CLOUD_CORE_ENABLED_FEATURES = "fleet.managed, call.unlimited"
      stub()
      expect(await lookup(CALL)).toEqual([])
    })

    test("is unioned with licenses, each key once, sorted", async () => {
      process.env.CLOUD_CORE_ENABLED_FEATURES =
        "call.unlimited:com.mentra.call+com.example.dialer, a.first:com.mentra.call"
      stub({
        personal: [
          {
            features: [
              {key: "call.unlimited", packages: [CALL]},
              {key: "call.extra", packages: [CALL]},
            ],
          },
        ],
      })
      expect(await lookup()).toEqual(["a.first", "call.extra", "call.unlimited"])
    })

    test("still reads the database, so a failure is never hidden by a configured grant", async () => {
      process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited:com.mentra.call"
      mocks.push(
        spyOn(LicenseSeatModel, "find").mockImplementation((() => ({lean: async () => []})) as never),
        spyOn(LicenseModel, "find").mockImplementation((() => ({
          lean: () => Promise.reject(new Error("mongo down")),
        })) as never),
      )
      await expect(lookup()).rejects.toThrow("mongo down")
    })
  })

  describe("a lookup that fails", () => {
    test("rejects when the personal licenses cannot be read", async () => {
      mocks.push(
        spyOn(LicenseSeatModel, "find").mockImplementation((() => ({lean: async () => []})) as never),
        spyOn(LicenseModel, "find").mockImplementation((() => ({
          lean: () => Promise.reject(new Error("mongo down")),
        })) as never),
      )
      await expect(lookup()).rejects.toThrow("mongo down")
    })

    test("rejects when the seats cannot be read", async () => {
      mocks.push(
        spyOn(LicenseSeatModel, "find").mockImplementation((() => ({
          lean: () => Promise.reject(new Error("mongo down")),
        })) as never),
        spyOn(LicenseModel, "find").mockImplementation((() => ({lean: async () => []})) as never),
      )
      await expect(lookup()).rejects.toThrow("mongo down")
    })

    test("rejects when the seated licenses cannot be read, rather than answering with the personal ones", async () => {
      mocks.push(
        spyOn(LicenseSeatModel, "find").mockImplementation((() => ({
          lean: async () => [{licenseId: "01LICENSEAAAAAAAAAAAAAAAAA"}],
        })) as never),
        spyOn(LicenseModel, "find").mockImplementation(((filter: Record<string, unknown>) => ({
          lean: () =>
            "_id" in filter
              ? Promise.reject(new Error("mongo down"))
              : Promise.resolve([{features: [{key: "call.unlimited", packages: [CALL]}]}]),
        })) as never),
      )
      await expect(lookup()).rejects.toThrow("mongo down")
    })
  })
})
