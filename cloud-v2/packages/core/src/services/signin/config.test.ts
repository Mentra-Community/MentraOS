import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {
  assertSigninConfiguration,
  ConfigurationError,
  findProviderBySourceId,
  isSourceEnabled,
  portalIdentityProvider,
  supabaseProvider,
  webClientIds,
} from "./config"

const ENV_KEYS = [
  "CLOUD_CORE_OIDC_PROVIDERS",
  "CLOUD_CORE_SUPABASE_ISSUER",
  "CLOUD_CORE_SUPABASE_JWKS_URL",
  "CLOUD_CORE_WEB_CLIENT_IDS",
  "CLOUD_CORE_ADMIN_PORTAL_URL",
  "CLOUD_CORE_ENTERPRISE_PORTAL_URL",
  "CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID",
  "CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID",
  "CLOUD_CORE_IDP_SIGNOUT_URL",
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
  "SUPABASE_URL",
  "ENTRA_BROWSER_CLIENT_SECRET",
] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

function entra(overrides: Record<string, unknown> = {}) {
  return {
    id: "entra",
    protocol: "oidc",
    providerKind: "microsoft-entra",
    tenantId: "contoso",
    issuer: "https://login.microsoftonline.com/t/v2.0",
    jwksUrl: "https://login.microsoftonline.com/t/discovery/v2.0/keys",
    audience: "core-api",
    subjectClaim: "oid",
    directoryTenantClaim: "tid",
    expectedDirectoryTenantId: "t",
    verifiedEmailDomains: ["contoso.com"],
    browser: {
      clientId: "core-api",
      clientSecretEnv: "ENTRA_BROWSER_CLIENT_SECRET",
      scopes: ["openid", "email", "profile"],
      emailClaim: "email",
      displayName: "Contoso",
    },
    ...overrides,
  }
}

function providers(...list: unknown[]) {
  process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify(list)
}

async function refusal(): Promise<string> {
  try {
    await assertSigninConfiguration({skipDatabase: true})
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigurationError)
    return (err as Error).message
  }
  throw new Error("expected assertSigninConfiguration to refuse")
}

describe("valid configurations", () => {
  test("nothing configured: Core starts and portal sign-in is not configured", async () => {
    await assertSigninConfiguration({skipDatabase: true})
    expect(supabaseProvider()).toBeNull()
    expect(() => portalIdentityProvider()).toThrow(ConfigurationError)
  })

  test("a valid hosted configuration", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    process.env.SUPABASE_URL = "https://auth.mentra.glass"
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1/"
    process.env.CLOUD_CORE_WEB_CLIENT_IDS = " admin-client , portal-client ,"
    process.env.CLOUD_CORE_ADMIN_PORTAL_URL = "https://admin.mentraglass.com"
    process.env.CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID = "admin-client"
    process.env.CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID = "portal-client"
    await assertSigninConfiguration({skipDatabase: true})
    const provider = portalIdentityProvider()
    expect(provider.kind).toBe("supabase")
    expect(provider.issuer).toBe("https://ref.supabase.co/auth/v1")
    expect(provider.jwksUrl).toBe("https://auth.mentra.glass/auth/v1/.well-known/jwks.json")
    expect([...webClientIds()]).toEqual(["admin-client", "portal-client"])
    expect(isSourceEnabled("mentra", "mentra")).toBe(true)
  })

  test("CLOUD_CORE_SUPABASE_JWKS_URL overrides the derived key set", () => {
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1"
    process.env.CLOUD_CORE_SUPABASE_JWKS_URL = "https://keys.example/jwks.json"
    expect(supabaseProvider()?.jwksUrl).toBe("https://keys.example/jwks.json")
  })

  test("a valid Private Cloud configuration", async () => {
    process.env.ENTRA_BROWSER_CLIENT_SECRET = "secret"
    providers(entra())
    await assertSigninConfiguration({skipDatabase: true})
    const provider = portalIdentityProvider()
    expect(provider.kind).toBe("oidc_provider")
    expect(provider.tenantId).toBe("contoso")
    expect(provider.browser?.displayName).toBe("Contoso")
    expect(findProviderBySourceId("entra")?.subjectClaim).toBe("oid")
    expect(isSourceEnabled("contoso", "entra")).toBe(true)
    expect(isSourceEnabled("contoso", "other")).toBe(false)
    expect(isSourceEnabled("mentra", "mentra")).toBe(false)
  })

  test("a provider without browser settings needs no secret", async () => {
    providers(entra({browser: undefined}))
    await assertSigninConfiguration({skipDatabase: true})
    expect(() => portalIdentityProvider()).toThrow(ConfigurationError)
  })
})

