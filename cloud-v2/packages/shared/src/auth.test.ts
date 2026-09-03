import crypto from "node:crypto"
import {afterEach, describe, expect, test} from "bun:test"
import * as jose from "jose"

import {resetRuntimeAuthCache, signRuntimeToken, verifyRuntimeToken} from "./auth"

const savedEnv = {
  CLOUD_RUNTIME_AUTH_AUDIENCE: process.env.CLOUD_RUNTIME_AUTH_AUDIENCE,
  CLOUD_RUNTIME_AUTH_ISSUERS: process.env.CLOUD_RUNTIME_AUTH_ISSUERS,
  TEST_RUNTIME_PUBLIC_KEY: process.env.TEST_RUNTIME_PUBLIC_KEY,
}

afterEach(() => {
  restoreEnv("CLOUD_RUNTIME_AUTH_AUDIENCE", savedEnv.CLOUD_RUNTIME_AUTH_AUDIENCE)
  restoreEnv("CLOUD_RUNTIME_AUTH_ISSUERS", savedEnv.CLOUD_RUNTIME_AUTH_ISSUERS)
  restoreEnv("TEST_RUNTIME_PUBLIC_KEY", savedEnv.TEST_RUNTIME_PUBLIC_KEY)
  resetRuntimeAuthCache()
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

    await expect(verifyRuntimeToken(token)).resolves.toMatchObject({
      mentraUserId: "user-1",
      tenantId: "oem-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
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

    await expect(verifyRuntimeToken(token)).resolves.toMatchObject({
      mentraUserId: "mu_01TEST",
      tenantId: "acme-private",
      sessionId: "sess_01TEST",
      federatedIdentity: {
        providerKind: "microsoft-entra",
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

    await expect(verifyRuntimeToken(token)).resolves.toMatchObject({
      mentraUserId: "user-1",
      tenantId: "tenant-1",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
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

    await expect(verifyRuntimeToken(token)).resolves.toMatchObject({
      mentraUserId: "user-1",
      tenantId: "tenant-legacy",
      sessionId: "runtime_runtime-jti",
      jti: "runtime-jti",
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
    await expect(verifyRuntimeToken(valid)).resolves.toMatchObject({
      mentraUserId: "employee-1",
      tenantId: "tenant-1",
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
