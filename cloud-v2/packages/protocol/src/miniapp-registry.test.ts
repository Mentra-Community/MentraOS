import {describe, expect, test} from "bun:test"
import {
  MINIAPP_REGISTRY_STATUS_MAX_ENTRIES,
  RegistryRegisterRequestSchema,
  RegistryRegisterResponseSchema,
  RegistryStatusRequestSchema,
  RegistryStatusResponseSchema,
} from "./miniapp-registry"

const entry = {
  url: "https://notes.example.com/",
  packageName: "com.example.notes",
  registrableDomain: "example.com",
  name: "Notes",
  version: "1.0.0",
  ageRating: "4+",
  iconUrl: null,
  verification: "verified",
  private: false,
  status: "active",
  firstRegisteredAt: "2026-10-24T08:00:00.000Z",
  lastVerifiedAt: null,
}

const manifest = {
  packageName: "com.example.notes",
  version: "1.0.0",
  name: "Notes",
  bundle: {url: "com.example.notes-1.0.0.zip", sha256: "AB".repeat(32)},
}

describe("the register request", () => {
  test("takes a URL and an optional report", () => {
    expect(RegistryRegisterRequestSchema.safeParse({url: "https://notes.example.com/"}).success).toBe(true)
    const withReport = {
      url: "https://notes.example.com/",
      reported: {packageName: "com.example.notes", name: "Notes", version: "1.4.2-beta.1", ageRating: "13+"},
    }
    expect(RegistryRegisterRequestSchema.parse(withReport)).toEqual(withReport as never)
    const unrated = {url: "https://notes.example.com/", reported: {packageName: "com.example.notes", name: "Notes", version: "1.0.0", ageRating: null}}
    expect(RegistryRegisterRequestSchema.safeParse(unrated).success).toBe(true)
  })

  test("refuses a report Core couldn't keep", () => {
    for (const reported of [
      {packageName: "Notes", name: "Notes", version: "1.0.0"},
      {packageName: "com.example.notes", name: "  ", version: "1.0.0"},
      {packageName: "com.example.notes", name: "Notes", version: "1.0"},
      {packageName: "com.example.notes", name: "Notes", version: "1.0.0", ageRating: "12+"},
      {packageName: "com.example.notes", name: "x".repeat(501), version: "1.0.0"},
    ]) {
      expect({reported, ok: RegistryRegisterRequestSchema.safeParse({url: "https://a.example.com/", reported}).success}).toEqual({
        reported,
        ok: false,
      })
    }
    expect(RegistryRegisterRequestSchema.safeParse({url: ""}).success).toBe(false)
    expect(RegistryRegisterRequestSchema.safeParse({url: `https://a.example.com/${"x".repeat(2048)}`}).success).toBe(false)
  })
})

describe("the register answer", () => {
  test("reads each result", () => {
    for (const answer of [
      {result: "accepted", entry, manifest},
      {result: "accepted_unverified", entry: {...entry, verification: "phone_reported"}},
      {result: "not_a_miniapp", reason: "local_network_url"},
      {result: "archived"},
    ]) {
      expect({answer, ok: RegistryRegisterResponseSchema.safeParse(answer).success}).toEqual({answer, ok: true})
    }
  })

  test("keeps only the fields it names, so a later Core can add some", () => {
    const parsed = RegistryRegisterResponseSchema.parse({result: "accepted_unverified", entry: {...entry, extra: 1}, note: "x"})
    expect(parsed).toEqual({result: "accepted_unverified", entry} as never)
  })

  test("refuses an unknown result, reason or verification", () => {
    for (const answer of [
      {result: "pending"},
      {result: "not_a_miniapp", reason: "too_big"},
      {result: "accepted_unverified", entry: {...entry, verification: "crawled"}},
      {result: "accepted", entry},
    ]) {
      expect(RegistryRegisterResponseSchema.safeParse(answer).success).toBe(false)
    }
  })
})

describe("the status call", () => {
  test("takes at most 500 entries", () => {
    const entries = Array.from({length: MINIAPP_REGISTRY_STATUS_MAX_ENTRIES + 1}, (_, index) => ({
      url: `https://n${index}.example.com/`,
      version: "1.0.0",
    }))
    expect(RegistryStatusRequestSchema.safeParse({entries: entries.slice(1)}).success).toBe(true)
    expect(RegistryStatusRequestSchema.safeParse({entries}).success).toBe(false)
    expect(RegistryStatusRequestSchema.safeParse({entries: [{url: "https://a.example.com/"}]}).success).toBe(false)
  })

  test("answers active, archived or unknown with a positive lifetime", () => {
    const answer = {statuses: [{url: "https://a.example.com/", status: "archived"}], validForSeconds: 21600}
    expect(RegistryStatusResponseSchema.parse(answer)).toEqual(answer as never)
    expect(RegistryStatusResponseSchema.safeParse({...answer, validForSeconds: 0}).success).toBe(false)
    expect(RegistryStatusResponseSchema.safeParse({statuses: [{url: "x", status: "paused"}], validForSeconds: 1}).success).toBe(false)
  })
})
