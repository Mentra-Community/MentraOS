import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {assertSupabaseApiKeys, deleteUser, supabaseApiKeyFormat, verifyPassword} from "./gotrue.client"

const LEGACY_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl"
const LEGACY_SERVICE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl"
const KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const

let saved: Record<string, string | undefined>
let realFetch: typeof fetch
let seen: Headers[]

function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response(body === undefined ? null : JSON.stringify(body), {status})
  }) as typeof fetch
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  realFetch = globalThis.fetch
  seen = []
  process.env.SUPABASE_URL = "https://auth.example.test"
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const confirmedUser = {user: {id: "u1", email: "a@b.co", email_confirmed_at: "2026-01-01T00:00:00Z"}}

describe("Supabase API key headers", () => {
  test("a legacy anon key goes in apikey and Authorization, as before", async () => {
    process.env.SUPABASE_ANON_KEY = LEGACY_ANON
    respondWith(200, confirmedUser)
    await verifyPassword("a@b.co", "pw")
    expect(seen[0]!.get("apikey")).toBe(LEGACY_ANON)
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${LEGACY_ANON}`)
  })

  test("a publishable key goes only in apikey", async () => {
    process.env.SUPABASE_ANON_KEY = "sb_publishable_test"
    respondWith(200, confirmedUser)
    await verifyPassword("a@b.co", "pw")
    expect(seen[0]!.get("apikey")).toBe("sb_publishable_test")
    expect(seen[0]!.has("authorization")).toBe(false)
  })

  test("a secret key reaches the admin API in apikey only", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test"
    respondWith(204, undefined)
    await deleteUser("u1")
    expect(seen[0]!.get("apikey")).toBe("sb_secret_test")
    expect(seen[0]!.has("authorization")).toBe(false)
  })

  test("a legacy service key still sends Authorization for the admin API", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SERVICE
    respondWith(204, undefined)
    await deleteUser("u1")
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${LEGACY_SERVICE}`)
  })
})

describe("supabaseApiKeyFormat", () => {
  test("recognizes each key format", () => {
    expect(supabaseApiKeyFormat("sb_publishable_x")).toBe("publishable")
    expect(supabaseApiKeyFormat("sb_secret_x")).toBe("secret")
    expect(supabaseApiKeyFormat(LEGACY_ANON)).toBe("legacy_jwt")
  })
})

describe("assertSupabaseApiKeys", () => {
  test("accepts legacy keys, new keys, a mixed pair, and unset keys", () => {
    expect(() =>
      assertSupabaseApiKeys({SUPABASE_ANON_KEY: LEGACY_ANON, SUPABASE_SERVICE_ROLE_KEY: LEGACY_SERVICE}),
    ).not.toThrow()
    expect(() =>
      assertSupabaseApiKeys({SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x"}),
    ).not.toThrow()
    expect(() =>
      assertSupabaseApiKeys({SUPABASE_ANON_KEY: LEGACY_ANON, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x"}),
    ).not.toThrow()
    expect(() => assertSupabaseApiKeys({})).not.toThrow()
  })

  test("refuses a secret key in the anon slot", () => {
    expect(() => assertSupabaseApiKeys({SUPABASE_ANON_KEY: "sb_secret_x"})).toThrow(/SUPABASE_ANON_KEY/)
  })

  test("refuses a publishable key in the service slot", () => {
    expect(() => assertSupabaseApiKeys({SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_x"})).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    )
  })
})
