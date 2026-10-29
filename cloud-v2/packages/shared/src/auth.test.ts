import crypto from "node:crypto"
import {afterEach, describe, expect, test} from "bun:test"
import * as jose from "jose"

import {
  resetMentraKeyCache,
  resetRuntimeAuthCache,
  signRuntimeToken,
  verifyAccessTokenSignature,
  verifyRuntimeToken,
} from "./auth"

const savedEnv = {
  MENTRA_JWT_PUBLIC_KEY: process.env.MENTRA_JWT_PUBLIC_KEY,
  CLOUD_CORE_ISSUER: process.env.CLOUD_CORE_ISSUER,
  CLOUD_RUNTIME_AUTH_AUDIENCE: process.env.CLOUD_RUNTIME_AUTH_AUDIENCE,
  CLOUD_RUNTIME_AUTH_ISSUERS: process.env.CLOUD_RUNTIME_AUTH_ISSUERS,
  TEST_RUNTIME_PUBLIC_KEY: process.env.TEST_RUNTIME_PUBLIC_KEY,
}

afterEach(() => {
  restoreEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", savedEnv.CLOUD_RUNTIME_AUTH_AUDIENCE)
  restoreEnv("CLOUD_RUNTIME_AUTH_ISSUERS", savedEnv.CLOUD_RUNTIME_AUTH_ISSUERS)
  restoreEnv("TEST_RUNTIME_PUBLIC_KEY", savedEnv.TEST_RUNTIME_PUBLIC_KEY)
  restoreEnv("MENTRA_JWT_PUBLIC_KEY", savedEnv.MENTRA_JWT_PUBLIC_KEY)
  restoreEnv("CLOUD_CORE_ISSUER", savedEnv.CLOUD_CORE_ISSUER)
  resetRuntimeAuthCache()
  resetMentraKeyCache()
})

