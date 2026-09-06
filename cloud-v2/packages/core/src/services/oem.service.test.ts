import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import * as jose from "jose"

import {resetOidcVerifierCache} from "@mentra/cloud-shared"
import {InvalidGrant} from "../types/oauth.types"
import {isConfiguredOidcTenant, verifyTenantJwt} from "./oem.service"

const ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0"
const JWKS_URL = "https://login.microsoftonline.com/tenant-1/discovery/v2.0/keys"
const AUDIENCE = "core-api-client-id"
const MOBILE_CLIENT_ID = "mobile-client-id"
const savedProviders = process.env.CLOUD_CORE_OIDC_PROVIDERS
const savedFetch = globalThis.fetch

let privateKey: jose.KeyLike

beforeEach(async () => {
  const pair = await jose.generateKeyPair("RS256", {extractable: true})
  privateKey = pair.privateKey
  const publicJwk = await jose.exportJWK(pair.publicKey)
  globalThis.fetch = (async (input) => {
    expect(String(input)).toBe(JWKS_URL)
    return new Response(JSON.stringify({keys: [{...publicJwk, alg: "RS256", kid: "test-key", use: "sig"}]}), {
      headers: {"Content-Type": "application/json"},
    })
  }) as typeof fetch
  process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify([
    {
      id: "workforce",
      protocol: "oidc",
      providerKind: "microsoft-entra",
      tenantId: "acme-private",
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      audience: AUDIENCE,
      subjectClaim: "oid",
      directoryTenantClaim: "tid",
      expectedDirectoryTenantId: "tenant-1",
      requiredScopes: ["mentra.session"],
      allowedClientIds: [MOBILE_CLIENT_ID],
    },
  ])
  resetOidcVerifierCache()
})

afterEach(() => {
  if (savedProviders === undefined) delete process.env.CLOUD_CORE_OIDC_PROVIDERS
  else process.env.CLOUD_CORE_OIDC_PROVIDERS = savedProviders
  globalThis.fetch = savedFetch
  resetOidcVerifierCache()
})

describe("configured workforce OIDC", () => {
  test("maps a verified Entra identity into the generic tenant contract", async () => {
    const token = await workforceToken()

    await expect(verifyTenantJwt(token)).resolves.toMatchObject({
      tenantId: "acme-private",
      tenantUserId: "employee-object-id",
      federatedIdentity: {
        providerId: "workforce",
        providerKind: "microsoft-entra",
        issuer: ISSUER,
        subject: "employee-object-id",
        directoryTenantId: "tenant-1",
      },
    })
    expect(isConfiguredOidcTenant("acme-private")).toBe(true)
  })

  test("rejects tokens from an unapproved mobile client", async () => {
    const token = await workforceToken({azp: "different-client"})

    await expect(verifyTenantJwt(token)).rejects.toBeInstanceOf(InvalidGrant)
  })

  test("rejects tokens without the Core session scope", async () => {
    const token = await workforceToken({scp: "other.scope"})

    await expect(verifyTenantJwt(token)).rejects.toBeInstanceOf(InvalidGrant)
  })

  test("rejects a configured symmetric OIDC algorithm", async () => {
    const providers = JSON.parse(process.env.CLOUD_CORE_OIDC_PROVIDERS!)
    providers[0].algorithms = ["HS256"]
    process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify(providers)

    await expect(verifyTenantJwt(await workforceToken())).rejects.toThrow(
      "OIDC algorithms must use EdDSA, RS256, or ES256",
    )
  })

  test("rejects the reserved Mentra tenant namespace", () => {
    const providers = JSON.parse(process.env.CLOUD_CORE_OIDC_PROVIDERS!)
    providers[0].tenantId = "mentra"
    process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify(providers)

    expect(() => isConfiguredOidcTenant("mentra")).toThrow("tenantId is reserved")
  })

  test("treats an explicitly empty client allowlist as deny-all", async () => {
    const providers = JSON.parse(process.env.CLOUD_CORE_OIDC_PROVIDERS!)
    providers[0].allowedClientIds = []
    process.env.CLOUD_CORE_OIDC_PROVIDERS = JSON.stringify(providers)

    await expect(verifyTenantJwt(await workforceToken())).rejects.toThrow("client is not allowed")
  })
})

async function workforceToken(overrides: Record<string, unknown> = {}): Promise<string> {
  return new jose.SignJWT({
    oid: "employee-object-id",
    tid: "tenant-1",
    azp: MOBILE_CLIENT_ID,
    scp: "mentra.session",
    ...overrides,
  })
    .setProtectedHeader({alg: "RS256", kid: "test-key"})
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey)
}