describe("refusals name the field", () => {
  beforeEach(() => {
    process.env.ENTRA_BROWSER_CLIENT_SECRET = "secret"
  })

  test("browser without clientId", async () => {
    providers(entra({browser: {...entra().browser, clientId: ""}}))
    expect(await refusal()).toContain("browser.clientId")
  })

  test("browser without displayName", async () => {
    providers(entra({browser: {...entra().browser, displayName: undefined}}))
    expect(await refusal()).toContain("browser.displayName")
  })

  test("browser secret env unset", async () => {
    delete process.env.ENTRA_BROWSER_CLIENT_SECRET
    providers(entra())
    expect(await refusal()).toContain("ENTRA_BROWSER_CLIENT_SECRET")
  })

  test("scopes without openid", async () => {
    providers(entra({browser: {...entra().browser, scopes: ["email", "profile"]}}))
    expect(await refusal()).toContain("openid")
  })

  test.each([["Contoso.com"], ["contoso.com."], ["contosö.com"], ["contoso"]])("non-canonical domain %s", async domain => {
    providers(entra({verifiedEmailDomains: [domain]}))
    expect(await refusal()).toContain("verifiedEmailDomains")
  })

  test("duplicate domain", async () => {
    providers(entra({verifiedEmailDomains: ["contoso.com", "contoso.com"]}))
    expect(await refusal()).toContain("twice")
  })

  test("a domain listed by two providers", async () => {
    providers(
      entra(),
      entra({id: "second", tenantId: "second", issuer: "https://idp.second.example", browser: undefined}),
    )
    expect(await refusal()).toContain("also listed")
  })

  test.each([["mentra.glass"], ["mentraglass.com"], ["eng.mentra.glass"]])("Mentra domain %s", async domain => {
    providers(entra({verifiedEmailDomains: [domain]}))
    expect(await refusal()).toContain("Mentra domain")
  })

  test.each([["mentra"], ["workos"]])("reserved tenant %s", async tenantId => {
    providers(entra({tenantId}))
    expect(await refusal()).toContain("reserved")
  })

  test("more than one provider with browser settings", async () => {
    providers(
      entra(),
      entra({id: "second", tenantId: "second", issuer: "https://idp.second.example", verifiedEmailDomains: ["second.example"]}),
    )
    expect(await refusal()).toContain("at most one provider")
  })

  test("Supabase and a browser provider at once", async () => {
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1"
    providers(entra())
    expect(await refusal()).toContain("one identity provider")
  })

  test("an HTTP Supabase issuer on a deployed Core", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "staging"
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "http://ref.supabase.co/auth/v1"
    process.env.CLOUD_CORE_WEB_CLIENT_IDS = "admin"
    expect(await refusal()).toContain("CLOUD_CORE_SUPABASE_ISSUER")
  })

  test("an HTTP key set URL on a deployed Core", async () => {
    process.env.NODE_ENV = "production"
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1"
    process.env.CLOUD_CORE_SUPABASE_JWKS_URL = "http://keys.example/jwks.json"
    process.env.CLOUD_CORE_WEB_CLIENT_IDS = "admin"
    expect(await refusal()).toContain("CLOUD_CORE_SUPABASE_JWKS_URL")
  })

  test("a portal client missing from the web client IDs", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "dev"
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1"
    process.env.CLOUD_CORE_WEB_CLIENT_IDS = "admin-client"
    process.env.CLOUD_CORE_ADMIN_PORTAL_CLIENT_ID = "admin-client"
    process.env.CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID = "portal-client"
    expect(await refusal()).toContain("CLOUD_CORE_ENTERPRISE_PORTAL_CLIENT_ID")
  })

  test("no web client IDs while the issuer is set, on a deployed Core", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "dev"
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "https://ref.supabase.co/auth/v1"
    expect(await refusal()).toContain("CLOUD_CORE_WEB_CLIENT_IDS")
  })

  test("a local Core may use a loopback HTTP issuer", async () => {
    process.env.CLOUD_CORE_SUPABASE_ISSUER = "http://127.0.0.1:54321/auth/v1"
    await assertSigninConfiguration({skipDatabase: true})
  })

  test("an HTTP portal URL on a deployed Core", async () => {
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    process.env.CLOUD_CORE_ADMIN_PORTAL_URL = "http://admin.example"
    expect(await refusal()).toContain("CLOUD_CORE_ADMIN_PORTAL_URL")
  })

  test("malformed provider JSON", async () => {
    process.env.CLOUD_CORE_OIDC_PROVIDERS = "{not json"
    expect(await refusal()).toContain("CLOUD_CORE_OIDC_PROVIDERS")
  })
})