// Core's signing key signs phone access tokens (kid mentra-access-1), runtime
// tokens and the sign-in server's tokens (kid mentra-oidc-1, typ at+jwt). Each
// verifier pins the key ID and type, not only the signature and claims.
describe("phone access token verification pins the key and type", () => {
  async function signWithCoreKey(privateKey: string, header: jose.JWTHeaderParameters, claims: jose.JWTPayload = {}) {
    const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`, "EdDSA")
    return new jose.SignJWT({tenant_id: "mentra", session_id: "sess_1", ...claims})
      .setProtectedHeader(header)
      .setIssuer("cloud-core")
      .setAudience("cloud-core")
      .setSubject("mu_1")
      .setJti("jti_1")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key)
  }

  function useCoreKey() {
    const keypair = createEd25519Keypair()
    process.env.MENTRA_JWT_PUBLIC_KEY = keypair.publicKey
    delete process.env.CLOUD_CORE_ISSUER
    resetMentraKeyCache()
    return keypair
  }

  test("a phone access token (kid mentra-access-1, no typ) verifies", async () => {
    const keypair = useCoreKey()
    const token = await signWithCoreKey(keypair.privateKey, {alg: "EdDSA", kid: "mentra-access-1"})
    await expect(verifyAccessTokenSignature(token)).resolves.toMatchObject({mentraUserId: "mu_1"})
  })

  test.each([
    ["the sign-in server's kid", {alg: "EdDSA", kid: "mentra-oidc-1"}],
    ["an at+jwt access token", {alg: "EdDSA", kid: "mentra-access-1", typ: "at+jwt"}],
    ["the runtime kid", {alg: "EdDSA", kid: "cloud-core-runtime-1"}],
    ["no kid", {alg: "EdDSA"}],
    // The header is caller-controlled JSON: a non-string typ is refused, never a TypeError.
    ["a numeric typ", {alg: "EdDSA", kid: "mentra-access-1", typ: 1}],
    ["an object typ", {alg: "EdDSA", kid: "mentra-access-1", typ: {}}],
  ])("a token with matching claims but %s is refused", async (_label, header) => {
    const keypair = useCoreKey()
    const token = await signWithCoreKey(keypair.privateKey, header as jose.JWTHeaderParameters)
    await expect(verifyAccessTokenSignature(token)).rejects.toThrow("not a Mentra access token")
  })
})

describe("runtime token verification pins the key and type", () => {
  function configure(extra: Record<string, unknown> = {}) {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {issuer: "test-runtime", publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY", userIdClaim: "sub", tenantIdClaim: "tenant_id", ...extra},
    ])
    return keypair
  }

  test.each(["mentra-oidc-1", "mentra-access-1", "mentra-miniapp-1", "mentra-account-1"])(
    "a token under Core's %s key ID is never a runtime token",
    async (kid) => {
      const keypair = configure()
      const token = await signRuntimeToken({privateKey: keypair.privateKey, issuer: "test-runtime", subject: "u", tenantId: "t", expiresInSeconds: 60, kid})
      await expect(verifyRuntimeToken(token)).rejects.toThrow("not a runtime token")
    },
  )

  test("a typed at+jwt token is refused", async () => {
    const keypair = configure()
    const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${keypair.privateKey}\n-----END PRIVATE KEY-----`, "EdDSA")
    const token = await new jose.SignJWT({tenant_id: "t"})
      .setProtectedHeader({alg: "EdDSA", kid: "cloud-core-runtime-1", typ: "at+jwt"})
      .setIssuer("test-runtime")
      .setAudience("cloud-runtime")
      .setSubject("u")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key)
    await expect(verifyRuntimeToken(token)).rejects.toThrow("not a runtime token")
  })

  test.each([1, {}])("a non-string typ (%p) is refused, never a TypeError", async (typ) => {
    const keypair = configure()
    const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${keypair.privateKey}\n-----END PRIVATE KEY-----`, "EdDSA")
    const token = await new jose.SignJWT({tenant_id: "t"})
      .setProtectedHeader({alg: "EdDSA", kid: "cloud-core-runtime-1", typ} as unknown as jose.JWTHeaderParameters)
      .setIssuer("test-runtime")
      .setAudience("cloud-runtime")
      .setSubject("u")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key)
    await expect(verifyRuntimeToken(token)).rejects.toThrow("not a runtime token")
  })

  test("an issuer's keyIds pin the key ID", async () => {
    const keypair = configure({keyIds: ["cloud-core-runtime-1"]})
    const sign = (kid: string) => signRuntimeToken({privateKey: keypair.privateKey, issuer: "test-runtime", subject: "u", tenantId: "t", expiresInSeconds: 60, kid})
    await expect(verifyRuntimeToken(await sign("cloud-core-runtime-1"))).resolves.toMatchObject({mentraUserId: "u"})
    await expect(verifyRuntimeToken(await sign("other-1"))).rejects.toThrow("unexpected key ID")
  })
})

describe("runtime token verification", () => {
  test("requires explicit runtime issuer config", async () => {
    delete process.env.CLOUD_RUNTIME_AUTH_ISSUERS

    await expect(verifyRuntimeToken("not-a-runtime-token")).rejects.toThrow("runtime auth issuer config is required")
  })

  test("accepts a configured cloud-runtime issuer", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        tenantIdClaim: "tenant_id",
      },
    ])

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "oem-1",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    })

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "oem-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
      exp: expect.any(Number),
    })
  })

  test("preserves a Core-attested federated workforce identity", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "https://core.workspace.example",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        tenantIdClaim: "tenant_id",
      },
    ])

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "https://core.workspace.example",
      subject: "mu_01TEST",
      tenantId: "acme-private",
      sessionId: "sess_01TEST",
      federatedIdentity: {
        providerId: "workforce",
        providerKind: "microsoft-entra",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
        subject: "employee-object-id",
        directoryTenantId: "tenant",
      },
      expiresInSeconds: 60,
    })

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "mu_01TEST",
      tenantId: "acme-private",
      sessionId: "sess_01TEST",
      jti: expect.any(String),
      exp: expect.any(Number),
      federatedIdentity: {
        providerId: "workforce",
        providerKind: "microsoft-entra",
        issuer: "https://login.microsoftonline.com/tenant/v2.0",
        subject: "employee-object-id",
        directoryTenantId: "tenant",
      },
    })
  })

  test("accepts legacy issuer tenant config while preferring tenant_id tokens", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        oemIdClaim: "oem_id",
      },
    ])

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "tenant-1",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    })

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "tenant-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
      exp: expect.any(Number),
    })
  })

  test("accepts legacy fixed OEM config as fixed tenant config", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        fixedOemId: "tenant-legacy",
      },
    ])

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "tenant-token",
      jti: "runtime-jti",
      expiresInSeconds: 60,
    })

    await expect(verifyRuntimeToken(token)).resolves.toEqual({
      mentraUserId: "user-1",
      tenantId: "tenant-legacy",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
      exp: expect.any(Number),
    })
  })

  test("rejects tokens with the wrong audience", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "sub",
        fixedTenantId: "oem-1",
      },
    ])

    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      audience: "cloud-core",
      subject: "user-1",
      tenantId: "oem-1",
      expiresInSeconds: 60,
    })

    await expect(verifyRuntimeToken(token)).rejects.toThrow("runtime_token rejected")
  })

  test("enforces configured delegated scopes and native client ids", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "https://login.example/tenant/v2.0",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        userIdClaim: "oid",
        fixedTenantId: "tenant-1",
        requiredScopes: ["mentra.runtime"],
        allowedClientIds: ["native-client"],
      },
    ])

    const valid = await signClaims(keypair.privateKey, {
      iss: "https://login.example/tenant/v2.0",
      aud: "cloud-runtime",
      oid: "employee-1",
      scp: "mentra.runtime",
      azp: "native-client",
    })
    await expect(verifyRuntimeToken(valid)).resolves.toEqual({
      mentraUserId: "employee-1",
      tenantId: "tenant-1",
      sessionId: expect.stringMatching(/^runtime_/),
      jti: expect.any(String),
      exp: expect.any(Number),
    })

    const wrongClient = await signClaims(keypair.privateKey, {
      iss: "https://login.example/tenant/v2.0",
      aud: "cloud-runtime",
      oid: "employee-1",
      scp: "mentra.runtime",
      azp: "other-client",
    })
    await expect(verifyRuntimeToken(wrongClient)).rejects.toThrow("client is not allowed")
  })

  test("rejects symmetric algorithms and an explicitly empty client allowlist", async () => {
    const keypair = createEd25519Keypair()
    process.env.TEST_RUNTIME_PUBLIC_KEY = keypair.publicKey
    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        fixedTenantId: "tenant-1",
        algorithms: ["HS256"],
      },
    ])
    await expect(verifyRuntimeToken("not-reached")).rejects.toThrow("algorithms must use EdDSA, RS256, or ES256")

    process.env.CLOUD_RUNTIME_AUTH_ISSUERS = JSON.stringify([
      {
        issuer: "test-runtime",
        publicKeyEnv: "TEST_RUNTIME_PUBLIC_KEY",
        fixedTenantId: "tenant-1",
        allowedClientIds: [],
      },
    ])
    const token = await signRuntimeToken({
      privateKey: keypair.privateKey,
      issuer: "test-runtime",
      subject: "user-1",
      tenantId: "tenant-1",
      expiresInSeconds: 60,
    })
    await expect(verifyRuntimeToken(token)).rejects.toThrow("client is not allowed")
  })
})

async function signClaims(privateKey: string, claims: jose.JWTPayload): Promise<string> {
  const key = await jose.importPKCS8(`-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`, "EdDSA")
  return new jose.SignJWT(claims).setProtectedHeader({alg: "EdDSA"}).setIssuedAt().setExpirationTime("60s").sign(key)
}

function createEd25519Keypair(): {privateKey: string; publicKey: string} {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("ed25519")
  return {
    privateKey: stripPem(privateKey.export({type: "pkcs8", format: "pem"}).toString()),
    publicKey: stripPem(publicKey.export({type: "spki", format: "pem"}).toString()),
  }
}

function stripPem(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "")
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
